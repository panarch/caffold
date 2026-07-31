use super::super::*;

pub(super) async fn app_state_with_codex_client(
    fs: RootedFs,
    client: CodexThreadClient,
) -> AppState {
    let (task_events, _) = broadcast::channel(256);
    let task_sync = TaskSyncCoordinator::new();
    let (task_sync_events, _) = broadcast::channel(64);
    let (task_list_removals, _) = broadcast::channel(64);
    let (task_list_updates, _) = broadcast::channel(64);
    let task_rollouts = task_rollout_monitor(task_sync.clone());
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
    let codex_threads = Arc::new(CodexThreadRuntime::default());
    {
        let mut runtime = codex_threads.state.lock().await;
        runtime.generation = 1;
        runtime.client = Some(client);
    }

    AppState {
        fs,
        server_settings: Arc::new(ServerSettingsStore::memory()),
        codex_threads,
        codex_sessions: CodexThreadSessions::default(),
        pending_approvals: Arc::new(AsyncMutex::new(HashMap::new())),
        task_events,
        task_sync,
        task_sync_events,
        task_list_removals,
        task_list_updates,
        thread_store: ThreadStore::memory().unwrap(),
        live_task_events: LiveTaskEventCache::default(),
        task_rollouts,
        watch_hub,
        shutdown,
        initial_path: String::new(),
        home_path: None,
    }
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

pub(super) async fn manage_test_thread(state: &AppState, thread_id: &str, cwd: &Path) {
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
