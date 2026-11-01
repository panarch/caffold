import type { TaskEvent } from "#app/api.js";
import { eventIdentityKey } from "#tasks/task-events.js";
import { formatDuration, formatStatus } from "#tasks/task-format.js";

export type ToolCallPresentation = ReturnType<typeof toolCallPresentation>;

// The one line a tool call shows: how far along it is, the agent's name for
// the tool, and the server and duration when the agent reported them.
export function toolCallPresentation(event: TaskEvent | null) {
  const payload = event?.payload ?? {};
  const status = `${payload.status ?? ""}`.trim();
  const server = `${payload.server ?? ""}`.trim();
  const durationMs = payload.durationMs;
  const duration =
    typeof durationMs === "number" && Number.isFinite(durationMs)
      ? formatDuration(durationMs)
      : "";
  return {
    key: eventIdentityKey(event),
    name: `${payload.name ?? ""}`.trim() || "Tool call",
    metadata: [server, duration].filter(Boolean).join(" · "),
    status: status || "unknown",
    statusLabel: STATUS_LABELS[status] ?? formatStatus(status),
    tone: status === "failed" ? ("danger" as const) : ("neutral" as const),
  };
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  declined: "Declined",
  inProgress: "In progress",
};
