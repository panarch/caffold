use serde::{Deserialize, Serialize};

use super::{CodexThread, SortDirection};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)]
pub(crate) enum ThreadSortKey {
    CreatedAt,
    UpdatedAt,
    RecencyAt,
    SectionPosition,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThreadSectionFilter<'a> {
    Unsectioned,
    Section(&'a str),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    section_id: Option<Option<&'a str>>,
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
        section_id: None,
    }
}

pub(crate) fn section_thread_list_params<'a>(
    section: ThreadSectionFilter<'a>,
    cursor: Option<&'a str>,
    limit: usize,
) -> ThreadListParams<'a> {
    let (sort_key, sort_direction, section_id) = match section {
        ThreadSectionFilter::Unsectioned => {
            (ThreadSortKey::RecencyAt, SortDirection::Desc, Some(None))
        }
        ThreadSectionFilter::Section(section_id) => (
            ThreadSortKey::SectionPosition,
            SortDirection::Asc,
            Some(Some(section_id)),
        ),
    };
    ThreadListParams {
        cursor: non_empty_cursor(cursor),
        limit,
        sort_key,
        sort_direction,
        archived: false,
        use_state_db_only: true,
        section_id,
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
    fn section_filter_preserves_omitted_null_and_value_states() {
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
        let fixtures = [
            (
                ThreadSectionFilter::Unsectioned,
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                    "sectionId": null
                }),
            ),
            (
                ThreadSectionFilter::Section("section-1"),
                json!({
                    "limit": 100,
                    "sortKey": "section_position",
                    "sortDirection": "asc",
                    "archived": false,
                    "useStateDbOnly": true,
                    "sectionId": "section-1"
                }),
            ),
        ];

        for (filter, expected) in fixtures {
            assert_eq!(
                serde_json::to_value(section_thread_list_params(filter, None, 100))
                    .expect("serialize section-aware thread list"),
                expected
            );
        }
    }
}
