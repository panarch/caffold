use super::*;

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
    assert_eq!(manifest["display"], "standalone");
    assert_eq!(manifest["theme_color"], "#ffffff");
    assert_eq!(manifest["background_color"], "#f5f5f5");
}

#[test]
fn service_worker_cache_name_uses_safely_serialized_build_id() {
    let source = static_assets::get("service-worker.js")
        .expect("service worker asset")
        .body;
    let first = render_service_worker(source, "first-build").unwrap();
    let second = render_service_worker(source, "second\"\\\nbuild").unwrap();

    assert!(first.starts_with("const CACHE_NAME = \"caffold-shell-first-build\";"));
    assert!(second.starts_with("const CACHE_NAME = \"caffold-shell-second\\\"\\\\\\nbuild\";"));
    assert_ne!(first, second);
    assert!(!first.contains("__CAFFOLD_BUILD_ID__"));
    assert!(!second.contains("__CAFFOLD_BUILD_ID__"));
}
