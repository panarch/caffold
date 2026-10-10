import { eventIdentityKey } from "#tasks/task-events.js";

// Finished commands that ran one after another fold into one group, so a long
// stretch of shell work reads as one entry instead of a row per command. The
// empty thinking blocks an agent files around its commands fold in with them,
// since they mark only when it thought. A command still running stays on its
// own, where its live output shows, and joins the group once it ends. Anything
// else the reader can see keeps two commands apart; an event that draws
// nothing does not.
export function groupFinishedCommands(events, isShown = () => true) {
  const segments = [];
  let run = [];
  const closeRun = () => {
    if (run.filter(isFinishedCommandEvent).length >= SMALLEST_COMMAND_GROUP) {
      segments.push({ group: run });
    } else {
      segments.push(...run.map((event) => ({ event })));
    }
    run = [];
  };
  for (const event of events) {
    if (isFinishedCommandEvent(event) || isEmptyReasoning(event)) {
      run.push(event);
      continue;
    }
    if (isShown(event)) {
      closeRun();
    }
    segments.push({ event });
  }
  closeRun();
  return segments;
}

// A group is known by its first command, which stays first however many
// commands later join it.
export function commandGroupIdentity(events) {
  const first = events.find(isCommandEvent) ?? events[0];
  return `command-group:${eventIdentityKey(first) || `${first?.id ?? ""}`}`;
}

export function isCommandEvent(event) {
  return event?.type === "command_execution";
}

export function isFinishedCommand(event) {
  return FINISHED_STATUSES.includes(`${event?.payload?.status ?? ""}`.trim());
}

// A declined command did not fail; nobody let it run. An exit code decides
// only for a command that actually ran.
export function commandResult(event) {
  const payload = event?.payload ?? {};
  const status = `${payload.status ?? ""}`.trim();
  const exitCode = payload.exitCode;
  if (status === "declined") {
    return "declined";
  }
  if (
    status === "failed" ||
    (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0)
  ) {
    return "failed";
  }
  return "completed";
}

function isFinishedCommandEvent(event) {
  return isCommandEvent(event) && isFinishedCommand(event);
}

function isEmptyReasoning(event) {
  if (event?.type !== "reasoning") {
    return false;
  }
  const payload = event.payload ?? {};
  return ![
    ...(Array.isArray(payload.summary) ? payload.summary : []),
    ...(Array.isArray(payload.content) ? payload.content : []),
  ].some((text) => `${text ?? ""}`.trim());
}

const SMALLEST_COMMAND_GROUP = 2;
const FINISHED_STATUSES = ["completed", "failed", "declined"];
