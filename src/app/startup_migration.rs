mod v4_to_v5_codex;

use std::path::PathBuf;

use crate::{
    codex_app_server::{CodexStatusResponse, CodexThreadError},
    task_store::{
        NavigatorMigrationSnapshot, PendingTaskStoreMigration, PreparedTaskStoreMigration,
        TaskStoreError, prepare_task_store_migration,
    },
};

#[derive(Debug, thiserror::Error)]
pub(super) enum StartupMigrationError {
    #[error(transparent)]
    Store(#[from] TaskStoreError),
    #[error("{}", .0.readiness.diagnostic_message)]
    CodexReadiness(Box<CodexStatusResponse>),
    #[error(transparent)]
    Codex(#[from] CodexThreadError),
    #[error("Task-store migration worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
}

pub(super) async fn migrate_task_store(path: PathBuf) -> Result<(), StartupMigrationError> {
    // A missing database is a fresh install, not a migration. TasksApp owns
    // creation of the current schema after this coordinator completes.
    if !path.exists() {
        return Ok(());
    }
    let prepared = tokio::task::spawn_blocking({
        let path = path.clone();
        move || prepare_task_store_migration(&path)
    })
    .await??;
    let PreparedTaskStoreMigration::NeedsSnapshot(pending) = prepared else {
        return Ok(());
    };

    if pending.inventory().is_empty() {
        apply_snapshot(
            pending,
            NavigatorMigrationSnapshot {
                sections: Vec::new(),
                threads: Vec::new(),
            },
        )
        .await?;
        return Ok(());
    }

    // Only non-empty v4 stores reach this path. v4 does not contain the
    // display names or Section placement required by v5, so startup collects
    // that projection from Codex before applying the v4-to-v5 migration.
    let snapshot = match v4_to_v5_codex::collect_v4_to_v5_snapshot(pending.inventory()).await {
        Ok(snapshot) => snapshot,
        Err(v4_to_v5_codex::SnapshotError::Readiness(status)) => {
            return Err(StartupMigrationError::CodexReadiness(status));
        }
        Err(v4_to_v5_codex::SnapshotError::Codex(error)) => {
            return Err(StartupMigrationError::Codex(error));
        }
    };
    apply_snapshot(pending, snapshot).await?;
    Ok(())
}

async fn apply_snapshot(
    pending: PendingTaskStoreMigration,
    snapshot: NavigatorMigrationSnapshot,
) -> Result<(), StartupMigrationError> {
    tokio::task::spawn_blocking(move || pending.apply(&snapshot)).await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::{TaskStore, write_empty_v4_test_store};

    #[tokio::test]
    async fn a_missing_database_is_left_for_fresh_schema_initialization() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("caffold.redb");

        migrate_task_store(path.clone()).await.unwrap();

        assert!(!path.exists());
        let store = TaskStore::redb(&path).unwrap();
        assert!(path.is_file());
        assert_eq!(
            store
                .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
                .unwrap(),
            (Vec::new(), Vec::new())
        );
    }

    #[tokio::test]
    async fn an_empty_v4_store_is_upgraded_without_starting_codex() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("caffold.redb");
        write_empty_v4_test_store(&path).unwrap();

        migrate_task_store(path.clone()).await.unwrap();

        let store = TaskStore::redb(&path).unwrap();
        assert_eq!(
            store
                .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
                .unwrap(),
            (Vec::new(), Vec::new())
        );
    }

