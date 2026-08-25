use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::events::TaskEventRecord;
use crate::agent::GeneratedImage;
use crate::fs::MAX_IMAGE_BYTES;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_ENCODED_IMAGE_BYTES: usize = (MAX_IMAGE_BYTES as usize).div_ceil(3) * 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) struct GeneratedImageObservation {
    pub(in crate::app) item_id: String,
    pub(in crate::app) saved_path: Option<PathBuf>,
    pub(in crate::app) result: Option<String>,
}

impl GeneratedImageObservation {
    /// Where an image the agent generated can be read from, if anywhere yet.
    ///
    /// An agent still drawing has neither a file nor bytes, and there is
    /// nothing to serve until it does.
    pub(in crate::app) fn for_item(item_id: &str, image: &GeneratedImage) -> Option<Self> {
        image.is_available().then(|| Self {
            item_id: item_id.to_string(),
            saved_path: image.saved_path.as_deref().map(PathBuf::from),
            result: image.encoded.clone(),
        })
    }
}

#[derive(Debug, Clone)]
enum GeneratedImageSource {
    SavedPath(PathBuf),
    Bytes(Arc<[u8]>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) enum GeneratedImageError {
    NotFound,
    Unavailable,
}

#[derive(Clone)]
pub(in crate::app) struct GeneratedImageStore {
    root: Option<PathBuf>,
    images: Arc<RwLock<HashMap<(String, String), GeneratedImageSource>>>,
}

impl Default for GeneratedImageStore {
    fn default() -> Self {
        Self::new(default_generated_images_root())
    }
}

impl GeneratedImageStore {
    fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            images: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(in crate::app) fn observe(&self, event: &TaskEventRecord) {
        let Some(observation) = event.generated_image.as_ref() else {
            return;
        };
        let Some(source) = generated_image_source(self.root.as_deref(), observation) else {
            return;
        };
        if let Ok(mut images) = self.images.write() {
            images.insert(
                (event.thread_id.clone(), observation.item_id.clone()),
                source,
            );
        }
    }

    pub(in crate::app) async fn load(
        &self,
        thread_id: &str,
        item_id: &str,
    ) -> Result<Vec<u8>, GeneratedImageError> {
        let source = self
            .images
            .read()
            .ok()
            .and_then(|images| {
                images
                    .get(&(thread_id.to_string(), item_id.to_string()))
                    .cloned()
            })
            .ok_or(GeneratedImageError::NotFound)?;

        match source {
            GeneratedImageSource::Bytes(bytes) => Ok(bytes.as_ref().to_vec()),
            GeneratedImageSource::SavedPath(path) => {
                let root = self.root.clone().ok_or(GeneratedImageError::Unavailable)?;
                tokio::task::spawn_blocking(move || read_generated_png(&root, &path))
                    .await
                    .map_err(|_| GeneratedImageError::Unavailable)?
            }
        }
    }

    pub(in crate::app) fn remove_thread(&self, thread_id: &str) {
        if let Ok(mut images) = self.images.write() {
            images.retain(|(candidate, _), _| candidate != thread_id);
        }
    }
}

fn default_generated_images_root() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join(".codex"))
        })
        .map(|codex_home| codex_home.join("generated_images"))
}

fn generated_image_source(
    root: Option<&Path>,
    observation: &GeneratedImageObservation,
) -> Option<GeneratedImageSource> {
    if let Some(path) = observation.saved_path.as_ref()
        && valid_generated_image_path(root, path)
    {
        return Some(GeneratedImageSource::SavedPath(path.clone()));
    }
    observation
        .result
        .as_deref()
        .and_then(decode_generated_png)
        .map(|bytes| GeneratedImageSource::Bytes(Arc::from(bytes)))
}

fn valid_generated_image_path(root: Option<&Path>, path: &Path) -> bool {
    root.is_some_and(|root| root.is_absolute() && path.starts_with(root))
        && path.is_absolute()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
}

fn decode_generated_png(result: &str) -> Option<Vec<u8>> {
    let encoded = result
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(result)
        .trim();
    if encoded.is_empty() || encoded.len() > MAX_ENCODED_IMAGE_BYTES {
        return None;
    }
    let bytes = STANDARD.decode(encoded).ok()?;
    valid_png_bytes(&bytes).then_some(bytes)
}

fn read_generated_png(root: &Path, path: &Path) -> Result<Vec<u8>, GeneratedImageError> {
    if !valid_generated_image_path(Some(root), path) {
        return Err(GeneratedImageError::Unavailable);
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|_| GeneratedImageError::Unavailable)?;
    let canonical_path =
        std::fs::canonicalize(path).map_err(|_| GeneratedImageError::Unavailable)?;
    if !canonical_path.starts_with(canonical_root) {
        return Err(GeneratedImageError::Unavailable);
    }
    let metadata =
        std::fs::metadata(&canonical_path).map_err(|_| GeneratedImageError::Unavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err(GeneratedImageError::Unavailable);
    }
    let bytes = std::fs::read(canonical_path).map_err(|_| GeneratedImageError::Unavailable)?;
    if !valid_png_bytes(&bytes) {
        return Err(GeneratedImageError::Unavailable);
    }
    Ok(bytes)
}

