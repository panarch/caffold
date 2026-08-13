export function sameCodexStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    readinessSignature(left) === readinessSignature(right) &&
    left.account?.accountType === right.account?.accountType &&
    left.account?.email === right.account?.email &&
    left.account?.planType === right.account?.planType &&
    daemonSignature(left) === daemonSignature(right) &&
    usageSignature(left, "primary") === usageSignature(right, "primary") &&
    usageSignature(left, "secondary") === usageSignature(right, "secondary") &&
    formatResetCredits(left) === formatResetCredits(right)
  );
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

export function codexBlocksTaskOperations(status) {
  return status?.readiness?.blocksTaskOperations !== false;
}

export const PENDING_CODEX_TASK_OPERATIONS = taskOperationsPresentation({
  phase: "pending",
  blocked: true,
  title: "Checking Codex readiness…",
  message: "Checking Codex readiness…",
});

export function codexTaskOperationsPresentation(snapshot) {
  const status = snapshot?.status;
  if (snapshot?.phase === "failed") {
    return taskOperationsPresentation({
      phase: "checkFailed",
      blocked: true,
      title: "Codex readiness check failed",
      message: "Codex readiness check failed.",
    });
  }

  if (!codexBlocksTaskOperations(status)) {
    return taskOperationsPresentation({
      phase: "ready",
      blocked: false,
      title: "New Task",
      message: "",
    });
  }

  if (!status?.readiness) {
    return PENDING_CODEX_TASK_OPERATIONS;
  }

  const title = `Codex ${formatCodexReadiness(snapshot).toLowerCase()}`;
  return taskOperationsPresentation({
    phase: "blocking",
    blocked: true,
    title,
    message: `${title}.`,
  });
}

export function codexTaskRecoveryVisible(snapshot) {
  if (snapshot?.phase === "failed") {
    return true;
  }
  const status = snapshot?.status;
  return Boolean(
    status?.readiness && codexBlocksTaskOperations(status),
  );
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
  if (state === "ready" && codexBlocksTaskOperations(status)) {
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

export function findRateWindow(value, name) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRateWindow(entry, name);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const direct = value[name];
  if (direct && typeof direct === "object") {
    if (Number.isFinite(Number(direct.usedPercent))) {
      return direct;
    }
    const nested = findRateWindow(direct, name);
    if (nested) {
      return nested;
    }
  }

  for (const key of ["rateLimits", "rateLimitsByLimitId"]) {
    const nested = findRateWindow(value[key], name);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function formatRateWindowLabel(window, fallback) {
  const minutes = Number(window?.windowDurationMins);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fallback === "primary" ? "5 hours" : "1 week";
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

export function formatRemainingPercent(window) {
  const usedPercent = Number(window?.usedPercent);
  return Number.isFinite(usedPercent)
    ? `${Math.max(0, Math.round(100 - usedPercent))}%`
    : "-";
}

export function formatRateReset(window) {
  const resetsAt = Number(window?.resetsAt);
  if (!Number.isFinite(resetsAt)) {
    return "-";
  }

  const date = new Date(resetsAt * 1000);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("en-US", sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

export function formatResetCredits(status) {
  const count = Number(status?.rateLimits?.rateLimitResetCredits?.availableCount);
  return Number.isFinite(count) ? `${count} available` : "-";
}

function usageSignature(status, name) {
  const window = findRateWindow(status?.rateLimits, name);
  return [
    formatRateWindowLabel(window, name),
    formatRemainingPercent(window),
    formatRateReset(window),
  ].join("|");
}
