use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::{fs, path::Path};

use super::{PathQuery, WorkspaceState};
use crate::{
    app::error::ApiError,
    fs::{FileResponse, FsError, RootedFs},
};

const PLAN_RELATIVE_PATH: &str = ".caffold/plans/current/PLAN.md";
const CHECKLIST_RELATIVE_PATH: &str = ".caffold/plans/current/CHECKLIST.md";
const WATCH_RELATIVE_PATHS: [&str; 3] = [".caffold", ".caffold/plans", ".caffold/plans/current"];
const DEFAULT_PLAN_TITLE: &str = "Current plan";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CurrentPlanStatus {
    Absent,
    Ready,
    Problem,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CurrentPlanResponse {
    status: CurrentPlanStatus,
    watch_path: String,
    plan: Option<CurrentPlanSummary>,
    problems: Vec<CurrentPlanProblem>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CurrentPlanSummary {
    title: String,
    completed: usize,
    total: usize,
    plan_document: CurrentPlanDocument,
    checklist_document: CurrentPlanDocument,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CurrentPlanDocument {
    path: String,
    name: String,
    size: u64,
    modified_ms: Option<u64>,
}

impl From<&FileResponse> for CurrentPlanDocument {
    fn from(file: &FileResponse) -> Self {
        Self {
            path: file.path.clone(),
            name: file.name.clone(),
            size: file.size,
            modified_ms: file.modified_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CurrentPlanDocumentKind {
    Plan,
    Checklist,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CurrentPlanProblem {
    document: CurrentPlanDocumentKind,
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedPlanDocuments {
    title: String,
    completed: usize,
    total: usize,
}

pub(super) fn router() -> Router<WorkspaceState> {
    Router::new().route("/api/current-plan", get(current_plan))
}

async fn current_plan(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<CurrentPlanResponse>, ApiError> {
    current_plan_projection(&state.fs, &query.path)
        .map(Json)
        .map_err(ApiError::from)
}

fn current_plan_projection(
    fs: &RootedFs,
    requested_path: &str,
) -> Result<CurrentPlanResponse, FsError> {
    let cwd_absolute = fs.absolute_directory_path(requested_path)?;
    let cwd = fs.logical_path_for_absolute(&cwd_absolute)?;
    let watch_path = deepest_watch_path(fs, &cwd);
    let plan_path = join_logical_path(&cwd, PLAN_RELATIVE_PATH);
    let checklist_path = join_logical_path(&cwd, CHECKLIST_RELATIVE_PATH);
    let plan = fs.read_file(&plan_path);
    let checklist = fs.read_file(&checklist_path);

    if document_is_absent(&cwd_absolute, PLAN_RELATIVE_PATH, &plan)
        && document_is_absent(&cwd_absolute, CHECKLIST_RELATIVE_PATH, &checklist)
    {
        return Ok(CurrentPlanResponse {
            status: CurrentPlanStatus::Absent,
            watch_path,
            plan: None,
            problems: Vec::new(),
        });
    }

    match (plan, checklist) {
        (Ok(plan), Ok(checklist)) => {
            let parsed = parse_plan_documents(&plan.content, &checklist.content);
            Ok(CurrentPlanResponse {
                status: CurrentPlanStatus::Ready,
                watch_path,
                plan: Some(CurrentPlanSummary {
                    title: parsed.title,
                    completed: parsed.completed,
                    total: parsed.total,
                    plan_document: CurrentPlanDocument::from(&plan),
                    checklist_document: CurrentPlanDocument::from(&checklist),
                }),
                problems: Vec::new(),
            })
        }
        (plan, checklist) => {
            let mut problems = Vec::new();
            if let Err(error) = plan {
                problems.push(current_plan_problem(CurrentPlanDocumentKind::Plan, error));
            }
            if let Err(error) = checklist {
                problems.push(current_plan_problem(
                    CurrentPlanDocumentKind::Checklist,
                    error,
                ));
            }
            Ok(CurrentPlanResponse {
                status: CurrentPlanStatus::Problem,
                watch_path,
                plan: None,
                problems,
            })
        }
    }
}

fn deepest_watch_path(fs: &RootedFs, cwd: &str) -> String {
    let mut watch_path = cwd.to_string();
    for relative_path in WATCH_RELATIVE_PATHS {
        let candidate = join_logical_path(cwd, relative_path);
        match fs.absolute_directory_path(&candidate) {
            Ok(_) => watch_path = candidate,
            Err(_) => break,
        }
    }
    watch_path
}

fn join_logical_path(base: &str, relative_path: &str) -> String {
    if base.is_empty() {
        relative_path.to_string()
    } else {
        format!("{base}/{relative_path}")
    }
}

fn document_is_absent(
    cwd: &Path,
    relative_path: &str,
    result: &Result<FileResponse, FsError>,
) -> bool {
    if !matches!(result, Err(FsError::NotFound { .. })) {
        return false;
    }
    matches!(
        fs::symlink_metadata(cwd.join(relative_path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

fn current_plan_problem(document: CurrentPlanDocumentKind, error: FsError) -> CurrentPlanProblem {
    let code = match &error {
        FsError::PathEscapesRoot => "path_escapes_root",
        FsError::NotFound { .. } => "missing",
        FsError::NotDirectory { .. } => "not_directory",
        FsError::IsDirectory { .. } => "is_directory",
        FsError::NotFile { .. } => "not_file",
        FsError::FileTooLarge { .. } => "file_too_large",
        FsError::BinaryFile { .. } => "binary_file",
        FsError::InvalidUtf8 { .. } => "invalid_utf8",
        FsError::Io { .. } => "io_error",
        _ => "unreadable",
    };
    CurrentPlanProblem {
        document,
        code,
        message: error.to_string(),
    }
}

fn parse_plan_documents(plan: &str, checklist: &str) -> ParsedPlanDocuments {
    let mut saw_h1 = false;
    let mut reading_h1 = false;
    let mut heading = String::new();

    for event in Parser::new_ext(plan, Options::ENABLE_TASKLISTS) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if !saw_h1 => {
                saw_h1 = true;
                reading_h1 = true;
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if reading_h1 => break,
            Event::Text(text) | Event::Code(text) if reading_h1 => {
                heading.push_str(&text);
                heading.push(' ');
            }
            Event::SoftBreak | Event::HardBreak if reading_h1 => heading.push(' '),
            _ => {}
        }
    }

    let title = heading.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut completed = 0;
    let mut total = 0;
    for event in Parser::new_ext(checklist, Options::ENABLE_TASKLISTS) {
        if let Event::TaskListMarker(checked) = event {
            total += 1;
            completed += usize::from(checked);
        }
    }

    ParsedPlanDocuments {
        title: if !title.is_empty() {
            title
        } else {
            DEFAULT_PLAN_TITLE.to_string()
        },
        completed,
        total,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    fn fixture() -> (tempfile::TempDir, RootedFs) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("task")).unwrap();
        let rooted = RootedFs::new(root.path()).unwrap();
        (root, rooted)
    }

    fn write_current(root: &tempfile::TempDir, plan: &[u8], checklist: &[u8]) {
        let current = root.path().join("task/.caffold/plans/current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("PLAN.md"), plan).unwrap();
        fs::write(current.join("CHECKLIST.md"), checklist).unwrap();
    }

    #[test]
    fn projects_absent_partial_and_ready_current_plan_states() {
        let (root, rooted) = fixture();
        let absent = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(absent.status, CurrentPlanStatus::Absent);
        assert_eq!(absent.watch_path, "task");

        let current = root.path().join("task/.caffold/plans/current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("PLAN.md"), "# Release plan\n").unwrap();
        let partial = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(partial.status, CurrentPlanStatus::Problem);
        assert_eq!(partial.watch_path, "task/.caffold/plans/current");
        assert_eq!(partial.problems.len(), 1);
        assert_eq!(
            partial.problems[0],
            CurrentPlanProblem {
                document: CurrentPlanDocumentKind::Checklist,
                code: "missing",
                message: "path was not found: task/.caffold/plans/current/CHECKLIST.md".to_string(),
            }
        );

        fs::write(
            current.join("CHECKLIST.md"),
            "## Build\n- [x] Parse\n  - [ ] Render\n",
        )
        .unwrap();
        let ready = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(ready.status, CurrentPlanStatus::Ready);
        let summary = ready.plan.unwrap();
        assert_eq!(summary.title, "Release plan");
        assert_eq!((summary.completed, summary.total), (1, 2));
        assert_eq!(
            summary.plan_document.path,
            "task/.caffold/plans/current/PLAN.md"
        );
        assert_eq!(
            summary.checklist_document.path,
            "task/.caffold/plans/current/CHECKLIST.md"
        );
    }

    #[test]
    fn projects_current_documents_from_the_workspace_root() {
        let (root, rooted) = fixture();
        let current = root.path().join(".caffold/plans/current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("PLAN.md"), "# Root plan\n").unwrap();
        fs::write(current.join("CHECKLIST.md"), "- [ ] root task\n").unwrap();

        for path in ["", "."] {
            let projection = current_plan_projection(&rooted, path).unwrap();
            assert_eq!(projection.status, CurrentPlanStatus::Ready);
            assert_eq!(projection.watch_path, ".caffold/plans/current");
            assert_eq!(projection.plan.unwrap().title, "Root plan");
        }
    }

    #[test]
    fn parses_only_the_first_h1_and_gfm_task_list_markers() {
        let parsed = parse_plan_documents(
            "## Intro\n# Ship `current` plan\n# Ignore this\n",
            "plain [x]\n```md\n- [x] example\n```\n- [X] done\n- [ ] pending\n  - [x] nested\n",
        );
        assert_eq!(parsed.title, "Ship current plan");
        assert_eq!((parsed.completed, parsed.total), (2, 3));

        let empty = parse_plan_documents("#   \n# Later title\n", "No tasks yet.");
        assert_eq!(empty.title, DEFAULT_PLAN_TITLE);
        assert_eq!((empty.completed, empty.total), (0, 0));

        let complete = parse_plan_documents("No heading", "- [x] one\n- [X] two\n");
        assert_eq!(complete.title, DEFAULT_PLAN_TITLE);
        assert_eq!((complete.completed, complete.total), (2, 2));

        let multiline = parse_plan_documents(
            "Coordinate plan documents\nacross agent harnesses\n======================\n",
            "- [ ] review\n",
        );
        assert_eq!(
            multiline.title,
            "Coordinate plan documents across agent harnesses"
        );
    }

    #[test]
    fn keeps_ignored_documents_readable_and_reports_invalid_files() {
        let (root, rooted) = fixture();
        fs::write(root.path().join("task/.gitignore"), ".caffold/\n").unwrap();
        write_current(&root, b"# Ignored plan\n", b"- [ ] visible\n");
        assert_eq!(
            current_plan_projection(&rooted, "task").unwrap().status,
            CurrentPlanStatus::Ready
        );

        fs::write(
            root.path().join("task/.caffold/plans/current/PLAN.md"),
            b"bad\0plan",
        )
        .unwrap();
        fs::write(
            root.path().join("task/.caffold/plans/current/CHECKLIST.md"),
            [0xff, 0xfe],
        )
        .unwrap();
        let problem = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(problem.status, CurrentPlanStatus::Problem);
        assert_eq!(
            problem
                .problems
                .iter()
                .map(|problem| problem.code)
                .collect::<Vec<_>>(),
            ["binary_file", "invalid_utf8"]
        );
    }

    #[test]
    fn reports_directories_and_oversized_documents_without_projecting_progress() {
        let (root, rooted) = fixture();
        write_current(&root, b"# Plan\n", b"- [ ] task\n");
        let plan_path = root.path().join("task/.caffold/plans/current/PLAN.md");
        fs::remove_file(&plan_path).unwrap();
        fs::create_dir(&plan_path).unwrap();
        let checklist_path = root.path().join("task/.caffold/plans/current/CHECKLIST.md");
        fs::write(
            &checklist_path,
            vec![b'x'; crate::fs::MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let problem = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(problem.status, CurrentPlanStatus::Problem);
        assert!(problem.plan.is_none());
        assert_eq!(
            problem
                .problems
                .iter()
                .map(|problem| problem.code)
                .collect::<Vec<_>>(),
            ["is_directory", "file_too_large"]
        );
    }

    #[test]
    fn maps_document_read_failures_to_stable_problem_codes() {
        let cases = [
            (
                FsError::NotDirectory {
                    path: "task/.caffold".to_string(),
                },
                "not_directory",
            ),
            (
                FsError::NotFile {
                    path: "task/.caffold/plans/current/PLAN.md".to_string(),
                },
                "not_file",
            ),
            (
                FsError::Io {
                    action: "read file",
                    path: "task/.caffold/plans/current/PLAN.md".to_string(),
                    source: std::io::Error::other("unavailable"),
                },
                "io_error",
            ),
        ];

        for (error, expected) in cases {
            assert_eq!(
                current_plan_problem(CurrentPlanDocumentKind::Plan, error).code,
                expected
            );
        }
    }

    #[test]
    fn watch_path_tracks_the_deepest_existing_directory() {
        let (root, rooted) = fixture();
        assert_eq!(deepest_watch_path(&rooted, "task"), "task");

        fs::create_dir(root.path().join("task/.caffold")).unwrap();
        assert_eq!(deepest_watch_path(&rooted, "task"), "task/.caffold");

        fs::create_dir(root.path().join("task/.caffold/plans")).unwrap();
        assert_eq!(deepest_watch_path(&rooted, "task"), "task/.caffold/plans");

        fs::create_dir(root.path().join("task/.caffold/plans/current")).unwrap();
        assert_eq!(
            deepest_watch_path(&rooted, "task"),
            "task/.caffold/plans/current"
        );

        fs::remove_dir(root.path().join("task/.caffold/plans/current")).unwrap();
        assert_eq!(deepest_watch_path(&rooted, "task"), "task/.caffold/plans");
    }

    #[test]
    fn rejects_task_paths_outside_the_root() {
        let (_root, rooted) = fixture();
        assert!(matches!(
            current_plan_projection(&rooted, "../task"),
            Err(FsError::PathEscapesRoot)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_current_document_symlink_that_escapes_the_root() {
        use std::os::unix::fs::symlink;

        let (root, rooted) = fixture();
        let outside = tempfile::tempdir().unwrap();
        write_current(&root, b"# Plan\n", b"- [ ] task\n");
        let plan_path = root.path().join("task/.caffold/plans/current/PLAN.md");
        fs::remove_file(&plan_path).unwrap();
        symlink(outside.path().join("PLAN.md"), &plan_path).unwrap();
        fs::write(outside.path().join("PLAN.md"), "# Outside\n").unwrap();

        let problem = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(problem.status, CurrentPlanStatus::Problem);
        assert_eq!(problem.problems[0].code, "path_escapes_root");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_treat_a_dangling_current_document_symlink_as_absent() {
        use std::os::unix::fs::symlink;

        let (root, rooted) = fixture();
        let current = root.path().join("task/.caffold/plans/current");
        fs::create_dir_all(&current).unwrap();
        symlink("missing-plan.md", current.join("PLAN.md")).unwrap();

        let problem = current_plan_projection(&rooted, "task").unwrap();
        assert_eq!(problem.status, CurrentPlanStatus::Problem);
        assert_eq!(problem.problems.len(), 2);
        assert!(
            problem
                .problems
                .iter()
                .all(|problem| problem.code == "missing")
        );
    }

    #[tokio::test]
    async fn route_serializes_the_workspace_projection_contract() {
        let (root, rooted) = fixture();
        write_current(&root, b"# API plan\n", b"- [x] done\n- [ ] next\n");
        let app = router().with_state(WorkspaceState::new(std::sync::Arc::new(rooted)));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/current-plan?path=task")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["status"], "ready");
        assert_eq!(body["watchPath"], "task/.caffold/plans/current");
        assert_eq!(body["plan"]["title"], "API plan");
        assert_eq!(body["plan"]["completed"], 1);
        assert_eq!(body["plan"]["total"], 2);
        assert!(body["plan"].get("content").is_none());
    }
}
