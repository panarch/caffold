import type { TaskStoreReadiness } from "#app/api.ts";

// What the Task store last said about whether it can take Task operations.
export interface TaskStoreStatusSnapshot {
  readiness: TaskStoreReadiness | null;
  retryAvailable: boolean;
}

// Whether Task operations can run now, and what a blocked control says. `key`
// changes whenever anything else does.
export interface TaskOperationsPresentation {
  key: string;
  phase: string;
  blocked: boolean;
  title: string;
  message: string;
}

export function createTaskStoreStatusSnapshot({
  readiness = null,
  retryAvailable = false,
}: {
  readiness?: unknown;
  retryAvailable?: unknown;
} = {}): TaskStoreStatusSnapshot {
  return Object.freeze({
    readiness: normalizeTaskStoreReadiness(readiness),
    retryAvailable: Boolean(retryAvailable),
  });
}

// The snapshot before the store has said anything.
export const INITIAL_TASK_STORE_STATUS_SNAPSHOT =
  createTaskStoreStatusSnapshot();

export function sameTaskStoreStatusSnapshot(
  left: TaskStoreStatusSnapshot | null | undefined,
  right: TaskStoreStatusSnapshot | null | undefined,
) {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        left.retryAvailable === right.retryAvailable &&
        readinessSignature(left.readiness) ===
          readinessSignature(right.readiness),
    )
  );
}

/// The store is shared by every agent, so its readiness gates every Task
/// operation. A store nobody has heard from yet is not a blocked store — an
/// operation tried too early is refused by the server, which is the true
/// answer.
export function taskStoreBlocksTaskOperations(
  snapshot: TaskStoreStatusSnapshot | null | undefined,
): snapshot is TaskStoreStatusSnapshot & { readiness: TaskStoreReadiness } {
  return snapshot?.readiness?.blocksTaskOperations === true;
}

export function taskStoreOperationsPresentation(
  snapshot: TaskStoreStatusSnapshot | null | undefined,
): TaskOperationsPresentation {
  if (!taskStoreBlocksTaskOperations(snapshot)) {
    return READY_TASK_OPERATIONS;
  }
  const readiness = snapshot.readiness;
  const content = taskStoreReadinessContent(readiness);
  return taskOperationsPresentation({
    phase: `taskStore:${readiness.state || "blocked"}`,
    blocked: true,
    title: content.title,
    message: content.message,
  });
}

export function normalizeTaskStoreReadiness(
  input: unknown,
): TaskStoreReadiness | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const readiness = input as Partial<Record<keyof TaskStoreReadiness, unknown>>;
  return Object.freeze({
    state: `${readiness.state ?? ""}`,
    blocksTaskOperations: readiness.blocksTaskOperations === true,
    diagnosticMessage: `${readiness.diagnosticMessage ?? ""}`,
  });
}

const READY_TASK_OPERATIONS = taskOperationsPresentation({
  phase: "ready",
  blocked: false,
  title: "New Task",
  message: "",
});

function taskOperationsPresentation({
  phase,
  blocked,
  title,
  message,
}: Omit<TaskOperationsPresentation, "key">): TaskOperationsPresentation {
  return Object.freeze({
    key: [phase, blocked, title, message].join("|"),
    phase,
    blocked,
    title,
    message,
  });
}

function taskStoreReadinessContent(readiness: TaskStoreReadiness) {
  if (readiness.state === "failed") {
    return {
      title: "Task data upgrade failed",
      message:
        readiness.diagnosticMessage ||
        "Caffold could not finish preparing the Task store.",
    };
  }
  return {
    title: "Preparing Tasks…",
    message:
      readiness.diagnosticMessage ||
      "Caffold is preparing the local Task navigator.",
  };
}

function readinessSignature(readiness: TaskStoreReadiness | null) {
  return readiness
    ? [
        readiness.state,
        readiness.blocksTaskOperations,
        readiness.diagnosticMessage,
      ].join("|")
    : "";
}
