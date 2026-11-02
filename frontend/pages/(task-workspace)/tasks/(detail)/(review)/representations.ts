import {
  changeRepresentations,
  documentPreviewKind,
  isPreviewableImagePath,
} from "#components/dom.js";

export type ReviewViewer = "diff" | "visual" | "source" | "preview";

// Each representation has a partner that shows the same thing another way:
// the change as text or as pictures, the file as text or as a preview. Every
// file has at least one of each pair.
const PARTNERS: Readonly<Record<ReviewViewer, ReviewViewer>> = {
  diff: "visual",
  visual: "diff",
  source: "preview",
  preview: "source",
};

export function isReviewViewer(value: unknown): value is ReviewViewer {
  return typeof value === "string" && Object.hasOwn(PARTNERS, value);
}

export function isFileRepresentation(viewer: ReviewViewer) {
  return viewer === "source" || viewer === "preview";
}

// A representation the file lacks gives way to its partner.
export function representationForFile(
  viewer: ReviewViewer,
  path: string,
): ReviewViewer {
  if (!path || fileHasRepresentation(path, viewer)) {
    return viewer;
  }
  return PARTNERS[viewer];
}

export function fileHasRepresentation(path: string, viewer: ReviewViewer) {
  switch (viewer) {
    case "diff":
    case "visual":
      return changeRepresentations(path)[viewer];
    case "source":
      return fileRepresentationCapabilities(path).source;
    case "preview":
      return Boolean(fileRepresentationCapabilities(path).previewKind);
  }
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
