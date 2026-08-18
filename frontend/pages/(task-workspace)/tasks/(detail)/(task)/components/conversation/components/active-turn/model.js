import { taskActiveFlagLabel } from "../../../../../../runtime-state.js";
import { formatDuration } from "../../../../../../task-format.js";

export function activeTurnPresentation(events = [], task = null) {
  return {
    startedMs: activeTurnStartMs(task),
    state: activeTurnStateLabel(events, task),
  };
}

export function activeTurnDuration(startedMs, nowMs = Date.now()) {
  if (!Number.isFinite(startedMs) || startedMs <= 0) {
    return "Working";
  }
  return `Working for ${formatDuration(Math.max(0, nowMs - startedMs))}`;
}

function activeTurnStartMs(task) {
  const taskStartedMs = Number(task?.activeTurn?.startedAtMs);
  if (Number.isFinite(taskStartedMs) && taskStartedMs > 0) {
    return taskStartedMs;
  }
  return null;
}

function activeTurnStateLabel(events, task) {
  const activeFlagLabel = taskActiveFlagLabel(task);
  if (activeFlagLabel) {
    return activeFlagLabel;
  }

  const event =
    [...events]
      .reverse()
      .find((entry) => entry.payload?.lifecycle === "started") ??
    [...events]
      .reverse()
      .find((entry) =>
        entry.type === "work_status" ||
        entry.type === "reasoning" ||
        entry.type === "plan" ||
        entry.type === "command_execution" ||
        entry.type === "file_change" ||
        entry.type === "assistant_message",
      );
  if (!event) {
    return "Thinking";
  }
  if (event.type === "work_status") {
    return activeWorkItemLabel(
      event.payload?.itemType,
      event.payload?.lifecycle,
    );
  }
  if (event.type === "reasoning") {
    return "Thinking";
  }
  if (event.type === "plan") {
    return "Updating plan";
  }
  if (event.type === "command_execution") {
    return "Running command";
  }
  if (event.type === "file_change") {
    return "Editing files";
  }
  return "Thinking";
}

function activeWorkItemLabel(itemType, lifecycle) {
  if (itemType === "contextCompaction") {
    return lifecycle === "started" ? "Compacting context…" : "Thinking";
  }
  if (itemType === "plan") {
    return "Updating plan";
  }
  if (
    ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(itemType)
  ) {
    return "Running command";
  }
  if (itemType === "fileChange") {
    return "Editing files";
  }
  return "Thinking";
}
