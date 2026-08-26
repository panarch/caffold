import { eventIdentityKey } from "../../../../../../task-events.js";
import {
  formatDate,
  formatDuration,
  formatStatus,
  taskEventObservedMs,
} from "../../../../../../task-format.js";

export function commandPresentation(event = {}) {
  const payload = event.payload ?? {};
  const observedMs = taskEventObservedMs(event);
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const rawStatus = `${payload.status ?? ""}`.trim();
  const output = `${payload.output ?? ""}`.trim();
  const exitCode = finiteNumber(payload.exitCode);
  const duration = finiteNumber(payload.durationMs);
  const terminal = ["completed", "failed", "declined"].includes(rawStatus);
  // A declined command did not fail; nobody let it run. An exit code decides
  // only for a command that actually ran.
  const result =
    rawStatus === "declined"
      ? "declined"
      : rawStatus === "failed" || (exitCode !== null && exitCode !== 0)
        ? "failed"
        : "completed";
  const metadata = terminal
    ? [
        duration !== null ? formatDuration(duration) : "",
        result === "failed" && exitCode !== null ? `Exit ${exitCode}` : "",
      ].filter(Boolean)
    : [];
  const unavailable = "(command unavailable)";

  return {
    command: command || unavailable,
    commandKey: eventIdentityKey(event),
    // The one-line form the summary row shows. A command is routinely a
    // multi-line script, and engines disagree about a raw newline inside a
    // single-line box — Safari draws a missing-glyph mark where Chrome
    // collapses it to a space — so the line is made here rather than left to
    // the renderer. What this trades away is the row as a faithful copy
    // source: selecting it yields this flattened form, and the script's own
    // whitespace survives in `command`, which the dialog and the active
    // disclosure show.
    commandLine: command.replace(/\s+/g, " ") || unavailable,
    cwd,
    defaultOpen: Boolean(rawStatus && !terminal),
    metadata: metadata.join(" · "),
    mode: terminal ? "terminal" : "active",
    output,
    result,
    status: terminal ? result : rawStatus || "unknown",
    statusLabel: terminal
      ? { failed: "Failed", declined: "Declined", completed: "Completed" }[result]
      : rawStatus
        ? formatStatus(rawStatus)
        : "",
    time: observedMs === null ? "" : formatDate(observedMs),
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
