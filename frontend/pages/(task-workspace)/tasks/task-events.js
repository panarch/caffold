import { PROMPT_SUBMISSION_STATE } from "./runtime-state.js";
import { presentTaskFilePath } from "./task-format.js";

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
  return groups
    .map((group, index) => ({
      group,
      index,
      createdMs: conversationGroupCreatedMs(group),
    }))
    .sort(
      (left, right) =>
        left.createdMs - right.createdMs || left.index - right.index,
    )
    .map(({ group }) => group);
}

function conversationGroupCreatedMs(group) {
  if (group.kind !== "turn") {
    return group.event?.createdMs ?? 0;
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
  return substantive?.createdMs ?? 0;
}

export function eventTurnId(event) {
  const payload = event?.payload ?? {};
  return payload.turnId ?? payload.turn?.id ?? payload.params?.turnId ?? null;
}

export function isWorkEvent(event) {
  return [
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "task_failed",
    "approval_resolved",
  ].includes(event.type);
}

export function isTurnContinuationEvent(event) {
  return event.type === "work_status" || isWorkEvent(event) || isTurnStatusEvent(event);
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
  if (["final", "final_answer"].includes(phase)) {
    return "final";
  }
  if (phase === "commentary") {
    return "progress";
  }
  return null;
}

export function isFinalAssistantEvent(event) {
  return assistantMessagePhase(event?.payload?.phase ?? event?.payload?.item?.phase) === "final";
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
    if (
      event?.type !== "file_change" ||
      !Array.isArray(event.payload?.changes)
    ) {
      continue;
    }
    for (const change of event.payload.changes) {
      const presentation = presentTaskFilePath(
        typeof change === "string" ? change : change?.path,
        rootPath,
      );
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

export function upsertEvent(events, event) {
  return mergeEvents(events, [event]);
}

export function sortEventsChronologically(events) {
  return [...events].sort(
    (left, right) =>
      (left.createdMs ?? 0) - (right.createdMs ?? 0) ||
      (left.sortIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.sortIndex ?? Number.MAX_SAFE_INTEGER),
  );
}

export function mergeEvents(leftEvents, rightEvents) {
  const byId = new Map();
  for (const event of [...leftEvents, ...rightEvents]) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, mergeEventRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically(
    dedupeCanonicalEvents([...byId.values()]),
  );
}

export function reconcileCanonicalEvents(currentEvents, canonicalEvents) {
  const byId = new Map();
  for (const event of currentEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, mergeEventRecord(byId.get(key), event));
    }
  }
  for (const event of canonicalEvents) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, reconcileCanonicalEventRecord(byId.get(key), event));
    }
  }
  return sortEventsChronologically(
    dedupeCanonicalEvents([...byId.values()]),
  );
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

function mergeEventRecord(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  const createdMs = existing.createdMs;
  const sortIndex = existing.sortIndex ?? incoming.sortIndex;
  const existingUpdatedMs = existing.updatedMs ?? existing.createdMs ?? 0;
  const incomingUpdatedMs = incoming.updatedMs ?? incoming.createdMs ?? 0;
  const [latest, earlier] =
    incomingUpdatedMs >= existingUpdatedMs
      ? [incoming, existing]
      : [existing, incoming];
  const existingPayload = existing.payload ?? {};
  const incomingPayload = incoming.payload ?? {};
  const earlierPayload = earlier.payload ?? {};
  const latestPayload = latest.payload ?? {};
  const payload = { ...earlierPayload, ...latestPayload };
  if (existingPayload.item || incomingPayload.item) {
    payload.item = {
      ...(earlierPayload.item ?? {}),
      ...(latestPayload.item ?? {}),
    };
  }
  const updatedMs = Math.max(existingUpdatedMs, incomingUpdatedMs);
  return {
    ...earlier,
    ...latest,
    payload,
    createdMs,
    ...(sortIndex === undefined ? {} : { sortIndex }),
    ...(updatedMs > (createdMs ?? 0) ? { updatedMs } : {}),
  };
}

function reconcileCanonicalEventRecord(current, canonical) {
  if (!current) {
    return canonical;
  }
  const currentIsTransient = current.type === "work_status";
  const canonicalIsTransient = canonical.type === "work_status";
  if (currentIsTransient !== canonicalIsTransient) {
    // A lifecycle placeholder may be newer by wall-clock time, but it cannot
    // replace the useful projection for the same canonical item.
    return currentIsTransient ? canonical : current;
  }
  return mergeEventRecord(current, canonical);
}

export function optimisticUserMessageEvent(threadId, prompt, images, requestId) {
  const createdMs = Date.now();
  const content = [
    ...(prompt ? [{ type: "text", text: prompt }] : []),
    ...images.map((image) => ({
      type: "image",
      url: image.dataUrl,
      name: image.name,
    })),
  ];
  return {
    id: `local:user:${threadId}:${requestId}:${createdMs}`,
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      text: prompt,
      item: { content },
      optimistic: true,
      submissionState: PROMPT_SUBMISSION_STATE.SENDING,
    },
    createdMs,
  };
}

