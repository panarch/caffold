export const TASK_TRANSPORT_STATE = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  READY: "ready",
  VALIDATING: "validating",
  RECONNECTING: "reconnecting",
  UNAVAILABLE: "unavailable",
});

export const PROMPT_SUBMISSION_STATE = Object.freeze({
  SENDING: "sending",
  ACCEPTED: "accepted",
  OUTCOME_UNKNOWN: "outcomeUnknown",
  REJECTED: "rejected",
});

export function isTaskTransportStale(state) {
  return [
    TASK_TRANSPORT_STATE.RECONNECTING,
    TASK_TRANSPORT_STATE.UNAVAILABLE,
  ].includes(state);
}

export function taskThreadStatusType(task) {
  return `${task?.threadStatus?.type ?? "notLoaded"}`;
}

export function taskActiveFlags(task) {
  return Array.isArray(task?.threadStatus?.activeFlags)
    ? task.threadStatus.activeFlags
    : [];
}

export function isTaskActivelyWorking(task) {
  return taskThreadStatusType(task) === "active";
}

export function taskStatusKey(task) {
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
  return type === "systemError" ? "failed" : type;
}

export function taskActiveFlagLabel(task) {
  return {
    waiting_for_approval: "Waiting for approval",
    waiting_on_user_input: "Waiting for input",
  }[taskStatusKey(task)] ?? null;
}

export function taskStatusView(task) {
  return {
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
  }[taskStatusKey(task)] ?? null;
}

export function formatTaskStatus(task) {
  const key = taskStatusKey(task);
  return {
    waiting_for_approval: "waiting for approval",
    waiting_on_user_input: "waiting for input",
    running: "active",
    notLoaded: "not loaded",
  }[key] ?? key;
}

export function classifyPromptFailure(error) {
  const status = Number(error?.status);
  const code = `${error?.code ?? ""}`;
  const outcomeUnknown =
    !Number.isFinite(status) ||
    status === 0 ||
    status >= 500 ||
    code === "request_timeout" ||
    code === "codex_app_server_timeout";
  return outcomeUnknown
    ? PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN
    : PROMPT_SUBMISSION_STATE.REJECTED;
}

export function withPromptSubmissionState(event, state) {
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

export function promptSubmissionState(event) {
  if (!event?.payload?.optimistic) {
    return null;
  }
  return (
    event.payload.submissionState ??
    PROMPT_SUBMISSION_STATE.SENDING
  );
}
