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

  // The newest thing still running says what is happening now. Nothing
  // running means the agent is between pieces of work.
  const event =
    [...events].reverse().find((entry) => entry.payload?.status === "inProgress") ??
    [...events].reverse().find((entry) => WORKING_EVENT_TYPES.includes(entry.type));
  return event ? workingLabel(event) : "Thinking";
}

const WORKING_EVENT_TYPES = [
  "tool_call",
  "reasoning",
  "plan",
  "command_execution",
  "file_change",
  "assistant_message",
];

function workingLabel(event) {
  if (event.type === "command_execution") {
    return "Running command";
  }
  if (event.type === "file_change") {
    return "Editing files";
  }
  if (event.type === "plan") {
    return "Updating plan";
  }
  // Work Caffold has no surface for says what it is itself, in the agent's
  // own words, because Caffold has no better name for it.
  if (event.type === "tool_call" && event.payload?.status === "inProgress") {
    return `${event.payload?.name ?? "Working"}…`;
  }
  return "Thinking";
}
