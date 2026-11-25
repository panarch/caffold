// Append this test to the historical migration module listed in README.md.
#[test]
fn generate_gluesql_v3_fixture() {
    use std::path::PathBuf;

    let output = PathBuf::from(std::env::var_os("CAFFOLD_FIXTURE_DIR").unwrap());
    let suffix = if LATEST_SCHEMA_VERSION == 4 {
        "-unclean"
    } else {
        ""
    };
    let path = output.join(format!("v3-schema-{LATEST_SCHEMA_VERSION}{suffix}.redb"));
    assert!(!path.exists());
    let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
    let timestamp = "2026-07-01T00:00:00".parse().unwrap();
    create_latest_schema(&mut glue, timestamp).unwrap();
    if LATEST_SCHEMA_VERSION == 4 {
        drop(glue);
        // Exit with Caffold's writer open so redb recovers the file on its next open.
        std::mem::forget(crate::task_store::TaskStore::redb(path).unwrap());
        return;
    }
    glue.execute("
        INSERT INTO managed_sections (section_id, logical_path, position)
            VALUES ('section-1', '/fixture', 0);
        INSERT INTO managed_threads (thread_id, claimed_at, display_name, section_id, position_in_section)
            VALUES ('task-1', TIMESTAMP '2026-07-01 00:00:00', 'First task', 'section-1', 0);
        INSERT INTO managed_worktrees (worktree_id, thread_id, repository_git_dir, worktree_path,
            state, created_at, updated_at)
            VALUES ('00000000-0000-4000-8000-000000000001', 'task-1', '/fixture/.git',
                '/fixture/worktrees/00000000-0000-4000-8000-000000000001', 'ready',
                TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');
        INSERT INTO notes (note_id, name, content, content_version, created_by_thread_id,
            updated_by_thread_id, created_at, updated_at)
            VALUES ('note-1', 'Migration', 'Kept note', 3, 'task-1', 'task-1',
                TIMESTAMP '2026-07-01 00:00:00', TIMESTAMP '2026-07-01 00:00:00');
    ").unwrap();
    if let Some(root) = std::env::var_os("CAFFOLD_FIXTURE_WORKTREE_ROOT") {
        use gluesql::core::query_builder::{table, text};
        let tree = PathBuf::from(root).join("00000000-0000-4000-8000-000000000001");
        table("managed_worktrees")
            .update()
            .set("worktree_path", text(tree.to_str().unwrap()))
            .execute(&mut glue)
            .unwrap();
    }
    let update = match LATEST_SCHEMA_VERSION {
        16 => "UPDATE managed_threads SET permission_instructions = 'old instructions'",
        17 => {
            r#"UPDATE managed_threads SET recent_prompts = '[{"turn_id":"turn-1","prompt":"Kept prompt"}]'"#
        }
        other => panic!("unexpected fixture schema {other}"),
    };
    glue.execute(update).unwrap();
}
