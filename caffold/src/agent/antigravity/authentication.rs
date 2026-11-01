//! Explicit native Google authentication and a single-use remote loopback handoff.
//! Codes, URLs and credentials are never persisted or written to diagnostics.
use super::{AntigravityError, installation, protocol};
use crate::agent::runner::RunnerClient;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex, watch},
};
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthPhase {
    Idle,
    Starting,
    AwaitingCallback,
    Completing,
    SigningOut,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStatus {
    phase: AuthPhase,
    request_id: Option<String>,
    authorization_url: Option<String>,
    verified: Option<Verified>,
    error: Option<String>,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verified {
    authenticated: bool,
    tier: Option<Tier>,
    verified_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct Tier {
    id: String,
    name: String,
}
#[derive(Clone)]
pub(super) struct Authentication {
    data: PathBuf,
    native_home: PathBuf,
    runner: RunnerClient,
    state: Arc<Mutex<State>>,
}
struct State {
    phase: AuthPhase,
    job: Option<Job>,
    verified: Option<Verified>,
    error: Option<String>,
}
enum AuthEvent {
    SignIn,
    SignOut,
    Link,
    Callback,
    Finished,
}
impl State {
    fn transition(&mut self, event: AuthEvent) -> Result<(), AntigravityError> {
        self.phase = match (self.phase, event) {
            (AuthPhase::Idle, AuthEvent::SignIn) => AuthPhase::Starting,
            (AuthPhase::Idle, AuthEvent::SignOut) => AuthPhase::SigningOut,
            (AuthPhase::Starting, AuthEvent::Link) => AuthPhase::AwaitingCallback,
            (AuthPhase::AwaitingCallback, AuthEvent::Callback) => AuthPhase::Completing,
            (
                AuthPhase::Starting
                | AuthPhase::AwaitingCallback
                | AuthPhase::Completing
                | AuthPhase::SigningOut,
                AuthEvent::Finished,
            ) => AuthPhase::Idle,
            _ => return Err(auth_error("invalid or stale authentication transition")),
        };
        Ok(())
    }
}
struct Job {
    id: Uuid,
    cancel: watch::Sender<bool>,
    handoff: Option<Handoff>,
}
struct Handoff {
    authorization: Url,
    target: Url,
    state: String,
}

impl Verified {
    pub(super) fn from_result(authenticated: bool, result: &Value) -> Self {
        Self {
            authenticated,
            tier: if authenticated {
                result
                    .pointer("/_meta/antigravity/tier")
                    .cloned()
                    .and_then(|tier| serde_json::from_value(tier).ok())
            } else {
                None
            },
            verified_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
    pub(super) fn recovered() -> Self {
        Self {
            authenticated: true,
            tier: None,
            verified_at_ms: 0,
        }
    }
}

impl Authentication {
    pub(super) fn new(data: PathBuf, native_home: PathBuf, runner: RunnerClient) -> Self {
        Self {
            data,
            native_home,
            runner,
            state: Arc::new(Mutex::new(State {
                phase: AuthPhase::Idle,
                job: None,
                verified: None,
                error: None,
            })),
        }
    }
    pub(super) async fn status(&self) -> AuthStatus {
        let state = self.state.lock().await;
        AuthStatus {
            phase: state.phase,
            request_id: state.job.as_ref().map(|job| job.id.to_string()),
            authorization_url: state
                .job
                .as_ref()
                .and_then(|job| job.handoff.as_ref())
                .filter(|_| state.phase == AuthPhase::AwaitingCallback)
                .map(|handoff| handoff.authorization.as_str().to_string()),
            verified: state.verified.clone(),
            error: state.error.clone(),
        }
    }
    pub(super) async fn observe(&self, verified: Verified) {
        let mut state = self.state.lock().await;
        if state.phase == AuthPhase::Idle
            && state
                .verified
                .as_ref()
                .is_none_or(|old| old.verified_at_ms <= verified.verified_at_ms)
        {
            state.verified = Some(verified);
            state.error = None;
        }
    }

    pub(super) async fn require_sign_in(&self) {
        self.observe(Verified::from_result(false, &json!({}))).await;
    }

    pub(super) async fn allow_refresh(&self) -> Result<(), AntigravityError> {
        if self.state.lock().await.phase != AuthPhase::Idle {
            return Err(auth_error("wait for the authentication action to finish"));
        }
        Ok(())
    }

    pub(super) async fn allow_work(&self) -> Result<(), AntigravityError> {
        let state = self.state.lock().await;
        if state.phase == AuthPhase::SigningOut
            || state
                .verified
                .as_ref()
                .is_some_and(|verified| !verified.authenticated)
        {
            return Err(AntigravityError::SignInRequired);
        }
        Ok(())
    }
    pub(super) async fn start(&self, sign_out: bool) -> Result<(), AntigravityError> {
        let executable = installation::executable(&self.data)?;
        let (cancel, receiver) = watch::channel(false);
        let id = Uuid::new_v4();
        {
            let mut state = self.state.lock().await;
            if state.phase != AuthPhase::Idle {
                return Err(auth_error("an authentication action is already running"));
            }
            state.transition(if sign_out {
                AuthEvent::SignOut
            } else {
                AuthEvent::SignIn
            })?;
            state.job = Some(Job {
                id,
                cancel,
                handoff: None,
            });
            state.error = None;
        }
        let owner = self.clone();
        tokio::spawn(async move {
            let result = owner.run(id, executable, receiver, sign_out).await;
            let mut state = owner.state.lock().await;
            if state.job.as_ref().is_some_and(|job| job.id == id) {
                match result {
                    Ok(result) => {
                        state.verified = Some(Verified::from_result(!sign_out, &result));
                    }
                    Err(error) => state.error = Some(error.to_string()),
                }
                let _ = state.transition(AuthEvent::Finished);
                state.job = None;
            }
        });
        Ok(())
    }

    pub(super) async fn cancel(&self, expected: Option<Uuid>) -> Result<(), AntigravityError> {
        let state = self.state.lock().await;
        let Some(job) = &state.job else {
            return Ok(());
        };
        if expected.is_some_and(|id| id != job.id) {
            return Err(auth_error(
                "this authentication request is no longer current",
            ));
        }
        job.cancel.send_replace(true);
        Ok(())
    }

    pub(super) async fn callback(&self, id: Uuid, returned: &str) -> Result<(), AntigravityError> {
        let target = {
            let mut state = self.state.lock().await;
            if state.phase != AuthPhase::AwaitingCallback {
                return Err(auth_error("no callback is pending for this request"));
            }
            let job = state
                .job
                .as_ref()
                .filter(|job| job.id == id && !*job.cancel.borrow())
                .ok_or_else(|| auth_error("this authentication request is no longer current"))?;
            let handoff = job
                .handoff
                .as_ref()
                .ok_or_else(|| auth_error("no native callback is pending"))?;
            let target = handoff.validate(returned)?;
            state.transition(AuthEvent::Callback)?;
            target
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| auth_error("could not prepare the native callback"))?;
        let result = client.get(target).send().await;
        match result {
            Ok(response) if matches!(response.status().as_u16(), 200 | 302) => Ok(()),
            _ => Err(auth_error(
                "native callback delivery could not be confirmed; wait for authentication status before starting again",
            )),
        }
    }

    async fn url(&self, id: Uuid, url: &str) -> Result<(), AntigravityError> {
        let handoff = Handoff::parse(url)?;
        let mut state = self.state.lock().await;
        if state
            .job
            .as_ref()
            .is_none_or(|job| job.id != id || *job.cancel.borrow())
        {
            return Err(auth_error("stale authentication process"));
        }
        match state.phase {
            AuthPhase::Starting => {
                state.transition(AuthEvent::Link)?;
                state.job.as_mut().expect("checked job").handoff = Some(handoff);
                Ok(())
            }
            AuthPhase::AwaitingCallback | AuthPhase::Completing => Ok(()),
            AuthPhase::SigningOut => Err(auth_error(
                "personal Google credentials could not be verified for sign-out; sign in first",
            )),
            AuthPhase::Idle => Err(auth_error("authentication is no longer running")),
        }
    }

    async fn run(
        &self,
        id: Uuid,
        executable: PathBuf,
        mut cancel: watch::Receiver<bool>,
        sign_out: bool,
    ) -> Result<Value, AntigravityError> {
        let mut native = NativeAuth::spawn(executable, &self.native_home)?;
        let result=async{
            let initialized=native.request(self,id,&mut cancel,1,"initialize",protocol::initialize()).await?;
            if initialized["protocolVersion"].as_u64()!=Some(1)||!initialized["authMethods"].as_array().is_some_and(|methods|methods.iter().any(|method|method["id"].as_str()==Some("oauth-personal"))){return Err(auth_error("official server does not advertise personal Google authentication"));}
            let authenticated=native.request(self,id,&mut cancel,2,"authenticate",json!({"methodId":"oauth-personal"})).await?;
            if sign_out {
                if initialized.pointer("/agentCapabilities/auth/logout").is_none(){return Err(auth_error("official server does not advertise logout"));}
                // The explicit sign-out action ends this installation's Tasks;
                // native credentials may also be shared by other ACP clients.
                self.runner.restart().await.map_err(|_|auth_error("could not confirm Antigravity Task writers stopped; credentials were retained"))?;
                native.request(self,id,&mut cancel,3,"logout",json!({})).await
            }else{Ok(authenticated)}
        }.await;
        native.close().await;
        result
    }
}

impl Handoff {
    fn parse(raw: &str) -> Result<Self, AntigravityError> {
        let authorization =
            Url::parse(raw).map_err(|_| auth_error("native authorization URL is invalid"))?;
        if authorization.scheme() != "https"
            || authorization.host_str() != Some("accounts.google.com")
            || !authorization.username().is_empty()
            || authorization.password().is_some()
            || authorization.fragment().is_some()
        {
            return Err(auth_error(
                "native authorization URL is not the expected Google address",
            ));
        }
        let pairs = authorization.query_pairs().collect::<Vec<_>>();
        let values = |name: &str| {
            pairs
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.to_string())
                .collect::<Vec<_>>()
        };
        let redirect = values("redirect_uri");
        let states = values("state");
        if redirect.len() != 1 || states.len() != 1 || states[0].is_empty() {
            return Err(auth_error(
                "native authorization request has no unique callback/state",
            ));
        }
        let target =
            Url::parse(&redirect[0]).map_err(|_| auth_error("native callback URL is invalid"))?;
        if target.scheme() != "http"
            || target.host_str() != Some("127.0.0.1")
            || target.port().is_none()
            || !target.username().is_empty()
            || target.password().is_some()
            || target.fragment().is_some()
            || target.query().is_some()
        {
            return Err(auth_error(
                "native callback is not an explicit loopback address",
            ));
        }
        Ok(Self {
            authorization,
            target,
            state: states[0].clone(),
        })
    }
    fn validate(&self, raw: &str) -> Result<Url, AntigravityError> {
        let raw = raw.trim();
        if raw.len() > 32768 || raw.bytes().any(|byte| !(33..=126).contains(&byte)) {
            return Err(auth_error(
                "paste the complete callback address without spaces",
            ));
        }
        let returned = Url::parse(raw).map_err(|_| auth_error("callback URL is invalid"))?;
        if returned.scheme() != self.target.scheme()
            || returned.host_str() != self.target.host_str()
            || returned.port() != self.target.port()
            || returned.path() != self.target.path()
            || !returned.username().is_empty()
            || returned.password().is_some()
            || returned.fragment().is_some()
        {
            return Err(auth_error(
                "callback address does not belong to this authentication request",
            ));
        }
        let pairs = returned.query_pairs().collect::<Vec<_>>();
        let values = |name: &str| {
            pairs
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.as_ref())
                .collect::<Vec<_>>()
        };
        let states = values("state");
        let codes = values("code");
        let errors = values("error");
        if states.len() != 1
            || states[0] != self.state
            || !((codes.len() == 1 && !codes[0].is_empty() && errors.is_empty())
                || (errors.len() == 1 && !errors[0].is_empty() && codes.is_empty()))
        {
            return Err(auth_error(
                "callback state or result does not belong to this request",
            ));
        }
        Ok(returned)
    }
}

struct NativeAuth {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr: Lines<BufReader<ChildStderr>>,
}
impl NativeAuth {
    fn spawn(executable: PathBuf, native_home: &Path) -> Result<Self, AntigravityError> {
        let mut child = Command::new(executable)
            .env("BROWSER", "/usr/bin/true")
            .env("GEMINI_HOME", native_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| auth_error("could not start official ACP authentication process"))?;
        Ok(Self {
            stdin: child.stdin.take(),
            stdout: BufReader::new(child.stdout.take().expect("piped stdout")).lines(),
            stderr: BufReader::new(child.stderr.take().expect("piped stderr")).lines(),
            child,
        })
    }
    async fn request(
        &mut self,
        owner: &Authentication,
        job: Uuid,
        cancel: &mut watch::Receiver<bool>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, AntigravityError> {
        let frame =
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string() + "\n";
        self.stdin
            .as_mut()
            .ok_or_else(|| auth_error("authentication process closed"))?
            .write_all(frame.as_bytes())
            .await
            .map_err(|_| auth_error("could not send native authentication request"))?;
        let deadline = tokio::time::sleep(Duration::from_secs(320));
        tokio::pin!(deadline);
        loop {
            if *cancel.borrow() {
                return Err(auth_error(
                    "authentication cancelled; native credentials may already have been updated",
                ));
            }
            tokio::select! {
                _=&mut deadline=>return Err(auth_error("native authentication wait expired")),
                _=cancel.changed()=>{return Err(auth_error("authentication cancelled; native credentials may already have been updated"));},
                line=self.stderr.next_line()=>{
                    let line=line.map_err(|_|auth_error("authentication diagnostics connection ended"))?.ok_or_else(||auth_error("authentication process ended"))?;
                    if let Some(url)=authorization_url(&line){
                        owner.url(job,url).await?;
                    }
                },
                line=self.stdout.next_line()=>{
                    let line=line.map_err(|_|auth_error("authentication connection ended"))?.ok_or_else(||auth_error("authentication process ended"))?;
                    let response:Value=serde_json::from_str(&line).map_err(|_|auth_error("native authentication response is malformed"))?;
                    if response.get("method").is_some(){return Err(auth_error("unexpected Task callback during authentication"));}
                    if response["id"].as_u64()!=Some(id){return Err(auth_error("authentication response belongs to another request"));}
                    if let Some(error)=response.get("error"){let code=error["code"].as_i64().ok_or_else(||auth_error("invalid authentication error code"))?;return Err(auth_error(format!("native authentication failed (RPC {code})")));}
                    return response.get("result").cloned().ok_or_else(||auth_error("native authentication response has no result"));
                }
            }
        }
    }
    async fn close(mut self) {
        self.stdin.take();
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

/// Native diagnostics can mention Google documentation and endpoint URLs.
/// Only the actual loopback OAuth handoff is a sign-in request.
pub(super) fn authorization_url(line: &str) -> Option<&str> {
    line.split_whitespace().find_map(|word| {
        let start = word.find("https://accounts.google.com/")?;
        let candidate = word[start..].trim_end_matches([')', ']', '"', '\'', ',', '.']);
        Handoff::parse(candidate).ok().map(|_| candidate)
    })
}
fn auth_error(message: impl Into<String>) -> AntigravityError {
    AntigravityError::Authentication(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    fn authorization(port: u16) -> String {
        let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        url.query_pairs_mut()
            .append_pair(
                "redirect_uri",
                &format!("http://127.0.0.1:{port}/oauth2callback"),
            )
            .append_pair("state", "fixture-state");
        url.to_string()
    }
    #[test]
    fn diagnostic_google_links_do_not_start_an_oauth_handoff() {
        assert!(
            authorization_url("OAuth endpoint https://accounts.google.com/o/oauth2/v2/auth")
                .is_none()
        );
        assert!(authorization_url("https://accounts.google.com/ documentation").is_none());
        let url = authorization(43123);
        assert_eq!(
            authorization_url(&format!("Open this link: {url}")),
            Some(url.as_str())
        );
    }
    #[test]
    fn only_the_exact_native_loopback_and_unique_state_and_result_are_accepted() {
        let handoff = Handoff::parse(&authorization(45123)).unwrap();
        assert!(
            handoff
                .validate(
                    "http://127.0.0.1:45123/oauth2callback?state=fixture-state&code=fixture-code"
                )
                .is_ok()
        );
        for callback in [
            "http://localhost:45123/oauth2callback?state=fixture-state&code=fixture-code",
            "http://127.0.0.1:45124/oauth2callback?state=fixture-state&code=fixture-code",
            "http://127.0.0.1:45123/elsewhere?state=fixture-state&code=fixture-code",
            "http://127.0.0.1:45123/oauth2callback?state=other&code=fixture-code",
            "http://127.0.0.1:45123/oauth2callback?state=fixture-state&state=fixture-state&code=fixture-code",
            "http://127.0.0.1:45123/oauth2callback?state=fixture-state&code=fixture-code&error=denied",
            "http://127.0.0.1:45123/oauth2callback?state=fixture-state&code=one&code=two",
            "http://user@127.0.0.1:45123/oauth2callback?state=fixture-state&code=fixture-code",
            "http://127.0.0.1:45123/oauth2callback?state=fixture-state&code=fixture-code#fragment",
        ] {
            let error = handoff.validate(callback).unwrap_err().to_string();
            assert!(!error.contains("fixture-code"));
        }
        assert!(
            Handoff::parse("https://example.com/?redirect_uri=http://127.0.0.1:45123/&state=s")
                .is_err()
        );
    }
    #[tokio::test]
    async fn callback_is_delivered_once_without_following_redirects_and_stale_jobs_cannot_deliver()
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let root = tempfile::tempdir().unwrap();
        let owner = Authentication::new(
            root.path().into(),
            root.path().into(),
            RunnerClient::at_socket(root.path().join("runner.sock")),
        );
        let id = Uuid::new_v4();
        let (cancel, _) = watch::channel(false);
        {
            let mut state = owner.state.lock().await;
            state.transition(AuthEvent::SignIn).unwrap();
            state.job = Some(Job {
                id,
                cancel,
                handoff: None,
            });
        }
        owner.url(id, &authorization(port)).await.unwrap();
        let callback =
            format!("http://127.0.0.1:{port}/oauth2callback?state=fixture-state&code=fixture-code");
        assert!(owner.callback(Uuid::new_v4(), &callback).await.is_err());
        let server = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let n = stream.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]);
            assert!(
                request.starts_with(
                    "GET /oauth2callback?state=fixture-state&code=fixture-code HTTP/1.1"
                )
            );
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/must-not-follow\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        owner.callback(id, &callback).await.unwrap();
        server.await.unwrap();
        assert!(owner.callback(id, &callback).await.is_err());
        assert!(owner.state.lock().await.phase == AuthPhase::Completing);
    }
    #[test]
    fn auth_graph_rejects_duplicate_intents_and_late_callbacks_after_completion() {
        let mut state = State {
            phase: AuthPhase::Idle,
            job: None,
            verified: None,
            error: None,
        };
        state.transition(AuthEvent::SignIn).unwrap();
        assert!(state.transition(AuthEvent::SignOut).is_err());
        state.transition(AuthEvent::Link).unwrap();
        state.transition(AuthEvent::Callback).unwrap();
        assert!(state.transition(AuthEvent::Callback).is_err());
        state.transition(AuthEvent::Finished).unwrap();
        assert!(state.transition(AuthEvent::Callback).is_err());
        state.transition(AuthEvent::SignOut).unwrap();
        state.transition(AuthEvent::Finished).unwrap();
    }
    #[tokio::test]
    async fn account_observations_preserve_newer_results_and_explicit_auth_jobs() {
        let directory = tempfile::tempdir().unwrap();
        let auth = Authentication::new(
            directory.path().into(),
            directory.path().into(),
            RunnerClient::at_socket(directory.path().join("runner.sock")),
        );
        let result =
            json!({"_meta":{"antigravity":{"tier":{"id":"fixture-pro","name":"Fixture Pro"}}}});
        let mut verified = Verified::from_result(true, &result);
        verified.verified_at_ms = 10;
        auth.observe(verified.clone()).await;
        assert_eq!(
            auth.status().await.verified.unwrap().tier.unwrap().name,
            "Fixture Pro"
        );
        auth.observe(Verified::recovered()).await;
        assert_eq!(auth.status().await.verified.unwrap().verified_at_ms, 10);
        {
            let mut state = auth.state.lock().await;
            state.transition(AuthEvent::SignOut).unwrap();
        }
        verified.verified_at_ms = 11;
        auth.observe(verified).await;
        assert_eq!(auth.status().await.verified.unwrap().verified_at_ms, 10);
        assert!(auth.allow_work().await.is_err());
        assert!(auth.allow_refresh().await.is_err());
    }
}
