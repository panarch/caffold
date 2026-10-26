import type {
  TaskEvent,
  TaskEventPosition,
  TaskEventsRange,
} from "#app/api.ts";
import { PROMPT_SUBMISSION_STATE } from "./runtime-state.ts";
import {
  presentTaskFilePath,
  type TaskFilePath,
  taskEventObservedMs,
} from "./task-format.ts";

// A turn's events in conversation order, or an event outside any turn.
export type ConversationGroup =
  | { kind: "turn"; turnId: string; events: TaskEvent[] }
  | { kind: "event"; event: TaskEvent };

type TurnGroup = Extract<ConversationGroup, { kind: "turn" }>;

export type AssistantMessagePhase = "final" | "progress";

export function conversationGroups(events: TaskEvent[]) {
  const groups: ConversationGroup[] = [];
  const turns = new Map<string, TurnGroup>();
  let activeGroup: TurnGroup | null = null;

  const createImplicitTurnGroup = () => {
    const group: TurnGroup = {
      kind: "turn",
      turnId: `implicit-${groups.length}`,
      events: [],
    };
    groups.push(group);
    activeGroup = group;
    return group;
  };

  for (const event of events) {
    const turnId = eventTurnId(event);
    if (!turnId) {
      if (event.type === "user_message") {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      if (
        isImplicitTurnEvent(event) &&
        canAcceptTurnContinuation(activeGroup)
      ) {
        activeGroup.events.push(event);
        continue;
      }
      if (isImplicitTurnEvent(event)) {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      groups.push({ kind: "event", event });
      continue;
    }

    let group = turns.get(turnId);
    if (!group) {
      group = { kind: "turn", turnId, events: [] };
      turns.set(turnId, group);
      groups.push(group);
    }
    group.events.push(event);
    activeGroup = isTerminalTurnEvent(event) ? null : group;
  }
  const positionedGroups = groups.map((group, index) => ({
    group,
    index,
    position: conversationGroupPosition(group),
  }));
  if (!allPositioned(positionedGroups)) {
    return positionedGroups.map(({ group }) => group);
  }
  return positionedGroups
    .sort(
      (left, right) =>
        left.position.anchorMs - right.position.anchorMs ||
        left.position.index - right.position.index ||
        left.index - right.index,
    )
    .map(({ group }) => group);
}

function conversationGroupPosition(group: ConversationGroup) {
  if (group.kind !== "turn") {
    return taskEventPosition(group.event);
  }
  const message = group.events.find((event) =>
    ["user_message", "assistant_message", "generated_image"].includes(
      event.type,
    ),
  );
  const substantive =
    message ??
    group.events.find(
      (event) =>
        event.type !== "turn_started" && event.type !== "thread_status_changed",
    ) ??
    group.events[0];
  return taskEventPosition(substantive);
}

export function taskEventPosition(
  event: TaskEvent | null | undefined,
): TaskEventPosition | null {
  const anchorMs = event?.position?.anchorMs;
  const index = event?.position?.index;
  return isPositionNumber(anchorMs) && isPositionNumber(index)
    ? { anchorMs, index }
    : null;
}

function isPositionNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function allPositioned<T extends { position: TaskEventPosition | null }>(
  entries: T[],
): entries is Array<T & { position: TaskEventPosition }> {
  return entries.every(({ position }) => position !== null);
}

export function taskEventAnchorMs(event: TaskEvent | null | undefined) {
  return taskEventPosition(event)?.anchorMs ?? null;
}

export function taskEventPositionIndex(event: TaskEvent | null | undefined) {
  return taskEventPosition(event)?.index ?? null;
}

export function eventTurnId(event: TaskEvent | null | undefined) {
  return event?.payload?.turnId ?? null;
}

export function isWorkEvent(event: TaskEvent) {
  return [
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "tool_call",
    "task_failed",
    "approval_resolved",
  ].includes(event.type);
}

export function isTurnContinuationEvent(event: TaskEvent) {
  return isWorkEvent(event) || isTurnStatusEvent(event);
}

export function isImplicitTurnEvent(event: TaskEvent) {
  return (
    ["assistant_message", "generated_image"].includes(event.type) ||
    isTurnContinuationEvent(event)
  );
}

export function canAcceptTurnContinuation(
  group: ConversationGroup | null | undefined,
): group is TurnGroup {
  if (group?.kind !== "turn") {
    return false;
  }
  const events = group.events ?? [];
  return !events.some((event) => isTerminalTurnEvent(event));
}

export function isTurnStatusEvent(event: TaskEvent) {
  return [
    "turn_started",
    "turn_completed",
    "turn_interrupted",
    "approval_resolved",
    "diff_updated",
  ].includes(event.type);
}

export function isTerminalTurnEvent(event: TaskEvent) {
  if (!isTurnStatusEvent(event)) {
    return false;
  }
  const status = event.payload?.status ?? event.type;
  return (
    event.type === "turn_completed" ||
    event.type === "turn_interrupted" ||
    ["completed", "failed", "interrupted"].includes(status)
  );
}

export function assistantMessagePhase(
  phase: string | null | undefined,
): AssistantMessagePhase | null {
  return phase === "final" || phase === "progress" ? phase : null;
}

export function isFinalAssistantEvent(event: TaskEvent | null | undefined) {
  return assistantMessagePhase(event?.payload?.phase) === "final";
}

export function pendingApprovals(events: TaskEvent[]) {
  const pending = new Map<string, TaskEvent>();
  for (const event of events) {
    const approvalId = event.payload?.approvalId;
    if (!approvalId) {
      continue;
    }
    if (event.type === "approval_requested") {
      pending.set(approvalId, event);
    } else if (event.type === "approval_resolved") {
      pending.delete(approvalId);
    }
  }
  return [...pending.values()];
}

export function fileChangePathPresentations(
  events: TaskEvent[],
  rootPath = "",
) {
  const presentationsByFileIdentity = new Map<string, TaskFilePath>();
  for (const event of events) {
    if (event?.type !== "file_change" || !Array.isArray(event.payload?.paths)) {
      continue;
    }
    for (const path of event.payload.paths) {
      const presentation = presentTaskFilePath(path, rootPath);
      if (
        presentation.displayPath &&
        !presentationsByFileIdentity.has(presentation.fileIdentity)
      ) {
        presentationsByFileIdentity.set(
          presentation.fileIdentity,
          presentation,
        );
      }
    }
  }
  return [...presentationsByFileIdentity.values()];
}

export function applyProjectionDelta(events: TaskEvent[], event: TaskEvent) {
  return applyProjectionDeltas(events, [event]);
}

export function sortEventsChronologically(events: TaskEvent[]) {
  const positionedEvents = events.map((event) => ({
    event,
    position: taskEventPosition(event),
  }));
  if (!allPositioned(positionedEvents)) {
    return [...events];
  }
  return positionedEvents
    .sort(
      (left, right) =>
        left.position.anchorMs - right.position.anchorMs ||
        left.position.index - right.position.index,
    )
    .map(({ event }) => event);
}

// Apply backend projection patches in accepted publication order. Exact
// identity is the only join evidence. An existing item keeps its backend-owned
// placement while the incoming patch owns conflicting projected fields.
export function applyProjectionDeltas(
  currentEvents: TaskEvent[],
  deltas: TaskEvent[],
) {
  const byId = new Map<string, TaskEvent>();
  for (const event of [...currentEvents, ...deltas]) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, applyProjectionDeltaRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically([...byId.values()]);
}

// An optimistic request has no provider identity yet. Keep it as a separate
// local overlay until the adapter returns the exact handoff identity.
export function appendOptimisticEvent(
  events: TaskEvent[],
  optimisticEvent: TaskEvent,
) {
  return sortEventsChronologically([...events, optimisticEvent]);
}

function comparePositions(left: TaskEventPosition, right: TaskEventPosition) {
  return left.anchorMs - right.anchorMs || left.index - right.index;
}

function positionWithinRange(
  position: TaskEventPosition | null,
  range: TaskEventsRange,
) {
  if (!position) {
    return false;
  }
  return (
    (!range.from || comparePositions(position, range.from) >= 0) &&
    (!range.to || comparePositions(position, range.to) <= 0)
  );
}

// A Detail answer owns projection membership only within the extent it
// declares: retained records inside it are replaced by what the answer
// contains, and everything outside it stays as it is, including an identity
// the answer repeats from beyond its extent. An answer without an extent owns
// nothing beyond its own records and updates those by exact identity. An
// optimistic submission is a local overlay that no extent covers.
export function applyDetailRange(
  retainedEvents: TaskEvent[],
  detailEvents: TaskEvent[],
  range: TaskEventsRange | null,
) {
  const byId = new Map<string, TaskEvent>();
  const keptOutside = new Set<string>();
  for (const event of retainedEvents) {
    const key = eventIdentityKey(event);
    if (!key) {
      continue;
    }
    const owned =
      !!range &&
      !event.payload?.optimistic &&
      positionWithinRange(taskEventPosition(event), range);
    if (owned) {
      continue;
    }
    byId.set(key, event);
    if (range) {
      keptOutside.add(key);
    }
  }
  for (const event of detailEvents) {
    const key = eventIdentityKey(event);
    if (key && !keptOutside.has(key)) {
      byId.set(key, applyCanonicalDetailRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically([...byId.values()]);
}

// Once the prompt response or first provider projection proves which exact
// item an optimistic submission became, use its backend-owned position. The
// local placeholder's clock cannot order a confirmed item against an answer
// that arrived through a different request or stream.
export function handoffOptimisticSubmission(
  events: TaskEvent[],
  optimisticEventId: string,
  confirmedEvent: TaskEvent,
) {
  const optimistic = events.find((event) => event.id === optimisticEventId);
  const confirmedIdentity = eventIdentityKey(confirmedEvent);
  if (!optimistic || !confirmedIdentity) {
    return events;
  }
  const existingConfirmed = events.find(
    (event) => eventIdentityKey(event) === confirmedIdentity,
  );
  const confirmed = applyProjectionDeltaRecord(
    existingConfirmed,
    confirmedEvent,
  );
  const handedOff = projectPrimaryEvent(confirmed, null, confirmed.position);
  const remaining = events.filter(
    (event) =>
      event.id !== optimisticEventId &&
      eventIdentityKey(event) !== confirmedIdentity,
  );
  return sortEventsChronologically([...remaining, handedOff]);
}

function applyProjectionDeltaRecord(
  existing: TaskEvent | undefined,
  incoming: TaskEvent,
) {
  if (!existing) {
    return incoming;
  }
  return projectPrimaryEvent(incoming, existing, existing.position);
}

function applyCanonicalDetailRecord(
  existing: TaskEvent | undefined,
  incoming: TaskEvent,
) {
  if (!existing) {
    return incoming;
  }
  return projectPrimaryEvent(incoming, existing, incoming.position);
}

function projectPrimaryEvent(
  primary: TaskEvent,
  supplemental: TaskEvent | null | undefined,
  position: TaskEventPosition,
): TaskEvent {
  const { position: _primaryPosition, ...primaryFields } = primary;
  const { position: _supplementalPosition, ...supplementalFields } =
    supplemental ?? ({} as Partial<TaskEvent>);
  const carriesObservedTime = [primary, supplemental].some(
    (event) => event && Object.hasOwn(event, "observedMs"),
  );
  const observedTimes = [primary, supplemental]
    .map(taskEventObservedMs)
    .filter((value): value is number => value !== null);
  const observedMs = observedTimes.length ? Math.min(...observedTimes) : null;
  const payload = {
    ...(supplemental?.payload ?? {}),
    ...(primary?.payload ?? {}),
  };
  return {
    ...supplementalFields,
    ...primaryFields,
    payload,
    position,
    ...(carriesObservedTime ? { observedMs } : {}),
  };
}

// `uploadPaths` are the files the prompt's words list, still on their way up;
// the conversation shows each one's progress on its own line of that list.
export function optimisticUserMessageEvent(
  threadId: string,
  prompt: string,
  images: Array<{ dataUrl: string; name: string }>,
  requestId: string | number,
  uploadPaths: string[] = [],
): TaskEvent {
  const anchorMs = Date.now();
  const content = [
    ...(prompt ? [{ type: "text", text: prompt }] : []),
    ...images.map((image) => ({
      type: "image",
      url: image.dataUrl,
      name: image.name,
    })),
  ];
  return {
    id: `local:user:${threadId}:${requestId}:${anchorMs}`,
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      text: prompt,
      content,
      optimistic: true,
      submissionState: uploadPaths.length
        ? PROMPT_SUBMISSION_STATE.UPLOADING
        : PROMPT_SUBMISSION_STATE.SENDING,
      ...(uploadPaths.length
        ? {
            upload: {
              lines: uploadPaths.map((path) => ({ path, done: false })),
            },
          }
        : {}),
    },
    position: { anchorMs, index: 0 },
    observedMs: anchorMs,
  };
}

export function eventIdentityKey(event: TaskEvent | null | undefined) {
  if (!event) {
    return "";
  }

  const payload = event.payload ?? {};
  const threadId = event.threadId ?? payload.threadId ?? "";

  // An approval names the item it is asking about, but it is not that item:
  // the question and the work are two entries, and answering one of them is
  // what lets the other proceed.
  const approvalId = payload.approvalId ?? "";
  if (approvalId) {
    return ["approval", threadId, approvalId, event.type].join(":");
  }

  const itemId = payload.itemId ?? "";
  if (itemId) {
    return ["item", threadId, eventTurnId(event) ?? "", itemId].join(":");
  }

  const turnId = eventTurnId(event);
  if (turnId && isTurnStatusEvent(event)) {
    return ["turn", threadId, turnId, event.type, payload.status ?? ""].join(
      ":",
    );
  }

  // Text is presentation, not identity. A sparse event with no item id keeps
  // its own event id. Two equal messages are otherwise indistinguishable from
  // one message reported twice, and the frontend has no evidence with which to
  // choose either interpretation.
  return event.id ?? "";
}

export function dedupeCanonicalEvents(events: TaskEvent[]) {
  const byIdentity = new Map<string, TaskEvent>();
  for (const event of events) {
    const identity = eventIdentityKey(event);
    if (!identity) {
      continue;
    }
    byIdentity.set(
      identity,
      applyProjectionDeltaRecord(byIdentity.get(identity), event),
    );
  }
  return [...byIdentity.values()];
}
