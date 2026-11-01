//! Pinned official installation, independent of the separately installed CLI.
use super::{AntigravityError, protocol::VERSION};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt::Display,
    fs,
    io::{self, ErrorKind, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use uuid::Uuid;

const URL: &str =
    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip";
const SHA256: &str = "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f";
const MAX_DOWNLOAD: u64 = 1024 * 1024 * 1024;
const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallPhase {
    Idle,
    Downloading,
    Verifying,
    Extracting,
    Publishing,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationStatus {
    phase: InstallPhase,
    supported: bool,
    version: &'static str,
    installed: Option<bool>,
    executable: Option<String>,
    error: Option<String>,
}
#[derive(Clone)]
pub(super) struct Installer {
    directory: PathBuf,
    state: Arc<Mutex<InstallState>>,
}
enum InstallEvent {
    Start,
    Downloaded,
    Verified,
    Extracted,
    Finished,
}
struct InstallState {
    phase: InstallPhase,
    job: Option<Uuid>,
    error: Option<String>,
}

impl InstallState {
    fn transition(&mut self, event: InstallEvent) -> Result<(), AntigravityError> {
        self.phase = match (self.phase, event) {
            (InstallPhase::Idle, InstallEvent::Start) => InstallPhase::Downloading,
            (InstallPhase::Downloading, InstallEvent::Downloaded) => InstallPhase::Verifying,
            (InstallPhase::Verifying, InstallEvent::Verified) => InstallPhase::Extracting,
            (InstallPhase::Extracting, InstallEvent::Extracted) => InstallPhase::Publishing,
            (
                InstallPhase::Downloading
                | InstallPhase::Verifying
                | InstallPhase::Extracting
                | InstallPhase::Publishing,
                InstallEvent::Finished,
            ) => InstallPhase::Idle,
            _ => return Err(install_error("invalid or stale installation transition")),
        };
        Ok(())
    }
}

impl Installer {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Arc::new(Mutex::new(InstallState {
                phase: InstallPhase::Idle,
                job: None,
                error: None,
            })),
        }
    }
    pub(super) async fn status(&self) -> InstallationStatus {
        let state = self.state.lock().await;
        let (path, installed, problem) = match executable(&self.directory) {
            Ok(path) => (Some(path), Some(true), None),
            Err(AntigravityError::NotInstalled) => (None, Some(false), None),
            Err(error) => (None, None, Some(error.to_string())),
        };
        InstallationStatus {
            phase: state.phase,
            supported: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            version: VERSION,
            installed,
            executable: path.map(|path| path.display().to_string()),
            error: state.error.clone().or(problem),
        }
    }
    pub(super) async fn start(&self) -> Result<(), AntigravityError> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(install_error(
                "Antigravity installation currently supports macOS arm64",
            ));
        }
        let id = Uuid::new_v4();
        {
            let mut state = self.state.lock().await;
            if state.phase != InstallPhase::Idle {
                return Err(install_error(
                    "an Antigravity installation is already running",
                ));
            }
            state.job = Some(id);
            state.transition(InstallEvent::Start)?;
            state.error = None;
        }
        let installer = self.clone();
        tokio::spawn(async move {
            let result = installer.install(id).await;
            let mut state = installer.state.lock().await;
            if state.job == Some(id) {
                let _ = state.transition(InstallEvent::Finished);
                state.job = None;
                state.error = result.err().map(|error| error.to_string());
            }
        });
        Ok(())
    }

    async fn install(&self, id: Uuid) -> Result<(), AntigravityError> {
        regular_directory(&self.directory)?;
        let versions = self.directory.join("versions");
        regular_directory(&versions)?;
        tokio::fs::create_dir_all(&versions)
            .await
            .map_err(install_error)?;
        let target = versions.join(VERSION);
        if target.try_exists().map_err(install_error)? {
            executable(&self.directory)?;
            return Ok(());
        }
        let staging = versions.join(format!(".staging-{id}"));
        tokio::fs::create_dir(&staging)
            .await
            .map_err(install_error)?;
        tokio::fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
            .await
            .map_err(install_error)?;
        let result = async {
            let archive = staging.join("download.zip");
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(install_error)?;
            let response = client
                .get(URL)
                .send()
                .await
                .map_err(install_error)?
                .error_for_status()
                .map_err(install_error)?;
            if response
                .content_length()
                .is_some_and(|length| length > MAX_DOWNLOAD)
            {
                return Err(install_error("official ZIP exceeds the download limit"));
            }
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&archive)
                .await
                .map_err(install_error)?;
            let mut chunks = response.bytes_stream();
            let mut bytes = 0u64;
            let mut hash = Sha256::new();
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = chunks.next().await {
                let chunk = chunk.map_err(install_error)?;
                bytes = bytes
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| install_error("download size overflow"))?;
                if bytes > MAX_DOWNLOAD {
                    return Err(install_error("official ZIP exceeds the download limit"));
                }
                hash.update(&chunk);
                file.write_all(&chunk).await.map_err(install_error)?;
            }
            file.sync_all().await.map_err(install_error)?;
            drop(file);
            self.transition(id, InstallEvent::Downloaded).await?;
            if format!("{:x}", hash.finalize()) != SHA256 {
                return Err(install_error(
                    "official Antigravity ZIP checksum does not match the pinned release",
                ));
            }
            self.transition(id, InstallEvent::Verified).await?;
            let payload = staging.join("payload");
            let unpack = payload.clone();
            tokio::task::spawn_blocking(move || extract(&archive, &unpack))
                .await
                .map_err(install_error)??;
            self.transition(id, InstallEvent::Extracted).await?;
            let manifest = serde_json::json!({"version":VERSION,"sha256":SHA256});
            tokio::fs::write(payload.join("release.json"), manifest.to_string())
                .await
                .map_err(install_error)?;
            tokio::fs::rename(&payload, &target)
                .await
                .map_err(install_error)?;
            Ok(())
        }
        .await;
        let cleanup = tokio::fs::remove_dir_all(&staging).await;
        if result.is_ok() {
            cleanup.map_err(install_error)?;
        }
        result
    }
    async fn transition(&self, id: Uuid, event: InstallEvent) -> Result<(), AntigravityError> {
        let mut state = self.state.lock().await;
        if state.job != Some(id) {
            return Err(install_error("stale installation completion"));
        }
        state.transition(event)
    }
}