fn valid_png_bytes(bytes: &[u8]) -> bool {
    bytes.len() as u64 <= MAX_IMAGE_BYTES && bytes.starts_with(PNG_SIGNATURE)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::{ActivityStatus, codex::conversation_item};
    use crate::app::tasks::events::task_event_from_item;

    const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    #[tokio::test]
    async fn generated_image_store_keys_assets_by_thread_and_item() {
        let item = conversation_item(
            &json!({
                "type": "imageGeneration",
                "id": "image_1",
                "status": "completed",
                "result": ONE_PIXEL_PNG,
                "savedPath": null
            }),
            ActivityStatus::Completed,
        )
        .expect("a generated image item");
        let event =
            task_event_from_item("thread_1", "turn_1", 1, &item).expect("generated image event");
        let store = GeneratedImageStore::new(None);
        store.observe(&event);

        assert!(
            store
                .load("thread_1", "image_1")
                .await
                .expect("generated image")
                .starts_with(PNG_SIGNATURE)
        );
        assert_eq!(
            store.load("thread_2", "image_1").await,
            Err(GeneratedImageError::NotFound)
        );
        assert_eq!(
            store.load("thread_1", "image_2").await,
            Err(GeneratedImageError::NotFound)
        );

        store.remove_thread("thread_1");
        assert_eq!(
            store.load("thread_1", "image_1").await,
            Err(GeneratedImageError::NotFound)
        );
    }

    #[tokio::test]
    async fn generated_image_store_reads_only_png_saved_paths() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let png_path = temp.path().join("generated.png");
        let bytes = STANDARD.decode(ONE_PIXEL_PNG).expect("fixture png");
        std::fs::write(&png_path, &bytes).expect("write generated image");
        let mut event = TaskEventRecord {
            id: "thread_1:turn_1:image_1".to_string(),
            thread_id: "thread_1".to_string(),
            event_type: "generated_image".to_string(),
            summary: "Image generated".to_string(),
            payload: None,
            created_ms: 1,
            observed_ms: Some(1),
            updated_ms: None,
            sort_index: None,
            generated_image: Some(GeneratedImageObservation {
                item_id: "image_1".to_string(),
                saved_path: Some(png_path),
                result: None,
            }),
        };
        let store = GeneratedImageStore::new(Some(temp.path().to_path_buf()));
        store.observe(&event);
        assert_eq!(
            store.load("thread_1", "image_1").await.expect("saved png"),
            bytes
        );

        event.generated_image = Some(GeneratedImageObservation {
            item_id: "image_2".to_string(),
            saved_path: Some(temp.path().join("generated.jpg")),
            result: None,
        });
        store.observe(&event);
        assert_eq!(
            store.load("thread_1", "image_2").await,
            Err(GeneratedImageError::NotFound)
        );
    }

    #[test]
    fn generated_image_observation_requires_an_identified_asset() {
        let drawing = GeneratedImage {
            revised_prompt: None,
            saved_path: None,
            encoded: None,
        };

        assert!(GeneratedImageObservation::for_item("image_1", &drawing).is_none());
    }

    #[test]
    fn generated_image_store_ignores_events_without_an_asset() {
        let store = GeneratedImageStore::new(None);
        store.observe(&TaskEventRecord {
            id: "event_1".to_string(),
            thread_id: "thread_1".to_string(),
            event_type: "assistant_message".to_string(),
            summary: "Done".to_string(),
            payload: None,
            created_ms: 1,
            observed_ms: Some(1),
            updated_ms: None,
            sort_index: None,
            generated_image: None,
        });
        assert!(
            store
                .images
                .read()
                .expect("generated image store")
                .is_empty()
        );
    }

    #[test]
    fn generated_image_decoder_rejects_empty_oversized_and_non_png_results() {
        assert!(decode_generated_png("").is_none());
        assert!(decode_generated_png(&"A".repeat(MAX_ENCODED_IMAGE_BYTES + 1)).is_none());
        assert!(decode_generated_png("bm90IGEgcG5n").is_none());
        assert!(decode_generated_png(&format!("data:image/png;base64,{ONE_PIXEL_PNG}")).is_some());
    }

    #[test]
    fn generated_image_reader_rejects_unsafe_or_invalid_files() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let outside = tempfile::tempdir().expect("outside directory");
        let bytes = STANDARD.decode(ONE_PIXEL_PNG).expect("fixture png");

        let outside_png = outside.path().join("outside.png");
        std::fs::write(&outside_png, &bytes).expect("outside png");
        assert_eq!(
            read_generated_png(temp.path(), &outside_png),
            Err(GeneratedImageError::Unavailable)
        );

        let directory = temp.path().join("directory.png");
        std::fs::create_dir(&directory).expect("png-named directory");
        assert_eq!(
            read_generated_png(temp.path(), &directory),
            Err(GeneratedImageError::Unavailable)
        );

        let oversized = temp.path().join("oversized.png");
        let oversized_file = std::fs::File::create(&oversized).expect("oversized png");
        oversized_file
            .set_len(MAX_IMAGE_BYTES + 1)
            .expect("size oversized png");
        assert_eq!(
            read_generated_png(temp.path(), &oversized),
            Err(GeneratedImageError::Unavailable)
        );

        let invalid = temp.path().join("invalid.png");
        std::fs::write(&invalid, b"not a png").expect("invalid png");
        assert_eq!(
            read_generated_png(temp.path(), &invalid),
            Err(GeneratedImageError::Unavailable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn generated_image_reader_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temporary directory");
        let outside = tempfile::tempdir().expect("outside directory");
        let outside_png = outside.path().join("outside.png");
        std::fs::write(
            &outside_png,
            STANDARD.decode(ONE_PIXEL_PNG).expect("fixture png"),
        )
        .expect("outside png");
        let linked_png = temp.path().join("linked.png");
        symlink(outside_png, &linked_png).expect("generated image symlink");

        assert_eq!(
            read_generated_png(temp.path(), &linked_png),
            Err(GeneratedImageError::Unavailable)
        );
    }
}
