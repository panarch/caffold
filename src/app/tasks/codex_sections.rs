use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    app::error::ApiError,
    codex_app_server::{CodexThreadClient, CodexThreadError, ThreadSection, ThreadSectionFilter},
};

use super::TaskRecord;

const CODEX_SECTION_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskSectionIdentity {
    pub(in crate::app) id: String,
    pub(in crate::app) name: String,
    pub(in crate::app) repository: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskTopPlacement {
    pub(in crate::app) section: ActiveTaskSectionIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) before_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskSectionIdentity {
    name: String,
    repository: bool,
}

#[derive(Clone, Default)]
pub(in crate::app) struct CodexSections {
    path_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl CodexSections {
    pub(in crate::app) async fn place_at_top(
        &self,
        client: &CodexThreadClient,
        task: &TaskRecord,
    ) -> Result<ActiveTaskTopPlacement, ApiError> {
        let identity = task_section_identity(task).ok_or_else(|| {
            ApiError::Internal(format!(
                "failed to resolve the active Section path for Task {}",
                task.thread_id
            ))
        })?;
        let path_lock = self.path_lock(&identity.name).await;
        let _guard = path_lock.lock().await;
        let section = self.ensure_section_locked(client, &identity.name).await?;
        let first = client
            .list_section_threads(ThreadSectionFilter::Section(&section.id), None, 1)
            .await?
            .data
            .into_iter()
            .next();
        let before_thread_id = first
            .as_ref()
            .filter(|first| first.id != task.thread_id)
            .map(|thread| thread.id.clone());
        if first
            .as_ref()
            .is_none_or(|first| first.id != task.thread_id)
        {
            client
                .move_thread_to_section(
                    &task.thread_id,
                    Some(&section.id),
                    before_thread_id.as_deref(),
                )
                .await?;
        }
        Ok(ActiveTaskTopPlacement {
            section: ActiveTaskSectionIdentity {
                id: section.id,
                name: section.name,
                repository: identity.repository,
            },
            before_thread_id,
        })
    }

    async fn ensure_section_locked(
        &self,
        client: &CodexThreadClient,
        name: &str,
    ) -> Result<ThreadSection, CodexThreadError> {
        let mut matches = list_all_sections(client)
            .await?
            .into_iter()
            .filter(|section| section.name == name)
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| left.id.cmp(&right.id));
        match matches.into_iter().next() {
            Some(section) => Ok(section),
            None => client.create_thread_section(name).await,
        }
    }

    async fn path_lock(&self, name: &str) -> Arc<Mutex<()>> {
        let mut locks = self.path_locks.lock().await;
        locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn task_section_identity(task: &TaskRecord) -> Option<TaskSectionIdentity> {
    if let Some(worktree) = &task.worktree {
        return Some(TaskSectionIdentity {
            name: worktree.repository_root_path.clone(),
            repository: true,
        });
    }
    task.cwd_path.as_ref().map(|cwd_path| TaskSectionIdentity {
        name: cwd_path.clone(),
        repository: false,
    })
}

async fn list_all_sections(
    client: &CodexThreadClient,
) -> Result<Vec<ThreadSection>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_sections = HashSet::new();
    let mut sections = Vec::new();
    loop {
        let page = client
            .list_thread_sections(cursor.as_deref(), CODEX_SECTION_PAGE_SIZE)
            .await?;
        for section in page.data {
            if seen_sections.insert(section.id.clone()) {
                sections.push(section);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(sections);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated a threadSection/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}