pub(super) fn executable(data: &Path) -> Result<PathBuf, AntigravityError> {
    let path = data
        .join("versions")
        .join(VERSION)
        .join("agy_acp_server.par");
    for directory in [data.join("versions"), data.join("versions").join(VERSION)] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(install_error(
                    "Antigravity installation directory is not a regular directory",
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(AntigravityError::NotInstalled);
            }
            Err(error) => return Err(install_error(error)),
        }
    }
    regular_executable(&path)?;
    regular_executable(&path.with_file_name("localharness_external"))?;
    let manifest_path = path.with_file_name("release.json");
    let mut manifest_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(manifest_path)
        .map_err(install_error)?;
    if !manifest_file.metadata().map_err(install_error)?.is_file() {
        return Err(install_error("release manifest is not a regular file"));
    }
    let mut manifest = Vec::new();
    Read::by_ref(&mut manifest_file)
        .take(4097)
        .read_to_end(&mut manifest)
        .map_err(install_error)?;
    if manifest.len() > 4096 {
        return Err(install_error("release manifest exceeds its limit"));
    }
    let manifest: Value = serde_json::from_slice(&manifest).map_err(install_error)?;
    if manifest["version"].as_str() != Some(VERSION) || manifest["sha256"].as_str() != Some(SHA256)
    {
        return Err(install_error(
            "the Antigravity installation has an invalid release manifest",
        ));
    }
    Ok(path)
}

fn regular_directory(path: &Path) -> Result<(), AntigravityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(install_error(
            "installation directory is not a regular directory",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(install_error(error)),
    }
}

fn regular_executable(path: &Path) -> Result<(), AntigravityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.permissions().mode() & 0o111 != 0 =>
        {
            Ok(())
        }
        Ok(_) => Err(install_error(
            "Antigravity release contains a link or non-executable file",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(AntigravityError::NotInstalled),
        Err(error) => Err(install_error(error)),
    }
}