    #[tokio::test]
    #[ignore = "requires an authenticated installed Codex app-server"]
    async fn live_v4_migration_reads_real_codex_names_sections_and_order() {
        use crate::{
            codex_app_server::{
                CodexNotification, CodexRuntimeEvent, CodexThreadClient, CodexTurnOptions,
                NORMAL_SERVICE_TIER_ID, ThreadSectionFilter, TurnStatus,
                inspect_codex_installation,
            },
            task_store::write_v4_test_store,
        };
        use anyhow::{Context, ensure};

        struct LiveMigrationObservation {
            section_id: String,
            section_name: String,
            first_thread_id: String,
            first_name: String,
            second_thread_id: String,
            second_name: String,
            archived_thread_id: String,
            archived_name: String,
            listed_first_name: Option<String>,
        }

        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("caffold.redb");
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let marker = uuid::Uuid::new_v4().simple().to_string();
        let installation = inspect_codex_installation()
            .await
            .expect("inspect installed Codex");
        let client = CodexThreadClient::start_with_installation(&installation)
            .await
            .expect("start real Codex app-server client");
        let mut created_thread_ids = Vec::new();

        let outcome = async {
            let section = match client
                .list_thread_sections(None, 1)
                .await
                .context("list real Codex Sections")?
                .data
                .into_iter()
                .next()
            {
                Some(section) => section,
                None => client
                    .create_thread_section(&cwd)
                    .await
                    .context("create a real Codex Section for the live migration fixture")?,
            };
            let previous_first = client
                .list_section_threads(ThreadSectionFilter::Section(&section.id), None, 1)
                .await
                .context("read the selected real Codex Section")?
                .data
                .into_iter()
                .next()
                .map(|thread| thread.id);

            let first = client
                .start_thread(&cwd, None, NORMAL_SERVICE_TIER_ID)
                .await
                .context("create the first real Codex Thread")?;
            created_thread_ids.push(first.thread_id.clone());
            let second = client
                .start_thread(&cwd, None, NORMAL_SERVICE_TIER_ID)
                .await
                .context("create the second real Codex Thread")?;
            created_thread_ids.push(second.thread_id.clone());
            let archived = client
                .start_thread(&cwd, None, NORMAL_SERVICE_TIER_ID)
                .await
                .context("create the locally archived real Codex Thread")?;
            created_thread_ids.push(archived.thread_id.clone());

            let first_name = format!("Caffold migration current first {marker}");
            let second_name = format!("Caffold migration current second {marker}");
            let archived_name = format!("Caffold migration current archived {marker}");
            client
                .set_thread_name(&first.thread_id, &format!("Old first {marker}"))
                .await
                .context("write the first stale-name candidate")?;
            client
                .set_thread_name(&second.thread_id, &format!("Old second {marker}"))
                .await
                .context("write the second stale-name candidate")?;
            client
                .set_thread_name(&archived.thread_id, &format!("Old archived {marker}"))
                .await
                .context("write the archived stale-name candidate")?;
            client
                .move_thread_to_section(
                    &first.thread_id,
                    Some(&section.id),
                    previous_first.as_deref(),
                )
                .await
                .context("place the first real Codex Thread")?;
            client
                .move_thread_to_section(
                    &second.thread_id,
                    Some(&section.id),
                    Some(&first.thread_id),
                )
                .await
                .context("place the second real Codex Thread before the first")?;
            client
                .set_thread_name(&first.thread_id, &first_name)
                .await
                .context("write the current first Thread name")?;
            client
                .set_thread_name(&second.thread_id, &second_name)
                .await
                .context("write the current second Thread name")?;
            client
                .set_thread_name(&archived.thread_id, &archived_name)
                .await
                .context("write the current archived Thread name")?;

            let mut events = client.subscribe();
            for (thread_id, reply) in [
                (&first.thread_id, format!("caffold-migration-first-{marker}")),
                (
                    &second.thread_id,
                    format!("caffold-migration-second-{marker}"),
                ),
            ] {
                client
                    .start_turn(
                        thread_id,
                        &cwd,
                        &format!(
                            "Reply with exactly {reply}. Do not modify files or run commands."
                        ),
                        &[],
                        CodexTurnOptions {
                            model: Some("gpt-5.3-codex-spark".to_string()),
                            effort: Some("low".to_string()),
                            service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
                            permission_mode: None,
                        },
                    )
                    .await
                    .with_context(|| format!("start the Spark fixture turn for {thread_id}"))?;
            }
            let mut pending_turns = [first.thread_id.clone(), second.thread_id.clone()]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                while !pending_turns.is_empty() {
                    if let Ok(CodexRuntimeEvent::Notification(
                        CodexNotification::TurnCompleted { thread_id, turn },
                    )) = events.recv().await
                        && turn.status != TurnStatus::InProgress
                    {
                        pending_turns.remove(&thread_id);
                    }
                }
            })
            .await
            .context("wait for the real Spark fixture turns to complete")?;