export function eventIdentityKey(event) {
  if (!event) {
    return "";
  }

  const payload = event.payload ?? {};
  const threadId = event.threadId ?? payload.threadId ?? "";
  const itemId = payload.itemId ?? payload.item?.id ?? "";
  if (itemId) {
    return ["item", threadId, eventTurnId(event) ?? "", itemId].join(":");
  }

  const approvalId = payload.approvalId ?? "";
  if (approvalId) {
    return ["approval", threadId, approvalId, event.type].join(":");
  }

  const turnId = eventTurnId(event);
  if (turnId && isTurnStatusEvent(event)) {
    return ["turn", threadId, turnId, event.type, payload.status ?? ""].join(":");
  }

  if (turnId && ["user_message", "assistant_message"].includes(event.type)) {
    const text =
      event.type === "user_message"
        ? userMessageText(payload)
        : `${payload.prompt ?? payload.text ?? ""}`.trim();
    if (text) {
      return ["message", threadId, turnId, event.type, text].join(":");
    }
  }

  return event.id ?? "";
}

export function dedupeCanonicalEvents(events) {
  const byKey = new Map();
  for (const event of removeSupersededOptimisticEvents(events)) {
    const key = canonicalEventKey(event) || eventIdentityKey(event);
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    byKey.set(key, preferStructuredEvent(existing, event));
  }
  return [...byKey.values()];
}

function removeSupersededOptimisticEvents(events) {
  const confirmedUserMessages = new Set();
  for (const event of events) {
    if (event?.type !== "user_message" || event.payload?.optimistic) {
      continue;
    }
    const fingerprint = userMessageFingerprint(event);
    if (fingerprint) {
      confirmedUserMessages.add(fingerprint);
    }
  }

  return events.filter((event) => {
    if (event?.type !== "user_message" || !event.payload?.optimistic) {
      return true;
    }
    return !confirmedUserMessages.has(userMessageFingerprint(event));
  });
}

export function userMessageFingerprint(event) {
  if (event?.type !== "user_message") {
    return "";
  }
  const payload = event.payload ?? {};
  const text = userMessageText(payload);
  const content = userMessageContent(payload);
  const images = content
    .filter((item) => ["image", "localImage"].includes(item?.type))
    .map((item) => imageInputFingerprint(item));
  if (!text && !images.length) {
    return "";
  }
  return JSON.stringify([event.threadId ?? "", text, images]);
}

function imageInputFingerprint(item) {
  if (item?.type === "localImage") {
    return `local:${item.path ?? ""}`;
  }
  const value = `${item?.url ?? ""}`;
  return `data:${value.length}:${value.slice(-64)}`;
}

function canonicalEventKey(event) {
  if (!event || !["user_message", "assistant_message"].includes(event.type)) {
    return "";
  }

  if (event.payload?.optimistic) {
    return event.id ?? "";
  }

  const payload = event.payload ?? {};
  const messageFingerprint =
    event.type === "user_message"
      ? userMessageFingerprint(event)
      : `${payload.prompt ?? payload.text ?? ""}`.trim();
  if (!messageFingerprint) {
    return "";
  }

  const threadId = event.threadId ?? payload.threadId ?? "";
  const turnId = eventTurnId(event);
  if (turnId) {
    const phase =
      event.type === "assistant_message"
        ? assistantMessagePhase(payload.phase ?? payload.item?.phase) ?? ""
        : "";
    return [
      "message",
      threadId,
      turnId,
      event.type,
      phase,
      messageFingerprint,
    ].join(":");
  }

  const createdMs = typeof event.createdMs === "number" ? event.createdMs : 0;
  const createdBucket = createdMs ? Math.floor(createdMs / 5000) : "";
  return ["message", threadId, event.type, messageFingerprint, createdBucket].join(":");
}

function preferStructuredEvent(existing, next) {
  if (!existing) {
    return next;
  }
  const existingScore = eventStructureScore(existing);
  const nextScore = eventStructureScore(next);
  if (nextScore !== existingScore) {
    return nextScore > existingScore ? next : existing;
  }
  return (next.createdMs ?? 0) >= (existing.createdMs ?? 0) ? next : existing;
}

function eventStructureScore(event) {
  const payload = event?.payload ?? {};
  return (
    [
      payload.itemId,
      payload.item?.id,
      payload.turnId,
      payload.threadId,
    ].filter(Boolean).length +
    (payload.lifecycle ? 2 : 0) +
    (event?.sortIndex === 0 ? 1 : 0)
  );
}

function userMessageText(payload) {
  const prompt = `${payload?.prompt ?? ""}`.trim();
  const payloadText = `${payload?.text ?? ""}`.trim();
  const content = userMessageContent(payload);
  const itemText = content
    .filter((item) => ["text", "input_text"].includes(item?.type))
    .map((item) => `${item?.text ?? ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  return normalizedUserMessageText(payloadText || prompt || itemText);
}

function userMessageContent(payload) {
  if (Array.isArray(payload?.content)) {
    return payload.content;
  }
  return Array.isArray(payload?.item?.content) ? payload.item.content : [];
}

function normalizedUserMessageText(text) {
  const isAmbientWrapper =
    text.includes("automatically supplied ambient UI state") ||
    text.includes("<in-app-browser-context") ||
    text.includes("# In app browser:");
  if (!isAmbientWrapper) {
    return text;
  }

  for (const marker of ["## My request for Codex:", "My request for Codex:"]) {
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return text.slice(markerIndex + marker.length).trim();
    }
  }
  return text;
}
