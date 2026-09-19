export function sameCodexStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    taskStoreReadinessSignature(left) === taskStoreReadinessSignature(right) &&
    readinessSignature(left) === readinessSignature(right) &&
    left.account?.accountType === right.account?.accountType &&
    left.account?.email === right.account?.email &&
    left.account?.planType === right.account?.planType &&
    daemonSignature(left) === daemonSignature(right) &&
    usageSignature(left) === usageSignature(right) &&
    formatResetCredits(left) === formatResetCredits(right)
  );
}

function taskStoreReadinessSignature(status) {
  const readiness = status?.taskStoreReadiness;
  return [
    readiness?.state,
    readiness?.blocksTaskOperations,
    readiness?.diagnosticMessage,
  ].join("|");
}

export function createCodexStatusSnapshot({
  phase = "checking",
  status = null,
  error = "",
} = {}) {
  return Object.freeze({
    phase,
    status: status ?? null,
    error: `${error ?? ""}`,
  });
}

export const INITIAL_CODEX_STATUS_SNAPSHOT = createCodexStatusSnapshot();

export function sameCodexStatusSnapshot(left, right) {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.phase === right.phase &&
      left.error === right.error &&
      sameCodexStatus(left.status, right.status),
    )
  );
}

function readinessSignature(status) {
  const readiness = status?.readiness;
  return [
    readiness?.state,
    readiness?.blocksTaskOperations,
    readiness?.reasonCode,
    readiness?.diagnosticMessage,
    readiness?.minimumSupportedVersion,
    readiness?.detectedExecutable?.path,
    readiness?.detectedExecutable?.version,
    readiness?.managedExecutable?.path,
    readiness?.managedExecutable?.version,
    readiness?.runningAppServerVersion,
  ].join("|");
}

function daemonSignature(status) {
  const daemon = status?.daemon;
  return [
    daemon?.status,
    daemon?.managedCodexVersion,
    daemon?.cliVersion,
    daemon?.appServerVersion,
  ].join("|");
}

export function codexState(snapshot) {
  const status = snapshot?.status;
  const state = status?.readiness?.state;
  if (!state) {
    return snapshot?.phase === "failed" ? "unavailable" : "pending";
  }
  if (state === "ready") {
    return "available";
  }
  if ([
    "missing",
    "unsupportedInstall",
    "updateRequired",
    "signInRequired",
    "restartRequired",
  ].includes(state)) {
    return "attention";
  }
  return "unavailable";
}

// Two axes, deliberately apart. The Task store is shared by every agent, so
// its readiness gates every Task operation. Codex readiness is one agent's,
// and gates only Codex's own surfaces — never a route, never another agent.
export function codexBlocksTaskOperations(status) {
  return status?.readiness?.blocksTaskOperations === true;
}

export function codexRuntimeRestartAvailable(status) {
  return ["ready", "restartRequired"].includes(status?.readiness?.state);
}

export function codexRuntimeUpdateAvailable(status) {
  return ["ready", "restartRequired"].includes(status?.readiness?.state);
}

export function taskStoreBlocksTaskOperations(status) {
  return status?.taskStoreReadiness?.blocksTaskOperations === true;
}

const READY_TASK_OPERATIONS = taskOperationsPresentation({
  phase: "ready",
  blocked: false,
  title: "New Task",
  message: "",
});

/// What every Task operation shares: the store's own gate, and nothing else.
/// A store nobody has heard from yet is not a blocked store — an operation
/// tried too early is refused by the server, which is the true answer.
export function taskStoreOperationsPresentation(snapshot) {
  const taskStore = snapshot?.status?.taskStoreReadiness;
  if (!taskStore?.blocksTaskOperations) {
    return READY_TASK_OPERATIONS;
  }
  const content = taskStoreReadinessContent(taskStore, snapshot);
  return taskOperationsPresentation({
    phase: `taskStore:${taskStore.state ?? "blocked"}`,
    blocked: true,
    title: content.title,
    message: content.message,
  });
}

/// Whether the store's own card takes the Task surface over. Only the store
/// earns that: nothing else may hold every Task hostage.
export function taskStoreRecoveryVisible(snapshot) {
  return taskStoreBlocksTaskOperations(snapshot?.status);
}

