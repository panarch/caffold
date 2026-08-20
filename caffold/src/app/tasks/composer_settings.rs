use crate::{
    app::error::ApiError,
    task_store::{ComposerSettings, ManagedSection, ManagedThread, TaskStore, TaskStoreError},
};

pub(super) struct PersistedComposerSettings {
    pub(super) thread: ManagedThread,
    pub(super) section: Option<ManagedSection>,
}

pub(super) async fn persist_started_turn_composer_settings(
    store: TaskStore,
    thread_id: &str,
    settings: ComposerSettings,
) -> Result<Option<PersistedComposerSettings>, ApiError> {
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.transaction(|tables| {
            let Some(thread) =
                tables.update_managed_thread_composer_settings(&thread_id, &settings)?
            else {
                return Ok(None);
            };
            let section = match thread.section_id.as_deref() {
                Some(section_id) => Some(
                    tables
                        .update_managed_section_composer_settings(section_id, &settings)?
                        .ok_or(TaskStoreError::UnexpectedPayload)?,
                ),
                None => None,
            };
            Ok(Some(PersistedComposerSettings { thread, section }))
        })
    })
    .await
    .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
    .map_err(|error| ApiError::Internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::RunBy;

    fn settings(model: &str, effort: &str, fast_mode: bool) -> ComposerSettings {
        ComposerSettings {
            model: Some(model.to_string()),
            reasoning_effort: Some(effort.to_string()),
            fast_mode,
        }
    }

    fn place_thread(store: &TaskStore, thread_id: &str, section_id: &str) {
        store
            .transaction(|tables| {
                tables.upsert_managed_section(&ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: format!("Workspace/{section_id}"),
                    position: 0,
                    last_composer_settings: None,
                })?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, RunBy::Codex, Some(1), None, None),
                    thread_id,
                    section_id,
                    1,
                )
            })
            .unwrap();
    }

    #[tokio::test]
    async fn updates_the_task_and_its_section_in_one_transaction() {
        let store = TaskStore::memory().unwrap();
        place_thread(&store, "thread-a", "section-a");
        place_thread(&store, "thread-b", "section-b");
        let selected = settings("gpt-selected", "xhigh", true);

        let persisted =
            persist_started_turn_composer_settings(store.clone(), "thread-a", selected.clone())
                .await
                .unwrap()
                .unwrap();

        assert_eq!(persisted.thread.composer_settings(), selected);
        assert_eq!(
            persisted.section.unwrap().last_composer_settings,
            Some(selected.clone())
        );
        let sections = store.read(|tables| tables.managed_sections()).unwrap();
        assert_eq!(sections[0].last_composer_settings, Some(selected));
        assert_eq!(sections[1].last_composer_settings, None);
    }

    #[tokio::test]
    async fn missing_task_is_a_noop() {
        let store = TaskStore::memory().unwrap();

        let persisted = persist_started_turn_composer_settings(
            store.clone(),
            "missing-thread",
            settings("gpt-selected", "high", true),
        )
        .await
        .unwrap();

        assert!(persisted.is_none());
        assert!(
            store
                .read(|tables| tables.managed_sections())
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn missing_section_rolls_back_the_task_update() {
        let store = TaskStore::memory().unwrap();
        store
            .transaction(|tables| {
                tables.claim_managed_thread_at_top(
                    ManagedThread::new("thread-orphan", RunBy::Codex, Some(1), None, None),
                    "Orphan",
                    "missing-section",
                    1,
                )
            })
            .unwrap();

        let result = persist_started_turn_composer_settings(
            store.clone(),
            "thread-orphan",
            settings("gpt-selected", "high", true),
        )
        .await;

        assert!(matches!(result, Err(ApiError::Internal(_))));
        assert_eq!(
            store
                .get("thread-orphan")
                .unwrap()
                .unwrap()
                .composer_settings(),
            ComposerSettings::default()
        );
    }

    #[tokio::test]
    async fn unsectioned_recovery_task_keeps_its_current_settings_without_a_section_write() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread-unsectioned", RunBy::Codex, Some(1), None, None),
                1,
            )
            .unwrap();
        let selected = settings("gpt-selected", "medium", false);

        let persisted =
            persist_started_turn_composer_settings(store, "thread-unsectioned", selected.clone())
                .await
                .unwrap()
                .unwrap();

        assert_eq!(persisted.thread.composer_settings(), selected);
        assert!(persisted.section.is_none());
    }
}
