use std::{
    path::Path,
    process::{Command, Output},
};

use serde::Deserialize;

use crate::git;

const MAX_PULL_CONNECTION_ITEMS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepository {
    pub owner: String,
    pub name: String,
    pub name_with_owner: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubCapability {
    pub repository: GithubRepository,
    pub gh_available: bool,
    pub authenticated: bool,
    pub issues_available: bool,
    pub pulls_available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssueSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: u64,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssuePage {
    pub issues: Vec<GithubIssueSummary>,
    pub page: usize,
    pub per_page: usize,
    pub total_issues: usize,
    pub total_pages: usize,
    pub has_previous: bool,
    pub has_next: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIssueDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: u64,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub comments: u64,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullPage {
    pub pulls: Vec<GithubPullSummary>,
    pub page: usize,
    pub per_page: usize,
    pub total_pulls: usize,
    pub total_pages: usize,
    pub has_previous: bool,
    pub has_next: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub comments: u64,
    pub reviews: u64,
    pub commits: u64,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
    pub conversation_comments: Vec<GithubPullComment>,
    pub review_comments: Vec<GithubPullReview>,
    pub commit_summaries: Vec<GithubPullCommit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullComment {
    pub author: Option<String>,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullReview {
    pub author: Option<String>,
    pub state: String,
    pub body: String,
    pub body_html: Option<String>,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub committed_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullFiles {
    pub files: Vec<GithubPullFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubPullFile {
    pub filename: String,
    pub previous_filename: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub patch: Option<String>,
    pub blob_url: Option<String>,
    pub raw_url: Option<String>,
}

pub fn repository_for(repository: &git::Repository) -> Option<GithubRepository> {
    let output = run_git(&repository.root, &["remote", "-v"])?;
    output.lines().find_map(github_repository_from_remote_line)
}

pub fn capability(repository: &git::Repository) -> Option<GithubCapability> {
    let repository = repository_for(repository)?;
    let gh_available = command_success(Command::new("gh").arg("--version").output().ok());
    let authenticated =
        gh_available && command_success(Command::new("gh").arg("auth").arg("status").output().ok());
    let issues_available = gh_available && authenticated;
    let pulls_available = gh_available && authenticated;
    let message = if !gh_available {
        Some("GitHub CLI is not available.".to_string())
    } else if !authenticated {
        Some("GitHub CLI is not authenticated.".to_string())
    } else {
        None
    };

    Some(GithubCapability {
        repository,
        gh_available,
        authenticated,
        issues_available,
        pulls_available,
        message,
    })
}

pub fn issue_page(
    repository: &GithubRepository,
    state: &str,
    page: usize,
    per_page: usize,
) -> Option<GithubIssuePage> {
    let state = normalize_issue_state(state);
    let per_page = per_page.clamp(1, 100);
    let requested_page = page.max(1);
    let mut page = requested_page;
    let mut response = run_issue_search(repository, state, page, per_page)?;
    let page_count = total_pages(response.total_count, per_page);

    if page_count > 0 && requested_page > page_count {
        page = page_count;
        response = run_issue_search(repository, state, page, per_page)?;
    }

    let total_pages = total_pages(response.total_count, per_page);
    let page = if total_pages == 0 { 1 } else { page };
    let issues = response
        .items
        .into_iter()
        .map(GithubIssueSummary::from)
        .collect();

    Some(GithubIssuePage {
        issues,
        page,
        per_page,
        total_issues: response.total_count,
        total_pages,
        has_previous: page > 1 && total_pages > 0,
        has_next: page < total_pages,
    })
}

fn run_issue_search(
    repository: &GithubRepository,
    state: &str,
    page: usize,
    per_page: usize,
) -> Option<GhIssueSearchResponse> {
    let query = issue_search_query(repository, state);
    let output = Command::new("gh")
        .arg("api")
        .arg("-X")
        .arg("GET")
        .arg("search/issues")
        .arg("-f")
        .arg(format!("q={query}"))
        .arg("-f")
        .arg("sort=updated")
        .arg("-f")
        .arg("order=desc")
        .arg("-F")
        .arg(format!("per_page={per_page}"))
        .arg("-F")
        .arg(format!("page={page}"))
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_issue_search(&output.stdout)
}

pub fn issue_detail(repository: &GithubRepository, number: u64) -> Option<GithubIssueDetail> {
    let output = Command::new("gh")
        .arg("api")
        .arg("graphql")
        .arg("-f")
        .arg(format!("owner={}", repository.owner))
        .arg("-f")
        .arg(format!("name={}", repository.name))
        .arg("-F")
        .arg(format!("number={number}"))
        .arg("-f")
        .arg(format!("query={}", issue_detail_query()))
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_issue_detail(&output.stdout)
}

pub fn pull_page(
    repository: &GithubRepository,
    state: &str,
    page: usize,
    per_page: usize,
) -> Option<GithubPullPage> {
    let state = normalize_issue_state(state);
    let per_page = per_page.clamp(1, 100);
    let requested_page = page.max(1);
    let mut page = requested_page;
    let mut response = run_pull_search(repository, state, page, per_page)?;
    let page_count = total_pages(response.total_count, per_page);

    if page_count > 0 && requested_page > page_count {
        page = page_count;
        response = run_pull_search(repository, state, page, per_page)?;
    }

    let total_pages = total_pages(response.total_count, per_page);
    let page = if total_pages == 0 { 1 } else { page };
    let pulls = response
        .items
        .into_iter()
        .map(GithubPullSummary::from)
        .collect();

    Some(GithubPullPage {
        pulls,
        page,
        per_page,
        total_pulls: response.total_count,
        total_pages,
        has_previous: page > 1 && total_pages > 0,
        has_next: page < total_pages,
    })
}

fn run_pull_search(
    repository: &GithubRepository,
    state: &str,
    page: usize,
    per_page: usize,
) -> Option<GhIssueSearchResponse> {
    let query = pull_search_query(repository, state);
    let output = Command::new("gh")
        .arg("api")
        .arg("-X")
        .arg("GET")
        .arg("search/issues")
        .arg("-f")
        .arg(format!("q={query}"))
        .arg("-f")
        .arg("sort=created")
        .arg("-f")
        .arg("order=desc")
        .arg("-F")
        .arg(format!("per_page={per_page}"))
        .arg("-F")
        .arg(format!("page={page}"))
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_issue_search(&output.stdout)
}

pub fn pull_detail(repository: &GithubRepository, number: u64) -> Option<GithubPullDetail> {
    let output = run_pull_graphql(repository, number, pull_detail_query(), None)?;
    let mut pull = parse_pull_detail_raw(&output.stdout)?;
    append_pull_comment_pages(repository, number, &mut pull)?;
    append_pull_review_pages(repository, number, &mut pull)?;
    append_pull_commit_pages(repository, number, &mut pull)?;
    Some(GithubPullDetail::from(pull))
}

pub fn pull_files(repository: &GithubRepository, number: u64) -> Option<GithubPullFiles> {
    let mut files = Vec::new();
    let per_page = 100;
    let mut page = 1;

    loop {
        let mut page_files = run_pull_files_page(repository, number, page, per_page)?;
        let page_len = page_files.len();
        files.append(&mut page_files);
        if page_len < per_page {
            break;
        }

        page += 1;
    }

    Some(GithubPullFiles { files })
}

fn run_pull_files_page(
    repository: &GithubRepository,
    number: u64,
    page: usize,
    per_page: usize,
) -> Option<Vec<GithubPullFile>> {
    let output = Command::new("gh")
        .arg("api")
        .arg("-X")
        .arg("GET")
        .arg(format!(
            "repos/{}/{}/pulls/{number}/files",
            repository.owner, repository.name
        ))
        .arg("-F")
        .arg(format!("per_page={per_page}"))
        .arg("-F")
        .arg(format!("page={page}"))
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_pull_files(&output.stdout)
}

fn append_pull_comment_pages(
    repository: &GithubRepository,
    number: u64,
    pull: &mut GhPullDetail,
) -> Option<()> {
    let nodes = collect_remaining_connection_nodes(
        pull.comments.page_info.clone(),
        pull.comments.nodes.len(),
        |cursor| run_pull_comments_page(repository, number, cursor),
    )?;
    pull.comments.nodes.extend(nodes);
    Some(())
}

fn append_pull_review_pages(
    repository: &GithubRepository,
    number: u64,
    pull: &mut GhPullDetail,
) -> Option<()> {
    let nodes = collect_remaining_connection_nodes(
        pull.reviews.page_info.clone(),
        pull.reviews.nodes.len(),
        |cursor| run_pull_reviews_page(repository, number, cursor),
    )?;
    pull.reviews.nodes.extend(nodes);
    Some(())
}

fn append_pull_commit_pages(
    repository: &GithubRepository,
    number: u64,
    pull: &mut GhPullDetail,
) -> Option<()> {
    let nodes = collect_remaining_connection_nodes(
        pull.commits.page_info.clone(),
        pull.commits.nodes.len(),
        |cursor| run_pull_commits_page(repository, number, cursor),
    )?;
    pull.commits.nodes.extend(nodes);
    Some(())
}

fn collect_remaining_connection_nodes<T, F>(
    mut page_info: GhPageInfo,
    mut total_len: usize,
    mut fetch_page: F,
) -> Option<Vec<T>>
where
    F: FnMut(&str) -> Option<GhConnection<T>>,
{
    let mut nodes = Vec::new();
    let mut previous_cursor = None;

    while page_info.has_next_page && total_len < MAX_PULL_CONNECTION_ITEMS {
        let cursor = page_info.end_cursor.clone()?;
        if previous_cursor.as_deref() == Some(cursor.as_str()) {
            return None;
        }
        previous_cursor = Some(cursor.clone());

        let mut connection = fetch_page(&cursor)?;
        page_info = connection.page_info;

        let remaining = MAX_PULL_CONNECTION_ITEMS.saturating_sub(total_len);
        if connection.nodes.len() > remaining {
            connection.nodes.truncate(remaining);
        }

        total_len += connection.nodes.len();
        nodes.append(&mut connection.nodes);
    }

    Some(nodes)
}

fn run_pull_comments_page(
    repository: &GithubRepository,
    number: u64,
    cursor: &str,
) -> Option<GhPullCommentsConnection> {
    let output = run_pull_graphql(repository, number, pull_comments_page_query(), Some(cursor))?;
    parse_pull_comments_page(&output.stdout)
}

fn run_pull_reviews_page(
    repository: &GithubRepository,
    number: u64,
    cursor: &str,
) -> Option<GhPullReviewsConnection> {
    let output = run_pull_graphql(repository, number, pull_reviews_page_query(), Some(cursor))?;
    parse_pull_reviews_page(&output.stdout)
}

fn run_pull_commits_page(
    repository: &GithubRepository,
    number: u64,
    cursor: &str,
) -> Option<GhPullCommitsConnection> {
    let output = run_pull_graphql(repository, number, pull_commits_page_query(), Some(cursor))?;
    parse_pull_commits_page(&output.stdout)
}

fn run_pull_graphql(
    repository: &GithubRepository,
    number: u64,
    query: &str,
    cursor: Option<&str>,
) -> Option<Output> {
    let mut command = Command::new("gh");
    command
        .arg("api")
        .arg("graphql")
        .arg("-f")
        .arg(format!("owner={}", repository.owner))
        .arg("-f")
        .arg(format!("name={}", repository.name))
        .arg("-F")
        .arg(format!("number={number}"));

    if let Some(cursor) = cursor {
        command.arg("-f").arg(format!("cursor={cursor}"));
    }

    let output = command
        .arg("-f")
        .arg(format!("query={query}"))
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(output)
}

fn normalize_issue_state(state: &str) -> &'static str {
    match state {
        "closed" => "closed",
        "all" => "all",
        _ => "open",
    }
}

fn issue_search_query(repository: &GithubRepository, state: &str) -> String {
    let mut query = format!("repo:{} is:issue", repository.name_with_owner);
    if state != "all" {
        query.push_str(&format!(" is:{state}"));
    }
    query
}

fn pull_search_query(repository: &GithubRepository, state: &str) -> String {
    let mut query = format!("repo:{} is:pr", repository.name_with_owner);
    if state != "all" {
        query.push_str(&format!(" is:{state}"));
    }
    query
}

fn issue_detail_query() -> &'static str {
    r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      author {
        login
      }
      labels(first: 50) {
        nodes {
          name
        }
      }
      assignees(first: 50) {
        nodes {
          login
        }
      }
      comments(first: 1) {
        totalCount
      }
      body
      bodyHTML
      createdAt
      updatedAt
      url
    }
  }
}
"#
}

fn pull_detail_query() -> &'static str {
    r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      state
      isDraft
      author {
        login
      }
      labels(first: 50) {
        nodes {
          name
        }
      }
      comments(first: 100) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            login
          }
          body
          bodyHTML
          createdAt
          updatedAt
          url
        }
      }
      reviews(first: 100) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            login
          }
          state
          body
          bodyHTML
          submittedAt
        }
      }
      commits(first: 100) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          commit {
            oid
            abbreviatedOid
            messageHeadline
            author {
              name
              email
              date
            }
            committedDate
            url
          }
        }
      }
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      body
      bodyHTML
      createdAt
      updatedAt
      url
    }
  }
}
"#
}

