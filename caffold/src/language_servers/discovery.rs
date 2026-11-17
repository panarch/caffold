//! Finding the projects a folder holds and the language server that answers
//! for them. Caffold never installs a server: it runs the one it finds and
//! reports what it could not find. Which check failed decides the report;
//! what a tool printed is only passed on.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::process::Command;

use super::Language;

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Directories a project marker is never looked for in.
const SKIPPED_DIRECTORIES: [&str; 2] = ["node_modules", "target"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FoundServer {
    pub(crate) program: PathBuf,
    pub(crate) arguments: Vec<String>,
    pub(crate) version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Discovery {
    Found(FoundServer),
    /// The project has no server; installing one on the host is the way on.
    NotInstalled(MissingServer),
    /// A server is there but `--version` failed, with what it printed.
    CouldNotStart {
        reason: String,
    },
}

/// What installing a missing server takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MissingServer {
    /// The rustup toolchain the project uses, when rustup chooses its Rust.
    pub(crate) toolchain: Option<String>,
    pub(crate) install_command: String,
    pub(crate) check_command: String,
}

impl MissingServer {
    fn new(language: Language, toolchain: Option<String>) -> Self {
        Self {
            install_command: language.install_command(toolchain.as_deref()),
            check_command: language.check_command(toolchain.as_deref()),
            toolchain,
        }
    }
}

/// The languages among `languages` that `root` holds a project of: a marker
/// file at its top or in a folder directly beneath it. rust-analyzer looks
/// for `Cargo.toml` as deep.
pub(super) fn languages_in(root: &Path, languages: &[Language]) -> Vec<Language> {
    let folders = project_folders(root);
    languages
        .iter()
        .copied()
        .filter(|language| {
            folders.iter().any(|folder| {
                language
                    .project_markers()
                    .iter()
                    .any(|marker| folder.join(marker).is_file())
            })
        })
        .collect()
}

/// The server for `language` that runs in `root`, found on the server's
/// `PATH` or, for TypeScript, in the project's own `node_modules`.
pub(super) async fn find_server(language: Language, root: &Path) -> Discovery {
    find_server_on(language, root, std::env::var_os("PATH").as_deref()).await
}

/// Checks the first candidate by running it with `--version` in `root`. A
/// rustup proxy exists on `PATH` even for a toolchain without the component,
/// so for Rust rustup itself says whether the project's toolchain has it.
async fn find_server_on(language: Language, root: &Path, search_path: Option<&OsStr>) -> Discovery {
    let rustup = match language {
        Language::Rust => on_search_path("rustup", search_path)
            .into_iter()
            .find(|candidate| is_executable_file(candidate)),
        Language::TypeScript => None,
    };
    let Some(program) = candidates(language, root, search_path).into_iter().next() else {
        let toolchain = match &rustup {
            Some(rustup) => active_toolchain(rustup, root).await,
            None => None,
        };
        return Discovery::NotInstalled(MissingServer::new(language, toolchain));
    };
    let reason = match version(&program, root).await {
        Ok(version) => {
            return Discovery::Found(FoundServer {
                program,
                arguments: language
                    .server_arguments()
                    .iter()
                    .map(|argument| (*argument).to_string())
                    .collect(),
                version,
            });
        }
        Err(reason) => reason,
    };
    match rustup {
        Some(rustup) if !toolchain_has(&rustup, language.server_name(), root).await => {
            let toolchain = active_toolchain(&rustup, root).await;
            Discovery::NotInstalled(MissingServer::new(language, toolchain))
        }
        _ => Discovery::CouldNotStart { reason },
    }
}

/// The toolchain rustup uses in `root`: the first word of
/// `rustup show active-toolchain`.
async fn active_toolchain(rustup: &Path, root: &Path) -> Option<String> {
    let output = run(rustup, &["show", "active-toolchain"], root).await?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
}

/// Whether the toolchain rustup uses in `root` has `binary`, by the exit
/// status of `rustup which`.
async fn toolchain_has(rustup: &Path, binary: &str, root: &Path) -> bool {
    run(rustup, &["which", binary], root)
        .await
        .is_some_and(|output| output.status.success())
}

async fn run(program: &Path, arguments: &[&str], root: &Path) -> Option<std::process::Output> {
    let output = Command::new(program)
        .args(arguments)
        .current_dir(root)
        .kill_on_drop(true)
        .output();
    tokio::time::timeout(VERSION_TIMEOUT, output)
        .await
        .ok()?
        .ok()
}

fn candidates(language: Language, root: &Path, search_path: Option<&OsStr>) -> Vec<PathBuf> {
    let name = language.server_name();
    let local = match language {
        Language::Rust => Vec::new(),
        Language::TypeScript => project_folders(root)
            .into_iter()
            .map(|folder| folder.join("node_modules/.bin").join(name))
            .collect(),
    };
    local
        .into_iter()
        .chain(on_search_path(name, search_path))
        .filter(|candidate| is_executable_file(candidate))
        .collect()
}

async fn version(program: &Path, root: &Path) -> Result<String, String> {
    let output = Command::new(program)
        .arg("--version")
        .current_dir(root)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(VERSION_TIMEOUT, output)
        .await
        .map_err(|_| format!("{} --version did not finish.", program.display()))?
        .map_err(|error| format!("{} could not run: {error}", program.display()))?;
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(version);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{} --version failed: {}", program.display(), output.status)))
}

/// `root` and the folders directly beneath it, except hidden folders and the
/// ones only tools write.
fn project_folders(root: &Path) -> Vec<PathBuf> {
    let mut folders = vec![root.to_path_buf()];
    let Ok(entries) = std::fs::read_dir(root) else {
        return folders;
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIPPED_DIRECTORIES.contains(&name.as_ref())
        })
        .map(|entry| entry.path())
        .collect();
    children.sort();
    folders.extend(children);
    folders
}

