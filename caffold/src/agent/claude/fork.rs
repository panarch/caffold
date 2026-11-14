//! Fork through Claude's native CLI. Merely initializing a fork does not
//! persist it: the native local `/rename` command gives it its real title and
//! commits the inherited transcript, without sending a prompt to a model.

use serde::Deserialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::Path,
};
use uuid::Uuid;

use super::{ClaudeClient, ClaudeTurnOptions, session::SessionStart, transcript};
use crate::agent::{
    AgentError, Conversation, ItemKind, ThreadStatus, TurnOptions,
    fork::{ForkRevision, ForkSource, ForkedConversation},
};

impl ClaudeClient {
    /// The conversation `id` as Claude keeps it under `config_dir`.
    pub(crate) async fn read_fork_source(
        &self,
        id: &str,
        config_dir: Option<&str>,
    ) -> Result<ForkSource, AgentError> {
        Uuid::parse_str(id)
            .map_err(|_| AgentError::Failed("A Claude Session ID must be a UUID".into()))?;
        let projects = self.projects(config_dir).ok_or_else(|| {
            AgentError::Failed("Cannot locate Claude's projects directory".into())
        })?;
        let wanted = id.to_string();
        let mut source = tokio::task::spawn_blocking(move || read_source(&projects, &wanted))
            .await
            .map_err(|error| AgentError::Failed(error.to_string()))??;
        if let Some(live) = self.watched_conversation(id).await {
            source.conversation.status = live.status;
            source.conversation.background_work = live.background_work;
            let known = self
                .driver(&source.conversation.cwd, config_dir.map(str::to_string))
                .read_settings(&self.settings_of(id).await);
            source.settings = TurnOptions {
                model: known.model.or(source.settings.model),
                ..known
            };
        }
        Ok(source)
    }

