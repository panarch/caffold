import { presentTaskFilePath } from "../../../../task-format.js";

export const CURRENT_PLAN_NODE = Object.freeze({
  INACTIVE: "inactive",
  RESOLVING: "resolving",
  SUBSCRIBED: "subscribed",
  DEGRADED: "degraded",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [CURRENT_PLAN_NODE.INACTIVE]: new Set([CURRENT_PLAN_NODE.RESOLVING]),
  [CURRENT_PLAN_NODE.RESOLVING]: new Set([
    CURRENT_PLAN_NODE.RESOLVING,
    CURRENT_PLAN_NODE.SUBSCRIBED,
    CURRENT_PLAN_NODE.DEGRADED,
    CURRENT_PLAN_NODE.INACTIVE,
  ]),
  [CURRENT_PLAN_NODE.SUBSCRIBED]: new Set([
    CURRENT_PLAN_NODE.SUBSCRIBED,
    CURRENT_PLAN_NODE.RESOLVING,
    CURRENT_PLAN_NODE.DEGRADED,
    CURRENT_PLAN_NODE.INACTIVE,
  ]),
  [CURRENT_PLAN_NODE.DEGRADED]: new Set([
    CURRENT_PLAN_NODE.RESOLVING,
    CURRENT_PLAN_NODE.INACTIVE,
  ]),
});

export function currentPlanTransitionAllowed(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function currentPlanDocumentPaths(projection) {
  const plan = `${projection?.plan?.planDocument?.path ?? ""}`.trim();
  const checklist = `${projection?.plan?.checklistDocument?.path ?? ""}`.trim();
  return [plan, checklist].filter(Boolean);
}

export function currentPlanDocumentDisplayPath(path, rootPath) {
  const originalPath = `${path ?? ""}`.trim();
  const originalRoot = `${rootPath ?? ""}`.trim();
  if (!originalPath || !originalRoot) {
    return originalPath;
  }

  const displayPath = presentTaskFilePath(
    rootedLogicalPath(originalPath),
    rootedLogicalPath(originalRoot),
  ).displayPath;
  return displayPath.startsWith("/") ? originalPath : displayPath;
}

export function normalizeCurrentPlanProjection(value) {
  const status = `${value?.status ?? ""}`;
  if (!["absent", "ready", "problem"].includes(status)) {
    throw new Error("Current plan response has an invalid status.");
  }
  if (typeof value?.watchPath !== "string") {
    throw new Error("Current plan response has no watch path.");
  }
  const problems = Array.isArray(value.problems)
    ? value.problems.map((problem) => ({
        document: `${problem?.document ?? ""}`,
        code: `${problem?.code ?? ""}`,
        message: `${problem?.message ?? ""}`,
      }))
    : [];
  if (status !== "ready") {
    return {
      status,
      watchPath: value.watchPath,
      plan: null,
      problems,
    };
  }

  const completed = Number(value?.plan?.completed);
  const total = Number(value?.plan?.total);
  const planDocument = normalizeDocument(value?.plan?.planDocument);
  const checklistDocument = normalizeDocument(value?.plan?.checklistDocument);
  if (
    !Number.isSafeInteger(completed) ||
    completed < 0 ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    completed > total ||
    !planDocument ||
    !checklistDocument
  ) {
    throw new Error("Current plan response has invalid progress or documents.");
  }
  return {
    status,
    watchPath: value.watchPath,
    plan: {
      title: `${value?.plan?.title ?? ""}`.trim() || "Current plan",
      completed,
      total,
      planDocument,
      checklistDocument,
    },
    problems,
  };
}

export function sameCurrentPlanProjection(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeDocument(document) {
  const path = `${document?.path ?? ""}`.trim();
  if (!path) {
    return null;
  }
  const size = Number(document?.size);
  const modifiedMs = document?.modifiedMs;
  return {
    path,
    name: `${document?.name ?? ""}`.trim() || path.split("/").at(-1) || path,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    modifiedMs:
      modifiedMs === null || modifiedMs === undefined
        ? null
        : Number(modifiedMs),
  };
}

function rootedLogicalPath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}
