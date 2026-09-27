use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fmt, fs,
    future::Future,
    io, iter,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use tokio::{process::Command, time::timeout};

const TAILSCALE_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_DIRECTORIES: [&str; 4] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/run/current-system/sw/bin",
];
const HOME_COMMAND_DIRECTORIES: [&str; 2] = [".nix-profile/bin", "go/bin"];
const APP_EXECUTABLE: &str = "Tailscale.app/Contents/MacOS/Tailscale";
const MAX_REPORTED_OUTPUT_CHARS: usize = 400;

pub(super) type TailscaleCommandFuture =
    Pin<Box<dyn Future<Output = Result<String, TailscaleCommandError>> + Send>>;

pub(super) trait TailscaleRunner: Send + Sync {
    fn find_executables(&self) -> TailscaleExecutables;
    fn run(&self, executable: &Path, arguments: &[&str]) -> TailscaleCommandFuture;
}

pub(super) enum TailscaleExecutables {
    Found(Vec<PathBuf>),
    Missing { searched: Vec<PathBuf> },
}

#[derive(Debug)]
pub(super) enum TailscaleCommandError {
    Start(io::Error),
    TimedOut,
    Exited { code: Option<i32>, output: String },
}

impl fmt::Display for TailscaleCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start(error) => write!(formatter, "could not start: {error}"),
            Self::TimedOut => write!(
                formatter,
                "did not finish within {} seconds",
                TAILSCALE_COMMAND_TIMEOUT.as_secs()
            ),
            Self::Exited { code, output } => {
                match code {
                    Some(code) => write!(formatter, "exited with code {code}")?,
                    None => write!(formatter, "was terminated by a signal")?,
                }
                if output.is_empty() {
                    Ok(())
                } else {
                    write!(formatter, ": {output}")
                }
            }
        }
    }
}

pub(super) struct ProcessTailscaleRunner;

impl TailscaleRunner for ProcessTailscaleRunner {
    fn find_executables(&self) -> TailscaleExecutables {
        find_executables(candidate_paths(env::var_os("PATH"), env::var_os("HOME")))
    }

