import type {
  DirectoryEntry,
  GitChangedFile,
  GitCompareFile,
  GitDiff,
  GitDiffVersions,
} from "#app/api.js";
import {
  changeRepresentations,
  type DocumentPreviewKind,
  fileNameFromPath,
} from "#components/dom.js";
import {
  fileRepresentationCapabilities,
  type ReviewViewer,
} from "../../representations.js";

// What the shown Working Tree or Branch changes say about one file.
export interface ReviewChange {
  file: GitChangedFile | GitCompareFile;
  deleted: boolean;
}

export interface ReviewChanges {
  ready: boolean;
  outdated: boolean;
  failed: boolean;
  error: Error | null;
  change: ReviewChange | null;
  // The ref the scope compares the working tree with, and how its diffs name
  // it.
  base: string;
  diffKind: string;
  readDiff: (() => Promise<GitDiff>) | null;
  readVersions: (() => Promise<GitDiffVersions>) | null;
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
  | { kind: "diff"; change: ReviewChange | null }
  | { kind: "visual"; change: ReviewChange | null };

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
      `This file was deleted in the selected scope. ${remainingChangeViews(logicalPath)}`,
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
  return representation === "visual"
    ? { kind: "visual", change }
    : { kind: "diff", change };
}

// Names the ways a deleted file's change can still be shown.
function remainingChangeViews(path: string) {
  const { diff, visual } = changeRepresentations(path);
  if (diff && visual) {
    return "Diff and Visual remain available.";
  }
  return visual ? "Visual remains available." : "Diff remains available.";
}

function notice(
  message: string,
  options: { actionLabel?: string; action?: string; title?: string },
): ReviewContent {
  return { kind: "notice", message, options };
}