fn on_search_path(name: &str, search_path: Option<&OsStr>) -> Vec<PathBuf> {
    search_path
        .map(|search_path| {
            std::env::split_paths(&OsString::from(search_path))
                .map(|directory| directory.join(name))
                .collect()
        })
        .unwrap_or_default()
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/language_servers/fixtures")
    }

    #[test]
    fn projects_are_found_at_the_top_and_one_folder_down() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("Cargo.toml"), "").unwrap();
        fs::create_dir(root.path().join("frontend")).unwrap();
        fs::write(root.path().join("frontend/package.json"), "{}").unwrap();

        assert_eq!(
            languages_in(root.path(), &Language::ALL),
            vec![Language::Rust, Language::TypeScript]
        );
        assert_eq!(
            languages_in(root.path(), &[Language::TypeScript]),
            vec![Language::TypeScript]
        );
    }

    #[test]
    fn markers_deeper_or_in_tool_folders_do_not_count() {
        let root = TempDir::new().unwrap();
        for folder in ["a/b", "node_modules/x", "target", ".hidden"] {
            fs::create_dir_all(root.path().join(folder)).unwrap();
        }
        fs::write(root.path().join("a/b/Cargo.toml"), "").unwrap();
        fs::write(root.path().join("node_modules/package.json"), "{}").unwrap();
        fs::write(root.path().join("target/Cargo.toml"), "").unwrap();
        fs::write(root.path().join(".hidden/tsconfig.json"), "{}").unwrap();

        assert_eq!(languages_in(root.path(), &Language::ALL), Vec::new());
    }

    #[tokio::test]
    async fn a_server_that_runs_is_found_with_its_version() {
        let root = TempDir::new().unwrap();
        let search_path = fixtures().join("installed");

        let found =
            find_server_on(Language::Rust, root.path(), Some(search_path.as_os_str())).await;

        assert_eq!(
            found,
            Discovery::Found(FoundServer {
                program: search_path.join("rust-analyzer"),
                arguments: Vec::new(),
                version: "rust-analyzer 1.96.0 (fixture)".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn a_toolchain_without_the_component_is_not_installed_for_that_toolchain() {
        let root = TempDir::new().unwrap();
        let search_path = fixtures().join("uninstalled");

        let found =
            find_server_on(Language::Rust, root.path(), Some(search_path.as_os_str())).await;

        assert_eq!(
            found,
            Discovery::NotInstalled(MissingServer {
                toolchain: Some("1.94-aarch64-apple-darwin".to_string()),
                install_command:
                    "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin"
                        .to_string(),
                check_command: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version"
                    .to_string(),
            })
        );
    }

    #[tokio::test]
    async fn rustup_without_a_proxy_still_names_the_toolchain_to_install_into() {
        let root = TempDir::new().unwrap();
        let search_path = fixtures().join("rustup-only");

        let found =
            find_server_on(Language::Rust, root.path(), Some(search_path.as_os_str())).await;

        let Discovery::NotInstalled(missing) = found else {
            panic!("expected not installed, got {found:?}");
        };
        assert_eq!(
            missing.toolchain.as_deref(),
            Some("1.94-aarch64-apple-darwin")
        );
    }

    #[tokio::test]
    async fn a_server_the_toolchain_has_that_does_not_run_could_not_start() {
        let root = TempDir::new().unwrap();
        let search_path = fixtures().join("broken");

        let found =
            find_server_on(Language::Rust, root.path(), Some(search_path.as_os_str())).await;

        assert_eq!(
            found,
            Discovery::CouldNotStart {
                reason: "rust-analyzer: could not load the toolchain sysroot (fixture)".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn nothing_on_the_search_path_is_not_installed() {
        let root = TempDir::new().unwrap();

        let rust = find_server_on(Language::Rust, root.path(), None).await;
        let typescript = find_server_on(Language::TypeScript, root.path(), None).await;

        assert_eq!(
            rust,
            Discovery::NotInstalled(MissingServer {
                toolchain: None,
                install_command: "rustup component add rust-analyzer rust-src".to_string(),
                check_command: "rust-analyzer --version".to_string(),
            })
        );
        assert_eq!(
            typescript,
            Discovery::NotInstalled(MissingServer {
                toolchain: None,
                install_command: "npm install --global typescript-language-server typescript"
                    .to_string(),
                check_command: "typescript-language-server --version".to_string(),
            })
        );
    }

    #[test]
    fn a_project_server_comes_before_the_search_path() {
        let root = TempDir::new().unwrap();
        let bin = root.path().join("frontend/node_modules/.bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(root.path().join("frontend/package.json"), "{}").unwrap();
        fs::copy(
            fixtures().join("installed/rust-analyzer"),
            bin.join("typescript-language-server"),
        )
        .unwrap();
        let search_path = fixtures().join("installed");

        let found = candidates(
            Language::TypeScript,
            root.path(),
            Some(search_path.as_os_str()),
        );

        assert_eq!(found, vec![bin.join("typescript-language-server")]);
    }
}
