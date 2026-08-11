export function normalizeTaskPath(path) {
  return `${path ?? ""}`
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
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

export function uniquePaths(paths) {
  return [...new Set(paths)];
}

export function formatStatus(status) {
  const normalized = `${status ?? ""}`.trim();
  return `${normalized || "unknown"}`.replaceAll("_", " ");
}

export function formatRelativeAge(ms, now = Date.now()) {
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "";
  }

  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) {
    return "now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }

  return `${Math.floor(months / 12)}y`;
}

export function formatDecision(decision) {
  return {
    accept: "Accept",
    acceptForSession: "Accept for Session",
    decline: "Decline",
    cancel: "Cancel",
  }[decision] ?? decision;
}

export function formatCommand(command) {
  if (Array.isArray(command)) {
    return command.join(" ");
  }
  if (typeof command === "string" && command.trim()) {
    return command;
  }
  if (command && typeof command === "object") {
    return JSON.stringify(command);
  }
  return "(command unavailable)";
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
