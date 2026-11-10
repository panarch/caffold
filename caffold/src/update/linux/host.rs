//! This Linux user's systemd service and the release archives on GitHub,
//! through the commands and requests the update needs.

use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::Client;
use semver::Version;
use sha2::{Digest, Sha256};
use tokio::{fs::File, io::AsyncWriteExt};

use super::{Host, UpdateRequest};
use crate::update::{
    LatestRelease, Processes, fetch_latest_release,
    process::{detached, run, succeed},
    server_version,
};

const SERVICE: &str = "caffold.service";
const RELEASES: &str = "https://github.com/panarch/caffold/releases/download";
/// What every archive holds: the server and the runner it starts beside it.
const ARCHIVE_FILES: [&str; 2] = ["caffold", "caffold-runner"];
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// This Linux user, through the commands the update needs.
pub(in crate::update) struct LinuxHost;

impl Processes for LinuxHost {}

impl Host for LinuxHost {
    async fn latest_release(&self) -> Result<LatestRelease, String> {
        fetch_latest_release().await
    }

    async fn install_version(&self, version: &Version, directory: &Path) -> Result<(), String> {
        let archive = archive_name(version, env::consts::ARCH);
        install_archive(
            &format!("{RELEASES}/v{version}/{archive}"),
            &archive,
            directory,
        )
        .await
    }

    async fn restart(&self) -> Result<(), String> {
        succeed(
            run(
                Path::new("systemctl"),
                &["--user", "restart", SERVICE],
                COMMAND_TIMEOUT,
            )
            .await?,
        )
    }

    async fn service_executable(&self) -> Option<PathBuf> {
        let output = run(
            Path::new("systemctl"),
            &["--user", "show", "--property=MainPID", "--value", SERVICE],
            COMMAND_TIMEOUT,
        )
        .await
        .ok()?;
        let pid = main_pid(&output.stdout)?;
        fs::read_link(format!("/proc/{pid}/exe")).ok()
    }