            let section_threads = client
                .list_section_threads(ThreadSectionFilter::Section(&section.id), None, 100)
                .await
                .context("observe the real Section-scoped list payload")?
                .data;
            let listed_first_name = section_threads
                .iter()
                .find(|thread| thread.id == first.thread_id)
                .and_then(|thread| thread.name.clone());
            eprintln!(
                "LIVE_MIGRATION_FIXTURE section={} first={} second={} archived={} listed_section_ids={:?}",
                section.id,
                first.thread_id,
                second.thread_id,
                archived.thread_id,
                section_threads
                    .iter()
                    .map(|thread| thread.id.as_str())
                    .collect::<Vec<_>>()
            );
            let read_first_name = client
                .read_thread(&first.thread_id)
                .await
                .context("read the current first Thread")?
                .name;
            ensure!(
                read_first_name.as_deref() == Some(first_name.as_str()),
                "individual thread/read did not return the current first Thread name"
            );

            let observer = CodexThreadClient::start_with_installation(&installation)
                .await
                .context("start an independent real Codex observer")?;
            let observer_section_ids = observer
                .list_section_threads(ThreadSectionFilter::Section(&section.id), None, 100)
                .await
                .context("list the selected Section from the independent observer")?
                .data
                .into_iter()
                .map(|thread| thread.id)
                .collect::<Vec<_>>();
            eprintln!(
                "LIVE_MIGRATION_OBSERVER section_ids={observer_section_ids:?}"
            );
            observer.shutdown().await;

            write_v4_test_store(
                &database_path,
                &[
                    (first.thread_id.clone(), false),
                    (second.thread_id.clone(), false),
                    (archived.thread_id.clone(), true),
                ],
            )
            .context("write the live v4 Task-store fixture")?;
            migrate_task_store(database_path.clone())
                .await
                .context("migrate v4 with the real Codex app-server projection")?;

            Ok::<_, anyhow::Error>(LiveMigrationObservation {
                section_id: section.id,
                section_name: section.name,
                first_thread_id: first.thread_id,
                first_name,
                second_thread_id: second.thread_id,
                second_name,
                archived_thread_id: archived.thread_id,
                archived_name,
                listed_first_name,
            })
        }
        .await;

        for thread_id in created_thread_ids.iter().rev() {
            if let Err(error) = client.delete_thread(thread_id).await {
                eprintln!("failed to clean up live migration Thread {thread_id}: {error}");
            }
        }
        client.shutdown().await;
        let outcome = outcome.expect("complete the real Codex v4 migration scenario");

        eprintln!(
            "LIVE_MIGRATION list_name={:?} read_name={}",
            outcome.listed_first_name, outcome.first_name
        );
        let store = TaskStore::redb(&database_path).expect("open the migrated v5 Task store");
        let (sections, active) = store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .expect("read the migrated active projection");
        let archived = store
            .list_archived(None, 100)
            .expect("read the migrated archived projection")
            .0;
        let section = sections
            .iter()
            .find(|section| section.section_id == outcome.section_id)
            .expect("persist the selected real Codex Section");
        assert_eq!(section.logical_path, outcome.section_name);
        let active = active
            .into_iter()
            .map(|thread| (thread.thread_id.clone(), thread))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            active[&outcome.second_thread_id].display_name,
            outcome.second_name
        );
        assert_eq!(
            active[&outcome.second_thread_id].section_id.as_deref(),
            Some(outcome.section_id.as_str())
        );
        assert_eq!(
            active[&outcome.second_thread_id].position_in_section,
            Some(0)
        );
        assert_eq!(
            active[&outcome.first_thread_id].display_name,
            outcome.first_name
        );
        assert_eq!(
            active[&outcome.first_thread_id].section_id.as_deref(),
            Some(outcome.section_id.as_str())
        );
        assert_eq!(
            active[&outcome.first_thread_id].position_in_section,
            Some(1)
        );
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].thread_id, outcome.archived_thread_id);
        assert_eq!(archived[0].display_name, outcome.archived_name);
        assert_eq!(archived[0].section_id, None);
        assert_eq!(archived[0].position_in_section, None);
        for thread in active.values().chain(archived.iter()) {
            assert_eq!(thread.model.as_deref(), Some("gpt-5.3-codex-spark"));
            assert_eq!(thread.reasoning_effort.as_deref(), Some("low"));
            assert!(thread.last_completed_at_ms.is_some());
        }
    }
}
