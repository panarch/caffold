//! The tools Caffold serves, as its HTTP MCP addresses list them: the
//! Task-owned tools defined here and the Notes tools every agent shares.

use serde_json::{Value, json};

use crate::agent::notes_tools::notes_tool_specs;

pub(crate) const RENAME_CURRENT_TASK_TOOL_NAME: &str = "rename_current_task";
pub(crate) const ISOLATE_CURRENT_TASK_TOOL_NAME: &str = "isolate_current_task";
pub(crate) const READ_CURRENT_TASK_NAME_TOOL_NAME: &str = "read_current_task_name";
pub(crate) const READ_CURRENT_TASK_AGENT_SETTINGS_TOOL_NAME: &str =
    "read_current_task_agent_settings";

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
    task_tools
        .chain(std::iter::once(crate::agent::history::tool_definition()))
        .chain(notes_tools)
        .collect()
}

fn listed_tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

pub(in crate::agent) fn caffold_mcp_tool_specs() -> [McpToolSpec; 4] {
    [
        rename_current_task_tool(),
        isolate_current_task_tool(),
        read_current_task_name_tool(),
        read_current_task_agent_settings_tool(),
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

/// Claude lists this one from here too, so its description has one home.
pub(in crate::agent) fn read_current_task_agent_settings_tool() -> McpToolSpec {
    McpToolSpec {
        name: READ_CURRENT_TASK_AGENT_SETTINGS_TOOL_NAME,
        description: "Read which agent runs the current Caffold task and the settings Caffold started the task's latest turn with: the model, the reasoning effort, whether fast mode was on, and the permission mode. Each value is the choice exactly as Caffold recorded it, under the agent's own name for it except Caffold's own `caffold:ask-jev-first` permission mode, so a model can be an alias such as `opus` rather than an exact version. A null value means Caffold has no record of that setting, so the agent's own default applied. Caffold does not ask the agent, and a setting changed after the turn started is not reflected. The result is JSON.",
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }),
    }
}
