//! Reads a whole file for a viewer to show. Each kind of viewer accepts its own
//! file types and size limit; a download is the file as it is and lives with
//! `RootedFs::open_download` instead.

use std::{fs, io::Read, path::Path};

use serde::Serialize;

use super::{FsError, ResolvedPath, RootedFs, modified_ms, relative_path_string};

pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileResponse {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub language_hint: Option<String>,
    pub content: String,
}

/// A file a library-backed document viewer draws, with the Content-Type its
/// extension names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentFile {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResponse {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

impl RootedFs {
    pub fn read_file(&self, requested_path: &str) -> Result<FileResponse, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let file = read_bounded(&resolved, requested_path, MAX_FILE_BYTES)?;

        if file.bytes.contains(&0) {
            return Err(FsError::BinaryFile {
                path: requested_path.to_string(),
            });
        }

        let content = String::from_utf8(file.bytes).map_err(|_| FsError::InvalidUtf8 {
            path: requested_path.to_string(),
        })?;

        Ok(FileResponse {
            path: relative_path_string(&resolved.logical),
            name: display_name(&resolved),
            size: file.metadata.len(),
            modified_ms: modified_ms(&file.metadata),
            language_hint: language_hint(&resolved.logical),
            content,
        })
    }

    pub fn read_image(&self, requested_path: &str) -> Result<ImageResponse, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let content_type =
            image_content_type(&resolved.logical).ok_or_else(|| FsError::UnsupportedImage {
                path: requested_path.to_string(),
            })?;
        let file = read_bounded(&resolved, requested_path, MAX_IMAGE_BYTES)?;

        Ok(ImageResponse {
            path: relative_path_string(&resolved.logical),
            name: display_name(&resolved),
            size: file.metadata.len(),
            modified_ms: modified_ms(&file.metadata),
            content_type,
            bytes: file.bytes,
        })
    }

    pub fn read_document(&self, requested_path: &str) -> Result<DocumentFile, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let content_type = document_content_type(&resolved.logical).ok_or_else(|| {
            FsError::UnsupportedDocument {
                path: requested_path.to_string(),
            }
        })?;
        let file = read_bounded(&resolved, requested_path, MAX_DOCUMENT_BYTES)?;
        Ok(DocumentFile {
            content_type,
            bytes: file.bytes,
        })
    }
}

struct BoundedFile {
    metadata: fs::Metadata,
    bytes: Vec<u8>,
}

// The size is checked before reading and again after, because the file can
// grow in between; the read itself stops one byte past the limit.
fn read_bounded(
    resolved: &ResolvedPath,
    requested_path: &str,
    limit: u64,
) -> Result<BoundedFile, FsError> {
    let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
        action: "read metadata",
        path: requested_path.to_string(),
        source,
    })?;

    if metadata.is_dir() {
        return Err(FsError::IsDirectory {
            path: requested_path.to_string(),
        });
    }

    if !metadata.is_file() {
        return Err(FsError::NotFile {
            path: requested_path.to_string(),
        });
    }

    if metadata.len() > limit {
        return Err(FsError::FileTooLarge {
            path: requested_path.to_string(),
            size: metadata.len(),
            limit,
        });
    }

    let mut file = fs::File::open(&resolved.absolute).map_err(|source| FsError::Io {
        action: "open file",
        path: requested_path.to_string(),
        source,
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| FsError::Io {
            action: "read file",
            path: requested_path.to_string(),
            source,
        })?;

    if bytes.len() as u64 > limit {
        return Err(FsError::FileTooLarge {
            path: requested_path.to_string(),
            size: bytes.len() as u64,
            limit,
        });
    }

    Ok(BoundedFile { metadata, bytes })
}

fn display_name(resolved: &ResolvedPath) -> String {
    resolved
        .logical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| relative_path_string(&resolved.logical))
}

fn document_content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "xlsm" => Some("application/vnd.ms-excel.sheet.macroEnabled.12"),
        _ => None,
    }
}

fn language_hint(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let language = match extension.as_str() {
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "css" => "css",
        "go" => "go",
        "html" | "htm" => "xml",
        "java" => "java",
        "js" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "kt" | "kts" => "kotlin",
        "md" | "markdown" => "markdown",
        "py" => "python",
        "rb" => "ruby",
        "rs" => "rust",
        "sh" | "bash" | "zsh" => "bash",
        "sql" => "sql",
        "toml" => "toml",
        "ts" | "tsx" => "typescript",
        "xml" => "xml",
        "yaml" | "yml" => "yaml",
        _ => return None,
    };

    Some(language.to_string())
}

