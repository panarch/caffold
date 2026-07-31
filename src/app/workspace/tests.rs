use super::*;

#[test]
fn task_images_must_stay_inside_the_browsing_root() {
    let root = tempfile::tempdir().unwrap();
    let image_path = root.path().join("task-image.png");
    let outside = tempfile::tempdir().unwrap();
    let outside_path = outside.path().join("outside.png");
    std::fs::write(&image_path, b"image").unwrap();
    std::fs::write(&outside_path, b"image").unwrap();

    let fs = RootedFs::new(root.path()).unwrap();
    assert_eq!(
        task_image_logical_path(&fs, &image_path).unwrap(),
        "task-image.png"
    );
    assert!(matches!(
        task_image_logical_path(&fs, &outside_path),
        Err(FsError::PathEscapesRoot)
    ));
}
