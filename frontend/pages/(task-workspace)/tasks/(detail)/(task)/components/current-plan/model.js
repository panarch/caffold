import { presentTaskFilePath } from "../../../../task-format.js";

// The graph tracks only whether a projection read is in flight. The accepted
// projection, the latest read failure, and Watch availability stay orthogonal:
// a successful read never clears a Watch interruption.
export const CURRENT_PLAN_NODE = Object.freeze({
  INACTIVE: "inactive",
  READING: "reading",
  SETTLED: "settled",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [CURRENT_PLAN_NODE.INACTIVE]: new Set([CURRENT_PLAN_NODE.READING]),
  [CURRENT_PLAN_NODE.READING]: new Set([
    CURRENT_PLAN_NODE.READING,
    CURRENT_PLAN_NODE.SETTLED,
    CURRENT_PLAN_NODE.INACTIVE,
  ]),
  [CURRENT_PLAN_NODE.SETTLED]: new Set([
    CURRENT_PLAN_NODE.READING,
    CURRENT_PLAN_NODE.INACTIVE,
  ]),
});

const DOCUMENT_FILE_NAMES = Object.freeze({
  plan: "PLAN.md",
  checklist: "CHECKLIST.md",
});

export function currentPlanTransitionAllowed(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function currentPlanPresentation({
  projection = null,
  readError = null,
  watchError = null,
} = {}) {
  const status = projection?.status;
  if (status !== "ready" && status !== "problem") {
    return {
      visible: false,
      presentation: "",
      label: "",
      issues: [],
      refreshAvailable: false,
    };
  }
  const problems = status === "problem" ? projection.problems : [];
  const issues = [
    ...problems.map((problem) => ({
      label: documentProblemLabel(
        DOCUMENT_FILE_NAMES[problem.document],
        [problem],
      ),
      detail: problem.message,
    })),
    ...(watchError
      ? [{ label: "Plan updates paused", detail: errorMessage(watchError) }]
      : []),
    ...(readError
      ? [{ label: "Couldn't load plan", detail: errorMessage(readError) }]
      : []),
  ];
  return {
    visible: true,
    presentation: status,
    label: status === "problem"
      ? documentProblemLabel(
          problems.length === 1
            ? DOCUMENT_FILE_NAMES[problems[0].document]
            : "Plan files",
          problems,
        )
      : issues[0]?.label ?? "",
    issues,
    refreshAvailable: Boolean(watchError || readError),
  };
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
    if (
      status === "problem" &&
      (problems.length === 0 ||
        problems.some(
          (problem) => !Object.hasOwn(DOCUMENT_FILE_NAMES, problem.document),
        ))
    ) {
      throw new Error("Current plan response has invalid problems.");
    }
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

function documentProblemLabel(subject, problems) {
  const missing = problems.every((problem) => problem.code === "missing");
  return `${subject} ${missing ? "missing" : "unreadable"}`;
}

function errorMessage(error) {
  return `${error?.message ?? error}`;
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
