import {
  documentPreviewKind,
  isPreviewableImagePath,
} from "#components/dom.js";

export type ReviewViewer = "diff" | "source" | "preview";

export function isFileRepresentation(viewer: ReviewViewer) {
  return viewer === "source" || viewer === "preview";
}

export function representationForFile(
  viewer: ReviewViewer,
  path: string,
): ReviewViewer {
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

export function fileRepresentationCapabilities(path: string) {
  const documentKind = documentPreviewKind(path);
  if (documentKind) {
    return { source: false, previewKind: "document", documentKind } as const;
  }
  const imagePreview = isPreviewableImagePath(path);
  return {
    source: !imagePreview || isSvgPath(path),
    previewKind: imagePreview
      ? "image"
      : isPreviewableMarkdownPath(path)
        ? "markdown"
        : null,
  } as const;
}

function isPreviewableMarkdownPath(path: string) {
  return /\.(?:md|markdown)$/i.test(`${path ?? ""}`);
}

function isSvgPath(path: string) {
  return /\.svg$/i.test(`${path ?? ""}`);
}
