use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Output,
    time::Duration,
};

use rustix::{
    io::Errno,
    process::{Pid, test_kill_process},
};
use semver::Version;
use tokio::{process::Command, time::timeout};

use super::procedure::{HomebrewRecord, Host, UpdateRequest};

const CASK: &str = "panarch/tap/caffold";
const APP_ID: &str = "io.panarch.caffold.server";
const BREW_DIRECTORIES: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// This Mac, through the commands the update needs.
pub(super) struct MacHost;

impl Host for MacHost {
    fn pid(&self) -> u32 {
        std::process::id()
    }

    fn alive(&self, pid: u32) -> bool {
        process_alive(pid)
    }

    async fn homebrew_record(&self) -> HomebrewRecord {
        homebrew_record().await
    }

    async fn homebrew_refresh(&self) -> Result<String, String> {
        brew_to_end(&["update"]).await
    }

    async fn homebrew_install(&self, reinstall: bool) -> Result<String, String> {
        let action = if reinstall { "reinstall" } else { "upgrade" };
        brew_to_end(&[action, "--cask", CASK]).await
    }

    async fn bundle_version(&self, app: &Path) -> Result<Version, String> {
        let plist = app.join("Contents/Info.plist");
        let output = run(
            Path::new("/usr/bin/plutil"),
            &[
                OsStr::new("-extract"),
                OsStr::new("CFBundleShortVersionString"),
                OsStr::new("raw"),
                OsStr::new("-o"),
                OsStr::new("-"),
                plist.as_os_str(),
            ],
            COMMAND_TIMEOUT,
        )
        .await?;
        if !output.success {
            return Err(output.combined.trim().to_string());
        }
        Version::parse(output.stdout.trim()).map_err(|error| error.to_string())
    }

    async fn copy_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        prepare_destination(to)?;
        succeed(run(Path::new("/usr/bin/ditto"), &[from, to], COMMAND_TIMEOUT).await?)
    }

    async fn move_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        prepare_destination(to)?;
        // `mv` also moves between volumes, which a rename cannot.
        succeed(run(Path::new("/bin/mv"), &[from, to], COMMAND_TIMEOUT).await?)
    }

    async fn forget_bundle(&self, bundle: &Path) {
        let _ = run(
            Path::new(LSREGISTER),
            &[OsStr::new("-u"), bundle.as_os_str()],
            COMMAND_TIMEOUT,
        )
        .await;
    }

    async fn server_owner(&self, port: u16) -> Option<String> {
        let pid = listener_pid(port).await?;
        let output = run(
            Path::new("/bin/ps"),
            &["-o", "command=", "-p", pid.to_string().as_str()],
            COMMAND_TIMEOUT,
        )
        .await
        .ok()?;
        let command = output.stdout.trim();
        (output.success && !command.is_empty()).then(|| command.to_string())
    }

    async fn server_version(&self, port: u16) -> Option<String> {
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .timeout(HEALTH_TIMEOUT)
            .send()
            .await
            .ok()?;
        let body = response.bytes().await.ok()?;
        let health = serde_json::from_slice::<serde_json::Value>(&body).ok()?;
        health["version"].as_str().map(str::to_string)
    }

    async fn quit_app(&self, app: &Path) {
        // Telling an app that is not running to quit can open it first.
        let running = self
            .app_processes()
            .await
            .iter()
            .any(|command| is_app_process(command, app));
        if !running {
            return;
        }
        let _ = run(
            Path::new("/usr/bin/osascript"),
            &[
                "-e",
                format!("tell application id \"{APP_ID}\" to quit").as_str(),
            ],
            COMMAND_TIMEOUT,
        )
        .await;
    }

    async fn app_stopped(&self, app: &Path, port: u16) -> bool {
        let processes = self.app_processes().await;
        !processes
            .iter()
            .any(|command| is_app_process(command, app) || is_server_process(command, app))
            && listener_pid(port).await.is_none()
    }

    async fn launch_app(&self, app: &Path) -> Result<(), String> {
        // Like Homebrew reopening an app after an upgrade, LaunchServices
        // supplies the environment instead of whoever ran this update.
        let status = Command::new("/usr/bin/open")
            .env_clear()
            .arg(app)
            .status()
            .await
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("open exited with {status}"))
        }
    }

    async fn start_worker(
        &self,
        request: &UpdateRequest,
        id: &str,
        log: &Path,
    ) -> Result<(), String> {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let status = detached(log, &executable, &worker_arguments(request, id))
            .status()
            .await
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("the shell exited with {status}"))
        }
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

