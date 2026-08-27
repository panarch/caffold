//! Contract between Caffold's Codex adapter and the installed Codex CLI.
//!
//! The adapter in `src/agent/codex/` is written against a specific
//! app-server schema. This asks the installed CLI to generate that schema and
//! checks that every method, field, and variant the adapter depends on is still
//! there, so an upgrade that removes one fails here rather than at runtime.
//!
//! It requires an installed Codex CLI, so it is opt-in:
//!
//! ```sh
//! cargo test --test codex_protocol -- --ignored
//! ```

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use caffold::MINIMUM_SUPPORTED_CODEX_CLI_VERSION;
use semver::Version;

/// Mirrors the released install policy in `agent::codex::readiness`:
/// `CAFFOLD_CODEX_BIN` is the explicit development override, and the official
/// standalone installation is the supported location otherwise.
fn codex_binary() -> PathBuf {
    if let Some(explicit) = env::var_os("CAFFOLD_CODEX_BIN") {
        let path = PathBuf::from(explicit);
        assert!(
            path.is_file(),
            "CAFFOLD_CODEX_BIN does not point to a file: {}",
            path.display(),
        );
        return path;
    }

    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let standalone = home.join(".local/bin/codex");
    assert!(
        standalone.is_file(),
        "no Codex CLI at {}; set CAFFOLD_CODEX_BIN to run this contract",
        standalone.display(),
    );
    standalone
}

fn run_codex<I, S>(binary: &Path, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let output = Command::new(binary)
        .args(args.into_iter().map(Into::into))
        .output()
        .expect("Codex CLI must be runnable");
    assert!(
        output.status.success(),
        "Codex CLI failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).expect("Codex CLI output must be UTF-8")
}

/// The CLI reports `codex-cli <version>`; the version gate itself is the
/// backend's, so this only has to reach the same comparison.
fn installed_version(version_output: &str) -> Version {
    let raw = version_output
        .split_whitespace()
        .find_map(|token| Version::parse(token).ok());
    raw.unwrap_or_else(|| {
        panic!(
            "could not parse Codex CLI version from: {}",
            version_output.trim()
        )
    })
}

struct GeneratedSchema {
    root: PathBuf,
}

impl GeneratedSchema {
    fn read(&self, relative: &str) -> String {
        let path = self.root.join(relative);
        fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("missing generated {}: {error}", path.display()))
    }

    /// Every declaration this asserts on is a literal in the generated
    /// TypeScript, so substring matching is the whole requirement.
    fn assert_declares(&self, relative: &str, expected: &[&str]) {
        let source = self.read(relative);
        for declaration in expected {
            assert!(
                source.contains(declaration),
                "{relative} no longer declares `{declaration}`",
            );
        }
    }
}

