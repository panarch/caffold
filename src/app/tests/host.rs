use super::super::*;

#[test]
fn app_server_timeout_preserves_rpc_context_in_api_error() {
    let error = ApiError::from(codex_app_server::CodexThreadError::RequestTimeout {
        method: "thread/resume",
        request_id: 42,
        timeout_ms: 120_000,
    });

    match error {
        ApiError::Timeout { code, message } => {
            assert_eq!(code, "codex_app_server_timeout");
            assert!(message.contains("thread/resume"));
            assert!(message.contains("request 42"));
            assert!(message.contains("120000ms"));
        }
        error => panic!("expected timeout API error, got {error:?}"),
    }
}

#[test]
fn extracts_codex_version_from_app_server_user_agent() {
    assert_eq!(
        codex_version_from_user_agent("Codex Desktop/0.144.4"),
        Some("0.144.4".to_string())
    );
    assert_eq!(codex_version_from_user_agent("Codex Desktop"), None);
}

#[test]
fn server_name_is_applied_to_install_metadata() {
    let index = render_index("Caffold & Mac Studio");
    assert!(index.contains("<title>Caffold &amp; Mac Studio</title>"));
    assert!(index.contains("content=\"Caffold &amp; Mac Studio\""));
    assert!(!index.contains("{{CAFFOLD_SERVER_NAME}}"));

    let manifest: JsonValue =
        serde_json::from_slice(&render_manifest("Caffold Studio").unwrap()).unwrap();
    assert_eq!(manifest["name"], "Caffold Studio");
    assert_eq!(manifest["short_name"], "Caffold Studio");
    assert_eq!(manifest["id"], "/");
}