/// Whether the Codex setup card has something to say — shown beside the Task
/// surface, never over it: Codex blocked, or a status nobody could load.
export function codexSetupVisible(snapshot) {
  if (snapshot?.phase === "failed" && !snapshot?.status) {
    return true;
  }
  const status = snapshot?.status;
  return Boolean(status?.readiness && codexBlocksTaskOperations(status));
}

function taskOperationsPresentation({ phase, blocked, title, message }) {
  return Object.freeze({
    key: [phase, blocked, title, message].join("|"),
    phase,
    blocked,
    title,
    message,
  });
}

export function formatCodexReadiness(snapshot) {
  const status = snapshot?.status;
  const state = status?.readiness?.state;
  if (!state) {
    return snapshot?.phase === "failed" ? "Check failed" : "Checking";
  }
  if (state === "ready" && status?.readiness?.blocksTaskOperations !== false) {
    return "Unavailable";
  }
  return {
    missing: "Setup required",
    unsupportedInstall: "Setup required",
    updateRequired: "Update required",
    signInRequired: "Sign-in required",
    restartRequired: "Restart required",
    incompatible: "Unavailable",
    ready: "Ready",
    error: "Unavailable",
  }[state] ?? "Unavailable";
}

function taskStoreReadinessContent(taskStore, snapshot) {
  if (taskStore.state === "waitingForCodex") {
    const title = `Codex ${formatCodexReadiness(snapshot).toLowerCase()}`;
    return {
      title,
      message:
        snapshot?.status?.readiness?.diagnosticMessage ||
        `${title}.`,
    };
  }
  if (taskStore.state === "failed") {
    return {
      title: "Task data upgrade failed",
      message:
        taskStore.diagnosticMessage ||
        "Caffold could not finish preparing the Task store.",
    };
  }
  return {
    title: "Preparing Tasks…",
    message:
      taskStore.diagnosticMessage ||
      "Caffold is preparing the local Task navigator.",
  };
}

export function formatCodexAccount(status) {
  const account = status?.account;
  if (!account) {
    return status?.readiness?.state === "ready" ? "Unknown" : "Not connected";
  }
  if (account.email) {
    return account.email;
  }
  if (account.accountType === "apiKey") {
    return "API key";
  }
  return account.accountType ?? "Unknown";
}

export function formatCodexPlan(status) {
  return status?.account?.planType ?? "-";
}

/// Every window Codex reported, limit by limit. The limit Codex also reports as
/// its single-bucket view leads; the by-limit map carries no order of its own.
export function codexRateWindows(status) {
  const reported = status?.rateLimits;
  const single = reported?.rateLimits;
  const limits = reported?.rateLimitsByLimitId
    ? Object.entries(reported.rateLimitsByLimitId)
    : [[single?.limitId, single]];
  return [
    ...limits.filter(([limitId]) => limitId === single?.limitId),
    ...limits.filter(([limitId]) => limitId !== single?.limitId),
  ].flatMap(([limitId, limit]) =>
    ["primary", "secondary"]
      .filter((name) => limit?.[name])
      .map((name) => ({
        limitId,
        limitName: limit.limitName,
        name,
        window: limit[name],
      })),
  );
}

export function formatRateWindowLabel(window, name) {
  const minutes = Number(window?.windowDurationMins);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    // A window Codex metered without naming its period is still a real limit,
    // so it is labelled by which limit it is rather than an invented duration.
    return name === "primary" ? "Primary limit" : "Secondary limit";
  }
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} min`;
}

export function formatUsedPercent(window) {
  const usedPercent = Number(window?.usedPercent);
  return Number.isFinite(usedPercent)
    ? `${Math.round(usedPercent)}%`
    : "-";
}

export function formatRateReset(window) {
  const resetsAt = Number(window?.resetsAt);
  if (!Number.isFinite(resetsAt)) {
    return "-";
  }

  const date = new Date(resetsAt * 1000);
  const sameDay = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatResetCredits(status) {
  const count = Number(status?.rateLimits?.rateLimitResetCredits?.availableCount);
  return Number.isFinite(count) ? `${count} available` : "-";
}

function usageSignature(status) {
  return codexRateWindows(status)
    .map(({ limitId, limitName, name, window }) => [
      limitId,
      limitName,
      name,
      formatRateWindowLabel(window, name),
      formatUsedPercent(window),
      formatRateReset(window),
    ].join("|"))
    .join("\n");
}
