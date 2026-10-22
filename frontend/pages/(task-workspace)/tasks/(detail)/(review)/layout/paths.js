import { cleanLogicalPath } from "#tasks/task-format.js";

export function taskRootPath(task) {
  const path = task?.worktree?.rootPath || task?.cwdPath || task?.cwd || ".";
  return cleanLogicalPath(path) || ".";
}

export function taskWorktreeRootPath(task) {
  const path = task?.worktree?.rootPath;
  return path ? cleanLogicalPath(path) || "." : "";
}

export function relativeTaskPath(path, rootPath) {
  const normalizedPath = cleanLogicalPath(path);
  const normalizedRoot = cleanLogicalPath(rootPath) || ".";
  if (!normalizedPath) {
    return "";
  }
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  const rootSegments = logicalSegments(normalizedRoot);
  const pathSegments = logicalSegments(normalizedPath);
  const common = rootSegments.findIndex((segment, index) => pathSegments[index] !== segment);
  const commonLength = common < 0
    ? Math.min(rootSegments.length, pathSegments.length)
    : common;
  return [
    ...Array(rootSegments.length - commonLength).fill(".."),
    ...pathSegments.slice(commonLength),
  ].join("/");
}

export function joinLogicalPath(root, relative) {
  const segments = logicalSegments(cleanLogicalPath(root) || ".");
  for (const segment of reviewFilePath(relative).split("/")) {
    if (!segment) {
      continue;
    }
    if (segment === "..") {
      if (!segments.length) {
        return "";
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

export function reviewFilePath(path) {
  const segments = [];
  for (const segment of `${path ?? ""}`.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function logicalSegments(path) {
  return `${path ?? ""}`.split("/").filter((segment) => segment && segment !== ".");
}
