//! Resolve Task-relative Note input against the server's filesystem boundary.
//! Symlinks are resolved once; descriptor-relative opens then refuse replaced
//! symlinks in every component, including the path to the server root.

use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path},
};

use rustix::fs::{AtFlags, FileType, Mode, OFlags, open, openat, statat};

use crate::{
    agent::notes_tools::{MAX_NOTE_FILE_BYTES, NoteContent},
    fs::RootedFs,
};

pub(super) fn resolve(
    content: NoteContent,
    fs: Option<&RootedFs>,
    task_cwd: Option<&Path>,
) -> Result<String, String> {
    let path = match content {
        NoteContent::Text(text) => return Ok(text),
        NoteContent::File(path) => path,
    };
    let fs = fs.ok_or_else(|| "Caffold's Notes file access is unavailable.".to_string())?;
    let requested = Path::new(&path);
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        let cwd = task_cwd.filter(|cwd| cwd.is_absolute()).ok_or_else(|| {
            "Caffold could not determine this Task's working directory for `contentPath`. Retry when the Task directory is available, or use an absolute path inside the server's filesystem root.".to_string()
        })?;
        cwd.join(requested)
    };
    let absolute = candidate.canonicalize().map_err(|error| {
        format!(
            "Caffold could not resolve `contentPath` `{path}` inside the server's filesystem root: {error}. Check that the file exists, is readable, and stays inside that root."
        )
    })?;
    // Keep the canonical path as OS components: a symlink target can contain
    // non-UTF-8 names even though the tool's supplied path is a JSON string.
    let logical = absolute.strip_prefix(fs.root()).map_err(|_| {
        format!("`contentPath` `{path}` resolves outside the server's filesystem root. Choose a file inside that root.")
    })?;
    let file = open_resolved(fs.root(), logical).map_err(|error| {
        format!(
            "Caffold could not safely open `contentPath` `{path}` as a regular file: {error}. Check permissions and retry if the path changed."
        )
    })?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Caffold could not inspect `contentPath` `{path}`: {error}."))?;
    if !metadata.is_file() {
        return Err(format!("`contentPath` `{path}` must name a regular file."));
    }
    if metadata.len() > MAX_NOTE_FILE_BYTES {
        return Err(too_large(&path));
    }
    read_opened(file, metadata.len(), &path)
}

fn open_resolved(root: &Path, logical: &Path) -> io::Result<File> {
    let mut directory = open("/", directory_flags(), Mode::empty())?;
    // Both paths come from RootedFs canonicalization. Starting at / also
    // refuses a symlink installed in an ancestor of the configured root.
    for component in root
        .components()
        .chain(logical.parent().into_iter().flat_map(Path::components))
    {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = openat(&directory, name, directory_flags(), Mode::empty())?;
            }
            _ => return Err(io::Error::other("the resolved file path changed; retry")),
        }
    }
    let name = logical
        .file_name()
        .ok_or_else(|| io::Error::other("not a regular file"))?;
    let metadata = statat(&directory, name, AtFlags::SYMLINK_NOFOLLOW)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(io::Error::other(
            "not a regular file, or the path changed; retry",
        ));
    }
    // NONBLOCK keeps a regular file swapped for a FIFO from blocking open.
    // The opened handle is checked again before reading any bytes.
    Ok(File::from(openat(
        &directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )?))
}

fn directory_flags() -> OFlags {
    // Traversal needs search permission, not permission to list a directory.
    #[cfg(target_os = "macos")]
    let access = OFlags::from_bits_retain(libc::O_SEARCH as _);
    #[cfg(target_os = "linux")]
    let access = OFlags::PATH;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let access = OFlags::RDONLY;
    access | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY
}

