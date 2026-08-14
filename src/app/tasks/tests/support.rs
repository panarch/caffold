use std::{path::Path, sync::Arc, time::Duration};

use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

use super::super::{TaskState, projection::*, routes::test_claim_task};
use crate::{codex_app_server::CodexThreadClient, fs::RootedFs, task_store::TaskStore};

pub(in crate::app::tasks) async fn task_state_with_codex_client(
    fs: RootedFs,
    client: CodexThreadClient,
) -> TaskState {
    let (shutdown, _) = broadcast::channel(16);
    let worktree_root = fs.root().join(".caffold-test/worktrees");
    let state = TaskState::new(
        Arc::new(fs),
        String::new(),
        shutdown,
        TaskStore::memory().expect("in-memory task store"),
        worktree_root,
    )
    .expect("task state");
    state.codex_runtime.install_test_client(1, client).await;
    state
}

pub(in crate::app::tasks) async fn wait_for_mock_method(client: &CodexThreadClient, method: &str) {
    wait_for_mock_method_count(client, method, 1).await;
}

pub(in crate::app::tasks) async fn wait_for_mock_method_count(
    client: &CodexThreadClient,
    method: &str,
    expected: usize,
) {
    for _ in 0..100 {
        if client
            .mock_requests()
            .await
            .iter()
            .filter(|(requested, _)| requested == method)
            .count()
            >= expected
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("mock Codex client did not receive {expected} {method} request(s)");
}

pub(in crate::app::tasks) fn task_thread_list(thread_id: &str, cwd: &Path) -> JsonValue {
    json!({
        "data": [{
            "id": thread_id,
            "preview": "Cached task detail regression",
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": []
        }],
        "nextCursor": null,
        "backwardsCursor": null
    })
}

pub(in crate::app::tasks) async fn manage_test_thread(
    state: &TaskState,
    thread_id: &str,
    cwd: &Path,
) {
    let thread = task_thread_list(thread_id, cwd)["data"][0].clone();
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let task =
        task_record_from_thread(&thread, &[], resolved.as_ref()).expect("test thread projection");
    test_claim_task(state, &task)
        .await
        .expect("test thread is managed");
}

pub(in crate::app::tasks) async fn cache_and_manage_test_thread(
    state: &TaskState,
    thread_id: &str,
    cwd: &Path,
) {
    let thread = serde_json::from_value(task_thread_list(thread_id, cwd)["data"][0].clone())
        .expect("canonical test thread");
    state.codex_sessions.observe_thread_metadata(thread).await;
    manage_test_thread(state, thread_id, cwd).await;
}

pub(in crate::app::tasks) fn resumed_task(thread_id: &str, cwd: &Path) -> JsonValue {
    json!({
        "thread": {
            "id": thread_id,
            "preview": "Cached task detail regression",
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": []
        },
        "initialTurnsPage": {
            "data": [],
            "nextCursor": null,
            "backwardsCursor": null
        }
    })
}
