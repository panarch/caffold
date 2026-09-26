use serde::{Deserialize, Serialize};

use super::{CodexThread, SortDirection};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)]
pub(crate) enum ThreadSortKey {
    CreatedAt,
    UpdatedAt,
    RecencyAt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadListResponse {
    #[serde(default)]
    pub data: Vec<CodexThread>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadListParams<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: usize,
    sort_key: ThreadSortKey,
    sort_direction: SortDirection,
    archived: bool,
    use_state_db_only: bool,
}

pub(crate) fn thread_list_params(cursor: Option<&str>, limit: usize) -> ThreadListParams<'_> {
    thread_list_params_for_archive_state(cursor, limit, false)
}

pub(crate) fn archived_thread_list_params(
    cursor: Option<&str>,
    limit: usize,
) -> ThreadListParams<'_> {
    thread_list_params_for_archive_state(cursor, limit, true)
}

fn thread_list_params_for_archive_state(
    cursor: Option<&str>,
    limit: usize,
    archived: bool,
) -> ThreadListParams<'_> {
    ThreadListParams {
        cursor: non_empty_cursor(cursor),
        limit,
        sort_key: ThreadSortKey::RecencyAt,
        sort_direction: SortDirection::Desc,
        archived,
        use_state_db_only: true,
    }
}

fn non_empty_cursor(cursor: Option<&str>) -> Option<&str> {
    cursor.filter(|cursor| !cursor.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_active_and_archived_thread_lists() {
        assert_eq!(
            serde_json::to_value(thread_list_params(None, 100))
                .expect("serialize unfiltered thread list"),
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true
            })
        );
        assert_eq!(
            serde_json::to_value(archived_thread_list_params(None, 100))
                .expect("serialize archived thread list"),
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": true,
                "useStateDbOnly": true
            })
        );
    }
}
