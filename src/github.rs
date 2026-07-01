use std::{
    path::Path,
    process::{Command, Output},
};

use serde::Deserialize;

use crate::git;

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
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
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
        .arg("-R")
        .arg(&repository.name_with_owner)
        .arg("issue")
        .arg("view")
        .arg(number.to_string())
        .arg("--json")
        .arg("number,title,state,author,labels,assignees,comments,body,createdAt,updatedAt,url")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_issue_detail(&output.stdout)
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
    serde_json::from_slice::<GhIssueDetail>(output)
        .ok()
        .map(GithubIssueDetail::from)
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
#[serde(rename_all = "camelCase")]
struct GhIssueDetail {
    number: u64,
    title: String,
    state: String,
    author: Option<GhUser>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    #[serde(default)]
    comments: GhComments,
    #[serde(default)]
    body: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(untagged)]
enum GhComments {
    Count(u64),
    Items(Vec<serde_json::Value>),
    #[default]
    Missing,
}

impl GhComments {
    fn count(&self) -> u64 {
        match self {
            Self::Count(count) => *count,
            Self::Items(items) => items.len() as u64,
            Self::Missing => 0,
        }
    }
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

impl From<GhIssueDetail> for GithubIssueDetail {
    fn from(issue: GhIssueDetail) -> Self {
        Self {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.author.map(|author| author.login),
            labels: issue.labels.into_iter().map(|label| label.name).collect(),
            assignees: issue
                .assignees
                .into_iter()
                .map(|assignee| assignee.login)
                .collect(),
            comments: issue.comments.count(),
            body: issue.body,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            url: issue.url,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remote_urls() {
        let https = github_repository_from_url("https://github.com/example/codger.git").unwrap();
        let ssh = github_repository_from_url("git@github.com:example/codger.git").unwrap();
        let explicit_ssh =
            github_repository_from_url("ssh://git@github.com/example/codger.git").unwrap();

        assert_eq!(https.name_with_owner, "example/codger");
        assert_eq!(ssh, https);
        assert_eq!(explicit_ssh, https);
        assert!(github_repository_from_url("https://gitlab.com/example/codger.git").is_none());
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
                  "html_url": "https://github.com/example/codger/issues/42"
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
        assert_eq!(issues[0].url, "https://github.com/example/codger/issues/42");
    }

    #[test]
    fn parses_issue_detail_json_with_comment_items() {
        let issue = parse_issue_detail(
            br#"{
              "number": 9,
              "title": "Add issue viewer",
              "state": "OPEN",
              "author": { "login": "taehoon" },
              "labels": [],
              "assignees": [],
              "comments": [{ "id": 1 }, { "id": 2 }],
              "body": "Issue body",
              "createdAt": "2026-07-01T09:00:00Z",
              "updatedAt": "2026-07-01T10:00:00Z",
              "url": "https://github.com/example/codger/issues/9"
            }"#,
        )
        .unwrap();

        assert_eq!(issue.number, 9);
        assert_eq!(issue.comments, 2);
        assert_eq!(issue.body, "Issue body");
    }
}