    /// Fork `source` into `cwd`. Claude copies the transcript within one
    /// config directory, so `config_dir` is the one the source was read from.
    pub(crate) async fn create_fork(
        &self,
        source: &ForkSource,
        cwd: &str,
        config_dir: Option<&str>,
        title: &str,
        options: &TurnOptions,
    ) -> Result<ForkedConversation, AgentError> {
        let ForkRevision::Claude { path, .. } = &source.revision else {
            return Err(AgentError::Failed(
                "The fork source belongs to another provider".into(),
            ));
        };
        let id = Uuid::now_v7().to_string();
        let options = ClaudeTurnOptions {
            model: options.model.clone(),
            effort: options.effort.clone(),
            fast_mode: options.fast_mode,
            permission_mode: super::claude_permission_mode(options.permission_mode.as_deref())
                .map(str::to_string),
        };
        let result = async {
            let session = self
                .open_session(&id, cwd, config_dir, SessionStart::Fork(path), &options)
                .await?;
            self.apply_settings(&session, &options).await?;
            // Titles are one native command argument, never additional lines.
            let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
            self.ask_quietly(&session, &format!("/rename {title}"))
                .await?;
            let child = self.read_fork_source(&id, config_dir).await?;
            if child.conversation.cwd != cwd || !self.was_written_down(cwd, config_dir, &id).await {
                return Err(AgentError::Failed(
                    "Claude did not persist the fork in its target directory".into(),
                ));
            }
            let mut conversation = self.conversation_of(&session).await;
            if conversation.id != id || conversation.cwd != cwd {
                return Err(AgentError::Failed(
                    "Claude returned a different fork identity or directory".into(),
                ));
            }
            conversation.title = Some(title);
            conversation.preview = child.conversation.preview;
            Ok(ForkedConversation {
                conversation,
                turns_page: child.turns_page.unwrap_or_default(),
                settings: self
                    .driver(cwd, config_dir.map(str::to_string))
                    .read_settings(&self.settings_of(&id).await),
            })
        }
        .await;
        if result.is_err()
            && let Err(error) = self.erase(&id, cwd, config_dir).await
        {
            eprintln!("failed to delete unclaimed Claude fork {id}: {error}");
        }
        result
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    message: Option<Model>,
}

#[derive(Deserialize)]
struct Model {
    #[serde(default)]
    model: Option<String>,
}

fn read_source(projects: &Path, id: &str) -> Result<ForkSource, AgentError> {
    let path = transcript::find(projects, id).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AgentError::ConversationGone(id.into())
        } else {
            history_error(error)
        }
    })?;
    let file = fs::File::open(&path).map_err(history_error)?;
    let mut fingerprint = DefaultHasher::new();
    let mut cwd = None;
    let mut title = None;
    let mut model = None;
    let mut identified = false;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(history_error)?;
        line.hash(&mut fingerprint);
        if line.trim().is_empty() {
            continue;
        }
        let row: Metadata = serde_json::from_str(&line).map_err(history_error)?;
        if let Some(session) = &row.session_id {
            if session != id {
                return Err(AgentError::Failed(
                    "Claude's transcript has a different session identity".into(),
                ));
            }
            identified = true;
        }
        cwd = row.cwd.or(cwd);
        title = row.custom_title.or(title);
        model = row.message.and_then(|message| message.model).or(model);
    }
    if !identified {
        return Err(AgentError::Failed(
            "Claude's transcript has no session identity".into(),
        ));
    }
    let cwd = cwd
        .filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or_else(|| {
            AgentError::Failed("Claude's transcript has no absolute working directory".into())
        })?;
    let reading = transcript::read(&path, None, 8).map_err(history_error)?;
    if reading.unreadable != 0 {
        return Err(AgentError::Failed(
            "Claude's transcript contains unreadable messages".into(),
        ));
    }
    let preview = reading
        .page
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .find_map(|item| match &item.kind {
            ItemKind::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let updated_at_ms = fs::metadata(&path)
        .map_err(history_error)?
        .modified()
        .map_err(history_error)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(history_error)?
        .as_millis() as u64;
    Ok(ForkSource {
        conversation: Conversation {
            id: id.into(),
            title,
            preview,
            status: ThreadStatus::NotLoaded,
            background_work: false,
            cwd,
            transcript_path: Some(path.to_string_lossy().into_owned()),
            created_at_ms: updated_at_ms,
            updated_at_ms,
            recency_at_ms: Some(updated_at_ms),
            turns: Vec::new(),
        },
        turns_page: Some(reading.page),
        settings: TurnOptions {
            model,
            ..TurnOptions::default()
        },
        revision: ForkRevision::Claude {
            path,
            fingerprint: fingerprint.finish(),
        },
    })
}

fn history_error(error: impl std::fmt::Display) -> AgentError {
    AgentError::Failed(format!("Cannot read Claude's fork source: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn transcript(id: &str, cwd: &str) -> String {
        [json!({"type":"user","uuid":"prompt-1","sessionId":id,"cwd":cwd,"promptSource":"sdk","timestamp":"2026-11-02T00:00:00Z","message":{"role":"user","content":"Preserve this conversation"}}),
         json!({"type":"assistant","uuid":"answer-1","parentUuid":"prompt-1","sessionId":id,"cwd":cwd,"timestamp":"2026-11-02T00:00:01Z","message":{"id":"answer-1","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Remembered"}]}})]
            .into_iter().map(|row| format!("{row}\n")).collect()
    }

    #[tokio::test]
    async fn source_lookup_is_read_only_and_rejects_duplicate_or_damaged_history() {
        let root = tempfile::tempdir().unwrap();
        let (client, _) = ClaudeClient::mock_writing_to(root.path().into());
        let id = Uuid::now_v7().to_string();
        let contents = transcript(&id, "/source");
        client.write_test_transcript("/source", &id, &contents);
        let source = client.read_fork_source(&id, None).await.unwrap();
        assert_eq!(source.conversation.cwd, "/source");
        assert_eq!(source.conversation.status, ThreadStatus::NotLoaded);
        assert_eq!(source.turns_page.as_ref().unwrap().turns.len(), 1);
        assert!(client.inner.sessions.lock().await.is_empty());
        client.write_test_transcript("/duplicate", &id, &contents);
        assert!(client.read_fork_source(&id, None).await.is_err());
        fs::remove_file(transcript::locate(root.path(), "/duplicate", &id).unwrap()).unwrap();
        client.write_test_transcript("/source", &id, "not-json\n");
        assert!(client.read_fork_source(&id, None).await.is_err());
    }

    #[tokio::test]
    async fn native_fork_arguments_persist_a_distinct_child_before_returning() {
        let root = tempfile::tempdir().unwrap();
        let (client, runner) = ClaudeClient::mock_writing_to(root.path().into());
        let id = Uuid::now_v7().to_string();
        let contents = transcript(&id, "/source");
        client.write_test_transcript("/source", &id, &contents);
        let source = client.read_fork_source(&id, None).await.unwrap();
        let forker = client.clone();
        let child = tokio::spawn(async move {
            forker
                .create_fork(&source, "/target", None, "Fork of source", &source.settings)
                .await
        });
        let child_id = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(id) = client.inner.sessions.lock().await.keys().next().cloned()
                    && runner
                        .heard(&id)
                        .await
                        .iter()
                        .any(|frame| frame["type"] == "user")
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let spawn = runner.spawned(&child_id).await.unwrap();
        assert!(spawn.argv.iter().any(|arg| arg == "--fork-session"));
        assert!(
            spawn
                .argv
                .windows(2)
                .any(|args| args == ["--session-id", &child_id])
        );
        assert_eq!(spawn.cwd, "/target");
        assert!(
            runner
                .heard(&child_id)
                .await
                .iter()
                .any(|frame| frame["message"]["content"][0]["text"] == "/rename Fork of source")
        );
        client.write_test_transcript("/target", &child_id, &transcript(&child_id, "/target"));
        runner
            .say(
                &child_id,
                json!({"type":"result","subtype":"success","is_error":false,"result":"Renamed"}),
            )
            .await;
        let child = child.await.unwrap().unwrap();
        assert_eq!(child.conversation.id, child_id);
        assert_eq!(child.turns_page.turns.len(), 1);
        assert_eq!(
            fs::read_to_string(transcript::locate(root.path(), "/source", &id).unwrap()).unwrap(),
            contents
        );
        client.erase(&child_id, "/target", None).await.unwrap();
        assert!(client.was_written_down("/source", None, &id).await);
        assert!(!client.was_written_down("/target", None, &child_id).await);
    }
}
