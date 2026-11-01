//! Exact native session files, removed only after writers and readers stop.
use super::{AntigravityError, invalid, validate_session};
use std::{fs, io::ErrorKind, path::Path};

pub(super) fn erase(root: &Path, native: &str) -> Result<(), AntigravityError> {
    validate_session(native)?;
    let root = match fs::canonicalize(root) {
        Ok(root) => root,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(invalid(&error.to_string())),
    };
    // Refuse intermediate directory links before removing any target. A link
    // inside a brain tree is unlinked by remove_dir_all, never traversed.
    for name in ["conversations", "brain"] {
        match fs::symlink_metadata(root.join(name)) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(invalid("native cleanup parent is not a regular directory"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(invalid(&error.to_string())),
        }
    }
    let paths = [
        root.join("conversations").join(format!("{native}.db")),
        root.join("conversations").join(format!("{native}.db-wal")),
        root.join("conversations").join(format!("{native}.db-shm")),
        root.join("conversations").join(format!("{native}.meta")),
        root.join("brain").join(native),
    ];
    for (index, path) in paths.iter().enumerate() {
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || (index == 4 && !metadata.is_dir())
                    || (index < 4 && !metadata.is_file()) =>
            {
                return Err(invalid(
                    "native cleanup target is not the expected regular file or directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(invalid(&error.to_string())),
        }
    }
    for (index, path) in paths.iter().enumerate() {
        let result = if index == 4 {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(invalid(&error.to_string())),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const NATIVE: &str = "63910fa2-b1ed-4e64-87b8-b9928c1d7015";
    #[test]
    fn exact_native_files_are_removed_and_other_sessions_and_shared_auth_survive() {
        let root = tempfile::tempdir().unwrap();
        let conversations = root.path().join("conversations");
        fs::create_dir(&conversations).unwrap();
        let brain = root.path().join("brain").join(NATIVE);
        fs::create_dir_all(&brain).unwrap();
        fs::write(brain.join("artifact"), b"artifact").unwrap();
        for suffix in [".db", ".db-wal", ".db-shm", ".meta"] {
            fs::write(conversations.join(format!("{NATIVE}{suffix}")), b"fixture").unwrap();
        }
        fs::write(conversations.join("other.db"), b"other").unwrap();
        fs::write(root.path().join("credentials"), b"kept").unwrap();
        erase(root.path(), NATIVE).unwrap();
        erase(root.path(), NATIVE).unwrap();
        assert!(!brain.exists());
        assert_eq!(fs::read(conversations.join("other.db")).unwrap(), b"other");
        assert_eq!(fs::read(root.path().join("credentials")).unwrap(), b"kept");
    }
    #[test]
    fn links_at_cleanup_parents_or_targets_do_not_remove_anything() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let kept = outside.path().join(format!("{NATIVE}.db"));
        fs::write(&kept, b"kept").unwrap();
        symlink(outside.path(), root.path().join("conversations")).unwrap();
        assert!(erase(root.path(), NATIVE).is_err());
        assert_eq!(fs::read(&kept).unwrap(), b"kept");
        fs::remove_file(root.path().join("conversations")).unwrap();
        fs::create_dir(root.path().join("conversations")).unwrap();
        symlink(
            &kept,
            root.path()
                .join("conversations")
                .join(format!("{NATIVE}.db")),
        )
        .unwrap();
        assert!(erase(root.path(), NATIVE).is_err());
        assert_eq!(fs::read(kept).unwrap(), b"kept");
        assert!(erase(root.path(), "../other").is_err());
    }
}
