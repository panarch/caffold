use super::super::*;

pub(super) async fn task_state_with_codex_client(
    fs: RootedFs,
    client: CodexThreadClient,
) -> TaskState {
    let (shutdown, _) = broadcast::channel(16);
    let state = TaskState::new(
        Arc::new(fs),
        String::new(),
        shutdown,
        ThreadStore::memory().expect("in-memory thread store"),
    );
    {
        let mut runtime = state.codex_threads.state.lock().await;
        runtime.generation = 1;
        runtime.client = Some(client);
    }
    state
}

pub(super) async fn wait_for_mock_method(client: &CodexThreadClient, method: &str) {
    wait_for_mock_method_count(client, method, 1).await;
}

pub(super) async fn wait_for_mock_method_count(
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

pub(super) fn task_thread_list(thread_id: &str, cwd: &Path) -> JsonValue {
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

pub(super) async fn manage_test_thread(state: &TaskState, thread_id: &str, cwd: &Path) {
    let thread = task_thread_list(thread_id, cwd)["data"][0].clone();
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let task =
        task_record_from_thread(&thread, &[], resolved.as_ref()).expect("test thread projection");
    thread_store_claim(state, managed_thread_from_task_record(&task, None, None))
        .await
        .expect("test thread is managed");
}

pub(super) fn resumed_task(thread_id: &str, cwd: &Path) -> JsonValue {
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
