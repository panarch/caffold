import { fileNameFromPath } from "#components/dom.js";
import { fileRepresentationCapabilities } from "../../representations.js";

// What the viewer shows for the selected file in its representation, from what
// the shown Working Tree or Branch changes say about that file. "unchanged"
// keeps whatever the viewer holds until the changes are read.
export function contentFor({ logicalPath, representation, changes }) {
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

function notice(message, options) {
  return { kind: "notice", message, options };
}