fn extract(archive: &Path, destination: &Path) -> Result<(), AntigravityError> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(install_error)?)
        .map_err(install_error)?;
    if zip.len() > 1024 {
        return Err(install_error("unexpected Antigravity ZIP entry count"));
    }
    fs::create_dir(destination).map_err(install_error)?;
    let mut unpacked = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(install_error)?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| install_error("Antigravity ZIP path escapes its installation"))?;
        if entry.is_symlink()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(install_error(
                "Antigravity ZIP contains a link or non-normal path",
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err(install_error(
                "Antigravity ZIP contains a non-regular entry",
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or_else(|| install_error("ZIP size overflow"))?;
        if unpacked > MAX_UNPACKED {
            return Err(install_error(
                "Antigravity ZIP exceeds its extraction limit",
            ));
        }
        let target = destination.join(path);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(install_error)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(install_error)?;
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&target)
            .map_err(install_error)?;
        let copied = io::copy(&mut entry.by_ref().take(MAX_UNPACKED + 1), &mut file)
            .map_err(install_error)?;
        if copied != entry.size() {
            return Err(install_error(
                "Antigravity ZIP entry has an inconsistent size",
            ));
        }
        file.flush().map_err(install_error)?;
    }
    for name in ["agy_acp_server.par", "localharness_external"] {
        let path = destination.join(name);
        if !path.is_file() {
            return Err(install_error(format!("official ZIP is missing {name}")));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(install_error)?;
    }
    Ok(())
}
fn install_error(error: impl Display) -> AntigravityError {
    AntigravityError::Installation(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn manifest_and_executables_never_follow_links_or_accept_unknown_releases() {
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(
            executable(root.path()),
            Err(AntigravityError::NotInstalled)
        ));
        let version = root.path().join("versions").join(VERSION);
        fs::create_dir_all(&version).unwrap();
        for name in ["agy_acp_server.par", "localharness_external"] {
            fs::write(version.join(name), b"fixture").unwrap();
            fs::set_permissions(version.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let manifest = serde_json::json!({"version":VERSION,"sha256":SHA256}).to_string();
        fs::write(version.join("release.json"), &manifest).unwrap();
        assert!(executable(root.path()).is_ok());
        fs::write(version.join("release.json"), b"{}").unwrap();
        assert!(executable(root.path()).is_err());
        let external = root.path().join("external.json");
        fs::write(&external, manifest).unwrap();
        fs::remove_file(version.join("release.json")).unwrap();
        symlink(&external, version.join("release.json")).unwrap();
        assert!(executable(root.path()).is_err());
        fs::remove_file(version.join("agy_acp_server.par")).unwrap();
        symlink(&external, version.join("agy_acp_server.par")).unwrap();
        assert!(executable(root.path()).is_err());
    }
    #[test]
    fn installation_has_one_complete_transition_authority_and_failures_return_to_idle() {
        let mut state = InstallState {
            phase: InstallPhase::Idle,
            job: None,
            error: None,
        };
        assert!(state.transition(InstallEvent::Verified).is_err());
        state.transition(InstallEvent::Start).unwrap();
        assert!(state.transition(InstallEvent::Start).is_err());
        state.transition(InstallEvent::Downloaded).unwrap();
        state.transition(InstallEvent::Verified).unwrap();
        state.transition(InstallEvent::Extracted).unwrap();
        state.transition(InstallEvent::Finished).unwrap();
        assert_eq!(state.phase, InstallPhase::Idle);
        assert!(state.transition(InstallEvent::Finished).is_err());
        for phase in [
            InstallPhase::Downloading,
            InstallPhase::Verifying,
            InstallPhase::Extracting,
            InstallPhase::Publishing,
        ] {
            let mut state = InstallState {
                phase,
                job: Some(Uuid::new_v4()),
                error: None,
            };
            state.transition(InstallEvent::Finished).unwrap();
            assert_eq!(state.phase, InstallPhase::Idle);
        }
    }
    #[test]
    fn zip_extraction_refuses_traversal_and_preserves_files_outside_staging() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("archive.zip");
        let file = fs::File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("../outside", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"escape").unwrap();
        zip.finish().unwrap();
        assert!(extract(&archive, &root.path().join("payload")).is_err());
        assert!(!root.path().join("outside").exists());
    }
}
