export function normalizeTaskPath(path) {
  return `${path ?? ""}`
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function effectiveTaskFileRoot(task) {
  const worktreeRoot = normalizeFilePresentationPath(task?.worktree?.rootPath);
  const cwd = preferredTaskFileCwd(task);
  if (!worktreeRoot) {
    return cwd;
  }
  if (filePresentationPathParts(worktreeRoot).absolute) {
    return worktreeRoot;
  }
  return absoluteWorktreeRootFromCwd(
    cwd,
    task?.worktree?.relativeCwd,
  ) || worktreeRoot;
}

export function presentTaskFilePath(path, rootPath = "") {
  const originalPath = `${path ?? ""}`;
  const pathParts = filePresentationPathParts(originalPath);
  const rootParts = filePresentationPathParts(rootPath);
  const normalizedPath = formatFilePresentationPath(pathParts);
  const normalizedRoot = formatFilePresentationPath(rootParts);
  if (!normalizedPath) {
    return { fileIdentity: "", originalPath, displayPath: "" };
  }

  const resolvedPath =
    pathParts.absolute || !normalizedRoot
      ? pathParts
      : filePresentationPathParts(`${normalizedRoot}/${normalizedPath}`);
  let displayPath = normalizedPath;
  if (normalizedRoot && containsFilePresentationPath(rootParts, resolvedPath)) {
    displayPath =
      resolvedPath.segments.slice(rootParts.segments.length).join("/") || ".";
  } else if (!pathParts.absolute && resolvedPath.absolute) {
    displayPath = formatFilePresentationPath(resolvedPath);
  }

  return {
    fileIdentity: formatFilePresentationPath(resolvedPath),
    originalPath,
    displayPath,
  };
}

function normalizeFilePresentationPath(path) {
  return formatFilePresentationPath(filePresentationPathParts(path));
}

function preferredTaskFileCwd(task) {
  const candidates = [task?.cwd, task?.cwdPath]
    .map(normalizeFilePresentationPath)
    .filter(Boolean);
  return (
    candidates.find((path) => filePresentationPathParts(path).absolute) ??
    candidates[0] ??
    ""
  );
}

function absoluteWorktreeRootFromCwd(cwd, relativeCwd) {
  const cwdParts = filePresentationPathParts(cwd);
  if (!cwdParts.absolute) {
    return "";
  }
  const relativeParts = filePresentationPathParts(relativeCwd);
  if (relativeParts.absolute) {
    return "";
  }
  if (!relativeParts.segments.length) {
    return formatFilePresentationPath(cwdParts);
  }
  const rootLength = cwdParts.segments.length - relativeParts.segments.length;
  if (
    rootLength < 0 ||
    !relativeParts.segments.every(
      (segment, index) => cwdParts.segments[rootLength + index] === segment,
    )
  ) {
    return "";
  }
  return formatFilePresentationPath({
    ...cwdParts,
    segments: cwdParts.segments.slice(0, rootLength),
  });
}

function filePresentationPathParts(path) {
  const source = `${path ?? ""}`.trim();
  const unc = source.startsWith("\\\\");
  const normalized = source.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\//);
  let root = "";
  let remainder = normalized;
  if (unc) {
    root = "//";
    remainder = normalized.replace(/^\/+/, "");
  } else if (drive) {
    root = `${drive[1].toUpperCase()}:`;
    remainder = normalized.slice(drive[0].length);
  } else if (normalized.startsWith("/")) {
    root = "/";
    remainder = normalized.replace(/^\/+/, "");
  }

  const segments = [];
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!root) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  return { root, absolute: Boolean(root), segments };
}

function formatFilePresentationPath({ root, segments }) {
  const suffix = segments.join("/");
  if (root === "/" || root === "//") {
    return `${root}${suffix}`;
  }
  if (root) {
    return `${root}/${suffix}`;
  }
  return suffix;
}

function containsFilePresentationPath(root, path) {
  return Boolean(
    root.root === path.root &&
      root.segments.length <= path.segments.length &&
      root.segments.every((segment, index) => path.segments[index] === segment),
  );
}

export function cleanRelativeTaskPath(path) {
  return normalizeTaskPath(path)
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

export function cleanLogicalPath(path) {
  return cleanRelativeTaskPath(path);
}

// How one tool call reads.
//
// Everything an agent does that Caffold draws no surface of its own for arrives
// under the agent's own name for it. The name and how far along it is are all
// there is to say, and saying only that is what lets an agent grow new kinds of
// work without Caffold guessing at them.
//
// A running turn and a finished one show a tool call in different places. Both
// read this, so the same work does not change shape when the turn ends.
export function toolCallPresentation(payload = {}) {
  const name = `${payload.name ?? ""}`.trim();
  const status = `${payload.status ?? ""}`.trim();
  return {
    label: name || "Tool call",
    text: status ? `Status: ${formatStatus(status)}` : "",
    tone: status === "failed" ? "danger" : "neutral",
  };
}

export function formatStatus(status) {
  const normalized = `${status ?? ""}`.trim();
  return `${normalized || "unknown"}`.replaceAll("_", " ");
}

export function formatRelativeAge(ms, now = Date.now()) {
  return formatRelativeAgePresentation(ms, now).text;
}

export function formatRelativeAgePresentation(ms, now = Date.now()) {
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return { text: "", label: "" };
  }

  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) {
    return { text: "now", label: "just now" };
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return relativeAgePresentation(minutes, "m", "minute");
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return relativeAgePresentation(hours, "h", "hour");
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return relativeAgePresentation(days, "d", "day");
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return relativeAgePresentation(months, "M", "month");
  }

  const years = Math.floor(months / 12);
  return years > 9
    ? { text: "9y+", label: "more than 9 years ago" }
    : relativeAgePresentation(years, "y", "year");
}

function relativeAgePresentation(value, suffix, unit) {
  return {
    text: `${value}${suffix}`,
    label: `${value} ${unit}${value === 1 ? "" : "s"} ago`,
  };
}

export function formatDecision(decision) {
  return (
    {
      allow: "Allow",
      allowAlways: "Allow Always",
      deny: "Deny",
      denyAndStop: "Deny and Stop",
    }[decision] ?? decision
  );
}

export function shortId(id) {
  return `${id ?? ""}`.slice(0, 8);
}

export function formatDate(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(seconds)) {
    return "";
  }

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (remainingSeconds > 0) {
    parts.push(`${remainingSeconds}s`);
  }
  return parts.join(" ");
}