    async fn server_version(&self, port: u16) -> Option<String> {
        server_version(port).await
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
}

/// Downloads the archive at `url` and its `.sha256` beside it, checks one
/// against the other, and unpacks the archive into `directory`. The work
/// happens in a staging directory beside `directory`, named as the install
/// script names it, which is gone when this returns.
async fn install_archive(url: &str, archive: &str, directory: &Path) -> Result<(), String> {
    let (Some(versions), Some(version)) = (directory.parent(), directory.file_name()) else {
        return Err(format!(
            "{} is not a version directory",
            directory.display()
        ));
    };
    let mut staging_name = OsString::from(".partial-");
    staging_name.push(version);
    let staging = versions.join(staging_name);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Caffold could not create {}: {error}", staging.display()))?;
    let installed = unpack_checked(url, archive, &staging, directory).await;
    let _ = fs::remove_dir_all(&staging);
    installed
}

async fn unpack_checked(
    url: &str,
    archive: &str,
    staging: &Path,
    directory: &Path,
) -> Result<(), String> {
    let client = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let expected = expected_checksum(&download_text(&client, &format!("{url}.sha256")).await?)
        .ok_or_else(|| format!("The checksum file of {archive} names no SHA-256 checksum."))?;
    let file = staging.join(archive);
    if download(&client, url, &file).await? != expected {
        return Err(format!("The checksum of {archive} does not match."));
    }
    let unpacked = staging.join("unpacked");
    fs::create_dir(&unpacked).map_err(|error| error.to_string())?;
    succeed(
        run(
            Path::new("tar"),
            &[
                OsString::from("-xzf"),
                file.into_os_string(),
                OsString::from("-C"),
                unpacked.clone().into_os_string(),
            ],
            COMMAND_TIMEOUT,
        )
        .await?,
    )
    .map_err(|error| format!("{archive} could not be unpacked: {error}"))?;
    if let Some(missing) = ARCHIVE_FILES
        .iter()
        .find(|name| !unpacked.join(name).is_file())
    {
        return Err(format!("{archive} holds no {missing}."));
    }
    let _ = fs::remove_dir_all(directory);
    fs::rename(&unpacked, directory)
        .map_err(|error| format!("Caffold could not move {archive} into place: {error}"))
}

/// Writes the body at `url` to `file` and returns its SHA-256.
async fn download(client: &Client, url: &str, file: &Path) -> Result<String, String> {
    let mut response = request(client, url).await?;
    let mut written = File::create(file)
        .await
        .map_err(|error| format!("Caffold could not write {}: {error}", file.display()))?;
    let mut digest = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Caffold could not download {url}: {error}"))?
    {
        digest.update(&chunk);
        written
            .write_all(&chunk)
            .await
            .map_err(|error| format!("Caffold could not write {}: {error}", file.display()))?;
    }
    written
        .flush()
        .await
        .map_err(|error| format!("Caffold could not write {}: {error}", file.display()))?;
    Ok(hex(&digest.finalize()))
}

async fn download_text(client: &Client, url: &str) -> Result<String, String> {
    request(client, url)
        .await?
        .text()
        .await
        .map_err(|error| format!("Caffold could not download {url}: {error}"))
}

async fn request(client: &Client, url: &str) -> Result<reqwest::Response, String> {
    let response = client
        .get(url)
        .header("User-Agent", concat!("Caffold/", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|error| format!("Caffold could not download {url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub answered HTTP {status} for {url}."));
    }
    Ok(response)
}

/// The checksum a `.sha256` file starts with, as `sha256sum` writes it.
fn expected_checksum(text: &str) -> Option<String> {
    let checksum = text.split_whitespace().next()?.to_ascii_lowercase();
    (checksum.len() == 64
        && checksum
            .chars()
            .all(|character| character.is_ascii_hexdigit()))
    .then_some(checksum)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The release archive for `arch`, as the release workflow names it.
fn archive_name(version: &Version, arch: &str) -> String {
    format!("Caffold-{version}-linux-{arch}.tar.gz")
}

/// `systemctl show --value` answers 0 while the service has no main process.
fn main_pid(text: &str) -> Option<u32> {
    text.trim().parse().ok().filter(|pid| *pid != 0)
}

fn worker_arguments(request: &UpdateRequest, id: &str) -> Vec<OsString> {
    vec![
        "update".into(),
        "--install-root".into(),
        request.install_root.clone().into(),
        "--data-dir".into(),
        request.data_dir.clone().into(),
        "--port".into(),
        request.port.to_string().into(),
        "--attempt".into(),
        id.into(),
    ]
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use axum::{Router, http::StatusCode, routing::get};

    use super::*;

    const ARCHIVE: &str = "Caffold-0.24.0-linux-x86_64.tar.gz";

    /// An archive with the files `names`, packed the way the release workflow
    /// packs them, and its checksum file.
    fn archive_with(names: &[&str]) -> (Vec<u8>, String) {
        let directory = tempfile::tempdir().unwrap();
        for name in names {
            fs::write(directory.path().join(name), format!("{name}\n")).unwrap();
        }
        let archive = directory.path().join(ARCHIVE);
        let packed = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(directory.path())
            .args(names)
            .status()
            .unwrap();
        assert!(packed.success());
        let bytes = fs::read(&archive).unwrap();
        let checksum = format!("{}  {ARCHIVE}\n", hex(&Sha256::digest(&bytes)));
        (bytes, checksum)
    }

    /// Serves `archive` and `checksum` where a release keeps them, and
    /// answers 404 for anything else.
    async fn release(archive: Vec<u8>, checksum: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let routes = Router::new()
            .route(
                &format!("/v0.24.0/{ARCHIVE}"),
                get(move || async move { archive }),
            )
            .route(
                &format!("/v0.24.0/{ARCHIVE}.sha256"),
                get(move || async move { checksum }),
            )
            .fallback(|| async { StatusCode::NOT_FOUND });
        tokio::spawn(async move {
            axum::serve(listener, routes).await.unwrap();
        });
        format!("http://{address}/v0.24.0/{ARCHIVE}")
    }

    fn versions() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let versions = root.path().join("versions");
        fs::create_dir_all(&versions).unwrap();
        (root, versions)
    }

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn unpacks_a_checked_archive_into_its_version_directory() {
        let (archive, checksum) = archive_with(&ARCHIVE_FILES);
        let url = release(archive, checksum).await;
        let (_root, versions) = versions();
        let directory = versions.join("0.24.0");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("left-by-an-earlier-attempt"), "").unwrap();

        install_archive(&url, ARCHIVE, &directory).await.unwrap();

        assert_eq!(entries(&directory), ["caffold", "caffold-runner"]);
        assert_eq!(
            fs::read_to_string(directory.join("caffold")).unwrap(),
            "caffold\n"
        );
        assert_eq!(entries(&versions), ["0.24.0"]);
    }