impl Drop for GeneratedSchema {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "requires an installed Codex CLI"]
fn installed_codex_app_server_keeps_the_required_caffold_contract() {
    let binary = codex_binary();

    let version = installed_version(&run_codex(&binary, ["--version"]));
    let minimum = Version::parse(MINIMUM_SUPPORTED_CODEX_CLI_VERSION)
        .expect("the supported baseline must be a valid version");
    assert!(
        version >= minimum,
        "Codex CLI {version} is older than the supported {minimum} baseline",
    );

    let root = env::temp_dir().join(format!("caffold-codex-protocol-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("schema output directory must be creatable");
    let schema = GeneratedSchema { root };

    run_codex(
        &binary,
        [
            OsString::from("app-server"),
            OsString::from("generate-ts"),
            OsString::from("--experimental"),
            OsString::from("--out"),
            schema.root.clone().into_os_string(),
        ],
    );

    let client_requests = schema.read("ClientRequest.ts");
    for method in [
        "thread/start",
        "thread/name/set",
        "thread/read",
        "thread/fork",
        "thread/delete",
        "thread/section/move",
        "thread/resume",
        "threadSection/list",
        "threadSection/create",
        "thread/unsubscribe",
        "thread/turns/list",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "model/list",
        "permissionProfile/list",
        "mcpServer/resource/read",
        "config/read",
    ] {
        assert!(
            client_requests.contains(&format!("\"method\": \"{method}\"")),
            "missing client request method {method}",
        );
    }

    schema.assert_declares(
        "ClientInfo.ts",
        &["name: string", "title: string | null", "version: string"],
    );
    schema.assert_declares(
        "v2/ThreadResumeParams.ts",
        &[
            "config?:",
            "excludeTurns",
            "initialTurnsPage",
            "serviceTier?: string | null",
        ],
    );
    schema.assert_declares("v2/ThreadStartParams.ts", &["config?:"]);
    schema.assert_declares(
        "v2/McpResourceReadParams.ts",
        &["threadId?: string | null", "server: string", "uri: string"],
    );
    schema.assert_declares(
        "v2/McpResourceReadResponse.ts",
        &["contents: Array<ResourceContent>"],
    );
    schema.assert_declares(
        "v2/ThreadResumeResponse.ts",
        &["cwd: AbsolutePathBuf", "serviceTier: string | null"],
    );
    schema.assert_declares(
        "v2/ThreadListParams.ts",
        &[
            "cursor",
            "sortKey",
            "sortDirection",
            "archived",
            "sectionId?: string | null",
            "useStateDbOnly",
        ],
    );
    schema.assert_declares("v2/ThreadSortKey.ts", &["\"section_position\""]);
    schema.assert_declares("v2/ThreadSection.ts", &["id: string", "name: string"]);
    schema.assert_declares(
        "v2/ThreadSectionListResponse.ts",
        &["data: Array<ThreadSection>", "nextCursor: string | null"],
    );
    schema.assert_declares("v2/ThreadSectionListParams.ts", &["cursor", "limit"]);
    schema.assert_declares("v2/ThreadSectionCreateParams.ts", &["name: string"]);
    schema.assert_declares(
        "v2/ThreadSectionMoveParams.ts",
        &[
            "threadId: string",
            "sectionId: string | null",
            "beforeThreadId?: string | null",
        ],
    );
    schema.assert_declares("v2/ThreadReadParams.ts", &["includeTurns?: boolean"]);
    schema.assert_declares(
        "v2/ThreadForkParams.ts",
        &[
            "threadId: string",
            "lastTurnId?: string | null",
            "cwd?: string | null",
            "runtimeWorkspaceRoots?: Array<AbsolutePathBuf> | null",
            "config?:",
            "excludeTurns",
            "deferGoalContinuation",
        ],
    );
    schema.assert_declares(
        "v2/ThreadForkResponse.ts",
        &["thread: Thread", "cwd: AbsolutePathBuf"],
    );
    schema.assert_declares(
        "v2/Thread.ts",
        &["id: string", "name: string | null", "preview: string"],
    );
    schema.assert_declares(
        "v2/ThreadListResponse.ts",
        &["data: Array<Thread>", "nextCursor: string | null"],
    );
    schema.assert_declares(
        "v2/Model.ts",
        &[
            "serviceTiers: Array<ModelServiceTier>",
            "defaultServiceTier: string | null",
        ],
    );
    schema.assert_declares(
        "v2/ModelServiceTier.ts",
        &["id: string", "name: string", "description: string"],
    );
    schema.assert_declares(
        "v2/TurnStartParams.ts",
        &[
            "clientUserMessageId?: string | null",
            "serviceTier?: string | null",
            "approvalPolicy",
            "approvalsReviewer",
            "permissions",
        ],
    );
    schema.assert_declares(
        "v2/TurnSteerParams.ts",
        &["clientUserMessageId?: string | null"],
    );
    schema.assert_declares("v2/ThreadStartResponse.ts", &["serviceTier: string | null"]);
    schema.assert_declares(
        "v2/ThreadTurnsListResponse.ts",
        &["nextCursor", "backwardsCursor"],
    );
    schema.assert_declares("v2/TurnItemsView.ts", &["\"full\""]);
    schema.assert_declares(
        "v2/ThreadItem.ts",
        &[
            "\"type\": \"userMessage\"",
            "clientId: string | null",
            "\"type\": \"imageGeneration\"",
        ],
    );
    schema.assert_declares(
        "ImageGenerationItem.ts",
        &[
            "id: string",
            "status: string",
            "revisedPrompt: string | null",
            "result: string",
            "savedPath?: AbsolutePathBuf",
        ],
    );
    schema.assert_declares(
        "ResponseItem.ts",
        &[
            "\"type\": \"image_generation_call\"",
            "revised_prompt?: string",
            "result: string",
        ],
    );
    schema.assert_declares(
        "v2/ThreadStatus.ts",
        &[
            "\"type\": \"notLoaded\"",
            "\"type\": \"idle\"",
            "\"type\": \"systemError\"",
            "\"type\": \"active\"",
            "activeFlags: Array<ThreadActiveFlag>",
        ],
    );
    schema.assert_declares(
        "v2/ThreadActiveFlag.ts",
        &["\"waitingOnApproval\"", "\"waitingOnUserInput\""],
    );

    let turn_status = schema.read("v2/TurnStatus.ts");
    for status in ["completed", "interrupted", "failed", "inProgress"] {
        assert!(
            turn_status.contains(&format!("\"{status}\"")),
            "missing turn status {status}",
        );
    }

    for (file, contract) in [
        (
            "v2/ThreadStatusChangedNotification.ts",
            "threadId: string, status: ThreadStatus",
        ),
        (
            "v2/TurnStartedNotification.ts",
            "threadId: string, turn: Turn",
        ),
        (
            "v2/TurnCompletedNotification.ts",
            "threadId: string, turn: Turn",
        ),
    ] {
        schema.assert_declares(file, &[contract]);
    }

    schema.assert_declares(
        "v2/ThreadUnsubscribeStatus.ts",
        &["notLoaded", "notSubscribed", "unsubscribed"],
    );
    schema.assert_declares(
        "v2/ThreadStartParams.ts",
        &[
            "approvalPolicy",
            "approvalsReviewer",
            "permissions",
            "developerInstructions",
            "serviceName?: string | null",
        ],
    );

    let server_requests = schema.read("ServerRequest.ts");
    for (method, description) in [
        ("item/tool/call", "dynamic tool"),
        ("item/permissions/requestApproval", "permission approval"),
    ] {
        assert!(
            server_requests.contains(&format!("\"method\": \"{method}\"")),
            "missing {description} server request",
        );
    }

    schema.assert_declares(
        "v2/PermissionsRequestApprovalParams.ts",
        &[
            "threadId: string",
            "turnId: string",
            "itemId: string",
            "startedAtMs: number",
            "cwd: AbsolutePathBuf",
            "permissions: RequestPermissionProfile",
        ],
    );
    schema.assert_declares(
        "v2/PermissionsRequestApprovalResponse.ts",
        &[
            "permissions: GrantedPermissionProfile",
            "scope: PermissionGrantScope",
        ],
    );
    schema.assert_declares("v2/PermissionGrantScope.ts", &["\"turn\" | \"session\""]);
    schema.assert_declares(
        "v2/DynamicToolCallParams.ts",
        &["threadId: string", "tool: string", "arguments"],
    );
    schema.assert_declares(
        "v2/DynamicToolCallResponse.ts",
        &["contentItems", "success: boolean"],
    );
    schema.assert_declares(
        "v2/ThreadNameUpdatedNotification.ts",
        &["threadId: string", "threadName"],
    );

    let server_notifications = schema.read("ServerNotification.ts");
    assert!(
        server_notifications.contains("\"method\": \"serverRequest/resolved\""),
        "missing server-request resolution notification",
    );
    schema.assert_declares(
        "v2/ServerRequestResolvedNotification.ts",
        &["threadId: string", "requestId: RequestId"],
    );
    schema.assert_declares(
        "v2/PermissionProfileListResponse.ts",
        &["PermissionProfileSummary", "nextCursor"],
    );
}
