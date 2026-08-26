//! Caffold-owned Task tools exposed through Codex's native extension points.
//!
//! New threads discover this catalog through Caffold's MCP server. Codex may
//! still call a `dynamicTools` definition persisted by a pre-MCP thread; those
//! calls keep their historical names while reaching the same Task operations.
//! Caffold no longer advertises dynamic tools on `thread/start`.

use serde_json::{Value, json};

pub(crate) const RENAME_CURRENT_TASK_TOOL_NAME: &str = "rename_current_task";
pub(crate) const LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME: &str = "rename_current_thread";
pub(crate) const ISOLATE_CURRENT_TASK_TOOL_NAME: &str = "isolate_current_task";

pub(super) struct CaffoldToolSpec {
    pub(super) name: &'static str,
    pub(super) description: &'static str,
    pub(super) input_schema: Value,
}

/// Reconstruct the pre-MCP creation payload for its ignored compatibility test.
#[cfg(test)]
pub(super) fn legacy_dynamic_tool_specs() -> [CaffoldToolSpec; 2] {
    [
        rename_current_task_tool(LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME),
        isolate_current_task_tool(),
    ]
}

/// The server-owned catalog discovered when Codex connects or resumes.
pub(super) fn mcp_tool_specs() -> Vec<CaffoldToolSpec> {
    vec![
        rename_current_task_tool(RENAME_CURRENT_TASK_TOOL_NAME),
        isolate_current_task_tool(),
    ]
}

fn isolate_current_task_tool() -> CaffoldToolSpec {
    CaffoldToolSpec {
        name: ISOLATE_CURRENT_TASK_TOOL_NAME,
        description: "Prepare the current Caffold task in a Caffold-managed Git worktree only when the user explicitly asks to isolate the current task or prepare a worktree. By default, leave staged, unstaged, and untracked source checkout changes in place. An optional baseRef creates a new branch from that ref without handing off the current branch and cannot be combined with includeChanges. Set includeChanges to true only when the user explicitly asks to move current or uncommitted changes too. Call this as the final file-affecting action of the current turn. After it succeeds, do not call command or file tools; end the turn so the user's next request can continue in the managed worktree.",
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "branchName": {
                    "type": "string",
                    "description": "Optional local branch name. Without baseRef, a current non-default branch is always handed off unchanged. With baseRef, this names the new branch created from that ref.",
                    "minLength": 1
                },
                "baseRef": {
                    "type": "string",
                    "description": "Optional existing branch, tag, or commit ref to use as the new branch starting point. When provided, the current checkout remains unchanged and includeChanges must be false.",
                    "minLength": 1
                },
                "includeChanges": {
                    "type": "boolean",
                    "description": "Whether to move staged, unstaged, and untracked changes into the worktree. Defaults to false and must be true only when the user explicitly requests that transfer."
                }
            }
        }),
    }
}

fn rename_current_task_tool(name: &'static str) -> CaffoldToolSpec {
    CaffoldToolSpec {
        name,
        description: "Set the user-facing name of the current Caffold task. Never use this tool to rename a different task.",
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The new user-facing name for the current Caffold task.",
                    "minLength": 1
                }
            },
            "required": ["name"]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_new_mcp_name_is_task_owned_while_the_legacy_fixture_keeps_its_old_name() {
        let legacy = legacy_dynamic_tool_specs().map(|tool| tool.name);
        let mcp = mcp_tool_specs()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();

        assert_eq!(
            legacy,
            [
                LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
                ISOLATE_CURRENT_TASK_TOOL_NAME
            ]
        );
        assert_eq!(
            mcp,
            [
                RENAME_CURRENT_TASK_TOOL_NAME,
                ISOLATE_CURRENT_TASK_TOOL_NAME
            ]
        );
    }
}
