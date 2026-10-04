use std::{env, time::Duration};

use reqwest::Client;
use semver::Version;
use serde::Deserialize;

/// GitHub answers with the newest release that is neither a draft nor a
/// pre-release; the menu-bar app reads the same endpoint.
const LATEST_RELEASE: &str = "https://api.github.com/repos/panarch/caffold/releases/latest";
/// Points the check somewhere else, so a test server does not depend on what
/// GitHub has published.
const LATEST_RELEASE_OVERRIDE: &str = "CAFFOLD_LATEST_RELEASE_URL";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LatestRelease {
    pub(crate) version: Version,
    pub(crate) url: String,
}

/// The newest stable Caffold release, or why Caffold could not learn it.
pub(crate) async fn fetch_latest_release() -> Result<LatestRelease, String> {
    let url = env::var(LATEST_RELEASE_OVERRIDE).unwrap_or_else(|_| LATEST_RELEASE.to_string());
    fetch_from(&Client::new(), &url).await
}

async fn fetch_from(client: &Client, url: &str) -> Result<LatestRelease, String> {
    let response = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", concat!("Caffold/", env!("CARGO_PKG_VERSION")))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("Caffold could not reach GitHub: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub answered HTTP {status}."));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Caffold could not read GitHub's answer: {error}"))?;
    let release = serde_json::from_slice::<GitHubRelease>(&body)
        .map_err(|error| format!("GitHub sent a release Caffold could not read: {error}"))?;
    if release.draft || release.prerelease {
        return Err(format!(
            "GitHub named a draft or pre-release as the latest Caffold: {}",
            release.tag_name
        ));
    }
    let version = release_version(&release.tag_name)?;
    Ok(LatestRelease {
        version,
        url: release.html_url,
    })
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
}

fn release_version(tag: &str) -> Result<Version, String> {
    tag.strip_prefix('v')
        .and_then(|version| Version::parse(version).ok())
        .ok_or_else(|| format!("GitHub named an unexpected Caffold release: {tag}"))
}

#[cfg(test)]
mod tests {
    use axum::{Router, http::HeaderMap, http::StatusCode, routing::get};

    use super::*;

    /// The fields `api.github.com` answered with for v0.18.2 on 2026-10-04,
    /// without the assets and author.
    const LATEST: &str = r#"{"tag_name":"v0.18.2","html_url":"https://github.com/panarch/caffold/releases/tag/v0.18.2","draft":false,"prerelease":false,"name":"v0.18.2"}"#;

    async fn github(status: StatusCode, body: &'static str) -> String {
        let app = Router::new().fallback(move || async move {
            (status, [("content-type", "application/json")], body)
        });
        serve(app).await
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}/repos/panarch/caffold/releases/latest")
    }

    #[tokio::test]
    async fn reads_the_newest_stable_release() {
        let url = github(StatusCode::OK, LATEST).await;

        assert_eq!(
            fetch_from(&Client::new(), &url).await,
            Ok(LatestRelease {
                version: Version::new(0, 18, 2),
                url: "https://github.com/panarch/caffold/releases/tag/v0.18.2".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn names_itself_to_github() {
        let app = Router::new().fallback(get(|headers: HeaderMap| async move {
            let header = |name: &str| {
                headers
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string()
            };
            let expected = (
                "application/vnd.github+json".to_string(),
                concat!("Caffold/", env!("CARGO_PKG_VERSION")).to_string(),
                "2022-11-28".to_string(),
            );
            let actual = (
                header("accept"),
                header("user-agent"),
                header("x-github-api-version"),
            );
            if actual == expected {
                (StatusCode::OK, LATEST)
            } else {
                (StatusCode::FORBIDDEN, "{}")
            }
        }));
        let url = serve(app).await;

        assert!(fetch_from(&Client::new(), &url).await.is_ok());
    }

    #[tokio::test]
    async fn explains_an_answer_that_did_not_name_a_stable_release() {
        for (status, body, expected) in [
            (
                StatusCode::FORBIDDEN,
                "{}",
                "GitHub answered HTTP 403 Forbidden.",
            ),
            (
                StatusCode::OK,
                r#"{"name":"v0.18.2"}"#,
                "GitHub sent a release Caffold could not read",
            ),
            (
                StatusCode::OK,
                r#"{"tag_name":"v0.19.0","html_url":"https://example.test","draft":true,"prerelease":false}"#,
                "GitHub named a draft or pre-release as the latest Caffold: v0.19.0",
            ),
            (
                StatusCode::OK,
                r#"{"tag_name":"v0.19.0-rc.1","html_url":"https://example.test","draft":false,"prerelease":true}"#,
                "GitHub named a draft or pre-release as the latest Caffold: v0.19.0-rc.1",
            ),
            (
                StatusCode::OK,
                r#"{"tag_name":"next","html_url":"https://example.test","draft":false,"prerelease":false}"#,
                "GitHub named an unexpected Caffold release: next",
            ),
        ] {
            let url = github(status, body).await;

            let problem = fetch_from(&Client::new(), &url).await.unwrap_err();

            assert!(problem.starts_with(expected), "{problem}");
        }
    }

    #[tokio::test]
    async fn explains_github_it_could_not_reach() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        drop(listener);

        let problem = fetch_from(&Client::new(), &url).await.unwrap_err();

        assert!(
            problem.starts_with("Caffold could not reach GitHub"),
            "{problem}"
        );
    }
}
