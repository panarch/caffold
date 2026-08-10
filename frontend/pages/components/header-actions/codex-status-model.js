export function sameCodexStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.available === right.available &&
    left.codexCliAvailable === right.codexCliAvailable &&
    left.appServerAvailable === right.appServerAvailable &&
    left.message === right.message &&
    left.requiresOpenaiAuth === right.requiresOpenaiAuth &&
    left.account?.accountType === right.account?.accountType &&
    left.account?.email === right.account?.email &&
    left.account?.planType === right.account?.planType &&
    daemonSignature(left) === daemonSignature(right) &&
    left.diagnostics?.codexCliVersion === right.diagnostics?.codexCliVersion &&
    usageSignature(left, "primary") === usageSignature(right, "primary") &&
    usageSignature(left, "secondary") === usageSignature(right, "secondary") &&
    formatResetCredits(left) === formatResetCredits(right)
  );
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

export function codexState(status) {
  if (!status) {
    return "pending";
  }
  return status.available ? "available" : "unavailable";
}

export function formatCodexAccount(status) {
  const account = status?.account;
  if (!account) {
    return status?.available ? "Unknown" : "Not connected";
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
