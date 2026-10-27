import type {
  DirectoryEntry,
  GitChangedFile,
  GitCompareFile,
  GitDiff,
} from "#app/api.js";
import { type DocumentPreviewKind, fileNameFromPath } from "#components/dom.js";
import {
  fileRepresentationCapabilities,
  type ReviewViewer,
} from "../../representations.js";

// What the shown Working Tree or Branch changes say about one file.
export interface ReviewChange {
  file: GitChangedFile | GitCompareFile;
  deleted: boolean;
  kind: string;
}

export interface ReviewChanges {
  ready: boolean;
  outdated: boolean;
  failed: boolean;
  error: Error | null;
  change: ReviewChange | null;
  diffKind: string;
  readDiff: (() => Promise<GitDiff>) | null;
}

// The selected file in its representation, with what the shown changes say
// about it.
export interface ReviewView {
  stateKey: string;
  scope: string;
  path: string;
  logicalPath: string;
  representation: ReviewViewer;
  line: number | null;
  entry: DirectoryEntry | null;
  changes: ReviewChanges;
}

export type ReviewContent =
  | { kind: "unchanged" }
  | { kind: "loading" }
  | { kind: "error"; error: Error | null }
  | {
      kind: "notice";
      message: string;
      options: { actionLabel?: string; action?: string; title?: string };
    }
  | { kind: "document"; documentKind: DocumentPreviewKind }
  | { kind: "image" }
  | { kind: "markdown" }
  | { kind: "file" }
  | { kind: "diff"; change: ReviewChange | null };

// What the viewer shows for the selected file in its representation, from what
// the shown Working Tree or Branch changes say about that file. "unchanged"
// keeps whatever the viewer holds until the changes are read.
export function contentFor({
  logicalPath,
  representation,
  changes,
}: Pick<
  ReviewView,
  "logicalPath" | "representation" | "changes"
>): ReviewContent {
  const sourceMode = representation === "source";
  const previewMode = representation === "preview";
  const fileMode = sourceMode || previewMode;
  if (!fileMode && !changes.ready) {
    return { kind: "unchanged" };
  }
  const title = fileNameFromPath(logicalPath);
  const change = changes.change;
  if (fileMode && change?.deleted) {
    return notice(
      "This file was deleted in the selected scope. Diff remains available.",
      { title },
    );
  }
  const representations = fileRepresentationCapabilities(logicalPath);
  if (previewMode && representations.previewKind === "document") {
    return { kind: "document", documentKind: representations.documentKind };
  }
  if (previewMode && representations.previewKind === "image") {
    return { kind: "image" };
  }
  if (sourceMode && !representations.source) {
    return notice("Source is unavailable for this file.", {
      actionLabel: "View preview",
      action: "view-preview",
      title,
    });
  }
  if (previewMode && !representations.previewKind) {
    return notice("Preview is unavailable for this file.", {
      actionLabel: "View source",
      action: "view-source",
      title,
    });
  }
  if (!fileMode && !change) {
    if (changes.outdated) {
      return changes.failed
        ? { kind: "error", error: changes.error }
        : { kind: "loading" };
    }
    return notice("No changes in this scope.", {
      actionLabel: "View source",
      action: "view-source",
      title,
    });
  }
  if (previewMode) {
    return { kind: "markdown" };
  }
  if (sourceMode) {
    return { kind: "file" };
  }
  return { kind: "diff", change };
}

function notice(
  message: string,
  options: { actionLabel?: string; action?: string; title?: string },
): ReviewContent {
  return { kind: "notice", message, options };
}
