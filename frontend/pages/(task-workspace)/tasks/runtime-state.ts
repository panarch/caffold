import type { TaskEvent, TaskThreadStatus } from "#app/api.js";

export const TASK_TRANSPORT_STATE = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  READY: "ready",
  VALIDATING: "validating",
  RECONNECTING: "reconnecting",
  UNAVAILABLE: "unavailable",
});

export type TaskTransportState =
  (typeof TASK_TRANSPORT_STATE)[keyof typeof TASK_TRANSPORT_STATE];

export const PROMPT_SUBMISSION_STATE = Object.freeze({
  UPLOADING: "uploading",
  SENDING: "sending",
  ACCEPTED: "accepted",
  OUTCOME_UNKNOWN: "outcomeUnknown",
  REJECTED: "rejected",
});

export type PromptSubmissionState =
  (typeof PROMPT_SUBMISSION_STATE)[keyof typeof PROMPT_SUBMISSION_STATE];

// Any Task shape that carries the agent's status: a Task, or a Task as the
// Active list shows it.
type StatusOf =
  | { threadStatus?: TaskThreadStatus | null; backgroundWork?: boolean }
  | null
  | undefined;

// How a Task's status reads where it is shown. Only these five are shown; a
// Task in any other state shows none.
export interface TaskStatusView {
  status:
    | "running"
    | "waiting_for_approval"
    | "waiting_on_user_input"
    | "failed"
    | "background";
  label: string;
  // The Lucide icon name, or "" for the spinner of a running Task.
  icon: string;
}

export function isTaskTransportStale(state: TaskTransportState) {
  return (
    [
      TASK_TRANSPORT_STATE.RECONNECTING,
      TASK_TRANSPORT_STATE.UNAVAILABLE,
    ] as TaskTransportState[]
  ).includes(state);
}

export function taskThreadStatusType(task: StatusOf) {
  return `${task?.threadStatus?.type ?? "notLoaded"}`;
}

export function taskActiveFlags(task: StatusOf): string[] {
  const status = task?.threadStatus as { activeFlags?: unknown } | null;
  return Array.isArray(status?.activeFlags) ? status.activeFlags : [];
}

export function isTaskActivelyWorking(task: StatusOf) {
  return taskThreadStatusType(task) === "active";
}

export function taskStatusKey(task: StatusOf) {
  const type = taskThreadStatusType(task);
  if (type === "active") {
    const activeFlags = taskActiveFlags(task);
    if (activeFlags.includes("waitingOnApproval")) {
      return "waiting_for_approval";
    }
    if (activeFlags.includes("waitingOnUserInput")) {
      return "waiting_on_user_input";
    }
    return "running";
  }
  if (type === "idle" && task?.backgroundWork) {
    return "background";
  }
  return type === "systemError" ? "failed" : type;
}

export function taskActiveFlagLabel(task: StatusOf) {
  const labels: Record<string, string> = {
    waiting_for_approval: "Waiting for approval",
    waiting_on_user_input: "Waiting for input",
  };
  return labels[taskStatusKey(task)] ?? null;
}

export function taskStatusView(task: StatusOf): TaskStatusView | null {
  const views: Record<string, TaskStatusView> = {
    running: { status: "running", label: "running", icon: "" },
    waiting_for_approval: {
      status: "waiting_for_approval",
      label: "approval",
      icon: "CircleAlert",
    },
    waiting_on_user_input: {
      status: "waiting_on_user_input",
      label: "input",
      icon: "MessageCircleQuestion",
    },
    failed: { status: "failed", label: "failed", icon: "TriangleAlert" },
    background: {
      status: "background",
      label: "background",
      icon: "CircleDashed",
    },
  };
  return views[taskStatusKey(task)] ?? null;
}

// How a Task's status reads in words, for one that shows no status chip too.
export function formatTaskStatus(task: StatusOf) {
  const key = taskStatusKey(task);
  const words: Record<string, string> = {
    waiting_for_approval: "waiting for approval",
    waiting_on_user_input: "waiting for input",
    running: "active",
    background: "background work",
    notLoaded: "not loaded",
  };
  return words[key] ?? key;
}

// What a failed prompt request means: certainly refused, or perhaps heard by
// the agent.
export function classifyPromptFailure(error: unknown) {
  const failure = error as { status?: unknown; code?: unknown } | null;
  const status = Number(failure?.status);
  const code = `${failure?.code ?? ""}`;
  // Refused before anything started: the backend answers this before a turn
  // exists, so the outcome is certainly a rejection — the draft comes back,
  // rather than lingering as a prompt that might have been heard.
  if (code === "codex_readiness_blocked") {
    return PROMPT_SUBMISSION_STATE.REJECTED;
  }
  const outcomeUnknown =
    !Number.isFinite(status) ||
    status === 0 ||
    status >= 500 ||
    code === "agent_timeout";
  return outcomeUnknown
    ? PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN
    : PROMPT_SUBMISSION_STATE.REJECTED;
}

// A prompt this browser sent, in the given submission state. Any other event
// is returned as it is.
export function withPromptSubmissionState(
  event: TaskEvent,
  state: PromptSubmissionState,
): TaskEvent {
  if (!event?.payload?.optimistic) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      submissionState: state,
    },
  };
}

export function promptSubmissionState(
  event: TaskEvent | null | undefined,
): PromptSubmissionState | null {
  if (!event?.payload?.optimistic) {
    return null;
  }
  return (
    (event.payload.submissionState as PromptSubmissionState | undefined) ??
    PROMPT_SUBMISSION_STATE.SENDING
  );
}
