import { fileStatusPresentation } from "../file-status.ts";
import { fileNameFromPath, formatBytes, formatModified } from "./dom.ts";

export interface ViewerMetadataItem {
  field: string;
  label: string;
  value: string;
}

export interface ViewerLineStats {
  additions: number;
  deletions: number;
}

// What a viewer's header shows for the file it presents.
export interface ViewerPresentation {
  title: string;
  subtitle?: string;
  metadata?: ViewerMetadataItem[];
  lineStats?: ViewerLineStats | null;
  downloadPath?: string;
}

export interface ViewerSource {
  path?: string;
  name?: string;
  size?: number | null;
  modifiedMs?: number | null;
  language?: string;
}

export interface ViewerDiff {
  path?: string;
  repository?: { rootPath?: string } | null;
  repoRelativePath?: string;
  kind?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export function sourceViewerPresentation(
  source: ViewerSource = {},
): ViewerPresentation {
  const path = `${source.path ?? ""}`;
  const title = `${source.name || fileNameFromPath(path) || "File"}`;
  const metadata = [
    path ? { field: "path", label: "Path", value: path } : null,
    Object.hasOwn(source, "size")
      ? { field: "size", label: "Size", value: formatBytes(source.size) }
      : null,
    Object.hasOwn(source, "modifiedMs")
      ? {
          field: "modified",
          label: "Modified",
          value: formatModified(source.modifiedMs) || "Unknown",
        }
      : null,
    Object.hasOwn(source, "language")
      ? { field: "language", label: "Language", value: `${source.language}` }
      : null,
  ].filter((item) => item !== null);

  // Source and Preview show the file on disk, so the same file can be saved.
  return { title, subtitle: "", metadata, downloadPath: path };
}

export function diffViewerPresentation(
  diff: ViewerDiff = {},
): ViewerPresentation {
  const path = `${diff.path ?? ""}`;
  const repositoryPath = `${diff.repository?.rootPath ?? ""}`;
  const repoRelativePath =
    `${diff.repoRelativePath ?? ""}` || relativePath(path, repositoryPath);
  const title = repoRelativePath || fileNameFromPath(path) || "File";
  const metadata = [
    path ? { field: "path", label: "Path", value: path } : null,
    diff.kind ? { field: "kind", label: "Diff", value: diff.kind } : null,
    repositoryPath
      ? {
          field: "repository",
          label: "Repository",
          value: repositoryPath,
        }
      : null,
  ].filter((item) => item !== null);

  return {
    title,
    subtitle: diffSubtitle(diff),
    metadata,
    lineStats: diffLineStats(diff),
  };
}

function diffLineStats(diff: ViewerDiff): ViewerLineStats | null {
  const { additions, deletions } = diff;
  if (
    additions === undefined ||
    deletions === undefined ||
    !Number.isFinite(additions) ||
    !Number.isFinite(deletions) ||
    additions < 0 ||
    deletions < 0
  ) {
    return null;
  }

  return { additions, deletions };
}

function relativePath(path: string, rootPath: string) {
  const normalizedPath = cleanPath(path);
  const normalizedRoot = cleanPath(rootPath);
  if (!normalizedPath || !normalizedRoot || normalizedPath === normalizedRoot) {
    return normalizedPath;
  }

  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

function cleanPath(path: string) {
  return `${path ?? ""}`.split("/").filter(Boolean).join("/");
}

function diffSubtitle(diff: ViewerDiff) {
  const labels = [
    diffStatusLabel(diff.status),
    diffKindLabel(diff.kind),
  ].filter(Boolean);

  return labels
    .filter((label, index) => labels.indexOf(label) === index)
    .join(" · ");
}

const DIFF_KIND_LABELS: Readonly<Record<string, string>> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Added",
};

function diffKindLabel(kind: string | undefined) {
  if (!kind) {
    return "";
  }

  if (kind.startsWith("commit ")) {
    return `Commit ${kind.slice("commit ".length)}`;
  }

  return DIFF_KIND_LABELS[kind] ?? kind;
}

function diffStatusLabel(status: string | undefined) {
  return fileStatusPresentation(status).label;
}
