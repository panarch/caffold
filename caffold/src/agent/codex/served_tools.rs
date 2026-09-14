//! The historical name a pre-MCP Codex thread may still call a Caffold Task
//! tool by.
//!
//! New threads discover Caffold's Task tools through Caffold's MCP server.
//! Codex may still call a `dynamicTools` definition persisted by a pre-MCP
//! thread; those calls keep their historical names while reaching the same
//! Task operations. Caffold does not advertise dynamic tools on `thread/start`.

#[cfg(test)]
use crate::agent::http_mcp::{McpToolSpec, RENAME_CURRENT_TASK_TOOL_NAME, caffold_mcp_tool_specs};

pub(crate) const LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME: &str = "rename_current_thread";

/// Reconstruct the pre-MCP creation payload for its ignored compatibility test.
#[cfg(test)]
pub(super) fn legacy_dynamic_tool_specs() -> [McpToolSpec; 2] {
    caffold_mcp_tool_specs().map(|tool| {
        if tool.name == RENAME_CURRENT_TASK_TOOL_NAME {
            McpToolSpec {
                name: LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
                ..tool
            }
        } else {
            tool
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::http_mcp::ISOLATE_CURRENT_TASK_TOOL_NAME;

    #[test]
    fn the_new_mcp_name_is_task_owned_while_the_legacy_fixture_keeps_its_old_name() {
        let legacy = legacy_dynamic_tool_specs().map(|tool| tool.name);
        let mcp = caffold_mcp_tool_specs().map(|tool| tool.name);

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