impl MacHost {
    /// Command lines of every process, for matching against the app.
    async fn app_processes(&self) -> Vec<String> {
        let Ok(output) = run(Path::new("/bin/ps"), &["-axo", "command="], COMMAND_TIMEOUT).await
        else {
            return Vec::new();
        };
        output
            .stdout
            .lines()
            .map(|line| line.trim().to_string())
            .collect()
    }
}

/// What Homebrew records for the `caffold` cask.
pub(crate) async fn homebrew_record() -> HomebrewRecord {
    let Some(brew) = find_brew(env::var_os("PATH").as_deref()) else {
        return HomebrewRecord::NoHomebrew;
    };
    match run(
        &brew,
        &["list", "--cask", "--versions", "caffold"],
        COMMAND_TIMEOUT,
    )
    .await
    {
        Ok(output) if output.success && !output.stdout.trim().is_empty() => {
            HomebrewRecord::Installed(recorded_version(&output.stdout))
        }
        _ => HomebrewRecord::NotInstalled,
    }
}

/// Whether a process exists. One owned by another user still exists.
pub(crate) fn process_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == Errno::PERM,
    }
}

/// A shell that starts `program` in the background with its output appended
/// to `log`, then exits. The program then belongs neither to this process tree
/// nor to this process group, so whoever stops waiting on `caffold update`
/// does not stop it.
fn detached(log: &Path, program: &Path, arguments: &[OsString]) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"log="$1"; shift; "$@" </dev/null >>"$log" 2>&1 &"#)
        .arg("caffold-update")
        .arg(log)
        .arg(program)
        .args(arguments)
        .process_group(0);
    command
}

fn worker_arguments(request: &UpdateRequest, id: &str) -> Vec<OsString> {
    let mut arguments: Vec<OsString> = vec![
        "update".into(),
        "--app".into(),
        request.app.clone().into(),
        "--data-dir".into(),
        request.data_dir.clone().into(),
        "--port".into(),
        request.port.to_string().into(),
    ];
    if request.from_menu_bar {
        arguments.push("--from-menu-bar".into());
    }
    arguments.push("--attempt".into());
    arguments.push(id.into());
    arguments
}

fn find_brew(path: Option<&OsStr>) -> Option<PathBuf> {
    path.map(env::split_paths)
        .into_iter()
        .flatten()
        .chain(BREW_DIRECTORIES.iter().map(PathBuf::from))
        .map(|directory| directory.join("brew"))
        .find(|candidate| candidate.is_file())
}

/// `brew list --versions` names the cask, then its installed versions.
fn recorded_version(listing: &str) -> Option<Version> {
    listing
        .split_whitespace()
        .skip(1)
        .filter_map(|version| Version::parse(version).ok())
        .max()
}

fn is_app_process(command: &str, app: &Path) -> bool {
    let executable = app.join("Contents/MacOS/CaffoldServer");
    let executable = executable.to_string_lossy();
    command == executable || command.starts_with(&format!("{executable} "))
}

fn is_server_process(command: &str, app: &Path) -> bool {
    command.starts_with(&format!(
        "{}/Contents/Resources/caffold serve",
        app.display()
    ))
}

async fn listener_pid(port: u16) -> Option<u32> {
    let output = run(
        Path::new("/usr/sbin/lsof"),
        &["-nP", format!("-tiTCP:{port}").as_str(), "-sTCP:LISTEN"],
        COMMAND_TIMEOUT,
    )
    .await
    .ok()?;
    output
        .stdout
        .lines()
        .find_map(|line| line.trim().parse().ok())
}

