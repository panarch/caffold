import { taskThreadId } from "#tasks/task-list-model.js";
import { representationForFile } from "../representations.js";
import { reviewFilePath, taskRootPath, taskWorktreeRootPath } from "./paths.js";

export function normalizeReviewRoute(route = {}, task = null) {
  const path = reviewFilePath(route?.path);
  return {
    scope: route?.reviewScope === "branch" ? "branch" : "working",
    navigator: route?.reviewNavigator === "files" ? "files" : "changes",
    viewer: ["source", "preview"].includes(route?.reviewViewer)
      ? route.reviewViewer
      : "diff",
    path,
    line: path ? positiveLine(route?.line) : null,
    baseRef: `${route?.baseRef ?? ""}`,
    ...(task ? { threadId: taskThreadId(task) } : {}),
  };
}

export function taskRouteForReview(threadId, state) {
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

export function normalizeForTask(route, task) {
  const taskRoute = task?.worktree
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

export function reviewRouteKey(route) {
  return [route.scope, route.navigator, route.viewer, route.path, route.line, route.baseRef].join("\u0000");
}

export function viewerStateKey(route) {
  return `${route.scope}:${route.path}:${route.viewer}`;
}

export function routeForSelectedFile(route, path) {
  return {
    ...route,
    viewer: representationForFile(route.viewer, path),
    path,
    line: null,
  };
}

export function reviewContextKey(task) {
  return [taskThreadId(task), taskRootPath(task), taskWorktreeRootPath(task)].join("\u0000");
}

function positiveLine(line) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}
