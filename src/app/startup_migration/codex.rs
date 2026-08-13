use std::collections::{BTreeMap, BTreeSet, HashSet};

use futures_util::{StreamExt, stream};

use crate::{
    codex_app_server::{
        CodexStatusResponse, CodexThread, CodexThreadClient, CodexThreadError, ThreadSectionFilter,
        inspect_codex_installation,
    },
    task_store::{
        ManagedThreadMigrationInventory, NavigatorMigrationSection, NavigatorMigrationSnapshot,
        NavigatorMigrationThread, NavigatorMigrationThreadClassification,
    },
};

const PAGE_SIZE: usize = 100;
const SECTION_LIST_CONCURRENCY: usize = 8;
const THREAD_READ_CONCURRENCY: usize = 8;

struct ThreadReadSnapshot {
    display_name: String,
    available: bool,
}

#[derive(Debug)]
pub(super) enum SnapshotError {
    Readiness(Box<CodexStatusResponse>),
    Codex(CodexThreadError),
}

pub(super) async fn collect_snapshot(
    inventory: &[ManagedThreadMigrationInventory],
) -> Result<NavigatorMigrationSnapshot, SnapshotError> {
    let installation = inspect_codex_installation().await.map_err(|readiness| {
        SnapshotError::Readiness(Box::new(CodexThreadClient::unavailable_status(
            &CodexThreadError::Readiness(Box::new(readiness)),
        )))
    })?;
    let client = CodexThreadClient::start_with_installation(&installation)
        .await
        .map_err(SnapshotError::Codex)?;
    let status = client.status(&installation).await;
    if status.readiness.blocks_task_operations {
        client.shutdown().await;
        return Err(SnapshotError::Readiness(Box::new(status)));
    }

    let snapshot = collect_snapshot_from_client(&client, inventory).await;
    client.shutdown().await;
    snapshot.map_err(SnapshotError::Codex)
}