/// A destination must not exist: `ditto` would merge into it and `mv` would
/// move into it.
fn prepare_destination(to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn succeed(output: CommandOutput) -> Result<(), String> {
    if output.success {
        Ok(())
    } else {
        Err(output.combined.trim().to_string())
    }
}

struct CommandOutput {
    success: bool,
    stdout: String,
    /// Standard output followed by standard error.
    combined: String,
}

async fn run(
    program: &Path,
    arguments: &[impl AsRef<OsStr>],
    limit: Duration,
) -> Result<CommandOutput, String> {
    let output = timeout(
        limit,
        Command::new(program)
            .args(arguments)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        format!(
            "{} did not finish within {} seconds",
            program.display(),
            limit.as_secs()
        )
    })?
    .map_err(|error| format!("{} could not start: {error}", program.display()))?;
    Ok(CommandOutput::from(output))
}

/// Runs Homebrew however long it takes and returns what it said. Stopping it
/// partway leaves a change it cannot undo, where letting it fail lets it undo
/// its own.
async fn brew_to_end(arguments: &[&str]) -> Result<String, String> {
    let brew = find_brew(env::var_os("PATH").as_deref()).ok_or("Homebrew is not installed.")?;
    let output = Command::new(&brew)
        .args(arguments)
        .output()
        .await
        .map_err(|error| format!("{} could not start: {error}", brew.display()))?;
    let output = CommandOutput::from(output);
    if output.success {
        Ok(output.combined)
    } else {
        Err(output.combined)
    }
}

