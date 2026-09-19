use std::time::Duration;

use reqwest::Client;
use semver::Version;
use serde::Deserialize;

/// The channel Codex's own `install.sh` resolves `latest` from before it falls
/// back to GitHub Releases, so it names what `codex app-server daemon update`
/// would install.
const LATEST_CHANNEL: &str = "https://releases.openai.com/codex/channels/latest";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The newest stable Codex, or why Caffold could not learn it.
pub(super) async fn fetch() -> Result<Version, String> {
    fetch_from(&Client::new(), LATEST_CHANNEL).await
}

async fn fetch_from(client: &Client, url: &str) -> Result<Version, String> {
    let response = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("Caffold could not reach the Codex release channel: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The Codex release channel answered HTTP {status}."));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Caffold could not read the Codex release channel: {error}"))?;
    let release = serde_json::from_slice::<ChannelRelease>(&body).map_err(|error| {
        format!("The Codex release channel sent a release Caffold could not read: {error}")
    })?;
    release_version(&release.tag_name)
}

#[derive(Deserialize)]
struct ChannelRelease {
    tag_name: String,
}

fn release_version(tag: &str) -> Result<Version, String> {
    tag.strip_prefix("rust-v")
        .and_then(|version| Version::parse(version).ok())
        .ok_or_else(|| format!("The Codex release channel named an unexpected release: {tag}"))
}

#[cfg(test)]
mod tests {
    use axum::{Router, http::StatusCode};

    use super::*;

    /// The shape `releases.openai.com` answered on 2026-09-19, trimmed to one
    /// asset.
    const LATEST: &str = r#"{"tag_name":"rust-v0.155.1","assets":[{"name":"argument-comment-lint","digest":"sha256:775f2ffd87ff9d8f8184dacaace6dd77942abab79bc0ef145c81603214bc9c56","browser_download_url":"https://releases.openai.com/codex/releases/0.155.1/argument-comment-lint"}]}"#;

    async fn channel(status: StatusCode, body: &'static str) -> String {
        let app = Router::new().fallback(move || async move {
            (status, [("content-type", "application/json")], body)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}/codex/channels/latest")
    }

    #[tokio::test]
    async fn reads_the_newest_release_from_the_channel() {
        let url = channel(StatusCode::OK, LATEST).await;

        assert_eq!(
            fetch_from(&Client::new(), &url).await,
            Ok(Version::parse("0.155.1").unwrap())
        );
    }

    #[tokio::test]
    async fn explains_a_channel_that_did_not_name_a_release() {
        for (status, body, expected) in [
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "{}",
                "The Codex release channel answered HTTP 503 Service Unavailable.",
            ),
            (
                StatusCode::OK,
                r#"{"name":"0.155.1"}"#,
                "The Codex release channel sent a release Caffold could not read",
            ),
            (
                StatusCode::OK,
                r#"{"tag_name":"v0.155.1"}"#,
                "The Codex release channel named an unexpected release: v0.155.1",
            ),
            (
                StatusCode::OK,
                r#"{"tag_name":"rust-vnext"}"#,
                "The Codex release channel named an unexpected release: rust-vnext",
            ),
        ] {
            let url = channel(status, body).await;

            let problem = fetch_from(&Client::new(), &url).await.unwrap_err();

            assert!(problem.starts_with(expected), "{problem}");
        }
    }

    #[tokio::test]
    async fn explains_a_channel_it_could_not_reach() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        drop(listener);

        let problem = fetch_from(&Client::new(), &url).await.unwrap_err();

        assert!(
            problem.starts_with("Caffold could not reach the Codex release channel"),
            "{problem}"
        );
    }
}
