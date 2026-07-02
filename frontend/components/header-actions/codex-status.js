import { escapeHtml } from "../dom.js";

const CODEX_POPOVER_ID = "caffold-codex-actions-popover";

export function renderCodexActions(codexStatus, { renderGroupButton }) {
  const state = !codexStatus
    ? "pending"
    : codexStatus.available
      ? "available"
      : "unavailable";
  const statusLabel =
    state === "pending" ? "Checking..." : codexStatus.available ? "Connected" : "Unavailable";
  const accountLabel = formatCodexAccount(codexStatus);
  const title =
    state === "pending"
      ? "Checking Codex app-server status"
      : codexStatus.available
        ? `Codex app-server connected, ${accountLabel}`
        : `Codex app-server unavailable${codexStatus.message ? `, ${codexStatus.message}` : ""}`;

  return `
    <div class="header-action-group">
      ${renderGroupButton({
        group: "codex",
        popoverId: CODEX_POPOVER_ID,
        brandIcon: {
          light: "/assets/brand/codex-template@2x.png",
          dark: "/assets/brand/codex-template@2x.png",
        },
        label: "Codex",
        title,
        state,
      })}
      <section
        id="${CODEX_POPOVER_ID}"
        class="header-actions-popover"
        data-action-group="codex"
        aria-label="Codex app-server status"
        hidden
      >
        <header class="header-actions-popover-header">
          <h2>Codex</h2>
          <span>${escapeHtml(statusLabel)}</span>
        </header>
        ${
          state === "pending"
            ? renderCodexNotice(title)
            : `<div class="header-status-panel">
                <strong class="header-status-account">${escapeHtml(accountLabel)}</strong>
                ${renderStatusRow("Plan", formatCodexPlan(codexStatus))}
                <div class="header-status-section-title">Remaining usage</div>
                ${renderUsageRow(codexStatus, "primary")}
                ${renderUsageRow(codexStatus, "secondary")}
                ${renderStatusRow("Resets", formatResetCredits(codexStatus))}
                ${
                  codexStatus.message
                    ? `<p class="header-status-message">${escapeHtml(codexStatus.message)}</p>`
                    : ""
                }
              </div>`
        }
      </section>
    </div>
  `;
}

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
    formatUsageSignature(left, "primary") === formatUsageSignature(right, "primary") &&
    formatUsageSignature(left, "secondary") === formatUsageSignature(right, "secondary") &&
    formatResetCredits(left) === formatResetCredits(right)
  );
}

function renderUsageRow(status, name) {
  const window = findRateWindow(status?.rateLimits, name);

  return `
    <div class="header-usage-row">
      <span>${escapeHtml(formatRateWindowLabel(window, name))}</span>
      <strong>${escapeHtml(formatRemainingPercent(window))}</strong>
      <time>${escapeHtml(formatRateReset(window))}</time>
    </div>
  `;
}

function renderStatusRow(label, value) {
  return `
    <div class="header-status-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderCodexNotice(message) {
  return `
    <div class="header-actions-notice">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function formatCodexAccount(status) {
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

function formatCodexPlan(status) {
  return status?.account?.planType ?? "-";
}

function formatUsageSignature(status, name) {
  const window = findRateWindow(status?.rateLimits, name);
  return [
    formatRateWindowLabel(window, name),
    formatRemainingPercent(window),
    formatRateReset(window),
  ].join("|");
}

function formatRateWindowLabel(window, fallback) {
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

function formatRemainingPercent(window) {
  const usedPercent = Number(window?.usedPercent);
  if (!Number.isFinite(usedPercent)) {
    return "-";
  }

  return `${Math.max(0, Math.round(100 - usedPercent))}%`;
}

function formatRateReset(window) {
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

  if (sameDay) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function findRateWindow(value, name) {
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

function formatResetCredits(status) {
  const count = Number(status?.rateLimits?.rateLimitResetCredits?.availableCount);
  if (!Number.isFinite(count)) {
    return "-";
  }

  return `${count} available`;
}
