import {
  fileNameFromPath,
  formatBytes,
  formatModified,
  languageLabel,
} from "./dom.js";

export function sourceViewerPresentation(source = {}) {
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
    Object.hasOwn(source, "languageHint")
      ? {
          field: "language",
          label: "Language",
          value: languageLabel(source.languageHint),
        }
      : null,
  ].filter(Boolean);

  return { title, subtitle: "", metadata };
}

export function diffViewerPresentation(diff = {}) {
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
  ].filter(Boolean);

  return {
    title,
    subtitle: diffSubtitle(diff),
    metadata,
    lineStats: diffLineStats(diff),
  };
}

function diffLineStats(diff) {
  if (
    !Number.isFinite(diff.additions) ||
    !Number.isFinite(diff.deletions) ||
    diff.additions < 0 ||
    diff.deletions < 0
  ) {
    return null;
  }

  return {
    additions: diff.additions,
    deletions: diff.deletions,
  };
}

function relativePath(path, rootPath) {
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

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter(Boolean)
    .join("/");
}

function diffSubtitle(diff) {
  const labels = [diffStatusLabel(diff.status), diffKindLabel(diff.kind)].filter(Boolean);

  return labels
    .filter((label, index) => labels.indexOf(label) === index)
    .join(" · ");
}

function diffKindLabel(kind) {
  if (!kind) {
    return "";
  }

  if (kind.startsWith("commit ")) {
    return `Commit ${kind.slice("commit ".length)}`;
  }

  const labels = {
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Added",
  };

  return labels[kind] ?? kind;
}

function diffStatusLabel(status) {
  if (!status) {
    return "";
  }

  const code = String(status).trim() === "??"
    ? "??"
    : Array.from(String(status)).find((character) => character !== " ");

  if (code === "??") {
    return "Added";
  }

  const labels = {
    A: "Added",
    C: "Copied",
    D: "Deleted",
    M: "Modified",
    R: "Renamed",
    T: "Type changed",
    U: "Unmerged",
  };

  return labels[code] ?? String(status).trim();
}
