import { presentTaskFilePath } from "#tasks/task-format.js";

// The graph tracks only whether a projection read is in flight. The accepted
// projection, the latest read failure, and Watch availability stay orthogonal:
// a successful read never clears a Watch interruption.
export const CURRENT_PLAN_NODE = Object.freeze({
  INACTIVE: "inactive",
  READING: "reading",
  SETTLED: "settled",
});

export type CurrentPlanNode =
  (typeof CURRENT_PLAN_NODE)[keyof typeof CURRENT_PLAN_NODE];

type PlanDocumentKind = "plan" | "checklist";

// One of the two plan files, as the server reports it.
export interface CurrentPlanDocument {
  path: string;
  name: string;
  size: number | null;
  modifiedMs: number | null;
}

export interface CurrentPlanProblem {
  document: string;
  code: string;
  message: string;
}

// What the server says about a Task's current plan: none, one to show, or
// files that could not be read. `watchPath` is where changes come from.
export interface CurrentPlanProjection {
  status: "absent" | "ready" | "problem";
  watchPath: string;
  plan: {
    title: string;
    completed: number;
    total: number;
    planDocument: CurrentPlanDocument;
    checklistDocument: CurrentPlanDocument;
  } | null;
  problems: CurrentPlanProblem[];
}

export interface CurrentPlanIssue {
  label: string;
  detail: string;
}

// How the plan strip reads: whether it shows, as a ready plan or a problem,
// what its status says, and whether Refresh can help.
export interface CurrentPlanPresentation {
  visible: boolean;
  presentation: "" | "ready" | "problem";
  label: string;
  issues: CurrentPlanIssue[];
  refreshAvailable: boolean;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<CurrentPlanNode, ReadonlySet<CurrentPlanNode>>
> = {
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
};

const DOCUMENT_FILE_NAMES: Readonly<Record<PlanDocumentKind, string>> = {
  plan: "PLAN.md",
  checklist: "CHECKLIST.md",
};

export function currentPlanTransitionAllowed(
  from: CurrentPlanNode,
  to: CurrentPlanNode,
) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function currentPlanPresentation({
  projection = null,
  readError = null,
  watchError = null,
}: {
  projection?: CurrentPlanProjection | null;
  readError?: unknown;
  watchError?: unknown;
} = {}): CurrentPlanPresentation {
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
  const problems = status === "problem" ? (projection?.problems ?? []) : [];
  const issues = [
    ...problems.map((problem) => ({
      label: documentProblemLabel(documentFileName(problem.document), [
        problem,
      ]),
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
    label:
      status === "problem"
        ? documentProblemLabel(
            problems.length === 1
              ? documentFileName(problems[0].document)
              : "Plan files",
            problems,
          )
        : (issues[0]?.label ?? ""),
    issues,
    refreshAvailable: Boolean(watchError || readError),
  };
}

export function currentPlanDocumentPaths(
  projection: CurrentPlanProjection | null | undefined,
) {
  const plan = `${projection?.plan?.planDocument?.path ?? ""}`.trim();
  const checklist = `${projection?.plan?.checklistDocument?.path ?? ""}`.trim();
  return [plan, checklist].filter(Boolean);
}

export function currentPlanDocumentDisplayPath(
  path: string | null | undefined,
  rootPath: string | null | undefined,
) {
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

// The response read as a projection, or an error naming what is wrong with
// it. The server's JSON is read field by field because nothing else checks it.
export function normalizeCurrentPlanProjection(
  value: unknown,
): CurrentPlanProjection {
  const response = (value ?? {}) as Record<string, unknown> & {
    plan?: Record<string, unknown> | null;
    problems?: unknown;
  };
  const status = `${response.status ?? ""}`;
  if (status !== "absent" && status !== "ready" && status !== "problem") {
    throw new Error("Current plan response has an invalid status.");
  }
  if (typeof response.watchPath !== "string") {
    throw new Error("Current plan response has no watch path.");
  }
  const problems: CurrentPlanProblem[] = Array.isArray(response.problems)
    ? response.problems.map((problem) => ({
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
    return { status, watchPath: response.watchPath, plan: null, problems };
  }

  const plan = response.plan ?? {};
  const completed = Number(plan.completed);
  const total = Number(plan.total);
  const planDocument = normalizeDocument(plan.planDocument);
  const checklistDocument = normalizeDocument(plan.checklistDocument);
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
    watchPath: response.watchPath,
    plan: {
      title: `${plan.title ?? ""}`.trim() || "Current plan",
      completed,
      total,
      planDocument,
      checklistDocument,
    },
    problems,
  };
}

function documentFileName(document: string) {
  return DOCUMENT_FILE_NAMES[document as PlanDocumentKind];
}

function documentProblemLabel(subject: string, problems: CurrentPlanProblem[]) {
  const missing = problems.every((problem) => problem.code === "missing");
  return `${subject} ${missing ? "missing" : "unreadable"}`;
}

function errorMessage(error: unknown) {
  return `${(error as { message?: unknown } | null)?.message ?? error}`;
}

function normalizeDocument(value: unknown): CurrentPlanDocument | null {
  const document = (value ?? {}) as Record<string, unknown>;
  const path = `${document.path ?? ""}`.trim();
  if (!path) {
    return null;
  }
  const size = Number(document.size);
  const modifiedMs = document.modifiedMs;
  return {
    path,
    name: `${document.name ?? ""}`.trim() || path.split("/").at(-1) || path,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    modifiedMs:
      modifiedMs === null || modifiedMs === undefined
        ? null
        : Number(modifiedMs),
  };
}

function rootedLogicalPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}