impl From<Output> for CommandOutput {
    fn from(output: Output) -> Self {
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        Self {
            success: output.status.success(),
            combined: format!("{stdout}{stderr}"),
            stdout,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "/Applications/Caffold Server.app";

    #[test]
    fn reads_the_version_homebrew_records() {
        assert_eq!(
            recorded_version("caffold 0.17.0\n"),
            Some(Version::new(0, 17, 0))
        );
        assert_eq!(
            recorded_version("caffold 0.17.0 0.18.2\n"),
            Some(Version::new(0, 18, 2))
        );
        assert_eq!(recorded_version("caffold latest\n"), None);
    }

    #[test]
    fn finds_brew_on_the_path_before_the_usual_places() {
        let directory = tempfile::tempdir().unwrap();
        let brew = directory.path().join("brew");
        fs::write(&brew, "").unwrap();
        let path = env::join_paths([directory.path()]).unwrap();

        assert_eq!(find_brew(Some(&path)), Some(brew));
    }

    #[test]
    fn tells_the_app_and_its_server_from_the_update_itself() {
        let app = Path::new(APP);

        assert!(is_app_process(
            "/Applications/Caffold Server.app/Contents/MacOS/CaffoldServer",
            app
        ));
        assert!(is_app_process(
            "/Applications/Caffold Server.app/Contents/MacOS/CaffoldServer -psn_0_1",
            app
        ));
        assert!(is_server_process(
            "/Applications/Caffold Server.app/Contents/Resources/caffold serve --port 5178",
            app
        ));
        let update =
            "/Applications/Caffold Server.app/Contents/Resources/caffold update --attempt 1";
        assert!(!is_app_process(update, app));
        assert!(!is_server_process(update, app));
        assert!(!is_app_process(
            "/Applications/Caffold Server.app/Contents/MacOS/CaffoldServerHelper",
            app
        ));
    }

    #[test]
    fn hands_the_worker_the_same_request() {
        let request = UpdateRequest {
            app: PathBuf::from(APP),
            data_dir: PathBuf::from("/Users/me/Library/Application Support/Caffold/data"),
            port: 5178,
            from_menu_bar: true,
        };

        assert_eq!(
            worker_arguments(&request, "20261004T121000Z"),
            [
                "update",
                "--app",
                APP,
                "--data-dir",
                "/Users/me/Library/Application Support/Caffold/data",
                "--port",
                "5178",
                "--from-menu-bar",
                "--attempt",
                "20261004T121000Z",
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn refuses_a_destination_that_exists() {
        let directory = tempfile::tempdir().unwrap();

        assert!(prepare_destination(directory.path()).is_err());
        let nested = directory.path().join("attempt/backup/Caffold Server.app");
        assert!(prepare_destination(&nested).is_ok());
        assert!(nested.parent().unwrap().is_dir());
    }

    #[test]
    fn knows_this_process_is_alive() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(0));
    }

    /// The commands below are the ones on every Mac; Linux has other paths.
    #[cfg(target_os = "macos")]
    mod on_this_mac {
        use super::*;

        fn app_with_version(root: &Path, version: &str) -> PathBuf {
            let app = root.join("Caffold Server.app");
            fs::create_dir_all(app.join("Contents")).unwrap();
            fs::write(
                app.join("Contents/Info.plist"),
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>
"#
                ),
            )
            .unwrap();
            app
        }

        #[tokio::test]
        async fn reads_the_version_a_bundle_declares() {
            let root = tempfile::tempdir().unwrap();
            let app = app_with_version(root.path(), "0.18.3");

            assert_eq!(
                MacHost.bundle_version(&app).await,
                Ok(Version::new(0, 18, 3))
            );
            assert!(
                MacHost
                    .bundle_version(&root.path().join("Missing.app"))
                    .await
                    .is_err()
            );
        }

        #[tokio::test]
        async fn copies_and_moves_a_bundle_to_a_place_that_is_free() {
            let root = tempfile::tempdir().unwrap();
            let app = app_with_version(root.path(), "0.18.2");
            let backup = root.path().join("attempt/backup/Caffold Server.app");
            let failed = root.path().join("attempt/failed/Caffold Server.app");

            MacHost.copy_bundle(&app, &backup).await.unwrap();
            assert_eq!(
                MacHost.bundle_version(&backup).await,
                Ok(Version::new(0, 18, 2))
            );
            assert!(app.exists());
            assert!(MacHost.copy_bundle(&app, &backup).await.is_err());

            MacHost.move_bundle(&app, &failed).await.unwrap();
            assert!(!app.exists());
            MacHost.move_bundle(&backup, &app).await.unwrap();
            assert_eq!(
                MacHost.bundle_version(&app).await,
                Ok(Version::new(0, 18, 2))
            );
            assert!(!backup.exists());
        }

        #[tokio::test]
        async fn names_the_process_listening_on_a_port_and_its_version() {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let app = axum::Router::new().route(
                "/api/health",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"version": "0.18.3"}))
                }),
            );
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });

            assert_eq!(
                MacHost.server_version(port).await.as_deref(),
                Some("0.18.3")
            );
            let owner = MacHost.server_owner(port).await.unwrap();
            let this_test = env::current_exe().unwrap();
            assert!(owner.starts_with(&*this_test.to_string_lossy()), "{owner}");
        }

        #[tokio::test]
        async fn finds_nothing_running_from_an_app_that_is_not_there() {
            let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = free.local_addr().unwrap().port();
            drop(free);
            let app = Path::new("/Applications/Not Caffold Server.app");

            assert!(MacHost.app_stopped(app, port).await);
            assert_eq!(MacHost.server_owner(port).await, None);
            assert_eq!(MacHost.server_version(port).await, None);
            MacHost.quit_app(app).await;
        }
    }

    #[tokio::test]
    async fn starts_a_detached_program_that_appends_to_the_log() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("log.txt");
        fs::write(&log, "earlier\n").unwrap();
        let done = directory.path().join("done");

        // The shell has exited by the time `status` returns; the program
        // signals its own end by creating `done` after writing.
        let status = detached(
            &log,
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                r#"echo "worker ran"; : > "$0""#.into(),
                done.clone().into(),
            ],
        )
        .status()
        .await
        .unwrap();
        assert!(status.success());

        for _ in 0..250 {
            if done.exists() {
                assert_eq!(fs::read_to_string(&log).unwrap(), "earlier\nworker ran\n");
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the detached program did not finish");
    }
}
