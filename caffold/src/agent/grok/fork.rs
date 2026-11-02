//! Independent conversation forks. Worktree switching rebinds a Task and
//! closes its previous session; this path creates a new binding with no
//! ownership of the parent, and never loads or closes the source.

use super::{
    GrokClient, GrokError, NativeSession, PermissionMode, Session, SessionState, history,
    protocol::{self, SessionInfoResult, UpdatesWindow},
};
use crate::agent::{
    AgentError, Conversation, ItemKind, ThreadStatus, TurnOptions,
    fork::{ForkRevision, ForkSource, ForkedConversation},
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedSession {
    session_id: String,
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionList {
    sessions: Vec<ListedSession>,
    #[serde(default)]
    next_cursor: Option<String>,
}

impl GrokClient {
    /// Resolve native IDs back to their deletion owner, including sessions a
    /// worktree switch left behind. This does not attach to any native session.
    pub(crate) async fn owns_fork_source(
        &self,
        task: &str,
        native: &str,
    ) -> Result<bool, GrokError> {
        let Some(binding) = self.inner.bindings.read(task).await? else {
            return Ok(false);
        };
        Ok(binding.current.session_id == native
            || binding.history.iter().any(|past| past.session_id == native)
            || binding
                .switch
                .is_some_and(|switch| switch.new_session_id == native))
    }

    pub(crate) async fn read_fork_source(
        &self,
        id: &str,
        external: bool,
    ) -> Result<ForkSource, AgentError> {
        let native = if external {
            None
        } else {
            Some(self.native_of(id).await?)
        };
        let native_id = native
            .as_ref()
            .map(|native| native.session_id.as_str())
            .unwrap_or(id);
        let info: SessionInfoResult = serde_json::from_value(
            self.inner
                .transport
                .call("_x.ai/session/info", protocol::session_params(native_id))
                .await?,
        )
        .map_err(|error| GrokError::Protocol(error.to_string()))?;
        if info
            .result
            .session_id
            .as_deref()
            .is_some_and(|reported| reported != native_id)
        {
            return Err(AgentError::Failed(
                "Grok returned a different source session".into(),
            ));
        }
        let mut title = None;
        let mut updated_at = String::new();
        let cwd = if let Some(cwd) = &info.result.cwd {
            cwd.clone()
        } else {
            let mut cursor = None;
            let mut cursors = std::collections::HashSet::new();
            let mut matches = Vec::new();
            loop {
                let mut params = json!({});
                if let Some(cursor) = &cursor {
                    params["cursor"] = json!(cursor);
                }
                let value = self.inner.transport.call("session/list", params).await?;
                if value
                    .pointer("/_meta/x.ai~1partial/conversations")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    return Err(AgentError::Failed(
                        "Grok could not read its complete session list".into(),
                    ));
                }
                let page: SessionList = serde_json::from_value(value)
                    .map_err(|error| GrokError::Protocol(format!("session/list: {error}")))?;
                matches.extend(
                    page.sessions
                        .into_iter()
                        .filter(|session| session.session_id == native_id),
                );
                cursor = page.next_cursor;
                let Some(next) = &cursor else {
                    break;
                };
                if !cursors.insert(next.clone()) {
                    return Err(AgentError::Failed(
                        "Grok repeated a session-list cursor".into(),
                    ));
                }
            }
            if matches.len() > 1 {
                return Err(AgentError::Failed(
                    "That Grok Session ID has multiple records".into(),
                ));
            }
            let found = matches.pop().ok_or_else(|| {
                AgentError::ConversationGone(format!(
                    "Grok could not resolve Session ID {native_id}"
                ))
            })?;
            title = found.title;
            updated_at = found.updated_at;
            found.cwd
        };
        if native.as_ref().is_some_and(|native| native.cwd != cwd) {
            return Err(AgentError::Failed(
                "Grok source directory no longer matches its Task binding".into(),
            ));
        }
        if !std::path::Path::new(&cwd).is_absolute() {
            return Err(AgentError::Failed(
                "Grok returned no absolute source directory".into(),
            ));
        }
        let address = NativeSession {
            session_id: native_id.to_string(),
            cwd: cwd.clone(),
        };
        let updates = self.updates(&address, UpdatesWindow::LastTurns(8)).await?;
        let page = history::turns_page(
            &updates,
            updates.total_count.saturating_sub(updates.updates.len()),
            None,
        );
        let owner = if external {
            self.inner.natives.lock().await.get(native_id).cloned()
        } else {
            Some(id.to_string())
        };
        let watched = match &owner {
            Some(owner) => self.watched_conversation(owner).await,
            None => None,
        };
        let settings = match &owner {
            Some(owner) => self.driver().read_settings(&self.settings_of(owner).await),
            None => TurnOptions {
                model: info.result.model,
                ..TurnOptions::default()
            },
        };
        let preview = page
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .find_map(|item| match &item.kind {
                ItemKind::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .unwrap_or_default();
        let updated_at_ms = updates
            .updates
            .iter()
            .filter_map(|update| update.timestamp)
            .max()
            .unwrap_or(0)
            .saturating_mul(1000);
        Ok(ForkSource {
            conversation: Conversation {
                id: native_id.to_string(),
                title: watched
                    .as_ref()
                    .and_then(|live| live.title.clone())
                    .or(title),
                preview,
                status: watched
                    .as_ref()
                    .map(|live| live.status.clone())
                    .unwrap_or(ThreadStatus::NotLoaded),
                background_work: watched.as_ref().is_some_and(|live| live.background_work),
                cwd: cwd.clone(),
                transcript_path: None,
                created_at_ms: updated_at_ms,
                updated_at_ms,
                recency_at_ms: Some(updated_at_ms),
                turns: Vec::new(),
            },
            turns_page: Some(page),
            settings,
            revision: ForkRevision::Grok {
                session_id: native_id.to_string(),
                cwd,
                updated_at,
                count: updates.total_count,
                last_event: updates.last_event_id,
            },
        })
    }

    pub(crate) async fn create_fork(
        &self,
        source: &ForkSource,
        cwd: &str,
        title: &str,
    ) -> Result<ForkedConversation, AgentError> {
        let ForkRevision::Grok {
            session_id,
            cwd: source_cwd,
            ..
        } = &source.revision
        else {
            return Err(AgentError::Failed(
                "The fork source belongs to another provider".into(),
            ));
        };
        let id = Uuid::now_v7().to_string();
        let bridge = self.inner.transport.bridge().await?;
        // The durable address exists before the native write. Its history is
        // empty: deletion of this Task must never delete the source.
        self.inner.bindings.create(&id, &id, cwd).await?;
        let result = async {
            let answer = self
                .inner
                .transport
                .call(
                    "_x.ai/session/fork",
                    protocol::fork_params(session_id, source_cwd, cwd, &id),
                )
                .await?;
            if answer
                .get("newSessionId")
                .and_then(serde_json::Value::as_str)
                != Some(id.as_str())
                || answer.get("newCwd").and_then(serde_json::Value::as_str) != Some(cwd)
                || answer
                    .get("parentSessionId")
                    .and_then(serde_json::Value::as_str)
                    != Some(session_id.as_str())
            {
                return Err(AgentError::Failed(
                    "Grok returned a different fork identity, parent or directory".into(),
                ));
            }
            let native = NativeSession {
                session_id: id.clone(),
                cwd: cwd.to_string(),
            };
            let session = Arc::new(Session {
                thread_id: id.clone(),
                native: Mutex::new(native.clone()),
                state: Mutex::new(SessionState::new(
                    super::grok_permission_mode(source.settings.permission_mode.as_deref())
                        .and_then(PermissionMode::from_name),
                    None,
                    None,
                )),
            });
            session.state.lock().await.loaded_on = bridge.generation;
            self.remember(session.clone()).await;
            let (loaded, info) = self.load_and_check(&bridge, &id, &native).await?;
            if info.result.cwd.as_deref() != Some(cwd)
                || info.result.session_id.as_deref() != Some(&id)
            {
                return Err(AgentError::Failed(
                    "Grok did not confirm the loaded fork identity and directory".into(),
                ));
            }
            self.absorb_loaded(&session, loaded, info).await;
            self.rename_conversation(&id, title).await?;
            let turns_page = self.read_turns(&id, None, 8).await?;
            let mut conversation = self.conversation_of(&session).await;
            conversation.title = Some(title.to_string());
            conversation.preview = source.conversation.preview.clone();
            Ok(ForkedConversation {
                conversation,
                turns_page,
                settings: self.driver().read_settings(&self.settings_of(&id).await),
            })
        }
        .await;
        if result.is_err() {
            match self.erase_sessions(&id).await {
                Ok(()) => {
                    if let Err(error) = self.forget_erased_binding(&id).await {
                        eprintln!("failed to forget unclaimed Grok fork {id}: {error}");
                    }
                }
                Err(error) => eprintln!("failed to delete unclaimed Grok fork {id}: {error}"),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        GrokTurnOptions,
        test_support::{scripted_leader, scripted_leader_with},
        transport::mock::MockAnswer,
    };
    use super::*;

    #[tokio::test]
    async fn an_independent_child_keeps_history_settings_and_owns_only_itself() {
        let root = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(root.path());
        let (leader, memory) = scripted_leader(bridges);
        let parent = client
            .start_conversation(
                "/source",
                &GrokTurnOptions {
                    model: Some("grok-4.5".into()),
                    effort: Some("low".into()),
                    permission_mode: Some("ask".into()),
                },
            )
            .await
            .unwrap();
        let history: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/updates-result.json")).unwrap();
        memory
            .lock()
            .unwrap()
            .updates
            .insert(parent.id.clone(), history);
        let before = client.read_fork_source(&parent.id, false).await.unwrap();
        let external = client.read_fork_source(&parent.id, true).await.unwrap();
        assert!(before.same_revision(&external));
        let child = client
            .create_fork(&before, "/target", "Fork of source")
            .await
            .unwrap();
        assert_ne!(child.conversation.id, parent.id);
        assert_eq!(child.conversation.cwd, "/target");
        assert_eq!(child.settings.model.as_deref(), Some("grok-4.5"));
        assert_eq!(child.settings.effort.as_deref(), Some("low"));
        assert!(!child.turns_page.turns.is_empty());
        let binding = client
            .inner
            .bindings
            .read(&child.conversation.id)
            .await
            .unwrap()
            .unwrap();
        assert!(binding.history.is_empty());
        assert!(binding.switch.is_none());
        assert!(
            leader
                .requests("session/load")
                .iter()
                .all(|request| request["sessionId"] == child.conversation.id)
        );
        assert!(leader.requests("session/close").is_empty());
        assert!(before.same_revision(&client.read_fork_source(&parent.id, false).await.unwrap()));
        client.erase(&child.conversation.id).await.unwrap();
        assert!(memory.lock().unwrap().cwds.contains_key(&parent.id));
        assert!(
            !memory
                .lock()
                .unwrap()
                .cwds
                .contains_key(&child.conversation.id)
        );
        assert!(
            client
                .inner
                .bindings
                .read(&parent.id)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn forks_follow_moved_task_bindings_and_child_moves_keep_parent_ownership_separate() {
        let root = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(root.path());
        let (_leader, memory) = scripted_leader(bridges);
        client.watch();
        let parent = client
            .start_conversation("/source", &GrokTurnOptions::default())
            .await
            .unwrap();
        client
            .plan_switch(&parent.id, "/parent-worktree")
            .await
            .unwrap();
        wait_for_move(&client, &parent.id).await;
        let source = client.read_fork_source(&parent.id, false).await.unwrap();
        assert_ne!(source.conversation.id, parent.id);
        assert_eq!(source.conversation.cwd, "/parent-worktree");
        assert!(
            client
                .owns_fork_source(&parent.id, &source.conversation.id)
                .await
                .unwrap()
        );
        assert!(
            client
                .owns_fork_source(&parent.id, &parent.id)
                .await
                .unwrap()
        );
        let child = client
            .create_fork(&source, "/target", "Child")
            .await
            .unwrap();
        client
            .plan_switch(&child.conversation.id, "/child-worktree")
            .await
            .unwrap();
        wait_for_move(&client, &child.conversation.id).await;
        let moved = client
            .read_fork_source(&child.conversation.id, false)
            .await
            .unwrap();
        assert_eq!(moved.conversation.cwd, "/child-worktree");
        client.erase(&child.conversation.id).await.unwrap();
        let records = memory.lock().unwrap();
        assert!(records.cwds.contains_key(&parent.id));
        assert!(records.cwds.contains_key(&source.conversation.id));
        assert!(!records.cwds.contains_key(&child.conversation.id));
        assert!(!records.cwds.contains_key(&moved.conversation.id));
    }

    async fn wait_for_move(client: &GrokClient, id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let binding = client.inner.bindings.read(id).await.unwrap().unwrap();
                if binding.switch.is_none() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("native worktree switch completes");
    }

    #[tokio::test]
    async fn a_wrong_fork_identity_is_never_loaded_or_deleted() {
        let root = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(root.path());
        let (leader, memory) = scripted_leader_with(bridges, |method, params| {
            (method == "_x.ai/session/fork").then(|| MockAnswer::Result(json!({"newSessionId": params["sourceSessionId"], "newCwd":"/target", "parentSessionId":params["sourceSessionId"]})))
        });
        let parent = client
            .start_conversation("/source", &GrokTurnOptions::default())
            .await
            .unwrap();
        let source = client.read_fork_source(&parent.id, false).await.unwrap();
        assert!(
            client
                .create_fork(&source, "/target", "Fork")
                .await
                .is_err()
        );
        assert!(leader.requests("session/load").is_empty());
        assert!(
            leader
                .requests("_x.ai/session/delete")
                .iter()
                .all(|request| request["sessionId"] != parent.id)
        );
        assert!(memory.lock().unwrap().cwds.contains_key(&parent.id));
    }

    #[tokio::test]
    async fn an_incomplete_native_list_is_unavailable_not_a_missing_source() {
        let root = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(root.path());
        let (leader, _) = scripted_leader_with(bridges, |method, _| {
            (method == "session/list").then(|| {
                MockAnswer::Result(json!({
                    "sessions": [], "_meta": {"x.ai/partial": {"conversations": true}}
                }))
            })
        });
        assert!(
            matches!(client.read_fork_source(&Uuid::now_v7().to_string(), true).await,
            Err(AgentError::Failed(message)) if message.contains("complete session list"))
        );
        assert!(leader.requests("session/load").is_empty());
    }

    #[tokio::test]
    async fn an_external_record_is_resolved_without_loading_or_creating_a_binding() {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::now_v7().to_string();
        let wanted = id.clone();
        let (client, bridges) = GrokClient::mock(root.path());
        let (leader, _) = scripted_leader_with(bridges, move |method, _| {
            (method == "session/list").then(|| MockAnswer::Result(json!({"sessions":[{"sessionId":wanted,"cwd":"/external","title":"External session","updatedAt":"2026-11-02T00:00:00Z"}]})))
        });
        let source = client.read_fork_source(&id, true).await.unwrap();
        assert_eq!(source.conversation.cwd, "/external");
        assert_eq!(source.conversation.status, ThreadStatus::NotLoaded);
        assert!(client.inner.bindings.read(&id).await.unwrap().is_none());
        assert!(leader.requests("session/load").is_empty());
        assert!(leader.requests("session/new").is_empty());
    }
}
