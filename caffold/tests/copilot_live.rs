//! Check the installed Copilot CLI, its signed-in account and native storage through Caffold HTTP.

mod support;

use serde_json::json;

#[tokio::test]
#[ignore = "requires the installed Copilot CLI and an active GitHub login"]
async fn installed_cli_keeps_a_named_empty_task_across_backend_replacement() {
    let native = tempfile::tempdir().unwrap();
    let mut server = support::Backend::start_with_environment(&[
        ("COPILOT_HOME", native.path().to_str().unwrap()),
        ("COPILOT_AUTO_UPDATE", "false"),
    ])
    .await;

    let status = server.get("/api/copilot/status").await.unwrap();
    assert_eq!(status["installation"]["state"], "ready", "{status}");
    assert_eq!(status["authenticated"], true, "{status}");
    assert!(!status["models"].as_array().unwrap().is_empty());

    let created = server
        .post(
            "/api/tasks",
            json!({
                "provider": "copilot",
                "cwd": "notes",
                "permissionMode": "manual",
                "titleSource": "Review an empty Copilot Task",
            }),
        )
        .await
        .unwrap();
    let task = created["detail"]["threadId"].as_str().expect("named Task");

    let binding = native.path().join("session-state");
    let sessions = || {
        std::fs::read_dir(&binding)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("events.jsonl").is_file())
            .map(|entry| entry.file_name())
            .collect::<Vec<_>>()
    };
    let before = sessions();
    assert_eq!(before.len(), 1);

    server.replace().await;
    let detail = server.get(&format!("/api/tasks/{task}")).await.unwrap();
    assert_eq!(detail["threadId"], task);
    assert_eq!(detail["provider"], "copilot");
    assert_eq!(sessions(), before);

    let archive = server
        .post(&format!("/api/tasks/{task}/archive"), json!({}))
        .await
        .unwrap();
    assert!(archive.get("error").is_none(), "{archive}");
    let archived = server.get("/api/tasks/archived").await.unwrap();
    assert!(
        archived["tasks"]
            .as_array()
            .expect("archived list")
            .iter()
            .any(|row| row["threadId"] == task && row["conversationAvailable"] == true)
    );

    let restored = server
        .post(&format!("/api/tasks/{task}/restore"), json!({}))
        .await
        .unwrap();
    assert!(restored.get("error").is_none(), "{restored}");
    assert_eq!(sessions(), before);
    let journal = std::fs::read_to_string(binding.join(&before[0]).join("events.jsonl")).unwrap();
    assert!(!journal.lines().any(|line| {
        let event: serde_json::Value = serde_json::from_str(line).unwrap();
        event["type"] == "user.message"
    }));

    let archived = server
        .post(&format!("/api/tasks/{task}/archive"), json!({}))
        .await
        .unwrap();
    assert!(archived.get("error").is_none(), "{archived}");
    let deleted = server.delete(&format!("/api/tasks/{task}")).await.unwrap();
    assert!(deleted.get("error").is_none(), "{deleted}");
    assert!(
        sessions().is_empty(),
        "the temporary native session survived deletion"
    );
}

#[tokio::test]
#[ignore = "requires the installed Copilot CLI and an active GitHub login"]
async fn native_fork_preview_and_creation_use_the_same_managed_session() {
    let native = tempfile::tempdir().unwrap();
    let server = support::Backend::start_with_environment(&[
        ("COPILOT_HOME", native.path().to_str().unwrap()),
        ("COPILOT_AUTO_UPDATE", "false"),
    ])
    .await;

    let created = server
        .post(
            "/api/tasks",
            json!({
                "provider": "copilot",
                "cwd": "notes",
                "permissionMode": "manual",
                "titleSource": "Native fork source",
            }),
        )
        .await
        .unwrap();
    let task = created["detail"]["threadId"]
        .as_str()
        .expect("managed source");
    let section = created["activeTopPlacement"]["section"]["id"]
        .as_str()
        .expect("source Section");

    let session_dir = std::fs::read_dir(native.path().join("session-state"))
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| entry.path().join("events.jsonl").is_file())
        .expect("native journal")
        .path();
    let session = session_dir.file_name().unwrap().to_str().unwrap();
    assert_ne!(session, task);
    let journal = session_dir.join("events.jsonl");

    let preview = server
        .post(
            "/api/task-forks/preview",
            json!({ "provider": "copilot", "sourceId": session }),
        )
        .await
        .unwrap();
    assert_eq!(preview["sourceId"], session, "{preview}");
    assert_eq!(preview["status"]["type"], "idle", "{preview}");
    assert!(preview["cwd"].as_str().unwrap().ends_with("/notes"));

    let by_task = server
        .post(
            "/api/task-forks/preview",
            json!({ "provider": "copilot", "sourceId": task }),
        )
        .await
        .unwrap();
    assert_eq!(by_task["sourceId"], task);
    for key in ["status", "cwd", "recentHistory"] {
        assert_eq!(preview[key], by_task[key], "{key}");
    }

    let parent = std::fs::read(&journal).unwrap();
    let fork = server
        .post(
            "/api/task-forks",
            json!({
                "provider": "copilot",
                "sourceId": session,
                "sectionId": section,
            }),
        )
        .await
        .unwrap();
    let child = fork["detail"]["threadId"]
        .as_str()
        .unwrap_or_else(|| panic!("Copilot fork failed: {fork}"));
    assert_ne!(child, task);
    assert_eq!(fork["activeTopPlacement"]["section"]["id"], section);
    assert_eq!(std::fs::read(&journal).unwrap(), parent);

    let archived = server
        .post(&format!("/api/tasks/{task}/archive"), json!({}))
        .await
        .unwrap();
    assert!(archived.get("error").is_none(), "{archived}");
    let preview = server
        .post(
            "/api/task-forks/preview",
            json!({ "provider": "copilot", "sourceId": session }),
        )
        .await
        .unwrap();
    assert_eq!(preview["sourceId"], session);
    assert_eq!(preview["status"]["type"], "idle", "{preview}");

    let fork = server
        .post(
            "/api/task-forks",
            json!({
                "provider": "copilot",
                "sourceId": session,
                "sectionId": section,
            }),
        )
        .await
        .unwrap();
    assert_ne!(
        fork["detail"]["threadId"]
            .as_str()
            .unwrap_or_else(|| panic!("Copilot fork of archived source failed: {fork}")),
        task
    );
    let archive = server.get("/api/tasks/archived").await.unwrap();
    assert!(
        archive["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["threadId"] == task)
    );
}
