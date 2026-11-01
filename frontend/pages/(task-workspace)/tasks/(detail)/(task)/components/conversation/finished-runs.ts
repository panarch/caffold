import type { TaskEvent } from "#app/api.js";
import { eventIdentityKey } from "#tasks/task-events.js";

export type FinishedRunKind = "command" | "tool-call";

export type FinishedRunSegment =
  | { kind: FinishedRunKind; group: TaskEvent[]; event?: undefined }
  | { event: TaskEvent; kind?: undefined; group?: undefined };

export type CommandResult = "completed" | "failed" | "declined";

// Finished commands that ran one after another fold into one group, and so do
// finished tool calls, so a long stretch of shell or tool work reads as one
// entry instead of a row per item. A command and a tool call never share a
// group. The empty thinking blocks an agent files around them fold in with
// the run they sit in, since they mark only when it thought. A command or tool
// call still running stays on its own, where it shows how far along it is, and
// joins the group once it ends. Anything else the reader can see keeps two
// items apart; an event that draws nothing does not.
export function groupFinishedRuns(
  events: TaskEvent[],
  isShown: (event: TaskEvent) => boolean = () => true,
): FinishedRunSegment[] {
  const segments: FinishedRunSegment[] = [];
  let run: TaskEvent[] = [];
  let runKind: FinishedRunKind | null = null;
  const closeRun = () => {
    const finished = run.filter((event) => finishedRunKind(event)).length;
    if (runKind && finished >= SMALLEST_RUN_GROUP) {
      segments.push({ kind: runKind, group: run });
    } else {
      segments.push(...run.map((event) => ({ event })));
    }
    run = [];
    runKind = null;
  };
  for (const event of events) {
    const kind = finishedRunKind(event);
    if (kind) {
      if (runKind && runKind !== kind) {
        closeRun();
      }
      runKind = kind;
      run.push(event);
      continue;
    }
    if (isEmptyReasoning(event)) {
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

// A group is known by its first command or tool call, which stays first
// however many later join it.
export function runGroupIdentity(kind: FinishedRunKind, events: TaskEvent[]) {
  const first =
    events.find((event) => eventRunKind(event) === kind) ?? events[0];
  return `${kind}-group:${eventIdentityKey(first) || `${first?.id ?? ""}`}`;
}

export function isCommandEvent(event: TaskEvent | null | undefined) {
  return event?.type === "command_execution";
}

export function isFinishedCommand(event: TaskEvent | null | undefined) {
  return FINISHED_STATUSES.includes(`${event?.payload?.status ?? ""}`.trim());
}

// A declined command did not fail; nobody let it run. An exit code decides
// only for a command that actually ran.
export function commandResult(
  event: TaskEvent | null | undefined,
): CommandResult {
  const payload = event?.payload ?? {};
  const status = `${payload.status ?? ""}`.trim();
  const exitCode = payload.exitCode;
  if (status === "declined") {
    return "declined";
  }
  if (
    status === "failed" ||
    (typeof exitCode === "number" &&
      Number.isFinite(exitCode) &&
      exitCode !== 0)
  ) {
    return "failed";
  }
  return "completed";
}

function finishedRunKind(event: TaskEvent) {
  const status = `${event.payload?.status ?? ""}`.trim();
  return FINISHED_STATUSES.includes(status) ? eventRunKind(event) : null;
}

function eventRunKind(event: TaskEvent): FinishedRunKind | null {
  if (isCommandEvent(event)) {
    return "command";
  }
  if (event.type === "tool_call") {
    return "tool-call";
  }
  return null;
}

function isEmptyReasoning(event: TaskEvent) {
  if (event.type !== "reasoning") {
    return false;
  }
  const payload = event.payload ?? {};
  return ![
    ...(Array.isArray(payload.summary) ? payload.summary : []),
    ...(Array.isArray(payload.content) ? payload.content : []),
  ].some((text) => `${text ?? ""}`.trim());
}

const SMALLEST_RUN_GROUP = 2;
const FINISHED_STATUSES = ["completed", "failed", "declined"];
