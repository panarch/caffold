use super::membership::task_store_join_error;
use super::store::task_store_api_error;
use crate::{
    agent::{Conversation, ThreadStatus},
    app::{
        error::ApiError,
        tasks::{
            TaskState,
            sections::{Reconnection, SectionDirectories, SectionDirectory},
        },
    },
    task_store::{ManagedThread, TaskStoreError},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use std::{path::PathBuf, sync::Arc};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReconnectRequest {
    expected_path: String,
    path: String,
}

pub(super) async fn directory(
    State(state): State<TaskState>,
    Path(id): Path<String>,
) -> Result<Json<SectionDirectory>, ApiError> {
    let directories = state.section_directories;
    tokio::task::spawn_blocking(move || directories.read(&id))
        .await
        .map_err(task_store_join_error)?
        .map(Json)
}

pub(super) async fn reconnect(
    State(state): State<TaskState>,
    Path(id): Path<String>,
    Json(request): Json<ReconnectRequest>,
) -> Result<Json<SectionDirectory>, ApiError> {
    // Keep accepted filesystem/store work alive when its HTTP caller leaves.
    tokio::spawn(reconnect_owned(state, id, request))
        .await
        .map_err(task_store_join_error)?
}

async fn reconnect_owned(
    state: TaskState,
    id: String,
    request: ReconnectRequest,
) -> Result<Json<SectionDirectory>, ApiError> {
    let _reconnect = state.section_directories.reserve().await;
    let Some(initial) = prepare(&state.section_directories, &id, &request).await? else {
        return directory(State(state), Path(id)).await;
    };
    let threads = initial.threads();
    let mut mutations = Vec::new();
    for thread in &threads {
        mutations.push(state.task_sessions.reserve_mutation(thread).await);
    }
    let plan = Arc::new(
        prepare(&state.section_directories, &id, &request)
            .await?
            .ok_or_else(changed)?,
    );
    if plan.threads() != threads {
        return Err(changed());
    }
    for thread in &plan.active_threads {
        let store = state.task_store.clone();
        let thread_id = thread.clone();
        let managed = tokio::task::spawn_blocking(move || store.get(&thread_id))
            .await
            .map_err(task_store_join_error)?
            .map_err(task_store_api_error)?
            .ok_or_else(changed)?;
        if let Err(error) = reconnect_active_task(&state, plan.clone(), &managed).await {
            // Earlier native/store repairs are durable; their Task rows remain
            // usable even while the Section still points to its old folder.
            state.task_list_events.refresh();
            let mut body = error.into_error_body();
            body.message = format!(
                "{}: {} Changes already made are kept. Resolve the problem and reconnect to the same folder.",
                managed.display_name, body.message
            );
            return Err(ApiError::Diagnostic(body));
        }
    }
    reconnect_archived(&state, plan.clone()).await;
    let plan = prepare(&state.section_directories, &id, &request)
        .await?
        .ok_or_else(changed)?;
    if plan.threads() != threads {
        return Err(changed());
    }
    let directories = state.section_directories.clone();
    let result = tokio::task::spawn_blocking(move || directories.apply(plan))
        .await
        .map_err(task_store_join_error)??;
    state.task_list_events.refresh();
    Ok(Json(result))
}

async fn reconnect_active_task(
    state: &TaskState,
    plan: Arc<Reconnection>,
    managed: &ManagedThread,
) -> Result<(), ApiError> {
    let thread = &managed.thread_id;
    let agent = state.task_runtime.agent_for(managed).await?;
    let driver = agent.driver();
    let direct = plan
        .direct_tasks
        .iter()
        .any(|task| &task.thread_id == thread);
    ensure_not_running(state, thread).await?;
    let known_destination = managed
        .run_by
        .cwd()
        .and_then(|cwd| plan.destination_for(cwd));
    let observed = if direct && (managed.run_by.cwd().is_none() || known_destination.is_some()) {
        let destination = rooted_destination(
            state,
            known_destination.unwrap_or_else(|| plan.target.clone()),
        )
        .await?;
        driver
            .prepare_directory_reconnection(thread, &destination)
            .await?
    } else {
        driver.describe(thread).await?
    };
    let mut viewer = None;
    let conversation = match observed {
        Some(conversation)
            if direct
                && conversation.status == ThreadStatus::NotLoaded
                && plan.destination_for(&conversation.cwd).is_some() =>
        {
            conversation
        }
        Some(conversation) if conversation.status != ThreadStatus::NotLoaded => conversation,
        _ => {
            viewer = Some(
                state
                    .task_sessions
                    .acquire_viewer(&driver, agent.generation(), thread)
                    .await?,
            );
            state
                .task_sessions
                .snapshot(thread)
                .await
                .and_then(|snapshot| snapshot.conversation)
                .ok_or_else(|| ApiError::Unavailable {
                    code: "section_reconnect_status_unavailable",
                    message: "The Task's current state could not be confirmed.".into(),
                })?
        }
    };
    if matches!(conversation.status, ThreadStatus::Active { .. })
        || (!direct && conversation.status == ThreadStatus::NotLoaded)
    {
        return Err(busy());
    }
    ensure_not_running(state, thread).await?;
    if direct {
        if let Some(destination) = plan.destination_for(&conversation.cwd) {
            let destination = rooted_destination(state, destination).await?;
            let conversation = driver
                .move_working_directory(thread, &destination, managed.fast_mode)
                .await?;
            verify_move(thread, &destination, &conversation)?;
            save_directory(state, managed, &destination).await?;
            state
                .task_sessions
                .observe_thread_metadata(conversation)
                .await;
        }
    } else {
        let directories = state.section_directories.clone();
        let thread_id = thread.clone();
        tokio::task::spawn_blocking(move || {
            directories.reconnect_active_worktree(&plan, &thread_id)
        })
        .await
        .map_err(task_store_join_error)??;
    }
    drop(viewer);
    Ok(())
}

async fn reconnect_archived(state: &TaskState, plan: Arc<Reconnection>) {
    let store = state.task_store.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        let tasks = store.list_archived(None, usize::MAX)?.0;
        Ok::<_, TaskStoreError>((tasks, store.managed_worktrees()?))
    })
    .await;
    let (tasks, worktrees) = match snapshot {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(error)) => {
            eprintln!("could not inspect archived Tasks during Section reconnection: {error}");
            return;
        }
        Err(error) => {
            eprintln!("could not inspect archived Tasks during Section reconnection: {error}");
            return;
        }
    };
    let directories = state.section_directories.clone();
    let archived_plan = plan.clone();
    match tokio::task::spawn_blocking(move || directories.archived_worktrees(&archived_plan)).await
    {
        Ok(Ok(records)) => {
            for record in records {
                let _mutation = match &record.thread_id {
                    Some(id) => Some(state.task_sessions.reserve_mutation(id).await),
                    None => None,
                };
                let name = tasks
                    .iter()
                    .find(|task| record.thread_id.as_deref() == Some(task.thread_id.as_str()))
                    .map(|task| task.display_name.clone())
                    .unwrap_or_else(|| record.worktree_id.clone());
                let directories = state.section_directories.clone();
                let archived_plan = plan.clone();
                let result = tokio::task::spawn_blocking(move || {
                    directories.reconnect_archived_worktree(&archived_plan, &record)
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        eprintln!("could not reconnect archived worktree {name}: {error}")
                    }
                    Err(error) => {
                        eprintln!("could not reconnect archived worktree {name}: {error}")
                    }
                }
            }
        }
        Ok(Err(error)) => {
            eprintln!("could not inspect archived worktrees during Section reconnection: {error}")
        }
        Err(error) => {
            eprintln!("could not inspect archived worktrees during Section reconnection: {error}")
        }
    }
    for managed in tasks {
        if worktrees
            .iter()
            .any(|record| record.thread_id.as_deref() == Some(managed.thread_id.as_str()))
        {
            continue;
        }
        if managed
            .run_by
            .cwd()
            .is_some_and(|cwd| plan.destination_for(cwd).is_none())
        {
            continue;
        }
        let _mutation = state
            .task_sessions
            .reserve_mutation(&managed.thread_id)
            .await;
        if let Err(error) = reconnect_archived_task(state, &plan, &managed).await {
            eprintln!(
                "could not reconnect archived Task {}: {error}",
                managed.thread_id
            );
        }
    }
}

