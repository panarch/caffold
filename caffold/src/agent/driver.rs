//! The agents Caffold can drive, and the questions it asks one.
//!
//! The set is closed on purpose. Caffold supports the agents it was built
//! against and loads nothing at run time, so an agent is a variant rather than
//! something reached behind a pointer. That choice is what turns a capability
//! one agent has and another lacks into a missing match arm — an error at every
//! place that has to decide — instead of a default quietly standing in.
//!
//! What is here is only what watching a conversation needs. Starting a turn,
//! answering an approval, reporting readiness, and resolving settings are still
//! each agent's own, reached through its own driver, because Caffold has not
//! yet watched two agents do them and would be guessing at the shared shape.
//!
//! The failures are still Codex's, for the same reason: sixty places across the
//! application read a `CodexThreadError` by variant, and giving the failures a
//! shared vocabulary is its own change rather than a detail of this one.

use std::collections::BTreeMap;

use serde_json::Value;

use super::codex::{CodexThreadClient, CodexThreadError, service_tier_for_fast_mode};
use super::{Conversation, TurnPage};

/// One agent, reached the way that agent is reached.
#[derive(Clone)]
pub(crate) enum Driver {
    Codex(CodexThreadClient),
}

/// A conversation as it stands, and the most recent of its turns.
///
/// An agent answers both in one exchange, because a conversation without its
/// last turns is not yet something a person can read.
pub(crate) struct OpenedConversation {
    pub(crate) conversation: Conversation,
    /// Absent when the turns were not asked for.
    pub(crate) turns_page: Option<TurnPage>,
    /// Where the agent is working, as the agent reports it.
    pub(crate) cwd: String,
    /// What the agent says its settings for this conversation are, in its own
    /// words. Caffold has not decided what a setting means across agents, so
    /// this crosses unread and the agent's own reader takes it from here.
    pub(crate) settings: BTreeMap<String, Value>,
}

impl Driver {
    /// Open a conversation, and watch it from here on.
    ///
    /// Opening is what starts the watching; there is no separate step, and
    /// [`Driver::stop_watching`] is what ends it. `with_turns` asks for the most
    /// recent turns in the same answer, which a reader about to show the
    /// conversation wants and a caller about to send a prompt does not.
    ///
    /// How fast the agent should work is Caffold's word for it. What that means
    /// to the agent — a service tier, a model, nothing at all — the agent
    /// decides.
    pub(crate) async fn open_conversation(
        &self,
        conversation_id: &str,
        with_turns: bool,
        fast_mode: bool,
    ) -> Result<OpenedConversation, CodexThreadError> {
        match self {
            Self::Codex(client) => {
                let response = client
                    .resume_thread_with_page(
                        conversation_id,
                        with_turns,
                        service_tier_for_fast_mode(fast_mode),
                    )
                    .await?;
                Ok(OpenedConversation {
                    conversation: Conversation::from(&response.thread),
                    turns_page: response.initial_turns_page.as_ref().map(TurnPage::from),
                    cwd: response.cwd,
                    settings: response.extra,
                })
            }
        }
    }

    /// Read a page of turns, continuing from a cursor the agent gave out.
    pub(crate) async fn read_turns(
        &self,
        conversation_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<TurnPage, CodexThreadError> {
        match self {
            Self::Codex(client) => Ok(TurnPage::from(
                &client
                    .list_thread_turns(conversation_id, cursor, limit)
                    .await?,
            )),
        }
    }

    /// Stop watching a conversation. It carries on without an audience.
    pub(crate) async fn stop_watching(
        &self,
        conversation_id: &str,
    ) -> Result<(), CodexThreadError> {
        match self {
            Self::Codex(client) => client.unsubscribe_thread(conversation_id).await.map(|_| ()),
        }
    }
}

impl CodexThreadClient {
    /// This client as the agent it drives.
    pub(crate) fn driver(&self) -> Driver {
        Driver::Codex(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::codex::MockCodexResponse;

    fn conversation_answer() -> Value {
        json!({
            "cwd": "/Users/example/project",
            "thread": {
                "id": "thread_1",
                "preview": "Task",
                "status": { "type": "idle" },
                "cwd": "/Users/example/project",
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "initialTurnsPage": {
                "data": [{
                    "id": "turn_1",
                    "items": [],
                    "itemsView": "full",
                    "status": "completed",
                    "startedAt": 1.0
                }],
                "nextCursor": "older-1",
                "backwardsCursor": null
            },
            "model": "gpt-5.6-sol"
        })
    }

    fn codex(responses: Vec<MockCodexResponse>) -> CodexThreadClient {
        CodexThreadClient::mock(responses)
    }

    #[tokio::test]
    async fn how_fast_to_work_reaches_the_agent_in_the_agents_own_terms() {
        // Fast mode is Caffold's word. Codex answers it with a service tier,
        // and deciding that is the driver's job rather than the caller's.
        for (fast_mode, tier) in [(true, "priority"), (false, "default")] {
            let client = codex(vec![MockCodexResponse::ok(
                "thread/resume",
                conversation_answer(),
            )]);

            client
                .driver()
                .open_conversation("thread_1", true, fast_mode)
                .await
                .expect("the conversation opens");

            let requests = client.mock_requests().await;
            assert_eq!(requests[0].0, "thread/resume");
            assert_eq!(
                requests[0].1["serviceTier"], tier,
                "fast mode {fast_mode} must reach Codex as the tier Codex calls it"
            );
        }
    }

    #[tokio::test]
    async fn a_caller_with_nothing_to_show_does_not_ask_for_the_turns() {
        // Sending a prompt needs the conversation, not its history. Asking for
        // turns nobody will read costs the person waiting for the prompt.
        let mut answer = conversation_answer();
        answer["initialTurnsPage"] = Value::Null;
        let client = codex(vec![MockCodexResponse::ok("thread/resume", answer)]);

        let opened = client
            .driver()
            .open_conversation("thread_1", false, false)
            .await
            .expect("the conversation opens");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].1["initialTurnsPage"], Value::Null);
        assert!(opened.turns_page.is_none());
    }

    #[tokio::test]
    async fn an_opened_conversation_arrives_in_caffolds_shape() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/resume",
            conversation_answer(),
        )]);

        let opened = client
            .driver()
            .open_conversation("thread_1", true, false)
            .await
            .expect("the conversation opens");

        assert_eq!(opened.conversation.id, "thread_1");
        assert_eq!(opened.cwd, "/Users/example/project");
        let page = opened.turns_page.expect("the turns were asked for");
        assert_eq!(page.turns.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("older-1"));
        // Settings cross unread: what a model or a permission mode means across
        // agents is not Caffold's to say yet.
        assert_eq!(opened.settings["model"], json!("gpt-5.6-sol"));
    }

    #[tokio::test]
    async fn reading_older_turns_carries_the_cursor_the_agent_gave_out() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/turns/list",
            json!({ "data": [], "nextCursor": null, "backwardsCursor": null }),
        )]);

        let page = client
            .driver()
            .read_turns("thread_1", Some("older-1"), 8)
            .await
            .expect("the turns are read");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].0, "thread/turns/list");
        assert_eq!(requests[0].1["cursor"], json!("older-1"));
        assert!(page.turns.is_empty());
    }

    #[tokio::test]
    async fn giving_up_the_audience_reaches_the_agent() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        )]);

        client
            .driver()
            .stop_watching("thread_1")
            .await
            .expect("watching stops");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].0, "thread/unsubscribe");
        assert_eq!(requests[0].1["threadId"], json!("thread_1"));
    }
}
