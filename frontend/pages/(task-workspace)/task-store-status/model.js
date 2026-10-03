export function createTaskStoreStatusSnapshot({
  readiness = null,
  retryAvailable = false,
} = {}) {
  return Object.freeze({
    readiness: normalizeTaskStoreReadiness(readiness),
    retryAvailable: Boolean(retryAvailable),
  });
}

export const INITIAL_TASK_STORE_STATUS_SNAPSHOT = createTaskStoreStatusSnapshot();

export function sameTaskStoreStatusSnapshot(left, right) {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.retryAvailable === right.retryAvailable &&
      readinessSignature(left.readiness) === readinessSignature(right.readiness),
    )
  );
}

/// The store is shared by every agent, so its readiness gates every Task
/// operation. A store nobody has heard from yet is not a blocked store — an
/// operation tried too early is refused by the server, which is the true
/// answer.
export function taskStoreBlocksTaskOperations(snapshot) {
  return snapshot?.readiness?.blocksTaskOperations === true;
}

export function taskStoreOperationsPresentation(snapshot) {
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

export function normalizeTaskStoreReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") {
    return null;
  }
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

function taskOperationsPresentation({ phase, blocked, title, message }) {
  return Object.freeze({
    key: [phase, blocked, title, message].join("|"),
    phase,
    blocked,
    title,
    message,
  });
}

function taskStoreReadinessContent(readiness) {
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

function readinessSignature(readiness) {
  return readiness
    ? [
      readiness.state,
      readiness.blocksTaskOperations,
      readiness.diagnosticMessage,
    ].join("|")
    : "";
}
