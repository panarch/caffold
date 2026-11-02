const IMAGE_TYPES: Readonly<Record<string, string>> = {
  avif: "AVIF image",
  gif: "GIF image",
  jpeg: "JPEG image",
  jpg: "JPEG image",
  png: "PNG image",
  svg: "SVG image",
  webp: "WebP image",
};

export type DocumentPreviewKind = "docx" | "pdf" | "pptx" | "xlsx";

// The file a document viewer opens: the fetched file, or the promise of one
// that fails when the fetch does. A newer copy replaces the file shown.
export interface DocumentPreviewFile {
  file: Blob | Promise<Blob>;
  newerCopy: boolean;
}

// The documents a library-backed viewer draws, by file extension.
const DOCUMENT_KINDS = new Map<string, DocumentPreviewKind>([
  ["docx", "docx"],
  ["pdf", "pdf"],
  ["pptx", "pptx"],
  ["xlsm", "xlsx"],
  ["xlsx", "xlsx"],
]);

export function formatBytes(size: number | null | undefined) {
  if (size === null || size === undefined) {
    return "";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatModified(modifiedMs: number | null | undefined) {
  if (!modifiedMs) {
    return "";
  }

  const date = new Date(modifiedMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// Added and deleted line counts as a header shows them, or null unless both
// are known.
export function formatLineStats(
  stats: { additions?: number; deletions?: number } | null | undefined,
) {
  if (
    stats?.additions === undefined ||
    stats.deletions === undefined ||
    !Number.isFinite(stats.additions) ||
    !Number.isFinite(stats.deletions)
  ) {
    return null;
  }
  const additions = new Intl.NumberFormat("en-US").format(stats.additions);
  const deletions = new Intl.NumberFormat("en-US").format(stats.deletions);
  return {
    label: `${additions} additions and ${deletions} deletions`,
    additions: `+${additions}`,
    deletions: `-${deletions}`,
  };
}

export function isPreviewableImagePath(path: string) {
  return Boolean(imageExtension(path));
}

// How a file's change can be shown: Diff as text, Visual as the pictures on
// each side. A picture other than SVG has no text worth a diff.
export function changeRepresentations(path: string) {
  const extension = imageExtension(path);
  return {
    diff: !extension || extension === "svg",
    visual: Boolean(extension),
  };
}

export type ChangeRepresentation = "diff" | "visual";

// The representation a file's change opens in: the one shown last when the
// file has it, else the other.
export function changeRepresentationFor(
  path: string,
  shown: ChangeRepresentation,
): ChangeRepresentation {
  if (changeRepresentations(path)[shown]) {
    return shown;
  }
  return shown === "diff" ? "visual" : "diff";
}

// The change representations a viewer offers to choose between: both when
// the file has both, none when there is nothing to choose.
export function changeRepresentationChoices(
  path: string,
  selected: ChangeRepresentation,
) {
  const { diff, visual } = changeRepresentations(path);
  return {
    choices:
      diff && visual
        ? [
            { value: "diff", label: "Diff" },
            { value: "visual", label: "Visual" },
          ]
        : [],
    selected,
  };
}

// The kind of document a library-backed viewer draws, or null for any other
// file.
export function documentPreviewKind(path: string) {
  const extension = fileNameFromPath(path)
    .toLowerCase()
    .match(/\.([^.]+)$/)?.[1];
  return extension ? (DOCUMENT_KINDS.get(extension) ?? null) : null;
}

export function imageTypeLabel(path: string) {
  const extension = imageExtension(path);
  return extension ? IMAGE_TYPES[extension] : "Image";
}

export function fileNameFromPath(path: string) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export function entryKindLabel(entry: {
  kind?: string;
  isSymlink?: boolean;
  supported?: boolean;
}) {
  if (!entry.supported) {
    return "blocked";
  }

  if (entry.kind === "directory") {
    return entry.isSymlink ? "dir link" : "dir";
  }

  if (entry.kind === "file") {
    return entry.isSymlink ? "file link" : "file";
  }

  if (entry.kind === "symlink") {
    return "link";
  }

  return "other";
}

function imageExtension(path: string) {
  const fileName = fileNameFromPath(path).toLowerCase();
  if (!fileName.includes(".")) {
    return null;
  }

  const extension = fileName.split(".").pop() ?? "";
  return IMAGE_TYPES[extension] ? extension : null;
}