    fn run(&self, executable: &Path, arguments: &[&str]) -> TailscaleCommandFuture {
        let mut command = Command::new(executable);
        command.kill_on_drop(true).args(arguments);
        Box::pin(async move {
            let output = timeout(TAILSCALE_COMMAND_TIMEOUT, command.output())
                .await
                .map_err(|_| TailscaleCommandError::TimedOut)?
                .map_err(TailscaleCommandError::Start)?;
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            if output.status.success() {
                return Ok(stdout);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let reported: &str = if stderr.trim().is_empty() {
                &stdout
            } else {
                &stderr
            };
            Err(TailscaleCommandError::Exited {
                code: output.status.code(),
                output: summarize_output(reported),
            })
        })
    }
}

fn candidate_paths(search_path: Option<OsString>, home: Option<OsString>) -> Vec<PathBuf> {
    let home = home.map(PathBuf::from);
    let command_directories = search_path
        .map(|search_path| env::split_paths(&search_path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(COMMAND_DIRECTORIES.map(PathBuf::from))
        .chain(
            home.iter()
                .flat_map(|home| HOME_COMMAND_DIRECTORIES.map(|directory| home.join(directory))),
        );
    let application_directories = iter::once(PathBuf::from("/Applications"))
        .chain(home.as_ref().map(|home| home.join("Applications")));
    let mut candidates = Vec::new();
    for candidate in command_directories
        .map(|directory| directory.join("tailscale"))
        .chain(application_directories.map(|directory| directory.join(APP_EXECUTABLE)))
    {
        if candidate.is_absolute() && !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn find_executables(candidates: Vec<PathBuf>) -> TailscaleExecutables {
    let mut targets = HashSet::new();
    let found: Vec<PathBuf> = candidates
        .iter()
        .filter(|candidate| is_executable_file(candidate))
        .filter(|candidate| {
            targets.insert(fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf()))
        })
        .cloned()
        .collect();
    if found.is_empty() {
        TailscaleExecutables::Missing {
            searched: candidates,
        }
    } else {
        TailscaleExecutables::Found(found)
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(super) fn summarize_output(output: &str) -> String {
    let words = output.split_whitespace().collect::<Vec<_>>().join(" ");
    match words.char_indices().nth(MAX_REPORTED_OUTPUT_CHARS) {
        Some((end, _)) => format!("{}…", &words[..end]),
        None => words,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use super::*;

    #[test]
    fn recognizes_only_executable_files() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("tailscale");
        fs::write(&executable, b"binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable_file(&executable));

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&executable));
        assert!(!is_executable_file(temp.path()));
        assert!(!is_executable_file(&temp.path().join("missing")));
    }

    #[test]
    fn searches_path_then_package_manager_directories_then_both_application_folders() {
        let candidates = candidate_paths(
            Some(OsString::from(
                "/custom/bin::relative:/usr/local/bin:/custom/bin",
            )),
            Some(OsString::from("/Users/someone")),
        );
        assert_eq!(
            candidates,
            [
                "/custom/bin/tailscale",
                "/usr/local/bin/tailscale",
                "/opt/homebrew/bin/tailscale",
                "/opt/local/bin/tailscale",
                "/run/current-system/sw/bin/tailscale",
                "/Users/someone/.nix-profile/bin/tailscale",
                "/Users/someone/go/bin/tailscale",
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                "/Users/someone/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            ]
            .map(PathBuf::from)
        );

        assert_eq!(
            candidate_paths(None, None),
            [
                "/opt/homebrew/bin/tailscale",
                "/usr/local/bin/tailscale",
                "/opt/local/bin/tailscale",
                "/run/current-system/sw/bin/tailscale",
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn finds_each_executable_once_and_reports_the_search_when_none_exists() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain");
        let binary = temp.path().join("binary");
        let link = temp.path().join("link");
        for directory in [&plain, &binary, &link] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(plain.join("tailscale"), b"text").unwrap();
        fs::set_permissions(plain.join("tailscale"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(binary.join("tailscale"), b"binary").unwrap();
        fs::set_permissions(binary.join("tailscale"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(binary.join("tailscale"), link.join("tailscale")).unwrap();

        let found = find_executables(vec![
            plain.join("tailscale"),
            link.join("tailscale"),
            binary.join("tailscale"),
        ]);
        assert!(matches!(
            found,
            TailscaleExecutables::Found(paths) if paths == [link.join("tailscale")]
        ));

        let searched = vec![plain.join("tailscale"), temp.path().join("missing")];
        let missing = find_executables(searched.clone());
        assert!(matches!(
            missing,
            TailscaleExecutables::Missing { searched: reported } if reported == searched
        ));
    }

    #[tokio::test]
    async fn returns_stdout_and_describes_how_a_command_failed() {
        let shell = Path::new("/bin/sh");
        let runner = ProcessTailscaleRunner;
        assert_eq!(
            runner.run(shell, &["-c", "echo ready"]).await.unwrap(),
            "ready\n"
        );

        let failed = runner
            .run(
                shell,
                &[
                    "-c",
                    "echo ignored; printf 'not   running\\nretry\\n' >&2; exit 3",
                ],
            )
            .await
            .unwrap_err();
        assert_eq!(failed.to_string(), "exited with code 3: not running retry");

        let stdout_only = runner
            .run(shell, &["-c", "echo only stdout; exit 4"])
            .await
            .unwrap_err();
        assert_eq!(stdout_only.to_string(), "exited with code 4: only stdout");

        let silent = runner.run(shell, &["-c", "exit 5"]).await.unwrap_err();
        assert_eq!(silent.to_string(), "exited with code 5");

        let killed = runner
            .run(shell, &["-c", "kill -KILL $$"])
            .await
            .unwrap_err();
        assert_eq!(killed.to_string(), "was terminated by a signal");

        let temp = tempfile::tempdir().unwrap();
        let unstartable = runner
            .run(&temp.path().join("missing"), &[])
            .await
            .unwrap_err();
        assert!(matches!(unstartable, TailscaleCommandError::Start(_)));
        assert!(unstartable.to_string().starts_with("could not start: "));
    }

    #[tokio::test(start_paused = true)]
    async fn stops_a_command_that_does_not_finish() {
        let error = ProcessTailscaleRunner
            .run(Path::new("/bin/sh"), &["-c", "exec sleep 30"])
            .await
            .unwrap_err();
        assert!(matches!(error, TailscaleCommandError::TimedOut));
        assert_eq!(error.to_string(), "did not finish within 10 seconds");
    }

    #[test]
    fn summarizes_output_on_one_bounded_line() {
        assert_eq!(summarize_output("  first\n\tsecond  "), "first second");
        let long = summarize_output(&"x".repeat(MAX_REPORTED_OUTPUT_CHARS + 1));
        assert_eq!(long.chars().count(), MAX_REPORTED_OUTPUT_CHARS + 1);
        assert!(long.ends_with('…'));
        assert_eq!(
            summarize_output(&"x".repeat(MAX_REPORTED_OUTPUT_CHARS)),
            "x".repeat(MAX_REPORTED_OUTPUT_CHARS)
        );
    }
}