async fn collect_snapshot_from_client(
    client: &CodexThreadClient,
    inventory: &[ManagedThreadMigrationInventory],
) -> Result<NavigatorMigrationSnapshot, CodexThreadError> {
    let sections = list_all_sections(client).await?;
    let active_managed_ids = inventory
        .iter()
        .filter(|managed| !managed.archived)
        .map(|managed| managed.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    let section_threads = stream::iter(sections.iter())
        .map(|section| async move {
            let threads = list_all_section_threads(client, &section.id).await?;
            Ok::<_, CodexThreadError>((section.id.clone(), threads))
        })
        .buffer_unordered(SECTION_LIST_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let (unsectioned, archived) = tokio::try_join!(
        list_all_section_threads(client, ""),
        list_all_archived_threads(client),
    )?;

    let mut section_order = BTreeMap::<String, Vec<String>>::new();
    let mut section_by_thread = BTreeMap::<String, String>::new();
    for (section_id, threads) in section_threads {
        for thread in threads {
            if active_managed_ids.contains(thread.id.as_str()) {
                if let Some(previous_section) =
                    section_by_thread.insert(thread.id.clone(), section_id.clone())
                {
                    return Err(CodexThreadError::Protocol(format!(
                        "managed Thread {} appeared in both Sections {previous_section} and {section_id}",
                        thread.id,
                    )));
                }
                section_order
                    .entry(section_id.clone())
                    .or_default()
                    .push(thread.id);
            }
        }
    }
    let unsectioned = unsectioned
        .into_iter()
        .map(|thread| thread.id)
        .collect::<BTreeSet<_>>();
    let archived = archived
        .into_iter()
        .map(|thread| thread.id)
        .collect::<BTreeSet<_>>();
    let reads = stream::iter(inventory.to_vec())
        .map(|managed| async move {
            let read = match client.read_thread(&managed.thread_id).await {
                Ok(thread) => ThreadReadSnapshot {
                    display_name: display_name(&thread),
                    available: true,
                },
                Err(error) if error.is_thread_unavailable() => ThreadReadSnapshot {
                    display_name: fallback_display_name(&managed.thread_id),
                    available: false,
                },
                Err(error) => return Err(error),
            };
            Ok::<_, CodexThreadError>((managed.thread_id, read))
        })
        .buffer_unordered(THREAD_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<BTreeMap<_, _>, _>>()?;

    let mut classifications = BTreeMap::new();
    for managed in inventory {
        let classification = if managed.archived {
            NavigatorMigrationThreadClassification::LocallyArchived
        } else {
            let section = section_by_thread.get(&managed.thread_id);
            let is_unsectioned = unsectioned.contains(&managed.thread_id);
            let is_codex_archived = archived.contains(&managed.thread_id);
            let location_count = usize::from(section.is_some())
                + usize::from(is_unsectioned)
                + usize::from(is_codex_archived);
            if location_count > 1 {
                return Err(CodexThreadError::Protocol(format!(
                    "managed Thread {} appeared in conflicting Codex locations",
                    managed.thread_id
                )));
            }
            if !reads[&managed.thread_id].available {
                NavigatorMigrationThreadClassification::Missing
            } else if section.is_some() {
                NavigatorMigrationThreadClassification::ActiveSectioned
            } else if is_unsectioned {
                NavigatorMigrationThreadClassification::ActiveUnsectioned
            } else if is_codex_archived {
                NavigatorMigrationThreadClassification::CodexArchived
            } else {
                return Err(CodexThreadError::Protocol(format!(
                    "managed Thread {} has no conclusive Codex lifecycle classification",
                    managed.thread_id
                )));
            }
        };
        classifications.insert(managed.thread_id.clone(), classification);
    }

    let mut location_by_thread = BTreeMap::<String, (String, u64)>::new();
    for (section_id, thread_ids) in section_order {
        let mut local_position = 0_u64;
        for thread_id in thread_ids {
            if classifications[&thread_id]
                == NavigatorMigrationThreadClassification::ActiveSectioned
            {
                location_by_thread.insert(thread_id, (section_id.clone(), local_position));
                local_position += 1;
            }
        }
    }

    let threads = inventory
        .iter()
        .map(|managed| {
            let classification = classifications[&managed.thread_id];
            let placement = (classification
                == NavigatorMigrationThreadClassification::ActiveSectioned)
                .then(|| location_by_thread.get(&managed.thread_id).cloned())
                .flatten();
            NavigatorMigrationThread {
                thread_id: managed.thread_id.clone(),
                display_name: reads[&managed.thread_id].display_name.clone(),
                classification,
                section_id: placement.as_ref().map(|(section_id, _)| section_id.clone()),
                position_in_section: placement.map(|(_, position)| position),
            }
        })
        .collect();
    Ok(NavigatorMigrationSnapshot {
        sections: sections
            .into_iter()
            .map(|section| NavigatorMigrationSection {
                section_id: section.id,
                logical_path: section.name,
            })
            .collect(),
        threads,
    })
}

async fn list_all_sections(
    client: &CodexThreadClient,
) -> Result<Vec<crate::codex_app_server::ThreadSection>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut sections = Vec::new();
    loop {
        let page = client
            .list_thread_sections(cursor.as_deref(), PAGE_SIZE)
            .await?;
        for section in page.data {
            if !seen_ids.insert(section.id.clone()) {
                return Err(CodexThreadError::Protocol(format!(
                    "Codex returned duplicate Section {} during startup migration",
                    section.id
                )));
            }
            sections.push(section);
        }
        let Some(next) = next_cursor(page.next_cursor, &mut seen_cursors, "threadSection/list")?
        else {
            return Ok(sections);
        };
        cursor = Some(next);
    }
}

async fn list_all_section_threads(
    client: &CodexThreadClient,
    section_id: &str,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let section = if section_id.is_empty() {
        ThreadSectionFilter::Unsectioned
    } else {
        ThreadSectionFilter::Section(section_id)
    };
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_section_threads(section, cursor.as_deref(), PAGE_SIZE)
            .await?;
        for thread in page.data {
            if !seen_ids.insert(thread.id.clone()) {
                return Err(CodexThreadError::Protocol(format!(
                    "Codex returned duplicate Thread {} during startup migration",
                    thread.id
                )));
            }
            threads.push(thread);
        }
        let Some(next) = next_cursor(page.next_cursor, &mut seen_cursors, "thread/list")? else {
            return Ok(threads);
        };
        cursor = Some(next);
    }
}

async fn list_all_archived_threads(
    client: &CodexThreadClient,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_archived_threads(cursor.as_deref(), PAGE_SIZE)
            .await?;
        for thread in page.data {
            if !seen_ids.insert(thread.id.clone()) {
                return Err(CodexThreadError::Protocol(format!(
                    "Codex returned duplicate archived Thread {} during startup migration",
                    thread.id
                )));
            }
            threads.push(thread);
        }
        let Some(next) = next_cursor(page.next_cursor, &mut seen_cursors, "thread/list archived")?
        else {
            return Ok(threads);
        };
        cursor = Some(next);
    }
}

