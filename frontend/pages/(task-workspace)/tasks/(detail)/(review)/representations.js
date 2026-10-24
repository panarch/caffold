import {
  documentPreviewKind,
  isPreviewableImagePath,
} from "#components/dom.ts";

export function isFileRepresentation(viewer) {
  return viewer === "source" || viewer === "preview";
}

export function representationForFile(viewer, path) {
  if (!path || viewer === "diff") {
    return viewer;
  }
  const representations = fileRepresentationCapabilities(path);
  if (
    (viewer === "source" && representations.source) ||
    (viewer === "preview" && representations.previewKind)
  ) {
    return viewer;
  }
  return representations.source ? "source" : "preview";
}

export function fileRepresentationCapabilities(path) {
  const documentKind = documentPreviewKind(path);
  if (documentKind) {
    return { source: false, previewKind: "document", documentKind };
  }
  const imagePreview = isPreviewableImagePath(path);
  return {
    source: !imagePreview || isSvgPath(path),
    previewKind: imagePreview
      ? "image"
      : isPreviewableMarkdownPath(path)
        ? "markdown"
        : null,
  };
}

function isPreviewableMarkdownPath(path) {
  return /\.(?:md|markdown)$/i.test(`${path ?? ""}`);
}

function isSvgPath(path) {
  return /\.svg$/i.test(`${path ?? ""}`);
}
