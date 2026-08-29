use serde::{Deserialize, Serialize};

pub(crate) const THREAD_SECTION_LIST: &str = "threadSection/list";
pub(crate) const THREAD_SECTION_CREATE: &str = "threadSection/create";
pub(crate) const THREAD_SECTION_MOVE: &str = "thread/section/move";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSection {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSectionListResponse {
    #[serde(default)]
    pub data: Vec<ThreadSection>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSectionCreateResponse {
    pub section: ThreadSection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub(crate) struct ThreadSectionMoveResponse {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSectionListParams<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSectionCreateParams<'a> {
    name: &'a str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadSectionMoveParams<'a> {
    thread_id: &'a str,
    section_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before_thread_id: Option<&'a str>,
}

pub(crate) fn thread_section_list_params(
    cursor: Option<&str>,
    limit: usize,
) -> ThreadSectionListParams<'_> {
    ThreadSectionListParams {
        cursor: cursor.filter(|cursor| !cursor.is_empty()),
        limit,
    }
}

pub(crate) fn thread_section_create_params(name: &str) -> ThreadSectionCreateParams<'_> {
    ThreadSectionCreateParams { name }
}

pub(crate) fn thread_section_move_params<'a>(
    thread_id: &'a str,
    section_id: Option<&'a str>,
    before_thread_id: Option<&'a str>,
) -> ThreadSectionMoveParams<'a> {
    ThreadSectionMoveParams {
        thread_id,
        section_id,
        before_thread_id,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_supported_section_mutations() {
        assert_eq!(
            serde_json::to_value(thread_section_create_params("Workspace/rust/codger"))
                .expect("serialize section creation"),
            json!({ "name": "Workspace/rust/codger" })
        );
        assert_eq!(
            serde_json::to_value(thread_section_move_params(
                "thread-1",
                Some("section-1"),
                Some("thread-2"),
            ))
            .expect("serialize section move"),
            json!({
                "threadId": "thread-1",
                "sectionId": "section-1",
                "beforeThreadId": "thread-2"
            })
        );
        assert_eq!(
            serde_json::to_value(thread_section_move_params("thread-1", None, None))
                .expect("serialize section removal"),
            json!({
                "threadId": "thread-1",
                "sectionId": null
            })
        );
    }
}