fn image_content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    match extension.as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml; charset=utf-8"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_up_to_the_limit_and_refuses_one_byte_more() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("four.bin"), b"abcd").unwrap();
        fs::write(temp.path().join("five.bin"), b"abcde").unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();

        let four = rooted.resolve_existing("four.bin").unwrap();
        assert_eq!(read_bounded(&four, "four.bin", 4).unwrap().bytes, b"abcd");

        let five = rooted.resolve_existing("five.bin").unwrap();
        assert!(matches!(
            read_bounded(&five, "five.bin", 4),
            Err(FsError::FileTooLarge {
                size: 5,
                limit: 4,
                ..
            })
        ));
    }

    #[test]
    fn refuses_a_directory_and_anything_but_a_regular_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        let _listener =
            std::os::unix::net::UnixListener::bind(temp.path().join("agent.sock")).unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("src"),
            Err(FsError::IsDirectory { .. })
        ));
        assert!(matches!(
            rooted.read_file("agent.sock"),
            Err(FsError::NotFile { .. })
        ));
    }

    #[test]
    fn reads_text_with_its_language_hint() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();

        let file = rooted.read_file("src/main.rs").unwrap();

        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.name, "main.rs");
        assert_eq!(file.size, 13);
        assert_eq!(file.language_hint.as_deref(), Some("rust"));
        assert_eq!(file.content, "fn main() {}\n");
    }

    #[test]
    fn rejects_binary_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("binary.bin"), b"abc\0def").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("binary.bin"),
            Err(FsError::BinaryFile { .. })
        ));
    }

    #[test]
    fn rejects_invalid_utf8_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("invalid.txt"), [0xff, 0xfe, 0xfd]).unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("invalid.txt"),
            Err(FsError::InvalidUtf8 { .. })
        ));
    }

    #[test]
    fn rejects_large_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("large.txt"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("large.txt"),
            Err(FsError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn reads_supported_image_preview() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("preview.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#,
        )
        .unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let image = rooted.read_image("preview.svg").unwrap();

        assert_eq!(image.path, "preview.svg");
        assert_eq!(image.name, "preview.svg");
        assert_eq!(image.content_type, "image/svg+xml; charset=utf-8");
        assert!(image.bytes.starts_with(b"<svg"));
    }

    #[test]
    fn rejects_unsupported_image_preview_type() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("notes.txt"), "hello").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_image("notes.txt"),
            Err(FsError::UnsupportedImage { .. })
        ));
    }

    #[test]
    fn rejects_large_image() {
        let temp = tempfile::tempdir().unwrap();
        fs::File::create(temp.path().join("large.png"))
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_image("large.png"),
            Err(FsError::FileTooLarge { .. })
        ));
    }

    #[test]
    fn reads_each_document_kind_with_its_content_type() {
        let temp = tempfile::tempdir().unwrap();
        let documents = [
            ("manual.pdf", "application/pdf"),
            (
                "Minutes.DOCX",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            (
                "deck.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            (
                "budget.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            (
                "macros.xlsm",
                "application/vnd.ms-excel.sheet.macroEnabled.12",
            ),
        ];
        for (name, _) in documents {
            fs::write(temp.path().join(name), name.as_bytes()).unwrap();
        }

        let rooted = RootedFs::new(temp.path()).unwrap();

        for (name, content_type) in documents {
            assert_eq!(
                rooted.read_document(name).unwrap(),
                DocumentFile {
                    content_type,
                    bytes: name.as_bytes().to_vec(),
                },
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_a_file_no_document_viewer_draws() {
        let temp = tempfile::tempdir().unwrap();
        let names = [
            "report.doc",
            "deck.ppt",
            "budget.xls",
            "notes.txt",
            "archive",
        ];
        for name in names {
            fs::write(temp.path().join(name), b"legacy").unwrap();
        }

        let rooted = RootedFs::new(temp.path()).unwrap();

        for name in names {
            assert!(
                matches!(
                    rooted.read_document(name),
                    Err(FsError::UnsupportedDocument { .. })
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_a_directory_named_like_a_document() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("bundle.pdf")).unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_document("bundle.pdf"),
            Err(FsError::IsDirectory { .. })
        ));
    }

    #[test]
    fn reads_a_document_of_100_mib_and_refuses_a_larger_one_of_every_kind() {
        let temp = tempfile::tempdir().unwrap();
        sparse_file(&temp.path().join("limit.xlsx"), 100 * 1024 * 1024);
        for extension in ["pdf", "docx", "pptx", "xlsx", "xlsm"] {
            sparse_file(
                &temp.path().join(format!("large.{extension}")),
                100 * 1024 * 1024 + 1,
            );
        }

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert_eq!(
            rooted.read_document("limit.xlsx").unwrap().bytes.len(),
            100 * 1024 * 1024
        );
        for extension in ["pdf", "docx", "pptx", "xlsx", "xlsm"] {
            assert!(
                matches!(
                    rooted.read_document(&format!("large.{extension}")),
                    Err(FsError::FileTooLarge { .. })
                ),
                "{extension}"
            );
        }
    }

    #[test]
    fn refuses_a_document_outside_the_browsing_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(temp.path().join("outside.pptx"), b"PK\x03\x04").unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside.pptx"), root.join("link.pptx"))
            .unwrap();

        let rooted = RootedFs::new(&root).unwrap();

        assert!(matches!(
            rooted.read_document("../outside.pptx"),
            Err(FsError::PathEscapesRoot)
        ));
        assert!(matches!(
            rooted.read_document("link.pptx"),
            Err(FsError::PathEscapesRoot)
        ));
    }

    // A file of this length without writing its bytes, so a limit of many
    // megabytes is tested without the disk traffic.
    fn sparse_file(path: &Path, len: u64) {
        fs::File::create(path).unwrap().set_len(len).unwrap();
    }
}