fn next_cursor(
    cursor: Option<String>,
    seen: &mut HashSet<String>,
    method: &'static str,
) -> Result<Option<String>, CodexThreadError> {
    let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) else {
        return Ok(None);
    };
    if !seen.insert(cursor.clone()) {
        return Err(CodexThreadError::Protocol(format!(
            "Codex repeated a {method} cursor during startup migration"
        )));
    }
    Ok(Some(cursor))
}

fn display_name(thread: &CodexThread) -> String {
    thread
        .name
        .as_deref()
        .and_then(non_empty)
        .or_else(|| non_empty(&thread.preview))
        .map(str::to_string)
        .unwrap_or_else(|| fallback_display_name(&thread.id))
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn fallback_display_name(thread_id: &str) -> String {
    format!("Thread {}", thread_id.chars().take(8).collect::<String>())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::codex_app_server::MockCodexResponse;

    #[tokio::test]
    async fn uses_thread_read_names_and_never_reads_unmanaged_threads() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "threadSection/list",
                json!({"data": [{"id": "section-1", "name": "Workspace/repo"}], "nextCursor": null}),
            ),
            MockCodexResponse::ok(
                "thread/list",
                json!({"data": [
                    {"id": "managed", "name": "stale", "preview": "stale", "status": {"type": "idle"}, "cwd": "/tmp", "turns": []},
                    {"id": "unmanaged", "name": "ignore", "preview": "ignore", "status": {"type": "idle"}, "cwd": "/tmp", "turns": []}
                ], "nextCursor": null}),
            ),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::ok_for(
                "thread/read",
                json!({"threadId": "managed", "includeTurns": false}),
                json!({"thread": {"id": "managed", "name": "Current name", "preview": "Current preview", "status": {"type": "idle"}, "cwd": "/tmp", "turns": []}}),
            ),
        ]);
        let snapshot = collect_snapshot_from_client(
            &client,
            &[ManagedThreadMigrationInventory {
                thread_id: "managed".to_string(),
                archived: false,
            }],
        )
        .await
        .unwrap();
        assert_eq!(snapshot.threads[0].display_name, "Current name");
        assert_eq!(
            snapshot.threads[0].classification,
            NavigatorMigrationThreadClassification::ActiveSectioned
        );
        assert_eq!(snapshot.threads[0].section_id.as_deref(), Some("section-1"));
        assert_eq!(snapshot.threads[0].position_in_section, Some(0));
        let requests = client.mock_requests().await;
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/read")
                .count(),
            1
        );
        assert!(requests.iter().all(|(_, params)| {
            params.get("threadId").and_then(serde_json::Value::as_str) != Some("unmanaged")
        }));
    }

    #[tokio::test]
    async fn required_read_failure_aborts_the_snapshot() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "threadSection/list",
                json!({"data": [], "nextCursor": null}),
            ),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::error(
                "thread/read",
                CodexThreadError::Protocol("read failed".to_string()),
            ),
        ]);
        let error = collect_snapshot_from_client(
            &client,
            &[ManagedThreadMigrationInventory {
                thread_id: "managed".to_string(),
                archived: false,
            }],
        )
        .await
        .unwrap_err();
        assert!(matches!(error, CodexThreadError::Protocol(message) if message == "read failed"));
    }

    #[tokio::test]
    async fn classifies_recovery_rows_and_redensifies_positions_after_unavailable_reads() {
        let section_params = json!({
            "limit": 100,
            "sortKey": "section_position",
            "sortDirection": "asc",
            "archived": false,
            "useStateDbOnly": true,
            "sectionId": "section-1",
        });
        let unsectioned_params = json!({
            "limit": 100,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "archived": false,
            "useStateDbOnly": true,
            "sectionId": null,
        });
        let archived_params = json!({
            "limit": 100,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "archived": true,
            "useStateDbOnly": true,
        });
        let listed = |id: &str, name: &str| {
            json!({
                "id": id,
                "name": name,
                "preview": name,
                "status": {"type": "idle"},
                "cwd": "/tmp",
                "turns": [],
            })
        };
        let read = |id: &str, name: &str, preview: &str| {
            MockCodexResponse::ok_for(
                "thread/read",
                json!({"threadId": id, "includeTurns": false}),
                json!({"thread": {
                    "id": id,
                    "name": name,
                    "preview": preview,
                    "status": {"type": "idle"},
                    "cwd": "/tmp",
                    "turns": [],
                }}),
            )
        };
        let unavailable = |id: &str| {
            MockCodexResponse::error_for(
                "thread/read",
                json!({"threadId": id, "includeTurns": false}),
                CodexThreadError::ThreadUnavailable(id.to_string()),
            )
        };
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                json!({"limit": 100}),
                json!({"data": [{"id": "section-1", "name": "Workspace/repo"}], "nextCursor": null}),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                section_params,
                json!({
                    "data": [
                        listed("unavailable-sectioned", "stale unavailable"),
                        listed("sectioned", "stale sectioned"),
                        listed("unmanaged", "never read"),
                    ],
                    "nextCursor": null,
                }),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                unsectioned_params,
                json!({"data": [listed("unsectioned", "stale unsectioned")], "nextCursor": null}),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                archived_params,
                json!({"data": [listed("codex-archived", "stale archived")], "nextCursor": null}),
            ),
            unavailable("unavailable-sectioned"),
            read("sectioned", "Current sectioned", "ignored preview"),
            read("unsectioned", "", "Current preview"),
            read("codex-archived", "", ""),
            unavailable("missing"),
            read("locally-archived", "Archived name", "ignored preview"),
        ]);
        let inventory = [
            ("unavailable-sectioned", false),
            ("sectioned", false),
            ("unsectioned", false),
            ("codex-archived", false),
            ("missing", false),
            ("locally-archived", true),
        ]
        .into_iter()
        .map(|(thread_id, archived)| ManagedThreadMigrationInventory {
            thread_id: thread_id.to_string(),
            archived,
        })
        .collect::<Vec<_>>();

        let snapshot = collect_snapshot_from_client(&client, &inventory)
            .await
            .unwrap();
        let threads = snapshot
            .threads
            .into_iter()
            .map(|thread| (thread.thread_id.clone(), thread))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(
            threads["unavailable-sectioned"].classification,
            NavigatorMigrationThreadClassification::Missing
        );
        assert_eq!(threads["unavailable-sectioned"].section_id, None);
        assert_eq!(
            threads["sectioned"].classification,
            NavigatorMigrationThreadClassification::ActiveSectioned
        );
        assert_eq!(threads["sectioned"].position_in_section, Some(0));
        assert_eq!(threads["sectioned"].display_name, "Current sectioned");
        assert_eq!(
            threads["unsectioned"].classification,
            NavigatorMigrationThreadClassification::ActiveUnsectioned
        );
        assert_eq!(threads["unsectioned"].display_name, "Current preview");
        assert_eq!(
            threads["codex-archived"].classification,
            NavigatorMigrationThreadClassification::CodexArchived
        );
        assert_eq!(threads["codex-archived"].display_name, "Thread codex-ar");
        assert_eq!(
            threads["missing"].classification,
            NavigatorMigrationThreadClassification::Missing
        );
        assert_eq!(threads["missing"].display_name, "Thread missing");
        assert_eq!(
            threads["locally-archived"].classification,
            NavigatorMigrationThreadClassification::LocallyArchived
        );
        assert_eq!(threads["locally-archived"].section_id, None);

        let requests = client.mock_requests().await;
        let reads = requests
            .iter()
            .filter(|(method, _)| method == "thread/read")
            .collect::<Vec<_>>();
        assert_eq!(reads.len(), inventory.len());
        assert!(
            reads
                .iter()
                .all(|(_, params)| params["includeTurns"] == false)
        );
        assert!(
            reads
                .iter()
                .all(|(_, params)| params["threadId"] != "unmanaged")
        );
    }

    #[tokio::test]
    async fn readable_thread_without_a_listed_lifecycle_aborts_the_snapshot() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "threadSection/list",
                json!({"data": [], "nextCursor": null}),
            ),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::ok("thread/list", json!({"data": [], "nextCursor": null})),
            MockCodexResponse::ok_for(
                "thread/read",
                json!({"threadId": "managed", "includeTurns": false}),
                json!({"thread": {
                    "id": "managed",
                    "name": "Readable but unclassified",
                    "preview": "",
                    "status": {"type": "idle"},
                    "cwd": "/tmp",
                    "turns": [],
                }}),
            ),
        ]);

        let error = collect_snapshot_from_client(
            &client,
            &[ManagedThreadMigrationInventory {
                thread_id: "managed".to_string(),
                archived: false,
            }],
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            CodexThreadError::Protocol(message)
                if message.contains("no conclusive Codex lifecycle classification")
        ));
    }

    #[tokio::test]
    async fn repeated_pagination_cursor_aborts_section_discovery() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                json!({"limit": 100}),
                json!({"data": [], "nextCursor": "repeat"}),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                json!({"cursor": "repeat", "limit": 100}),
                json!({"data": [], "nextCursor": "repeat"}),
            ),
        ]);

        let error = list_all_sections(&client).await.unwrap_err();
        assert!(matches!(
            error,
            CodexThreadError::Protocol(message)
                if message.contains("repeated a threadSection/list cursor")
        ));
    }
}
