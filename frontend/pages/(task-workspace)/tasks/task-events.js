import { PROMPT_SUBMISSION_STATE } from "./runtime-state.js";
import {
  presentTaskFilePath,
  taskEventObservedMs,
} from "./task-format.js";

export function conversationGroups(events) {
  const groups = [];
  const turns = new Map();
  let activeGroup = null;

  const createImplicitTurnGroup = () => {
    const group = { kind: "turn", turnId: `implicit-${groups.length}`, events: [] };
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
      if (isImplicitTurnEvent(event) && canAcceptTurnContinuation(activeGroup)) {
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
  if (positionedGroups.some(({ position }) => position === null)) {
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

function conversationGroupPosition(group) {
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
        event.type !== "turn_started" &&
        event.type !== "thread_status_changed",
    ) ??
    group.events[0];
  return taskEventPosition(substantive);
}

export function taskEventPosition(event) {
  const anchorMs = event?.position?.anchorMs;
  const index = event?.position?.index;
  return Number.isSafeInteger(anchorMs) &&
    anchorMs >= 0 &&
    Number.isSafeInteger(index) &&
    index >= 0
    ? { anchorMs, index }
    : null;
}

export function taskEventAnchorMs(event) {
  return taskEventPosition(event)?.anchorMs ?? null;
}

export function taskEventPositionIndex(event) {
  return taskEventPosition(event)?.index ?? null;
}

export function eventTurnId(event) {
  return event?.payload?.turnId ?? null;
}

export function isWorkEvent(event) {
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

export function isTurnContinuationEvent(event) {
  return isWorkEvent(event) || isTurnStatusEvent(event);
}

export function isImplicitTurnEvent(event) {
  return (
    ["assistant_message", "generated_image"].includes(event.type) ||
    isTurnContinuationEvent(event)
  );
}

export function canAcceptTurnContinuation(group) {
  if (!group || group.kind !== "turn") {
    return false;
  }
  const events = group.events ?? [];
  return !events.some((event) => isTerminalTurnEvent(event));
}

export function isTurnStatusEvent(event) {
  return [
    "turn_started",
    "turn_completed",
    "turn_interrupted",
    "approval_resolved",
    "diff_updated",
  ].includes(event.type);
}

export function isTerminalTurnEvent(event) {
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

export function assistantMessagePhase(phase) {
  return ["final", "progress"].includes(phase) ? phase : null;
}

export function isFinalAssistantEvent(event) {
  return assistantMessagePhase(event?.payload?.phase) === "final";
}

export function pendingApprovals(events) {
  const pending = new Map();
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

export function fileChangePathPresentations(events, rootPath = "") {
  const presentationsByFileIdentity = new Map();
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
        presentationsByFileIdentity.set(presentation.fileIdentity, presentation);
      }
    }
  }
  return [...presentationsByFileIdentity.values()];
}

export function upsertLiveEvent(events, event) {
  return advanceLiveEvents(events, [event]);
}

export function sortEventsChronologically(events) {
  const positionedEvents = events.map((event) => ({
    event,
    position: taskEventPosition(event),
  }));
  if (positionedEvents.some(({ position }) => position === null)) {
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

// Apply reports from the current live projection. Exact identity is the only
// join evidence. Once an item is terminal, a conflicting live status cannot
// replace it; a canonical Detail snapshot owns any correction between terminal
// outcomes. Otherwise the incoming report owns conflicting mutable fields
// while the first observed conversation position remains stable.
export function advanceLiveEvents(currentEvents, liveEvents) {
  const byId = new Map();
  for (const event of [...currentEvents, ...liveEvents]) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, advanceLiveEventRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically([...byId.values()]);
}

// A refreshed Detail snapshot owns every conflicting projected field and the
// conversation position for each exact identity it contains. Current records
// may fill fields Detail omitted, while identities absent from Detail remain
// visible where the backend projection last placed them.
export function reconcileDetailEvents(currentEvents, detailEvents) {
  const byId = new Map();
  for (const event of currentEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, advanceLiveEventRecord(byId.get(key), event));
    }
  }
  for (const event of detailEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, applyCanonicalDetailRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically([...byId.values()]);
}

// An optimistic request has no provider identity yet. Keep it as a separate
// local overlay until the adapter returns the exact handoff identity.
export function appendOptimisticEvent(events, optimisticEvent) {
  return sortEventsChronologically([...events, optimisticEvent]);
}

// Older Detail pages extend the visible transcript but cannot replace an
// exact current projection at the cursor boundary.
export function prependDetailEvents(currentEvents, olderDetailEvents) {
  const byId = new Map();
  for (const event of olderDetailEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, applyCanonicalDetailRecord(byId.get(key), event));
    }
  }
  for (const event of currentEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, projectPrimaryEvent(event, byId.get(key), event.position));
    }
  }
  return sortEventsChronologically([...byId.values()]);
}

