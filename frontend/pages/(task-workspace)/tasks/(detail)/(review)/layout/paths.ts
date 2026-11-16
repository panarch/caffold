import { cleanLogicalPath } from "#tasks/task-format.js";

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

// A Review file path that starts with `/` names a file from Caffold's root,
// such as a definition outside the Task's folder; any other is relative to
// the Task's root.
export function joinLogicalPath(root: string, relative: string) {
  if (isRootFilePath(relative)) {
    return reviewFilePath(relative).slice(1);
  }
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
  const fromRoot = isRootFilePath(path);
  const segments: string[] = [];
  for (const segment of `${path ?? ""}`.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!fromRoot) {
        segments.push(segment);
      }
    } else {
      segments.push(segment);
    }
  }
  const joined = segments.join("/");
  return fromRoot && joined ? `/${joined}` : joined;
}

// A Review file path for the logical `path`: relative to the Task's root
// when it lies inside it, else from Caffold's root.
export function reviewPathFor(path: string, rootPath: string) {
  const relative = relativeTaskPath(path, rootPath);
  return relative && !relative.startsWith("..")
    ? relative
    : `/${cleanLogicalPath(path)}`;
}

function isRootFilePath(path: string | null | undefined) {
  return `${path ?? ""}`.replaceAll("\\", "/").startsWith("/");
}

function logicalSegments(path: string) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== ".");
}
