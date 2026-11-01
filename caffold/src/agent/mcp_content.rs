//! The content blocks MCP defines for what a tool returns, as tool result
//! parts.
//!
//! Codex reports an MCP tool's result in these blocks, and ACP, which Grok and
//! Antigravity speak, carries tool output in the same ones.

use serde_json::Value;

use super::ToolResultPart;

/// One block as a result part: text as text, a picture, a sound, or a
/// resource's bytes as the kind of binary it was, anything else as sent.
pub(super) fn tool_result_part(block: &Value) -> ToolResultPart {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => match block.get("text").and_then(Value::as_str) {
            Some(text) => ToolResultPart::Text(text.to_string()),
            None => ToolResultPart::Json(block.clone()),
        },
        Some("image" | "audio") => ToolResultPart::Binary {
            media_type: media_type(block),
        },
        Some("resource") if block.pointer("/resource/blob").is_some() => ToolResultPart::Binary {
            media_type: block.get("resource").and_then(media_type),
        },
        _ => ToolResultPart::Json(block.clone()),
    }
}

fn media_type(value: &Value) -> Option<String> {
    value
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn text_stays_text_and_bytes_keep_only_their_kind() {
        assert_eq!(
            tool_result_part(&json!({ "type": "text", "text": "done" })),
            ToolResultPart::Text("done".to_string())
        );
        assert_eq!(
            tool_result_part(&json!({ "type": "image", "data": "iVBOR", "mimeType": "image/png" })),
            ToolResultPart::Binary {
                media_type: Some("image/png".to_string())
            }
        );
        assert_eq!(
            tool_result_part(&json!({ "type": "audio", "data": "UklGR" })),
            ToolResultPart::Binary { media_type: None }
        );
        assert_eq!(
            tool_result_part(&json!({
                "type": "resource",
                "resource": { "uri": "file:///a.pdf", "mimeType": "application/pdf", "blob": "JVBER" }
            })),
            ToolResultPart::Binary {
                media_type: Some("application/pdf".to_string())
            }
        );
    }

    #[test]
    fn any_other_block_arrives_as_sent() {
        for block in [
            json!({ "type": "resource", "resource": { "uri": "file:///a.md", "text": "# A" } }),
            json!({ "type": "resource_link", "uri": "file:///b.md", "name": "b.md" }),
            json!({ "type": "text" }),
            json!({ "type": "somethingNew", "value": 1 }),
        ] {
            assert_eq!(tool_result_part(&block), ToolResultPart::Json(block));
        }
    }
}