fn read_opened(file: File, checked_size: u64, path: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(checked_size as usize);
    file.take(MAX_NOTE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Caffold could not read `contentPath` `{path}`: {error}."))?;
    if bytes.len() as u64 > MAX_NOTE_FILE_BYTES {
        return Err(too_large(path));
    }
    String::from_utf8(bytes).map_err(|_| {
        format!("`contentPath` `{path}` is not valid UTF-8. Save the file as UTF-8 and retry.")
    })
}

fn too_large(path: &str) -> String {
    format!(
        "`contentPath` `{path}` exceeds the 1 MiB limit ({MAX_NOTE_FILE_BYTES} bytes). Use a smaller file; nothing was written."
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::{
            fs::{PermissionsExt, symlink},
            net::UnixListener,
        },
        process::Command,
    };

    use super::*;

    #[test]
    fn task_relative_and_absolute_paths_read_siblings_and_preserve_every_utf8_byte() {
        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();
        let cwd = rooted.root().join("backend");
        fs::create_dir(&cwd).unwrap();
        fs::create_dir(rooted.root().join("shared")).unwrap();
        let expected = "\u{feff}# 한글\r\n\0 keep trailing spaces  \r\n";
        let file = rooted.root().join("shared/ result.md ");
        fs::write(&file, expected).unwrap();
        symlink(&file, cwd.join("linked.md")).unwrap();
        for path in [
            "../shared/ result.md ".to_string(),
            file.display().to_string(),
            "linked.md".to_string(),
        ] {
            let content = resolve(NoteContent::File(path), Some(&rooted), Some(&cwd)).unwrap();
            assert_eq!(content.as_bytes(), expected.as_bytes());
        }
        assert_eq!(
            resolve(
                NoteContent::File(file.display().to_string()),
                Some(&rooted),
                None
            )
            .unwrap(),
            expected
        );
        assert!(
            resolve(
                NoteContent::File("linked.md".to_string()),
                Some(&rooted),
                None
            )
            .unwrap_err()
            .contains("working directory")
        );
        assert!(
            resolve(
                NoteContent::File("linked.md".to_string()),
                Some(&rooted),
                Some(Path::new("backend"))
            )
            .is_err()
        );
        assert!(
            resolve(NoteContent::File(file.display().to_string()), None, None)
                .unwrap_err()
                .contains("unavailable")
        );
        assert_eq!(
            resolve(NoteContent::Text("inline".to_string()), None, None).unwrap(),
            "inline"
        );
        let global = RootedFs::from_filesystem_root().unwrap();
        assert_eq!(
            resolve(
                NoteContent::File(file.display().to_string()),
                Some(&global),
                None
            )
            .unwrap(),
            expected
        );
    }

    #[test]
    fn files_outside_the_server_root_and_non_regular_files_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let sibling = temp.path().join("root-other");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        fs::write(sibling.join("secret.md"), "outside").unwrap();
        symlink(&sibling, root.join("outside")).unwrap();
        symlink(root.join("missing"), root.join("broken")).unwrap();
        let rooted = RootedFs::new(&root).unwrap();
        let socket = root.join("socket");
        let _listener = UnixListener::bind(&socket).unwrap();
        assert!(
            Command::new("mkfifo")
                .arg(root.join("fifo"))
                .status()
                .unwrap()
                .success()
        );
        fs::write(root.join("invalid.md"), [0xff]).unwrap();
        fs::write(root.join("private.md"), "private").unwrap();
        fs::set_permissions(root.join("private.md"), fs::Permissions::from_mode(0o0)).unwrap();
        for path in ["../root-other/secret.md", "outside/secret.md"] {
            let error = resolve(
                NoteContent::File(path.to_string()),
                Some(&rooted),
                Some(&root),
            )
            .unwrap_err();
            assert!(error.contains("outside the server"), "{error}");
        }
        for path in [
            "missing",
            "broken",
            ".",
            "socket",
            "fifo",
            "private.md",
            "invalid.md",
        ] {
            let error = resolve(
                NoteContent::File(path.to_string()),
                Some(&rooted),
                Some(&root),
            )
            .unwrap_err();
            assert!(error.contains("contentPath"), "{path}: {error}");
            if path == "invalid.md" {
                assert!(error.contains("not valid UTF-8"), "{error}");
            }
        }
    }

    #[test]
    fn size_limits_apply_to_bytes_including_files_that_grow_after_the_size_check() {
        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();
        let path = rooted.root().join("file.md");
        for size in [
            0,
            MAX_NOTE_FILE_BYTES - 1,
            MAX_NOTE_FILE_BYTES,
            MAX_NOTE_FILE_BYTES + 1,
        ] {
            fs::write(&path, vec![b'a'; size as usize]).unwrap();
            let answer = resolve(
                NoteContent::File(path.display().to_string()),
                Some(&rooted),
                None,
            );
            if size <= MAX_NOTE_FILE_BYTES {
                assert_eq!(answer.unwrap().len() as u64, size);
            } else {
                assert!(answer.unwrap_err().contains("1048576 bytes"));
            }
        }
        fs::write(&path, "한".repeat(MAX_NOTE_FILE_BYTES as usize / 3 + 1)).unwrap();
        assert!(
            resolve(
                NoteContent::File(path.display().to_string()),
                Some(&rooted),
                None
            )
            .is_err()
        );
        fs::write(&path, "").unwrap();
        let opened = File::open(&path).unwrap();
        let checked_size = opened.metadata().unwrap().len();
        fs::write(&path, vec![b'a'; MAX_NOTE_FILE_BYTES as usize + 1]).unwrap();
        assert!(
            read_opened(opened, checked_size, "file.md")
                .unwrap_err()
                .contains("1 MiB")
        );
    }

    #[test]
    fn resolved_paths_cannot_be_replaced_with_symlinks_before_opening() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("docs/file.md"), "inside").unwrap();
        fs::write(outside.join("file.md"), "outside").unwrap();
        let root = root.canonicalize().unwrap();
        // Replace a checked parent, then a checked leaf, then the server root.
        fs::rename(root.join("docs"), root.join("held")).unwrap();
        symlink(&outside, root.join("docs")).unwrap();
        assert!(open_resolved(&root, Path::new("docs/file.md")).is_err());
        fs::rename(root.join("held/file.md"), root.join("held/original.md")).unwrap();
        symlink(outside.join("file.md"), root.join("held/file.md")).unwrap();
        assert!(open_resolved(&root, Path::new("held/file.md")).is_err());
        let opened = open_resolved(&root, Path::new("held/original.md")).unwrap();
        fs::rename(root.join("held/original.md"), root.join("held/saved.md")).unwrap();
        symlink(outside.join("file.md"), root.join("held/original.md")).unwrap();
        assert_eq!(read_opened(opened, 6, "file.md").unwrap(), "inside");
        fs::rename(&root, temp.path().join("held-root")).unwrap();
        symlink(&outside, &root).unwrap();
        assert!(open_resolved(&root, Path::new("file.md")).is_err());
    }

    #[test]
    fn readable_files_do_not_require_permission_to_list_their_parent_directory() {
        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();
        let directory = rooted.root().join("search-only");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("file.md"), "readable").unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o100)).unwrap();
        let result = resolve(
            NoteContent::File("search-only/file.md".to_string()),
            Some(&rooted),
            Some(rooted.root()),
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(result.unwrap(), "readable");
    }

    // This macOS volume refuses creating non-UTF-8 filenames (EILSEQ).
    // Linux exercises byte-preserving path components at the real FS boundary.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_utf8_symlink_can_name_a_file_with_non_utf8_os_components() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();
        let raw_name = OsString::from_vec(vec![b'f', 0xff]);
        fs::write(rooted.root().join(&raw_name), "selected file").unwrap();
        fs::write(rooted.root().join("f�"), "different file").unwrap();
        symlink(raw_name, rooted.root().join("link.md")).unwrap();
        assert_eq!(
            resolve(
                NoteContent::File("link.md".to_string()),
                Some(&rooted),
                Some(rooted.root())
            )
            .unwrap(),
            "selected file"
        );
    }
}
