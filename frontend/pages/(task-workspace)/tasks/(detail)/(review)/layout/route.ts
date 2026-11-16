import { taskThreadId } from "#tasks/task-list-model.js";
import {
  isFileRepresentation,
  isReviewViewer,
  type ReviewViewer,
  representationForFile,
} from "../representations.js";
import {
  type ReviewTask,
  reviewFilePath,
  taskRootPath,
  taskWorktreeRootPath,
} from "./paths.js";

export type ReviewScope = "working" | "branch";
export type ReviewNavigator = "changes" | "files";
export type ReviewFindKind = "references" | "definitions";

// The places Review lists for a name in place of its navigator: the name's
// file as a Review file path, its one-based line, and its zero-based UTF-16
// offset in that line.
export interface ReviewFind {
  kind: ReviewFindKind;
  path: string;
  line: number;
  character: number;
}

// The reloadable part of Review: which changes, navigator, and representation
// it shows, and which file at which line.
export interface ReviewRoute {
  scope: ReviewScope;
  navigator: ReviewNavigator;
  viewer: ReviewViewer;
  path: string;
  line: number | null;
  baseRef: string;
  find: ReviewFind | null;
  threadId?: string;
}

// The route as the Tasks router names it.
export interface ReviewRouteInput {
  reviewScope?: string;
  reviewNavigator?: string;
  reviewViewer?: string;
  path?: string;
  line?: number | string | null;
  baseRef?: string | null;
  reviewFind?: string;
  reviewFindAt?: string;
}

export function normalizeReviewRoute(
  route: ReviewRouteInput | null = {},
  task: ReviewTask | null = null,
): ReviewRoute {
  const path = reviewFilePath(route?.path);
  return {
    scope: route?.reviewScope === "branch" ? "branch" : "working",
    navigator: route?.reviewNavigator === "files" ? "files" : "changes",
    viewer: isReviewViewer(route?.reviewViewer) ? route.reviewViewer : "diff",
    path,
    line: path ? positiveLine(route?.line) : null,
    baseRef: `${route?.baseRef ?? ""}`,
    find: reviewFind(route?.reviewFind, route?.reviewFindAt),
    ...(task ? { threadId: taskThreadId(task) } : {}),
  };
}

export function taskRouteForReview(threadId: string, state: ReviewRoute) {
  return {
    kind: "tasks",
    threadId,
    review: true,
    reviewScope: state.scope,
    reviewNavigator: state.navigator,
    reviewViewer: state.viewer,
    path: state.path,
    line: state.line,
    baseRef: state.baseRef,
    reviewFind: state.find?.kind ?? "",
    reviewFindAt: state.find ? reviewFindAt(state.find) : "",
  };
}

export function normalizeForTask(
  route: ReviewRoute,
  task: ReviewTask | null,
): ReviewRoute {
  const taskRoute: ReviewRoute = task?.worktree
    ? route
    : {
        ...route,
        scope: "working",
        navigator: "files",
        viewer: isFileRepresentation(route.viewer)
          ? route.viewer
          : route.viewer === "visual"
            ? "preview"
            : "source",
        baseRef: "",
      };
  const viewer = representationForFile(taskRoute.viewer, taskRoute.path);
  return viewer === taskRoute.viewer ? taskRoute : { ...taskRoute, viewer };
}

export function reviewRouteKey(route: ReviewRoute) {
  return [
    route.scope,
    route.navigator,
    route.viewer,
    route.path,
    route.line,
    route.baseRef,
    route.find ? `${route.find.kind}:${reviewFindAt(route.find)}` : "",
  ].join("\u0000");
}

export function viewerStateKey(route: ReviewRoute) {
  return `${route.scope}:${route.path}:${route.viewer}`;
}

export function routeForSelectedFile(
  route: ReviewRoute,
  path: string,
): ReviewRoute {
  return {
    ...route,
    viewer: representationForFile(route.viewer, path),
    path,
    line: null,
  };
}

export function reviewContextKey(task: ReviewTask | null) {
  return [
    taskThreadId(task),
    taskRootPath(task),
    taskWorktreeRootPath(task),
  ].join("\u0000");
}

// Where a find's name is, as the address writes it: `<file>:<line>:<column>`
// with a one-based column.
export function reviewFindAt({ path, line, character }: ReviewFind) {
  return `${path}:${line}:${character + 1}`;
}

function reviewFind(
  kind: string | undefined,
  at: string | undefined,
): ReviewFind | null {
  if (kind !== "references" && kind !== "definitions") {
    return null;
  }
  const match = `${at ?? ""}`.match(/^(.+):(\d+):(\d+)$/);
  const path = reviewFilePath(match?.[1]);
  const line = positiveLine(match?.[2]);
  const column = positiveLine(match?.[3]);
  return path && line && column
    ? { kind, path, line, character: column - 1 }
    : null;
}

function positiveLine(line: number | string | null | undefined) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}
