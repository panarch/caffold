import { cleanLogicalPath } from "#tasks/task-format.ts";

// What Review reads from the Task it reviews.
export interface ReviewTask {
  threadId?: string | null;
  cwdPath?: string | null;
  cwd?: string | null;
  worktree?: {
    rootPath?: string | null;
    branch?: string | null;
  } | null;
}

export function taskRootPath(task: ReviewTask | null | undefined) {
  const path = task?.worktree?.rootPath || task?.cwdPath || task?.cwd || ".";
  return cleanLogicalPath(path) || ".";
}

export function taskWorktreeRootPath(task: ReviewTask | null | undefined) {
  const path = task?.worktree?.rootPath;
  return path ? cleanLogicalPath(path) || "." : "";
}

export function relativeTaskPath(
  path: string | null | undefined,
  rootPath: string,
) {
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
  const common = rootSegments.findIndex(
    (segment, index) => pathSegments[index] !== segment,
  );
  const commonLength =
    common < 0 ? Math.min(rootSegments.length, pathSegments.length) : common;
  return [
    ...Array(rootSegments.length - commonLength).fill(".."),
    ...pathSegments.slice(commonLength),
  ].join("/");
}

export function joinLogicalPath(root: string, relative: string) {
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

export function reviewFilePath(path: string | null | undefined) {
  const segments: string[] = [];
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

function logicalSegments(path: string) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== ".");
}
