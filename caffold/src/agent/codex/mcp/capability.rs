use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SESSION_VERSION: &str = "s1";
const KEY_BYTES: usize = 32;
const DIGEST_LENGTH: usize = 43;
const SIGNATURE_LENGTH: usize = 43;
const MAX_THREAD_ID_BYTES: usize = 512;
const MAX_ENCODED_THREAD_ID_LENGTH: usize = MAX_THREAD_ID_BYTES.div_ceil(3) * 4;
const KEY_FILE_NAME: &str = "signing.key";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub(super) enum CapabilitySignerError {
    #[error("failed to access the Codex MCP signing key: {0}")]
    Io(#[from] io::Error),
    #[error("the Codex MCP signing key is invalid")]
    InvalidKey,
    #[error("the Codex MCP signing-key path is not a private regular file or directory")]
    UnsafePath,
    #[error("the Codex MCP thread identity cannot be represented in a transport session")]
    InvalidThread,
}

/// The one installation-owned secret used to authenticate self-contained MCP
/// sessions across Caffold backend generations.
///
/// A session contains its thread id and a digest of the private binding header.
/// It is useful only together with that header; the session value is therefore
/// not a bearer capability if Codex includes it in a transport diagnostic.
#[derive(Clone)]
pub(super) struct CapabilitySigner {
    key: [u8; KEY_BYTES],
}

impl CapabilitySigner {
    pub(super) fn memory() -> Self {
        Self { key: random_key() }
    }

    pub(super) fn open(root: PathBuf) -> Result<Self, CapabilitySignerError> {
        secure_directory(&root)?;
        let key = load_or_create_key(&root.join(KEY_FILE_NAME))?;
        Ok(Self { key })
    }

    pub(super) fn issue_thread_session(
        &self,
        binding: &str,
        thread_id: &str,
    ) -> Result<String, CapabilitySignerError> {
        if thread_id.is_empty() || thread_id.len() > MAX_THREAD_ID_BYTES {
            return Err(CapabilitySignerError::InvalidThread);
        }
        let encoded_thread = URL_SAFE_NO_PAD.encode(thread_id.as_bytes());
        let binding_digest = binding_digest(binding);
        let payload = format!("{SESSION_VERSION}.{encoded_thread}.{binding_digest}");
        let signature = self.sign(&payload);
        Ok(format!("{payload}.{signature}"))
    }

    pub(super) fn resolve_thread_session(&self, binding: &str, session: &str) -> Option<String> {
        let mut parts = session.split('.');
        let version = parts.next()?;
        let encoded_thread = parts.next()?;
        let encoded_binding_digest = parts.next()?;
        let encoded_signature = parts.next()?;
        if parts.next().is_some()
            || version != SESSION_VERSION
            || encoded_binding_digest.len() != DIGEST_LENGTH
            || encoded_signature.len() != SIGNATURE_LENGTH
            || !header_component(encoded_thread)
            || !header_component(encoded_binding_digest)
            || !header_component(encoded_signature)
            || encoded_binding_digest != binding_digest(binding)
        {
            return None;
        }
        let payload = format!("{version}.{encoded_thread}.{encoded_binding_digest}");
        let signature = URL_SAFE_NO_PAD.decode(encoded_signature).ok()?;
        let mut mac = HmacSha256::new_from_slice(&self.key).ok()?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature).ok()?;
        let thread = URL_SAFE_NO_PAD.decode(encoded_thread).ok()?;
        if thread.is_empty() || thread.len() > MAX_THREAD_ID_BYTES {
            return None;
        }
        String::from_utf8(thread).ok()
    }

    fn sign(&self, payload: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(&self.key).expect("a fixed-size SHA-256 key is valid");
        mac.update(payload.as_bytes());
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

pub(super) fn looks_like_thread_session(candidate: &str) -> bool {
    let mut parts = candidate.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(SESSION_VERSION), Some(thread), Some(binding), Some(signature), None)
            if !thread.is_empty()
                && thread.len() <= MAX_ENCODED_THREAD_ID_LENGTH
                && header_component(thread)
                && binding.len() == DIGEST_LENGTH
                && header_component(binding)
                && signature.len() == SIGNATURE_LENGTH
                && header_component(signature)
    )
}

fn binding_digest(binding: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(binding.as_bytes()))
}

