import { eventIdentityKey } from "../../../../../../task-events.js";
import {
  formatDate,
  formatDuration,
  formatStatus,
} from "../../../../../../task-format.js";

export function commandPresentation(event = {}) {
  const payload = event.payload ?? {};
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const rawStatus = `${payload.status ?? ""}`.trim();
  const output = `${payload.aggregatedOutput ?? ""}`.trim();
  const exitCode = finiteNumber(payload.exitCode);
  const duration = finiteNumber(payload.durationMs);
  const terminal = ["completed", "failed"].includes(rawStatus);
  const result =
    rawStatus === "failed" || (exitCode !== null && exitCode !== 0)
      ? "failed"
      : "completed";
  const metadata = terminal
    ? [
        duration !== null ? formatDuration(duration) : "",
        result === "failed" && exitCode !== null ? `Exit ${exitCode}` : "",
      ].filter(Boolean)
    : [];

  return {
    command: command || "(command unavailable)",
    commandKey: eventIdentityKey(event),
    cwd,
    defaultOpen: Boolean(rawStatus && !terminal),
    metadata: metadata.join(" · "),
    mode: terminal ? "terminal" : "active",
    output,
    result,
    status: terminal ? result : rawStatus || "unknown",
    statusLabel: terminal
      ? result === "failed"
        ? "Failed"
        : "Completed"
      : rawStatus
        ? formatStatus(rawStatus)
        : "",
    time: formatDate(event.createdMs),
    tone: terminal
      ? result === "failed"
        ? "danger"
        : "neutral"
      : rawStatus
        ? "active"
        : "neutral",
  };
}

export function sameCommandPresentation(left, right) {
  return Boolean(
    left &&
      right &&
      Object.keys(left).every((key) => left[key] === right[key]),
  );
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