async fn reconnect_archived_task(
    state: &TaskState,
    plan: &Reconnection,
    managed: &ManagedThread,
) -> Result<(), ApiError> {
    let store = state.task_store.clone();
    let thread = managed.thread_id.clone();
    let current = tokio::task::spawn_blocking(move || {
        store.read(|tables| tables.archived_managed_thread(&thread))
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)?;
    if current.as_ref() != Some(managed) {
        return Err(changed());
    }
    ensure_not_running(state, &managed.thread_id).await?;
    let agent = state.task_runtime.agent_for(managed).await?;
    let driver = agent.driver();
    let described = driver.describe(&managed.thread_id).await?;
    if described
        .as_ref()
        .is_some_and(|conversation| matches!(conversation.status, ThreadStatus::Active { .. }))
    {
        return Err(busy());
    }
    let cwd = described
        .as_ref()
        .map(|conversation| conversation.cwd.as_str())
        .or(managed.run_by.cwd());
    let Some(destination) = cwd.and_then(|cwd| plan.destination_for(cwd)) else {
        return Ok(());
    };
    let destination = rooted_destination(state, destination).await?;
    let conversation = driver
        .reconnect_archived_directory(&managed.thread_id, &destination, managed.fast_mode)
        .await?;
    verify_move(&managed.thread_id, &destination, &conversation)?;
    save_directory(state, managed, &destination).await?;
    Ok(())
}

async fn save_directory(
    state: &TaskState,
    managed: &ManagedThread,
    cwd: &str,
) -> Result<(), ApiError> {
    let directories = state.section_directories.clone();
    let (managed, cwd) = (managed.clone(), cwd.to_string());
    tokio::task::spawn_blocking(move || directories.reconnect_thread(&managed, &cwd))
        .await
        .map_err(task_store_join_error)?
}

fn verify_move(
    thread: &str,
    destination: &str,
    conversation: &Conversation,
) -> Result<(), ApiError> {
    if conversation.id != thread
        || conversation.cwd != destination
        || matches!(
            conversation.status,
            ThreadStatus::Active { .. } | ThreadStatus::NotLoaded
        )
    {
        return Err(ApiError::Conflict {
            code: "section_reconnect_conflict",
            message: "The Agent did not confirm the same idle Task in the selected folder.".into(),
        });
    }
    Ok(())
}

async fn ensure_not_running(state: &TaskState, thread: &str) -> Result<(), ApiError> {
    if state
        .task_sessions
        .snapshot(thread)
        .await
        .is_some_and(|snapshot| snapshot.active_turn_id.is_some())
    {
        return Err(busy());
    }
    Ok(())
}

fn busy() -> ApiError {
    ApiError::Conflict {
        code: "section_reconnect_busy",
        message:
            "Finish running Tasks before reconnecting this Section. Their state must be available."
                .into(),
    }
}

fn changed() -> ApiError {
    ApiError::Conflict {
        code: "section_reconnect_conflict",
        message: "The Section or its Tasks changed. Check again.".into(),
    }
}

async fn rooted_destination(state: &TaskState, path: PathBuf) -> Result<String, ApiError> {
    let fs = state.fs.clone();
    let destination = tokio::task::spawn_blocking(move || {
        let logical = fs.logical_path_for_absolute(&path)?;
        fs.absolute_directory_path(&logical)
    })
    .await
    .map_err(task_store_join_error)??;
    Ok(destination.to_string_lossy().into_owned())
}

async fn prepare(
    directories: &SectionDirectories,
    id: &str,
    request: &ReconnectRequest,
) -> Result<Option<Reconnection>, ApiError> {
    let directories = directories.clone();
    let (id, expected, path) = (
        id.to_string(),
        request.expected_path.clone(),
        request.path.clone(),
    );
    tokio::task::spawn_blocking(move || directories.prepare(&id, &expected, &path))
        .await
        .map_err(task_store_join_error)?
}

#[cfg(test)]
mod tests {
    use super::super::{
        router,
        test_support::{claim_cached_active, initialize_git_repository},
    };
    use super::*;
    use crate::{
        agent::codex::{CodexThreadClient, MockCodexResponse},
        app::tasks::{active_list, test_support::task_state_with_codex_client},
        fs::RootedFs,
        git,
        task_store::{ManagedWorktree, ManagedWorktreeState},
    };
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use std::{fs, path::PathBuf};
    use tower::ServiceExt;

    async fn fixture(
        status: &str,
    ) -> (tempfile::TempDir, TaskState, PathBuf, Vec<ManagedWorktree>) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("source");
        initialize_git_repository(&source);
        let responses = ["one", "two"].map(|id| MockCodexResponse::ok("thread/read", json!({
            "thread": { "id": id, "preview": id, "status": { "type": status }, "cwd": source,
                "createdAt": 1.0, "updatedAt": 1.0, "turns": [] }
        })));
        let state = task_state_with_codex_client(
            RootedFs::new(&root).unwrap(),
            CodexThreadClient::mock(Vec::from(responses)),
        )
        .await;
        let mut records = Vec::new();
        for (index, thread) in ["one", "two", "archived"].into_iter().enumerate() {
            claim_cached_active(&state, thread, thread, 1, "section", "source");
            let id = format!("00000000-0000-4000-8000-{:012}", index + 1);
            let target = root.join(".caffold-test/worktrees").join(&id);
            let checkout = git::create_attached_worktree(&source, &target, thread, None).unwrap();
            records.push(
                state
                    .task_store
                    .create_worktree(ManagedWorktree {
                        worktree_id: id,
                        thread_id: Some(thread.to_string()),
                        repository_git_dir: checkout.common_dir.display().to_string(),
                        worktree_path: checkout.path.display().to_string(),
                        state: ManagedWorktreeState::Ready,
                        checkout_anchor: None,
                        created_at_ms: 1,
                        updated_at_ms: 1,
                    })
                    .unwrap(),
            );
        }
        state
            .lifecycle
            .archive_worktree("archived".to_string())
            .await
            .unwrap();
        state.task_store.archive("archived", 2).unwrap();
        records[2] = state
            .task_store
            .worktree_for_thread("archived")
            .unwrap()
            .unwrap();
        (temp, state, source, records)
    }

    async fn post(state: &TaskState, expected: &str, path: &str) -> (u16, Value) {
        let response = router(state.clone())
            .oneshot(
                Request::post("/api/tasks/sections/section/reconnect")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"expectedPath": expected, "path": path}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn reconnect_keeps_successful_active_repairs_when_a_later_task_fails_and_can_retry() {
        use crate::app::tasks::test_support::resumed_task;

        let (_temp, state, source, records) = fixture("idle").await;
        let moved = state.fs.root().join("moved");
        fs::rename(&source, &moved).unwrap();
        let response = |id: &str, status: &str| {
            let mut value = resumed_task(id, &PathBuf::from(&records[0].worktree_path));
            value["thread"]["status"] = json!({"type": status});
            MockCodexResponse::ok("thread/read", value)
        };
        state
            .task_runtime
            .install_test_client(
                2,
                CodexThreadClient::mock(vec![
                    response("one", "idle"),
                    response("two", "active"),
                    response("one", "idle"),
                    response("two", "idle"),
                ]),
            )
            .await;
        let second_marker =
            fs::read(PathBuf::from(&records[1].worktree_path).join(".git")).unwrap();

        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 409, "{body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("two:")
        );
        assert_eq!(
            state.section_directories.read("section").unwrap().path,
            "source"
        );
        let repaired = state
            .task_store
            .worktree_for_thread("one")
            .unwrap()
            .unwrap();
        assert_eq!(
            repaired.repository_git_dir,
            moved.join(".git").to_string_lossy()
        );
        git::inspect_attached_worktree(
            PathBuf::from(&repaired.worktree_path).as_path(),
            &moved.join(".git"),
            None,
        )
        .unwrap();
        assert_eq!(
            state.task_store.worktree_for_thread("two").unwrap(),
            Some(records[1].clone())
        );
        assert_eq!(
            fs::read(PathBuf::from(&records[1].worktree_path).join(".git")).unwrap(),
            second_marker
        );

        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            state.section_directories.read("section").unwrap().path,
            "moved"
        );
    }

    #[tokio::test]
    async fn reconnect_archived_direct_codex_tasks_preserves_membership_without_blocking() {
        use crate::{
            agent::codex::CodexThreadError,
            app::tasks::{routes::test_support::seed_section, test_support::resumed_task},
        };

        for fails in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let source = root.join("source");
            let moved = root.join("moved");
            fs::create_dir(&source).unwrap();
            let mut responses = vec![
                MockCodexResponse::ok("thread/read", resumed_task("archived", &source)),
                MockCodexResponse::ok("thread/unarchive", resumed_task("archived", &source)),
                MockCodexResponse::ok("thread/resume", resumed_task("archived", &source)),
            ];
            if fails {
                responses.push(MockCodexResponse::error(
                    "thread/settings/update",
                    CodexThreadError::Protocol("settings unavailable".into()),
                ));
            } else {
                responses.push(MockCodexResponse::ok("thread/settings/update", json!({})));
                responses.push(MockCodexResponse::ok(
                    "thread/resume",
                    resumed_task("archived", &moved),
                ));
            }
            responses.push(MockCodexResponse::ok("thread/archive", json!({})));
            let client = CodexThreadClient::mock(responses);
            let state =
                task_state_with_codex_client(RootedFs::new(&root).unwrap(), client.clone()).await;
            seed_section(&state, "section", "source");
            claim_cached_active(
                &state,
                "archived",
                "Archived direct Task",
                1,
                "section",
                "source",
            );
            let archived = state.task_store.archive("archived", 2).unwrap().unwrap();
            fs::rename(&source, &moved).unwrap();

            let (status, body) = post(&state, "source", "moved").await;
            assert_eq!(status, 200, "fails={fails}: {body}");
            assert_eq!(body["path"], "moved");
            assert_eq!(
                state.task_store.get_archived("archived").unwrap(),
                Some(archived)
            );
            assert!(state.task_store.get("archived").unwrap().is_none());
            assert!(body.get("archivedWarnings").is_none());
            let methods = client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>();
            assert_eq!(
                methods.last().unwrap(),
                "thread/archive",
                "native archive is restored even when moving fails"
            );
            assert!(
                !methods
                    .iter()
                    .any(|method| method == "thread/list" || method == "thread/start")
            );
        }
    }

    #[tokio::test]
    async fn reconnect_archived_only_worktree_failure_does_not_block_a_plain_folder() {
        let (_temp, state, source, records) = fixture("idle").await;
        for record in &records[..2] {
            let id = record.thread_id.as_ref().unwrap();
            state
                .lifecycle
                .force_archive_worktree(id.clone(), record.worktree_id.clone())
                .await
                .unwrap();
            state.task_store.archive(id, 2).unwrap();
        }
        fs::rename(&source, state.fs.root().join("old-repository")).unwrap();
        fs::create_dir(state.fs.root().join("moved")).unwrap();
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert!(body.get("archivedWarnings").is_none());
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/unarchive",
                crate::app::tasks::test_support::resumed_task("archived", &source),
            ),
            MockCodexResponse::ok("thread/archive", json!({})),
        ]);
        state
            .task_runtime
            .install_test_client(2, client.clone())
            .await;
        let response = router(state.clone())
            .oneshot(
                Request::post("/api/tasks/archived/restore")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!response.status().is_success());
        let error: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert!(
            error["error"]["message"].as_str().unwrap().contains("Git"),
            "{error}"
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/unarchive", "thread/archive"]
        );
        assert!(state.task_store.get_archived("archived").unwrap().is_some());
        assert!(state.task_store.get("archived").unwrap().is_none());
    }

    #[tokio::test]
    async fn reconnect_section_without_worktrees_accepts_plain_and_git_directories() {
        use super::super::test_support::seed_section;

        for repository in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let source = root.join("source");
            if repository {
                initialize_git_repository(&source);
            } else {
                fs::create_dir(&source).unwrap();
            }
            fs::write(source.join("keep.txt"), "unchanged").unwrap();
            let state = task_state_with_codex_client(
                RootedFs::new(&root).unwrap(),
                CodexThreadClient::mock(Vec::new()),
            )
            .await;
            seed_section(&state, "section", "source");
            fs::rename(source, root.join("moved")).unwrap();

            let observation = state.section_directories.read("section").unwrap();
            assert!(observation.reconnect_unavailable_reason.is_none());
            let (status, body) = post(&state, "source", "moved").await;
            assert_eq!(status, 200, "repository={repository}: {body}");
            assert_eq!(body["sectionId"], "section");
            assert_eq!(body["path"], "moved");
            assert_eq!(body["directory"]["status"], "available");
            assert_eq!(
                fs::read_to_string(root.join("moved/keep.txt")).unwrap(),
                "unchanged"
            );
            assert_eq!(post(&state, "source", "moved").await.0, 200);
            assert!(!root.join("source").exists());
        }
    }

    #[tokio::test]
    async fn reconnect_preserves_direct_subpaths_and_leaves_independent_directories_alone() {
        use crate::{
            app::tasks::test_support::resumed_task,
            task_store::{ManagedThread, RunBy},
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let source = root.join("source");
        let moved = root.join("moved");
        let outside = root.join("independent");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(source.join("nested/keep"), "kept").unwrap();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/read",
                resumed_task("a-nested", &source.join("nested")),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resumed_task("a-nested", &moved.join("nested")),
            ),
            MockCodexResponse::ok_for(
                "thread/settings/update",
                json!({"threadId":"a-nested", "cwd":moved.join("nested")}),
                json!({}),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resumed_task("a-nested", &moved.join("nested")),
            ),
            MockCodexResponse::ok("thread/read", resumed_task("z-independent", &outside)),
            MockCodexResponse::ok(
                "thread/read",
                resumed_task("archived-independent", &outside),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(&root).unwrap(), client.clone()).await;
        for id in ["a-nested", "z-independent", "archived-independent"] {
            claim_cached_active(&state, id, id, 1, "section", "source");
        }
        state.task_store.archive("archived-independent", 2).unwrap();
        state
            .task_store
            .claim(
                ManagedThread::new(
                    "archived-claude",
                    RunBy::Claude {
                        cwd: outside.to_string_lossy().into_owned(),
                    },
                    Some(1),
                    None,
                    None,
                ),
                1,
            )
            .unwrap();
        let archived = state.task_store.archive("archived-claude", 2).unwrap();
        fs::rename(&source, &moved).unwrap();
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert!(body.get("archivedWarnings").is_none());
        assert_eq!(
            fs::read_to_string(moved.join("nested/keep")).unwrap(),
            "kept"
        );
        assert_eq!(
            state.task_store.get_archived("archived-claude").unwrap(),
            archived
        );
        let writes = client
            .mock_requests()
            .await
            .into_iter()
            .filter(|(method, _)| method != "thread/read")
            .collect::<Vec<_>>();
        assert_eq!(writes.len(), 3);
        assert!(
            writes
                .iter()
                .all(|(_, params)| params["threadId"] == "a-nested")
        );
    }

    #[tokio::test]
    async fn reconnect_direct_codex_task_keeps_identity_and_uses_new_cwd_for_next_prompt() {
        use super::super::test_support::current_model_list_response;
        use crate::app::tasks::test_support::resumed_task;

        for repository in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let source = root.join("source");
            if repository {
                initialize_git_repository(&source);
            } else {
                fs::create_dir(&source).unwrap();
            }
            let moved = root.join("moved");
            let client = CodexThreadClient::mock(vec![
                MockCodexResponse::ok(
                    "thread/read",
                    json!({"thread": {
                        "id": "direct", "preview": "Same conversation", "status": {"type": "notLoaded"},
                        "cwd": source, "createdAt": 1.0, "updatedAt": 2.0, "turns": []
                    }}),
                ),
                MockCodexResponse::ok("thread/resume", resumed_task("direct", &source)),
                MockCodexResponse::ok_for(
                    "thread/settings/update",
                    json!({"threadId": "direct", "cwd": moved}),
                    json!({}),
                ),
                MockCodexResponse::ok("thread/resume", {
                    let mut response = resumed_task("direct", &source);
                    response["cwd"] = json!(moved);
                    response
                }),
                MockCodexResponse::ok("thread/resume", resumed_task("direct", &moved)),
                MockCodexResponse::ok("model/list", current_model_list_response()),
                MockCodexResponse::ok(
                    "turn/start",
                    json!({
                        "turn": {"id": "continued", "items": [], "status": "inProgress"}
                    }),
                ),
            ]);
            let state =
                task_state_with_codex_client(RootedFs::new(&root).unwrap(), client.clone()).await;
            claim_cached_active(
                &state,
                "direct",
                "Same conversation",
                1,
                "section",
                "source",
            );
            let before = state.task_store.get("direct").unwrap().unwrap();
            fs::rename(source, &moved).unwrap();

            let (status, body) = post(&state, "source", "moved").await;
            assert_eq!(status, 200, "repository={repository}: {body}");
            assert_eq!(state.task_store.get("direct").unwrap(), Some(before));
            assert_eq!(
                state
                    .task_sessions
                    .snapshot("direct")
                    .await
                    .unwrap()
                    .conversation
                    .unwrap()
                    .cwd,
                moved.to_string_lossy()
            );
            let response = router(state)
                .oneshot(
                    Request::post("/api/tasks/direct/prompts")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"prompt": "Continue the same conversation"}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(status.is_success(), "{}", String::from_utf8_lossy(&body));
            let requests = client.mock_requests().await;
            let (_, resumed) = requests
                .iter()
                .find(|(method, _)| method == "thread/resume")
                .unwrap();
            assert_eq!(resumed["threadId"], "direct");
            assert_eq!(resumed["cwd"], moved.to_string_lossy().as_ref());
            assert_eq!(resumed["runtimeWorkspaceRoots"], json!([moved]));
            let (_, started) = requests
                .iter()
                .find(|(method, _)| method == "turn/start")
                .unwrap();
            assert_eq!(started["threadId"], "direct");
            assert_eq!(started["cwd"], moved.to_string_lossy().as_ref());
            assert!(
                !requests
                    .iter()
                    .any(|(method, _)| method == "thread/fork" || method == "thread/start")
            );
        }
    }

    #[tokio::test]
    async fn reconnect_direct_claude_task_moves_its_session_and_persists_its_cwd() {
        use super::super::test_support::seed_section;
        use crate::{
            app::tasks::test_support::task_state_with_agents,
            task_store::{ManagedThread, RunBy},
        };

        for archived in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let source = root.join("source");
            let moved = root.join("moved");
            fs::create_dir(&source).unwrap();
            let (state, runner) = task_state_with_agents(
                RootedFs::new(&root).unwrap(),
                CodexThreadClient::mock(Vec::new()),
            )
            .await;
            let id = "92b11700-eec3-4269-8e95-75bf5e4632fb";
            let history =
                include_str!("../../../agent/claude/transcript/a-session-claude-wrote.jsonl");
            let claude = state.task_runtime.claude();
            claude.write_test_transcript(&source.to_string_lossy(), id, history);
            // The stand-in runner answers controls but does not write native files.
            // The CLI's actual cold-resume relocation is verified separately with
            // an isolated CLAUDE_CONFIG_DIR and this same existing transcript.
            claude.write_test_transcript(&moved.to_string_lossy(), id, history);
            runner
                .greet_next_session_as(json!({"response": {"session_state": "idle"}}))
                .await;
            seed_section(&state, "section", "source");
            let mut thread = state
                .task_store
                .transaction(|tables| {
                    tables.claim_managed_thread_at_top(
                        ManagedThread::new(
                            id,
                            RunBy::Claude {
                                cwd: source.to_string_lossy().into_owned(),
                            },
                            Some(1),
                            None,
                            None,
                        ),
                        "Existing Claude conversation",
                        "section",
                        1,
                    )
                })
                .unwrap();
            if archived {
                thread = state.task_store.archive(id, 2).unwrap().unwrap();
            }
            fs::rename(&source, &moved).unwrap();

            let (status, body) = post(&state, "source", "moved").await;
            assert_eq!(status, 200, "{body}");
            let mut expected = thread;
            expected.run_by = RunBy::Claude {
                cwd: moved.to_string_lossy().into_owned(),
            };
            if archived {
                assert_eq!(state.task_store.get_archived(id).unwrap(), Some(expected));
                assert!(state.task_store.get(id).unwrap().is_none());
                assert!(claude.watched_conversation(id).await.is_none());
                assert!(body.get("archivedWarnings").is_none(), "{body}");
            } else {
                assert_eq!(state.task_store.get(id).unwrap(), Some(expected));
                assert_eq!(
                    claude.working_directory(id).await.as_deref(),
                    moved.to_str()
                );
                assert_eq!(
                    runner.spawned(id).await.unwrap().cwd,
                    root.to_string_lossy()
                );
            }
            if !archived {
                assert!(
                    runner
                        .heard(id)
                        .await
                        .iter()
                        .any(|frame| frame["request"]["subtype"] == "set_cwd"
                            && frame["request"]["path"] == moved.to_string_lossy().as_ref())
                );
            } else {
                let response = router(state.clone())
                    .oneshot(
                        Request::post(format!("/api/tasks/{id}/restore"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert!(response.status().is_success());
                assert_eq!(
                    state.task_store.get(id).unwrap().unwrap().run_by.cwd(),
                    moved.to_str()
                );
            }
            let page = claude
                .read_turns(id, &moved.to_string_lossy(), None, 8)
                .await
                .unwrap();
            assert!(
                !page.turns.is_empty(),
                "history is retained, not replaced by an empty conversation"
            );
            assert!(!source.exists());
        }
    }

    #[tokio::test]
    async fn reconnect_section_keeps_identity_and_archived_paths_and_restore() {
        let (_temp, state, source, records) = fixture("idle").await;
        let external = state.fs.root().join("external");
        git::create_attached_worktree(&source, &external, "external", None).unwrap();
        let external_marker = fs::read(external.join(".git")).unwrap();
        let before = state
            .task_store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap();
        let moved = state.fs.root().join("moved");
        fs::rename(&source, &moved).unwrap();
        let projection = active_list::load_cached(state.fs.clone(), state.task_store.clone())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(projection).unwrap()["sections"][0]["directory"]["status"],
            "missing"
        );
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["path"], "moved");
        assert_eq!(body["directory"]["status"], "available");
        let after = state
            .task_store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap();
        let mut expected_section = before.0[0].clone();
        expected_section.logical_path = "moved".to_string();
        assert_eq!(after.0, [expected_section]);
        assert_eq!(before.1, after.1);
        let new_common = moved.join(".git");
        for original in &records {
            let actual = state
                .task_store
                .worktree_for_thread(original.thread_id.as_deref().unwrap())
                .unwrap()
                .unwrap();
            let mut expected = original.clone();
            expected.repository_git_dir = new_common.display().to_string();
            assert_eq!(actual, expected);
        }
        assert_eq!(fs::read(external.join(".git")).unwrap(), external_marker);
        assert!(!PathBuf::from(&records[2].worktree_path).exists());
        let archived = router(state.clone())
            .oneshot(
                Request::get("/api/tasks/archived")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(archived.status().is_success());
        let archived: Value =
            serde_json::from_slice(&to_bytes(archived.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(archived["tasks"][0]["repositoryPath"], "moved");
        state
            .lifecycle
            .restore_worktree("archived".to_string())
            .await
            .unwrap();
        git::inspect_attached_worktree(
            PathBuf::from(&records[2].worktree_path).as_path(),
            &new_common,
            None,
        )
        .unwrap();
        state
            .lifecycle
            .archive_worktree("two".to_string())
            .await
            .unwrap();
        state
            .lifecycle
            .restore_worktree("two".to_string())
            .await
            .unwrap();
        assert_eq!(
            post(&state, "source", "moved").await.0,
            200,
            "a lost successful response can be retried"
        );
        assert_eq!(post(&state, "source", "external").await.0, 409);
    }

    #[tokio::test]
    async fn reconnect_section_rejects_other_repository_and_busy_tasks_without_writes() {
        let (_temp, state, source, records) = fixture("active").await;
        let moved = state.fs.root().join("moved");
        let other = state.fs.root().join("other");
        initialize_git_repository(&other);
        fs::rename(&source, &moved).unwrap();
        let marker = fs::read(PathBuf::from(&records[0].worktree_path).join(".git")).unwrap();
        assert_eq!(post(&state, "source", "other").await.0, 400);
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["error"]["code"], "section_reconnect_busy");
        assert_eq!(
            fs::read(PathBuf::from(&records[0].worktree_path).join(".git")).unwrap(),
            marker
        );
        assert_eq!(state.task_store.managed_worktrees().unwrap(), records);
    }

    #[tokio::test]
    async fn reconnect_section_accepts_repaired_git_with_uncommitted_store_paths() {
        let (_temp, state, source, records) = fixture("idle").await;
        let moved = state.fs.root().join("moved");
        fs::rename(&source, &moved).unwrap();
        git::prepare_reconnection(
            PathBuf::from(&records[0].worktree_path).as_path(),
            PathBuf::from(&records[0].repository_git_dir).as_path(),
            &moved.join(".git"),
        )
        .unwrap()
        .apply()
        .unwrap();
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            state
                .task_store
                .worktree_for_thread("one")
                .unwrap()
                .unwrap()
                .repository_git_dir,
            moved.join(".git").display().to_string()
        );
    }

    #[tokio::test]
    async fn reconnect_section_reserves_task_mutations_and_serializes_duplicate_requests() {
        use futures_util::FutureExt;
        let (_temp, state, source, _) = fixture("idle").await;
        let moved = state.fs.root().join("moved");
        fs::rename(source, moved).unwrap();
        let conversation = |id: &str| {
            json!({ "thread": {
                "id": id, "preview": id, "status": { "type": "idle" },
                "cwd": "unused", "createdAt": 1.0, "updatedAt": 1.0, "turns": []
            }})
        };
        let (first, release) = MockCodexResponse::gated_ok("thread/read", conversation("one"));
        let client = CodexThreadClient::mock(vec![
            first,
            MockCodexResponse::ok("thread/read", conversation("two")),
        ]);
        state
            .task_runtime
            .install_test_client(2, client.clone())
            .await;
        let first_state = state.clone();
        let first_request =
            tokio::spawn(async move { post(&first_state, "source", "moved").await });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while client.mock_requests().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            state
                .task_sessions
                .reserve_mutation("two")
                .now_or_never()
                .is_none(),
            "the provider check holds every affected Task's mutation reservation"
        );
        let duplicate_state = state.clone();
        let duplicate =
            tokio::spawn(async move { post(&duplicate_state, "source", "moved").await });
        release.send(()).unwrap();
        assert_eq!(first_request.await.unwrap().0, 200);
        assert_eq!(duplicate.await.unwrap().0, 200);
        assert_eq!(
            client.mock_requests().await.len(),
            2,
            "a duplicate does not run another provider operation"
        );
        assert!(
            state
                .task_sessions
                .reserve_mutation("two")
                .now_or_never()
                .is_some()
        );
    }

    #[tokio::test]
    async fn reconnect_section_opens_unloaded_state_and_next_prompt_uses_the_same_worktree() {
        use super::super::test_support::current_model_list_response;
        use crate::app::tasks::test_support::resumed_task;
        let (_temp, state, source, records) = fixture("idle").await;
        let moved = state.fs.root().join("moved");
        fs::rename(&source, &moved).unwrap();
        let mut responses = Vec::new();
        for (thread, record) in ["one", "two"].into_iter().zip(&records) {
            responses.push(MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": {
                    "id": thread, "preview": thread, "status": { "type": "notLoaded" },
                    "cwd": record.worktree_path, "createdAt": 1.0, "updatedAt": 1.0, "turns": []
                }}),
            ));
            responses.push(MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread, PathBuf::from(&record.worktree_path).as_path()),
            ));
        }
        responses.push(MockCodexResponse::ok(
            "model/list",
            current_model_list_response(),
        ));
        responses.push(MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": { "id": "continued", "items": [], "status": "inProgress" }
            }),
        ));
        let client = CodexThreadClient::mock(responses);
        state
            .task_runtime
            .install_test_client(2, client.clone())
            .await;
        assert_eq!(post(&state, "source", "moved").await.0, 200);
        let response = router(state)
            .oneshot(
                Request::post("/api/tasks/one/prompts")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"prompt": "Continue after reconnection"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(status.is_success(), "{}", String::from_utf8_lossy(&body));
        let requests = client.mock_requests().await;
        let (_, start) = requests
            .iter()
            .find(|(method, _)| method == "turn/start")
            .unwrap();
        assert_eq!(start["threadId"], "one");
        assert_eq!(start["cwd"], records[0].worktree_path);
        assert_ne!(start["cwd"], moved.display().to_string());
    }

    #[tokio::test]
    async fn reconnect_section_preflight_refusals_leave_git_and_store_unchanged() {
        use super::super::test_support::seed_section;
        for case in [
            "original-exists",
            "occupied",
            "in-progress",
            "escape",
            "plain-folder",
        ] {
            let (_temp, state, source, records) = fixture("idle").await;
            let marker = PathBuf::from(&records[0].worktree_path).join(".git");
            let before_marker = fs::read(&marker).unwrap();
            if case != "original-exists" {
                fs::rename(&source, state.fs.root().join("moved")).unwrap();
            }
            let (candidate, expected_status) = match case {
                "original-exists" => ("source", 409),
                "occupied" => {
                    seed_section(&state, "occupied", "moved");
                    ("moved", 409)
                }
                "in-progress" => {
                    state
                        .task_store
                        .transition_worktree(
                            &records[2].worktree_id,
                            ManagedWorktreeState::Archived,
                            ManagedWorktreeState::Restoring,
                            records[2].checkout_anchor.clone(),
                            3,
                        )
                        .unwrap();
                    ("moved", 409)
                }
                "escape" => ("../outside", 400),
                "plain-folder" => {
                    fs::create_dir(state.fs.root().join("plain")).unwrap();
                    ("plain", 400)
                }
                _ => unreachable!(),
            };
            let before_records = state.task_store.managed_worktrees().unwrap();
            let before_sections = state
                .task_store
                .read(|tables| tables.managed_sections())
                .unwrap();
            let (status, body) = post(&state, "source", candidate).await;
            assert_eq!(status, expected_status, "{case}: {body}");
            assert_eq!(fs::read(&marker).unwrap(), before_marker, "{case}");
            assert_eq!(
                state.task_store.managed_worktrees().unwrap(),
                before_records,
                "{case}"
            );
            assert_eq!(
                state
                    .task_store
                    .read(|tables| tables.managed_sections())
                    .unwrap(),
                before_sections,
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn reconnect_section_does_not_recreate_a_missing_individual_worktree() {
        let (_temp, state, source, records) = fixture("idle").await;
        fs::remove_dir_all(&records[0].worktree_path).unwrap();
        fs::rename(&source, state.fs.root().join("moved")).unwrap();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": {
                "id": "two", "preview": "two", "status": { "type": "idle" },
                "cwd": records[1].worktree_path, "createdAt": 1.0, "updatedAt": 1.0, "turns": []
            }}),
        )]);
        state.task_runtime.install_test_client(2, client).await;
        let (status, body) = post(&state, "source", "moved").await;
        assert_eq!(status, 200, "{body}");
        assert!(!PathBuf::from(&records[0].worktree_path).exists());
        let error = state.detail.get("one", None).await.unwrap_err();
        assert!(
            matches!(error, ApiError::Diagnostic(body) if body.code == "managed_worktree_missing")
        );
    }
}
