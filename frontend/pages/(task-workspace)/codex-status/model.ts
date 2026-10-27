import type {
  CodexRateLimit,
  CodexRateWindow,
  CodexResetCredit,
  CodexStatus,
} from "#app/api.js";

type Status = CodexStatus | null | undefined;

export interface CodexStatusSnapshot {
  phase: "checking" | "loaded" | "failed";
  status: CodexStatus | null;
  error: string;
}

export interface CodexRuntimeRequestState {
  state: string;
  message: string;
}

export function sameCodexStatus(left: Status, right: Status) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    readinessSignature(left) === readinessSignature(right) &&
    left.account?.accountType === right.account?.accountType &&
    left.account?.email === right.account?.email &&
    left.account?.planType === right.account?.planType &&
    daemonSignature(left) === daemonSignature(right) &&
    usageSignature(left) === usageSignature(right) &&
    resetCreditSignature(left) === resetCreditSignature(right)
  );
}

// A snapshot with each field left out at its resting value.
export function createCodexStatusSnapshot({
  phase = "checking",
  status = null,
  error = "",
}: Partial<CodexStatusSnapshot> = {}): CodexStatusSnapshot {
  return Object.freeze({
    phase,
    status: status ?? null,
    error: `${error ?? ""}`,
  });
}

export const INITIAL_CODEX_STATUS_SNAPSHOT = createCodexStatusSnapshot();

export function sameCodexStatusSnapshot(
  left: CodexStatusSnapshot | null | undefined,
  right: CodexStatusSnapshot | null | undefined,
) {
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

function readinessSignature(status: Status) {
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

function daemonSignature(status: Status) {
  const daemon = status?.daemon;
  return [
    daemon?.status,
    daemon?.managedCodexVersion,
    daemon?.cliVersion,
    daemon?.appServerVersion,
  ].join("|");
}

// What Codex's readiness means for the surfaces that use it: not known yet,
// ready, needing the person, or out of reach.
export function codexState(
  snapshot: CodexStatusSnapshot | null | undefined,
): "pending" | "available" | "attention" | "unavailable" {
  const status = snapshot?.status;
  const state = status?.readiness?.state;
  if (!state) {
    return snapshot?.phase === "failed" ? "unavailable" : "pending";
  }
  if (state === "ready") {
    return "available";
  }
  if (
    [
      "missing",
      "unsupportedInstall",
      "updateRequired",
      "signInRequired",
      "restartRequired",
    ].includes(state)
  ) {
    return "attention";
  }
  return "unavailable";
}

// Codex readiness is one agent's, and gates only Codex's own surfaces — never
// a route, never another agent.
export function codexBlocksTaskOperations(status: Status) {
  return status?.readiness?.blocksTaskOperations === true;
}

export function codexRuntimeRestartAvailable(status: Status) {
  return ["ready", "restartRequired"].includes(status?.readiness?.state ?? "");
}

export function codexRuntimeUpdateAvailable(status: Status) {
  return ["ready", "restartRequired"].includes(status?.readiness?.state ?? "");
}

export function formatCodexReadiness(
  snapshot: CodexStatusSnapshot | null | undefined,
) {
  const status = snapshot?.status;
  const state = status?.readiness?.state;
  if (!state) {
    return snapshot?.phase === "failed" ? "Check failed" : "Checking";
  }
  if (state === "ready" && status?.readiness?.blocksTaskOperations !== false) {
    return "Unavailable";
  }
  const labels: Record<string, string> = {
    missing: "Setup required",
    unsupportedInstall: "Setup required",
    updateRequired: "Update required",
    signInRequired: "Sign-in required",
    restartRequired: "Restart required",
    incompatible: "Unavailable",
    ready: "Ready",
    error: "Unavailable",
  };
  return labels[state] ?? "Unavailable";
}

export function formatCodexAccount(status: Status) {
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

export function formatCodexPlan(status: Status) {
  return status?.account?.planType ?? "-";
}

/// Every window Codex reported, limit by limit. The limit Codex also reports as
/// its single-bucket view leads; the by-limit map carries no order of its own.
export function codexRateWindows(status: Status): Array<{
  limitId?: string;
  limitName?: string;
  name: "primary" | "secondary";
  window: CodexRateWindow;
}> {
  const reported = status?.rateLimits;
  const single = reported?.rateLimits;
  const limits: Array<[string | undefined, CodexRateLimit | null | undefined]> =
    reported?.rateLimitsByLimitId
      ? Object.entries(reported.rateLimitsByLimitId)
      : [[single?.limitId, single]];
  return [
    ...limits.filter(([limitId]) => limitId === single?.limitId),
    ...limits.filter(([limitId]) => limitId !== single?.limitId),
  ].flatMap(([limitId, limit]) =>
    (["primary", "secondary"] as const).flatMap((name) => {
      const window = limit?.[name];
      return window
        ? [{ limitId, limitName: limit?.limitName, name, window }]
        : [];
    }),
  );
}

export function formatRateWindowLabel(
  window: CodexRateWindow | null | undefined,
  name: string,
) {
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

export function formatUsedPercent(window: CodexRateWindow | null | undefined) {
  const usedPercent = Number(window?.usedPercent);
  return Number.isFinite(usedPercent) ? `${Math.round(usedPercent)}%` : "-";
}

export function formatRateReset(window: CodexRateWindow | null | undefined) {
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

export function formatResetCredits(status: Status) {
  const credits = codexResetCredits(status);
  return credits ? `${credits.availableCount} available` : "-";
}

export function codexResetCredits(status: Status): {
  availableCount: number;
  credits: CodexResetCredit[] | null;
} | null {
  const reported = status?.rateLimits?.rateLimitResetCredits;
  const availableCount = reported?.availableCount;
  if (
    typeof availableCount !== "number" ||
    !Number.isSafeInteger(availableCount) ||
    availableCount < 0
  ) {
    return null;
  }

  const credits = Array.isArray(reported?.credits)
    ? reported.credits
        .filter((credit) => credit?.status === "available")
        .sort((left, right) => {
          const leftExpiry = validEpochSeconds(left.expiresAt) ?? Infinity;
          const rightExpiry = validEpochSeconds(right.expiresAt) ?? Infinity;
          return leftExpiry - rightExpiry;
        })
        .slice(0, availableCount)
    : null;
  return { availableCount, credits };
}

export function resetCreditExpiry(
  expiresAt: unknown,
): { datetime: string; label: string } | null {
  const seconds = validEpochSeconds(expiresAt);
  if (seconds === null) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return {
    datetime: date.toISOString(),
    label: formatRateReset({ resetsAt: seconds }),
  };
}

function validEpochSeconds(value: unknown) {
  if (typeof value !== "number") {
    return null;
  }
  return Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(new Date(value * 1000).getTime())
    ? value
    : null;
}

function resetCreditSignature(status: Status) {
  const credits = codexResetCredits(status);
  if (!credits) {
    return "unknown";
  }
  return JSON.stringify([
    credits.availableCount,
    credits.credits?.map((credit) => [
      credit.id,
      credit.resetType,
      credit.status,
      credit.grantedAt,
      credit.expiresAt,
      credit.title,
    ]) ?? null,
  ]);
}

function usageSignature(status: Status) {
  return codexRateWindows(status)
    .map(({ limitId, limitName, name, window }) =>
      [
        limitId,
        limitName,
        name,
        formatRateWindowLabel(window, name),
        formatUsedPercent(window),
        formatRateReset(window),
      ].join("|"),
    )
    .join("\n");
}
