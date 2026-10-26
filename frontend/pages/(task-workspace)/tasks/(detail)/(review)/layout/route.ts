import { taskThreadId } from "#tasks/task-list-model.ts";
import {
  type ReviewViewer,
  representationForFile,
} from "../representations.ts";
import {
  type ReviewTask,
  reviewFilePath,
  taskRootPath,
  taskWorktreeRootPath,
} from "./paths.ts";

export type ReviewScope = "working" | "branch";
export type ReviewNavigator = "changes" | "files";

// The reloadable part of Review: which changes, navigator, and representation
// it shows, and which file at which line.
export interface ReviewRoute {
  scope: ReviewScope;
  navigator: ReviewNavigator;
  viewer: ReviewViewer;
  path: string;
  line: number | null;
  baseRef: string;
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
}

export function normalizeReviewRoute(
  route: ReviewRouteInput | null = {},
  task: ReviewTask | null = null,
): ReviewRoute {
  const path = reviewFilePath(route?.path);
  return {
    scope: route?.reviewScope === "branch" ? "branch" : "working",
    navigator: route?.reviewNavigator === "files" ? "files" : "changes",
    viewer:
      route?.reviewViewer === "source" || route?.reviewViewer === "preview"
        ? route.reviewViewer
        : "diff",
    path,
    line: path ? positiveLine(route?.line) : null,
    baseRef: `${route?.baseRef ?? ""}`,
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
        viewer: route.viewer === "preview" ? "preview" : "source",
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

function positiveLine(line: number | string | null | undefined) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}