    #[tokio::test]
    async fn refuses_an_archive_whose_checksum_does_not_match() {
        let (archive, _) = archive_with(&ARCHIVE_FILES);
        let (_, other) = archive_with(&["caffold"]);
        let url = release(archive, other).await;
        let (_root, versions) = versions();

        assert_eq!(
            install_archive(&url, ARCHIVE, &versions.join("0.24.0")).await,
            Err(format!("The checksum of {ARCHIVE} does not match."))
        );
        assert!(entries(&versions).is_empty());
    }

    #[tokio::test]
    async fn refuses_an_archive_without_the_runner() {
        let (archive, checksum) = archive_with(&["caffold"]);
        let url = release(archive, checksum).await;
        let (_root, versions) = versions();

        assert_eq!(
            install_archive(&url, ARCHIVE, &versions.join("0.24.0")).await,
            Err(format!("{ARCHIVE} holds no caffold-runner."))
        );
        assert!(entries(&versions).is_empty());
    }

    #[tokio::test]
    async fn names_the_answer_of_a_release_without_the_archive() {
        let (archive, checksum) = archive_with(&ARCHIVE_FILES);
        let url = release(archive, checksum).await;
        let missing = url.replace("x86_64", "riscv64");
        let (_root, versions) = versions();

        let error = install_archive(&missing, ARCHIVE, &versions.join("0.24.0"))
            .await
            .unwrap_err();

        assert_eq!(
            error,
            format!("GitHub answered HTTP 404 Not Found for {missing}.sha256.")
        );
        assert!(entries(&versions).is_empty());
    }

    #[test]
    fn reads_the_checksum_sha256sum_writes() {
        let checksum = "a".repeat(64);
        assert_eq!(
            expected_checksum(&format!("{checksum}  {ARCHIVE}\n")),
            Some(checksum.clone())
        );
        assert_eq!(
            expected_checksum(&format!("{}\n", checksum.to_uppercase())),
            Some(checksum)
        );
        assert_eq!(expected_checksum("abc  file\n"), None);
        assert_eq!(
            expected_checksum(&format!("{}  file", "g".repeat(64))),
            None
        );
        assert_eq!(expected_checksum(""), None);
    }

    #[test]
    fn names_the_archive_as_the_release_workflow_does() {
        let version = Version::parse("0.24.0-rc.1").unwrap();

        assert_eq!(
            archive_name(&version, "aarch64"),
            "Caffold-0.24.0-rc.1-linux-aarch64.tar.gz"
        );
    }

    #[test]
    fn reads_the_main_process_of_a_running_service_only() {
        assert_eq!(main_pid("1234\n"), Some(1234));
        assert_eq!(main_pid("0\n"), None);
        assert_eq!(main_pid(""), None);
    }

    #[test]
    fn hands_the_worker_the_same_request() {
        let request = UpdateRequest {
            install_root: PathBuf::from("/home/me/.local/share/caffold"),
            link: PathBuf::from("/home/me/.local/bin/caffold"),
            data_dir: PathBuf::from("/home/me/.caffold"),
            port: 5178,
        };

        assert_eq!(
            worker_arguments(&request, "20261110T121000Z"),
            [
                "update",
                "--install-root",
                "/home/me/.local/share/caffold",
                "--data-dir",
                "/home/me/.caffold",
                "--port",
                "5178",
                "--attempt",
                "20261110T121000Z",
            ]
            .map(OsString::from)
        );
    }
}
