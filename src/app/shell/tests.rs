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
}
