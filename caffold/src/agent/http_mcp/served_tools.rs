//! The tools Caffold serves, as both agents' MCP addresses list them: the
//! Task-owned tools defined here and the Notes tools every agent shares.

use serde_json::{Value, json};

use crate::agent::notes_tools::notes_tool_specs;

pub(crate) const RENAME_CURRENT_TASK_TOOL_NAME: &str = "rename_current_task";
pub(crate) const ISOLATE_CURRENT_TASK_TOOL_NAME: &str = "isolate_current_task";
pub(crate) const READ_CURRENT_TASK_NAME_TOOL_NAME: &str = "read_current_task_name";

pub(in crate::agent) struct McpToolSpec {
    pub(in crate::agent) name: &'static str,
    pub(in crate::agent) description: &'static str,
    pub(in crate::agent) input_schema: Value,
}

/// The catalog an MCP `tools/list` answers with.
pub(crate) fn caffold_mcp_tools() -> Vec<Value> {
    let task_tools = caffold_mcp_tool_specs()
        .into_iter()
        .map(|tool| listed_tool(tool.name, tool.description, tool.input_schema));
    let notes_tools = notes_tool_specs()
        .into_iter()
        .map(|tool| listed_tool(tool.name, tool.description, tool.input_schema));
    task_tools.chain(notes_tools).collect()
}

fn listed_tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

pub(in crate::agent) fn caffold_mcp_tool_specs() -> [McpToolSpec; 3] {
    [
        rename_current_task_tool(),
        isolate_current_task_tool(),
        read_current_task_name_tool(),
    ]
}

fn isolate_current_task_tool() -> McpToolSpec {
    McpToolSpec {
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

fn rename_current_task_tool() -> McpToolSpec {
    McpToolSpec {
        name: RENAME_CURRENT_TASK_TOOL_NAME,
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

fn read_current_task_name_tool() -> McpToolSpec {
    McpToolSpec {
        name: READ_CURRENT_TASK_NAME_TOOL_NAME,
        description: "Read the user-facing name of the current Caffold task, as Caffold shows it. The result is the name alone, as plain text.",
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }),
    }
}
