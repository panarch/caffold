//! Read-only fork sources and native child creation. A snapshot is evidence
//! for one request, never a second store of provider conversation history.

use std::path::PathBuf;

use super::codex::codex_mode_id;
use super::{AgentError, Conversation, Driver, TurnOptions, TurnPage};

/// A managed fork follows the Task's current session. A native fork keeps the supplied
/// session ID, including one left behind by a worktree switch.
#[derive(Clone, Copy)]
pub(crate) enum ForkSourceId<'a> {
    Task(&'a str),
    Native { id: &'a str, owner: Option<&'a str> },
}

impl<'a> ForkSourceId<'a> {
    pub(crate) fn id(self) -> &'a str {
        match self {
            Self::Task(id) | Self::Native { id, .. } => id,
        }
    }
}

pub(crate) struct ForkSource {
    pub(crate) conversation: Conversation,
    pub(crate) turns_page: Option<TurnPage>,
    pub(crate) settings: TurnOptions,
    pub(super) revision: ForkRevision,
}

#[derive(Debug, PartialEq)]
pub(super) enum ForkRevision {
    Codex(f64),
    Copilot {
        native_id: String,
        last_event: Option<String>,
    },
    Claude {
        path: PathBuf,
        fingerprint: u64,
    },
    Grok {
        session_id: String,
        cwd: String,
        updated_at: String,
        count: usize,
        last_event: Option<String>,
    },
}

impl ForkSource {
    pub(crate) fn same_revision(&self, other: &Self) -> bool {
        self.conversation.id == other.conversation.id
            && self.conversation.cwd == other.conversation.cwd
            && self.revision == other.revision
    }
}

pub(crate) struct ForkedConversation {
    pub(crate) conversation: Conversation,
    pub(crate) turns_page: TurnPage,
    pub(crate) settings: TurnOptions,
}

impl Driver {
    pub(crate) async fn read_fork_source(
        &self,
        source: ForkSourceId<'_>,
        with_turns: bool,
    ) -> Result<ForkSource, AgentError> {
        let id = source.id();
        match self {
            Self::Codex(client) => {
                let thread = client.read_thread(id).await?;
                let turns_page = if with_turns && thread.id == id {
                    Some(TurnPage::from(
                        &client.list_thread_turns(id, None, 4).await?,
                    ))
                } else {
                    None
                };
                Ok(ForkSource {
                    conversation: Conversation::from(&thread),
                    turns_page,
                    settings: TurnOptions::default(),
                    revision: ForkRevision::Codex(thread.updated_at),
                })
            }
            Self::Claude(claude) => {
                claude
                    .client
                    .read_fork_source(id, claude.config_dir.as_deref())
                    .await
            }
            Self::Copilot(client) => client.read_fork_source(source, with_turns).await,
            Self::Grok(client) => client.read_fork_source(source).await,
            Self::Antigravity(_) => Err(AgentError::Failed(
                "Antigravity conversation fork is not supported".into(),
            )),
        }
    }

    /// The provider verifies and cleans up its own unclaimed child. No caller
    /// deletes an unrecognised ID returned by a faulty native response.
    pub(crate) async fn create_fork(
        &self,
        source: &ForkSource,
        cwd: &str,
        title: &str,
        options: &TurnOptions,
    ) -> Result<ForkedConversation, AgentError> {
        match self {
            Self::Codex(client) => {
                let child = client.fork_thread(&source.conversation.id, cwd).await?;
                Ok(ForkedConversation {
                    conversation: Conversation::from(&child.thread),
                    turns_page: TurnPage::default(),
                    settings: TurnOptions {
                        model: child.model,
                        effort: child.reasoning_effort,
                        speed: child.speed,
                        permission_mode: child.permission_mode.map(codex_mode_id),
                    },
                })
            }
            Self::Claude(claude) => {
                claude
                    .client
                    .create_fork(source, cwd, claude.config_dir.as_deref(), title, options)
                    .await
            }
            Self::Copilot(client) => client.create_fork(source, cwd, title, options).await,
            Self::Grok(client) => client.create_fork(source, cwd, title).await,
            Self::Antigravity(_) => Err(AgentError::Failed(
                "Antigravity conversation fork is not supported".into(),
            )),
        }
    }
    /// Codex can leave history and naming until after the source recheck.
    /// Claude must name its child to persist it; Grok verifies its loaded child
    /// during creation. This never creates another native conversation.
    pub(crate) async fn finish_fork(
        &self,
        child: &mut ForkedConversation,
        title: &str,
    ) -> Result<(), AgentError> {
        match self {
            Self::Codex(client) => {
                child.turns_page = TurnPage::from(
                    &client
                        .list_thread_turns(&child.conversation.id, None, 8)
                        .await?,
                );
                client
                    .set_thread_name(&child.conversation.id, title)
                    .await?;
                child.conversation.title = Some(title.to_string());
                Ok(())
            }
            Self::Claude(_) | Self::Grok(_) | Self::Copilot(_) => Ok(()),
            Self::Antigravity(_) => Err(AgentError::Failed(
                "Antigravity conversation fork is not supported".into(),
            )),
        }
    }
}