fn header_component(component: &str) -> bool {
    component
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn random_key() -> [u8; KEY_BYTES] {
    let mut key = [0_u8; KEY_BYTES];
    key[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    key
}

fn load_or_create_key(path: &Path) -> Result<[u8; KEY_BYTES], CapabilitySignerError> {
    let mut file = open_key_file(path)?;
    File::lock(&file)?;
    let result = read_or_initialize_key(&mut file);
    let unlock = File::unlock(&file);
    match (result, unlock) {
        (Ok(key), Ok(())) => Ok(key),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn open_key_file(path: &Path) -> Result<File, CapabilitySignerError> {
    loop {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(CapabilitySignerError::UnsafePath);
            }
            Ok(_) => {
                #[cfg(unix)]
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
                return Ok(OpenOptions::new().read(true).write(true).open(path)?);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut options = OpenOptions::new();
                options.read(true).write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                match options.open(path) {
                    Ok(file) => return Ok(file),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn read_or_initialize_key(file: &mut File) -> Result<[u8; KEY_BYTES], CapabilitySignerError> {
    match file.metadata()?.len() {
        0 => {
            let key = random_key();
            file.write_all(&key)?;
            file.sync_all()?;
            Ok(key)
        }
        length if length == KEY_BYTES as u64 => {
            let mut key = [0_u8; KEY_BYTES];
            file.seek(SeekFrom::Start(0))?;
            file.read_exact(&mut key)?;
            Ok(key)
        }
        _ => Err(CapabilitySignerError::InvalidKey),
    }
}

fn secure_directory(path: &Path) -> Result<(), CapabilitySignerError> {
    fs::create_dir_all(path)?;
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(CapabilitySignerError::UnsafePath);
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_session_survives_signer_reopening() {
        let root = tempfile::tempdir().unwrap();
        let first = CapabilitySigner::open(root.path().to_path_buf()).unwrap();
        let session = first
            .issue_thread_session("private-binding", "thread_1")
            .unwrap();

        let replacement = CapabilitySigner::open(root.path().to_path_buf()).unwrap();

        assert_eq!(
            replacement.resolve_thread_session("private-binding", &session),
            Some("thread_1".to_string())
        );
    }

    #[test]
    fn a_session_is_bound_to_both_its_private_header_and_exact_thread() {
        let signer = CapabilitySigner::memory();
        assert!(matches!(
            signer.issue_thread_session("binding-a", ""),
            Err(CapabilitySignerError::InvalidThread)
        ));
        assert!(matches!(
            signer.issue_thread_session("binding-a", &"x".repeat(MAX_THREAD_ID_BYTES + 1)),
            Err(CapabilitySignerError::InvalidThread)
        ));
        let session = signer
            .issue_thread_session("binding-a", "thread_1")
            .unwrap();
        let mut forged = session.clone().into_bytes();
        *forged.last_mut().unwrap() = if forged.last() == Some(&b'a') {
            b'b'
        } else {
            b'a'
        };

        assert_eq!(
            signer.resolve_thread_session("binding-a", &session),
            Some("thread_1".to_string())
        );
        assert_eq!(signer.resolve_thread_session("binding-b", &session), None);
        assert_eq!(
            signer.resolve_thread_session("binding-a", &String::from_utf8(forged).unwrap()),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn signing_material_is_one_private_installation_file() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("codex-mcp");
        CapabilitySigner::open(state.clone()).unwrap();

        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(state.join(KEY_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(state).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_signing_material_fails_closed_without_silent_rotation() {
        let root = tempfile::tempdir().unwrap();
        let key_path = root.path().join(KEY_FILE_NAME);
        fs::write(&key_path, b"corrupt").unwrap();

        assert!(matches!(
            CapabilitySigner::open(root.path().to_path_buf()),
            Err(CapabilitySignerError::InvalidKey)
        ));
        assert_eq!(fs::read(key_path).unwrap(), b"corrupt");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_signer_paths_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked_store = root.path().join("linked-store");
        symlink(outside.path(), &linked_store).unwrap();
        assert!(matches!(
            CapabilitySigner::open(linked_store),
            Err(CapabilitySignerError::UnsafePath)
        ));

        let state = root.path().join("codex-mcp");
        fs::create_dir(&state).unwrap();
        let outside_key = outside.path().join("key");
        fs::write(&outside_key, [0_u8; KEY_BYTES]).unwrap();
        symlink(&outside_key, state.join(KEY_FILE_NAME)).unwrap();
        assert!(matches!(
            CapabilitySigner::open(state),
            Err(CapabilitySignerError::UnsafePath)
        ));
    }
}