fn pull_comments_page_query() -> &'static str {
    r#"
query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100, after: $cursor) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            login
          }
          body
          bodyHTML
          createdAt
          updatedAt
          url
        }
      }
    }
  }
}
"#
}

fn pull_reviews_page_query() -> &'static str {
    r#"
query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            login
          }
          state
          body
          bodyHTML
          submittedAt
        }
      }
    }
  }
}
"#
}

fn pull_commits_page_query() -> &'static str {
    r#"
query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          commit {
            oid
            abbreviatedOid
            messageHeadline
            author {
              name
              email
              date
            }
            committedDate
            url
          }
        }
      }
    }
  }
}
"#
}

fn total_pages(total_count: usize, per_page: usize) -> usize {
    if total_count == 0 {
        0
    } else {
        total_count.div_ceil(per_page)
    }
}

fn command_success(output: Option<Output>) -> bool {
    output
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn run_git(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8(output.stdout).ok()
}

fn github_repository_from_remote_line(line: &str) -> Option<GithubRepository> {
    let mut parts = line.split_whitespace();
    let _remote = parts.next()?;
    let url = parts.next()?;
    github_repository_from_url(url)
}

fn github_repository_from_url(url: &str) -> Option<GithubRepository> {
    let slug = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let slug = slug.trim_end_matches(".git").trim_end_matches('/');
    let mut parts = slug.split('/');
    let owner = parts.next()?.to_string();
    let name = parts.next()?.to_string();
    if parts.next().is_some() || !valid_github_segment(&owner) || !valid_github_segment(&name) {
        return None;
    }
    let name_with_owner = format!("{owner}/{name}");

    Some(GithubRepository {
        owner,
        name,
        url: format!("https://github.com/{name_with_owner}"),
        name_with_owner,
    })
}

fn valid_github_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parse_issue_search(output: &[u8]) -> Option<GhIssueSearchResponse> {
    serde_json::from_slice(output).ok()
}

fn parse_issue_detail(output: &[u8]) -> Option<GithubIssueDetail> {
    let response = serde_json::from_slice::<GhIssueDetailResponse>(output).ok()?;
    response.data.repository.issue.map(GithubIssueDetail::from)
}

#[cfg(test)]
fn parse_pull_detail(output: &[u8]) -> Option<GithubPullDetail> {
    parse_pull_detail_raw(output).map(GithubPullDetail::from)
}

fn parse_pull_detail_raw(output: &[u8]) -> Option<GhPullDetail> {
    let response = serde_json::from_slice::<GhPullDetailResponse>(output).ok()?;
    response.data.repository.pull_request
}

fn parse_pull_comments_page(output: &[u8]) -> Option<GhPullCommentsConnection> {
    let response = serde_json::from_slice::<GhPullCommentsPageResponse>(output).ok()?;
    response
        .data
        .repository
        .pull_request
        .map(|pull| pull.comments)
}

fn parse_pull_reviews_page(output: &[u8]) -> Option<GhPullReviewsConnection> {
    let response = serde_json::from_slice::<GhPullReviewsPageResponse>(output).ok()?;
    response
        .data
        .repository
        .pull_request
        .map(|pull| pull.reviews)
}

fn parse_pull_commits_page(output: &[u8]) -> Option<GhPullCommitsConnection> {
    let response = serde_json::from_slice::<GhPullCommitsPageResponse>(output).ok()?;
    response
        .data
        .repository
        .pull_request
        .map(|pull| pull.commits)
}

fn parse_pull_files(output: &[u8]) -> Option<Vec<GithubPullFile>> {
    serde_json::from_slice::<Vec<GhPullFile>>(output)
        .ok()
        .map(|files| files.into_iter().map(GithubPullFile::from).collect())
}

#[derive(Debug, Deserialize)]
struct GhIssueSearchResponse {
    total_count: usize,
    #[serde(default)]
    items: Vec<GhSearchIssue>,
}

#[derive(Debug, Deserialize)]
struct GhSearchIssue {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    user: Option<GhUser>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    #[serde(default)]
    comments: u64,
    updated_at: Option<String>,
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GhIssueDetailResponse {
    data: GhIssueDetailData,
}

#[derive(Debug, Deserialize)]
struct GhIssueDetailData {
    repository: GhIssueDetailRepository,
}

#[derive(Debug, Deserialize)]
struct GhIssueDetailRepository {
    issue: Option<GhIssueDetail>,
}

#[derive(Debug, Deserialize)]
struct GhPullDetailResponse {
    data: GhPullDetailData,
}

#[derive(Debug, Deserialize)]
struct GhPullDetailData {
    repository: GhPullDetailRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullDetailRepository {
    pull_request: Option<GhPullDetail>,
}

#[derive(Debug, Deserialize)]
struct GhPullCommentsPageResponse {
    data: GhPullCommentsPageData,
}

#[derive(Debug, Deserialize)]
struct GhPullCommentsPageData {
    repository: GhPullCommentsPageRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullCommentsPageRepository {
    pull_request: Option<GhPullCommentsPage>,
}

#[derive(Debug, Deserialize)]
struct GhPullCommentsPage {
    comments: GhPullCommentsConnection,
}

#[derive(Debug, Deserialize)]
struct GhPullReviewsPageResponse {
    data: GhPullReviewsPageData,
}

#[derive(Debug, Deserialize)]
struct GhPullReviewsPageData {
    repository: GhPullReviewsPageRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullReviewsPageRepository {
    pull_request: Option<GhPullReviewsPage>,
}

#[derive(Debug, Deserialize)]
struct GhPullReviewsPage {
    reviews: GhPullReviewsConnection,
}

#[derive(Debug, Deserialize)]
struct GhPullCommitsPageResponse {
    data: GhPullCommitsPageData,
}

#[derive(Debug, Deserialize)]
struct GhPullCommitsPageData {
    repository: GhPullCommitsPageRepository,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullCommitsPageRepository {
    pull_request: Option<GhPullCommitsPage>,
}

#[derive(Debug, Deserialize)]
struct GhPullCommitsPage {
    commits: GhPullCommitsConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullDetail {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    author: Option<GhUser>,
    #[serde(default)]
    labels: GhNodeConnection<GhLabel>,
    #[serde(default)]
    comments: GhPullCommentsConnection,
    #[serde(default)]
    reviews: GhPullReviewsConnection,
    #[serde(default)]
    commits: GhPullCommitsConnection,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    body: String,
    #[serde(rename = "bodyHTML")]
    body_html: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssueDetail {
    number: u64,
    title: String,
    state: String,
    author: Option<GhUser>,
    #[serde(default)]
    labels: GhNodeConnection<GhLabel>,
    #[serde(default)]
    assignees: GhNodeConnection<GhUser>,
    #[serde(default)]
    comments: GhCommentsConnection,
    #[serde(default)]
    body: String,
    #[serde(rename = "bodyHTML")]
    body_html: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    url: String,
}

#[derive(Debug, Default, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Default, Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GhNodeConnection<T> {
    #[serde(default)]
    nodes: Vec<T>,
}

impl<T> Default for GhNodeConnection<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCommentsConnection {
    total_count: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", bound(deserialize = "T: Deserialize<'de>"))]
struct GhConnection<T> {
    #[serde(default)]
    total_count: u64,
    #[serde(default)]
    page_info: GhPageInfo,
    #[serde(default)]
    nodes: Vec<T>,
}

impl<T> Default for GhConnection<T> {
    fn default() -> Self {
        Self {
            total_count: 0,
            page_info: GhPageInfo::default(),
            nodes: Vec::new(),
        }
    }
}

type GhPullCommentsConnection = GhConnection<GhPullComment>;
type GhPullReviewsConnection = GhConnection<GhPullReview>;
type GhPullCommitsConnection = GhConnection<GhPullCommitNode>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullComment {
    author: Option<GhUser>,
    #[serde(default)]
    body: String,
    #[serde(rename = "bodyHTML")]
    body_html: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullReview {
    author: Option<GhUser>,
    state: String,
    #[serde(default)]
    body: String,
    #[serde(rename = "bodyHTML")]
    body_html: Option<String>,
    submitted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPullCommitNode {
    commit: GhPullCommit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullCommit {
    oid: String,
    abbreviated_oid: String,
    message_headline: String,
    author: Option<GhGitActor>,
    committed_date: Option<String>,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GhGitActor {
    name: Option<String>,
    email: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPullFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
    additions: u64,
    deletions: u64,
    changes: u64,
    patch: Option<String>,
    blob_url: Option<String>,
    raw_url: Option<String>,
}

impl From<GhSearchIssue> for GithubIssueSummary {
    fn from(issue: GhSearchIssue) -> Self {
        Self {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.user.map(|author| author.login),
            labels: issue.labels.into_iter().map(|label| label.name).collect(),
            assignees: issue
                .assignees
                .into_iter()
                .map(|assignee| assignee.login)
                .collect(),
            comments: issue.comments,
            updated_at: issue.updated_at,
            url: issue.html_url,
        }
    }
}

impl From<GhSearchIssue> for GithubPullSummary {
    fn from(pull: GhSearchIssue) -> Self {
        Self {
            number: pull.number,
            title: pull.title,
            state: pull.state,
            draft: pull.draft,
            author: pull.user.map(|author| author.login),
            labels: pull.labels.into_iter().map(|label| label.name).collect(),
            comments: pull.comments,
            updated_at: pull.updated_at,
            url: pull.html_url,
        }
    }
}

impl From<GhIssueDetail> for GithubIssueDetail {
    fn from(issue: GhIssueDetail) -> Self {
        Self {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.author.map(|author| author.login),
            labels: issue
                .labels
                .nodes
                .into_iter()
                .map(|label| label.name)
                .collect(),
            assignees: issue
                .assignees
                .nodes
                .into_iter()
                .map(|assignee| assignee.login)
                .collect(),
            comments: issue.comments.total_count,
            body: issue.body,
            body_html: issue.body_html,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            url: issue.url,
        }
    }
}

impl From<GhPullDetail> for GithubPullDetail {
    fn from(pull: GhPullDetail) -> Self {
        Self {
            number: pull.number,
            title: pull.title,
            state: pull.state,
            draft: pull.is_draft,
            author: pull.author.map(|author| author.login),
            labels: pull
                .labels
                .nodes
                .into_iter()
                .map(|label| label.name)
                .collect(),
            comments: pull.comments.total_count,
            reviews: pull.reviews.total_count,
            commits: pull.commits.total_count,
            additions: pull.additions,
            deletions: pull.deletions,
            changed_files: pull.changed_files,
            base_ref_name: pull.base_ref_name,
            head_ref_name: pull.head_ref_name,
            body: pull.body,
            body_html: pull.body_html,
            created_at: pull.created_at,
            updated_at: pull.updated_at,
            url: pull.url,
            conversation_comments: pull
                .comments
                .nodes
                .into_iter()
                .map(GithubPullComment::from)
                .collect(),
            review_comments: pull
                .reviews
                .nodes
                .into_iter()
                .map(GithubPullReview::from)
                .collect(),
            commit_summaries: pull
                .commits
                .nodes
                .into_iter()
                .map(|node| GithubPullCommit::from(node.commit))
                .collect(),
        }
    }
}

impl From<GhPullComment> for GithubPullComment {
    fn from(comment: GhPullComment) -> Self {
        Self {
            author: comment.author.map(|author| author.login),
            body: comment.body,
            body_html: comment.body_html,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            url: comment.url,
        }
    }
}

impl From<GhPullReview> for GithubPullReview {
    fn from(review: GhPullReview) -> Self {
        Self {
            author: review.author.map(|author| author.login),
            state: review.state,
            body: review.body,
            body_html: review.body_html,
            submitted_at: review.submitted_at,
        }
    }
}

impl From<GhPullCommit> for GithubPullCommit {
    fn from(commit: GhPullCommit) -> Self {
        Self {
            sha: commit.oid,
            short_sha: commit.abbreviated_oid,
            subject: commit.message_headline,
            author_name: commit
                .author
                .as_ref()
                .and_then(|author| author.name.clone()),
            author_email: commit
                .author
                .as_ref()
                .and_then(|author| author.email.clone()),
            authored_at: commit.author.and_then(|author| author.date),
            committed_at: commit.committed_date,
            url: commit.url,
        }
    }
}

impl From<GhPullFile> for GithubPullFile {
    fn from(file: GhPullFile) -> Self {
        Self {
            filename: file.filename,
            previous_filename: file.previous_filename,
            status: pull_file_status_code(&file.status).to_string(),
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
            blob_url: file.blob_url,
            raw_url: file.raw_url,
        }
    }
}

fn pull_file_status_code(status: &str) -> &'static str {
    match status {
        "added" => "A",
        "removed" => "D",
        "renamed" => "R",
        "copied" => "C",
        "changed" | "modified" => "M",
        _ => "M",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remote_urls() {
        let https = github_repository_from_url("https://github.com/example/caffold.git").unwrap();
        let ssh = github_repository_from_url("git@github.com:example/caffold.git").unwrap();
        let explicit_ssh =
            github_repository_from_url("ssh://git@github.com/example/caffold.git").unwrap();

        assert_eq!(https.name_with_owner, "example/caffold");
        assert_eq!(ssh, https);
        assert_eq!(explicit_ssh, https);
        assert!(github_repository_from_url("https://gitlab.com/example/caffold.git").is_none());
    }

    #[test]
    fn parses_issue_search_json() {
        let response = parse_issue_search(
            br#"{
              "total_count": 75,
              "items": [
                {
                  "number": 42,
                  "title": "Track review flow",
                  "state": "open",
                  "user": { "login": "taehoon" },
                  "labels": [{ "name": "ui" }],
                  "assignees": [{ "login": "codex" }],
                  "comments": 4,
                  "updated_at": "2026-07-01T10:00:00Z",
                  "html_url": "https://github.com/example/caffold/issues/42"
                }
              ]
            }"#,
        )
        .unwrap();
        let issues = response
            .items
            .into_iter()
            .map(GithubIssueSummary::from)
            .collect::<Vec<_>>();

        assert_eq!(response.total_count, 75);
        assert_eq!(total_pages(response.total_count, 50), 2);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 42);
        assert_eq!(issues[0].comments, 4);
        assert_eq!(
            issues[0].url,
            "https://github.com/example/caffold/issues/42"
        );
    }

    #[test]
    fn parses_issue_detail_graphql_json() {
        let issue = parse_issue_detail(
            br#"{
              "data": {
                "repository": {
                  "issue": {
                    "number": 9,
                    "title": "Add issue viewer",
                    "state": "OPEN",
                    "author": { "login": "taehoon" },
                    "labels": { "nodes": [{ "name": "ui" }] },
                    "assignees": { "nodes": [{ "login": "codex" }] },
                    "comments": { "totalCount": 2 },
                    "body": "**Issue** body",
                    "bodyHTML": "<p><strong>Issue</strong> body</p>",
                    "createdAt": "2026-07-01T09:00:00Z",
                    "updatedAt": "2026-07-01T10:00:00Z",
                    "url": "https://github.com/example/caffold/issues/9"
                  }
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(issue.number, 9);
        assert_eq!(issue.labels, ["ui"]);
        assert_eq!(issue.assignees, ["codex"]);
        assert_eq!(issue.comments, 2);
        assert_eq!(issue.body, "**Issue** body");
        assert_eq!(
            issue.body_html.as_deref(),
            Some("<p><strong>Issue</strong> body</p>")
        );
    }

    #[test]
    fn parses_pull_search_json() {
        let response = parse_issue_search(
            br#"{
              "total_count": 12,
              "items": [
                {
                  "number": 17,
                  "title": "Add PR review surface",
                  "state": "open",
                  "draft": true,
                  "user": { "login": "taehoon" },
                  "labels": [{ "name": "ui" }],
                  "comments": 5,
                  "updated_at": "2026-07-02T10:00:00Z",
                  "html_url": "https://github.com/example/caffold/pull/17"
                }
              ]
            }"#,
        )
        .unwrap();
        let pulls = response
            .items
            .into_iter()
            .map(GithubPullSummary::from)
            .collect::<Vec<_>>();

        assert_eq!(response.total_count, 12);
        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 17);
        assert!(pulls[0].draft);
        assert_eq!(pulls[0].comments, 5);
        assert_eq!(pulls[0].labels, ["ui"]);
    }

    #[test]
    fn parses_pull_detail_graphql_json() {
        let pull = parse_pull_detail(
            br#"{
              "data": {
                "repository": {
                  "pullRequest": {
                    "number": 17,
                    "title": "Add PR review surface",
                    "state": "OPEN",
                    "isDraft": false,
                    "author": { "login": "taehoon" },
                    "labels": { "nodes": [{ "name": "review" }] },
                    "comments": {
                      "totalCount": 1,
                      "nodes": [
                        {
                          "author": { "login": "codex" },
                          "body": "Conversation body",
                          "bodyHTML": "<p>Conversation body</p>",
                          "createdAt": "2026-07-02T08:00:00Z",
                          "updatedAt": "2026-07-02T08:30:00Z",
                          "url": "https://github.com/example/caffold/pull/17#issuecomment-1"
                        }
                      ]
                    },
                    "reviews": {
                      "totalCount": 1,
                      "nodes": [
                        {
                          "author": { "login": "reviewer" },
                          "state": "COMMENTED",
                          "body": "Review body",
                          "bodyHTML": "<p>Review body</p>",
                          "submittedAt": "2026-07-02T09:00:00Z"
                        }
                      ]
                    },
                    "commits": {
                      "totalCount": 1,
                      "nodes": [
                        {
                          "commit": {
                            "oid": "abcdef1234567890",
                            "abbreviatedOid": "abcdef1",
                            "messageHeadline": "Add pull viewer",
                            "author": {
                              "name": "Taehoon Moon",
                              "email": "taehoon@example.test",
                              "date": "2026-07-02T07:00:00Z"
                            },
                            "committedDate": "2026-07-02T07:05:00Z",
                            "url": "https://github.com/example/caffold/commit/abcdef1"
                          }
                        }
                      ]
                    },
                    "additions": 10,
                    "deletions": 4,
                    "changedFiles": 3,
                    "baseRefName": "main",
                    "headRefName": "feature/prs",
                    "body": "**Pull** body",
                    "bodyHTML": "<p><strong>Pull</strong> body</p>",
                    "createdAt": "2026-07-02T06:00:00Z",
                    "updatedAt": "2026-07-02T10:00:00Z",
                    "url": "https://github.com/example/caffold/pull/17"
                  }
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(pull.number, 17);
        assert_eq!(pull.labels, ["review"]);
        assert_eq!(pull.comments, 1);
        assert_eq!(pull.reviews, 1);
        assert_eq!(pull.commits, 1);
        assert_eq!(pull.changed_files, 3);
        assert_eq!(pull.base_ref_name, "main");
        assert_eq!(pull.head_ref_name, "feature/prs");
        assert_eq!(
            pull.conversation_comments[0].author.as_deref(),
            Some("codex")
        );
        assert_eq!(pull.review_comments[0].state, "COMMENTED");
        assert_eq!(pull.commit_summaries[0].short_sha, "abcdef1");
        assert_eq!(
            pull.body_html.as_deref(),
            Some("<p><strong>Pull</strong> body</p>")
        );
    }

    #[test]
    fn collects_remaining_pull_connection_pages() {
        let mut cursors = Vec::new();
        let mut pages = vec![
            GhConnection {
                total_count: 3,
                page_info: GhPageInfo {
                    has_next_page: true,
                    end_cursor: Some("cursor-b".to_string()),
                },
                nodes: vec![2],
            },
            GhConnection {
                total_count: 3,
                page_info: GhPageInfo {
                    has_next_page: false,
                    end_cursor: None,
                },
                nodes: vec![3],
            },
        ]
        .into_iter();

        let nodes = collect_remaining_connection_nodes(
            GhPageInfo {
                has_next_page: true,
                end_cursor: Some("cursor-a".to_string()),
            },
            1,
            |cursor| {
                cursors.push(cursor.to_string());
                pages.next()
            },
        )
        .unwrap();

        assert_eq!(
            cursors,
            vec!["cursor-a".to_string(), "cursor-b".to_string()]
        );
        assert_eq!(nodes, vec![2, 3]);
    }

    #[test]
    fn caps_remaining_pull_connection_pages() {
        let mut calls = 0;
        let nodes = collect_remaining_connection_nodes(
            GhPageInfo {
                has_next_page: true,
                end_cursor: Some("cursor-a".to_string()),
            },
            MAX_PULL_CONNECTION_ITEMS - 1,
            |_| {
                calls += 1;
                Some(GhConnection {
                    total_count: 2000,
                    page_info: GhPageInfo {
                        has_next_page: true,
                        end_cursor: Some("cursor-b".to_string()),
                    },
                    nodes: vec![1, 2, 3],
                })
            },
        )
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(nodes, vec![1]);
    }

    #[test]
    fn parses_pull_files_json() {
        let files = parse_pull_files(
            br#"[
              {
                "filename": "src/app.rs",
                "status": "modified",
                "additions": 8,
                "deletions": 2,
                "changes": 10,
                "patch": "@@ -1 +1 @@\n-old\n+new",
                "blob_url": "https://github.com/example/caffold/blob/sha/src/app.rs",
                "raw_url": "https://github.com/example/caffold/raw/sha/src/app.rs"
              },
              {
                "filename": "assets/image.png",
                "status": "added",
                "additions": 0,
                "deletions": 0,
                "changes": 0,
                "patch": null,
                "blob_url": "https://github.com/example/caffold/blob/sha/assets/image.png",
                "raw_url": "https://github.com/example/caffold/raw/sha/assets/image.png"
              },
              {
                "filename": "src/new.rs",
                "previous_filename": "src/old.rs",
                "status": "renamed",
                "additions": 1,
                "deletions": 1,
                "changes": 2,
                "patch": "@@ -1 +1 @@\n-old\n+new",
                "blob_url": null,
                "raw_url": null
              }
            ]"#,
        )
        .unwrap();

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].patch.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
        assert_eq!(files[1].status, "A");
        assert!(files[1].patch.is_none());
        assert_eq!(files[2].status, "R");
        assert_eq!(files[2].previous_filename.as_deref(), Some("src/old.rs"));
    }
}