// Once the prompt response or first provider projection proves which exact
// item an optimistic submission became, keep the position already visible in
// this browser. A later Detail reconciliation still replaces it with provider
// history position.
export function handoffOptimisticSubmission(
  events,
  optimisticEventId,
  confirmedEvent,
) {
  const optimistic = events.find((event) => event.id === optimisticEventId);
  const confirmedIdentity = eventIdentityKey(confirmedEvent);
  if (!optimistic || !confirmedIdentity) {
    return events;
  }
  const existingConfirmed = events.find(
    (event) => eventIdentityKey(event) === confirmedIdentity,
  );
  const confirmed = advanceLiveEventRecord(existingConfirmed, confirmedEvent);
  const latestUpdateMs = latestTaskEventUpdateMs(confirmed, optimistic);
  const handedOff = projectPrimaryEvent(
    confirmed,
    null,
    optimistic.position,
    { updatedMs: latestUpdateMs },
  );
  const remaining = events.filter(
    (event) =>
      event.id !== optimisticEventId &&
      eventIdentityKey(event) !== confirmedIdentity,
  );
  return sortEventsChronologically([...remaining, handedOff]);
}

export function mergeTaskEventsPage(currentPage, detail) {
  const incomingPage = detail?.eventsPage;
  if (!incomingPage) {
    return currentPage ?? { nextCursor: null };
  }
  if (
    detail?.historyLoading &&
    !incomingPage.nextCursor &&
    currentPage?.nextCursor
  ) {
    return currentPage;
  }
  return incomingPage;
}

function advanceLiveEventRecord(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  const incomingOwns = !liveReportConflictsWithTerminal(existing, incoming);
  return incomingOwns
    ? projectPrimaryEvent(incoming, existing, existing.position)
    : projectPrimaryEvent(existing, incoming, existing.position);
}

function applyCanonicalDetailRecord(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  return projectPrimaryEvent(incoming, existing, incoming.position);
}

function projectPrimaryEvent(
  primary,
  supplemental,
  position,
  { updatedMs = latestTaskEventUpdateMs(primary, supplemental) } = {},
) {
  const {
    position: _primaryPosition,
    updatedMs: _primaryUpdatedMs,
    ...primaryFields
  } = primary;
  const {
    position: _supplementalPosition,
    updatedMs: _supplementalUpdatedMs,
    ...supplementalFields
  } = supplemental ?? {};
  const carriesObservedTime = [primary, supplemental].some(
    (event) => event && Object.prototype.hasOwnProperty.call(event, "observedMs"),
  );
  const observedTimes = [primary, supplemental]
    .map(taskEventObservedMs)
    .filter((value) => value !== null);
  const observedMs = observedTimes.length ? Math.min(...observedTimes) : null;
  const payload = {
    ...(supplemental?.payload ?? {}),
    ...(primary?.payload ?? {}),
  };
  const anchorMs = taskEventAnchorMs({ position });
  const carriesUpdatedMs =
    updatedMs !== null && anchorMs !== null && updatedMs > anchorMs;
  return {
    ...supplementalFields,
    ...primaryFields,
    payload,
    position,
    ...(carriesObservedTime ? { observedMs } : {}),
    ...(carriesUpdatedMs ? { updatedMs } : {}),
  };
}

function liveReportConflictsWithTerminal(existing, incoming) {
  const existingStatus = existing?.payload?.status;
  if (!TERMINAL_ACTIVITY_STATUSES.has(existingStatus)) {
    return false;
  }
  return incoming?.payload?.status !== existingStatus;
}

const TERMINAL_ACTIVITY_STATUSES = new Set([
  "completed",
  "failed",
  "declined",
]);

function taskEventUpdateMs(event) {
  const updatedMs = event?.updatedMs;
  return Number.isSafeInteger(updatedMs) && updatedMs >= 0
    ? updatedMs
    : taskEventAnchorMs(event);
}

function latestTaskEventUpdateMs(...events) {
  const values = events
    .map(taskEventUpdateMs)
    .filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

export function optimisticUserMessageEvent(threadId, prompt, images, requestId) {
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
      submissionState: PROMPT_SUBMISSION_STATE.SENDING,
    },
    position: { anchorMs, index: 0 },
    observedMs: anchorMs,
  };
}

export function eventIdentityKey(event) {
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
    return ["turn", threadId, turnId, event.type, payload.status ?? ""].join(":");
  }

  // Text is presentation, not identity. A sparse event with no item id keeps
  // its own event id. Two equal messages are otherwise indistinguishable from
  // one message reported twice, and the frontend has no evidence with which to
  // choose either interpretation.
  return event.id ?? "";
}

export function dedupeCanonicalEvents(events) {
  const byIdentity = new Map();
  for (const event of events) {
    const identity = eventIdentityKey(event);
    if (!identity) {
      continue;
    }
    byIdentity.set(
      identity,
      advanceLiveEventRecord(byIdentity.get(identity), event),
    );
  }
  return [...byIdentity.values()];
}
