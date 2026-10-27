import type {
  Task,
  TaskEvent,
  TaskEventPayload,
  TaskFileLink,
  TaskMessageContent,
  TaskUploadLine,
} from "#app/api.js";
import {
  isTaskActivelyWorking,
  type PromptSubmissionState,
  promptSubmissionState,
} from "#tasks/runtime-state.js";
import {
  type AssistantMessagePhase,
  assistantMessagePhase,
  type ConversationGroup,
  conversationGroups,
  dedupeCanonicalEvents,
  eventIdentityKey,
  fileChangePathPresentations,
  isFinalAssistantEvent,
  isTerminalTurnEvent,
  isTurnStatusEvent,
  isWorkEvent,
  sortEventsChronologically,
  taskEventAnchorMs,
  taskEventPositionIndex,
} from "#tasks/task-events.js";
import {
  effectiveTaskFileRoot,
  formatDate,
  formatDuration,
  formatStatus,
  type TaskFilePath,
  taskEventObservedMs,
  toolCallPresentation,
} from "#tasks/task-format.js";
import { activeTurnPresentation } from "./active-turn.js";
import {
  type CommandRunSegment,
  commandGroupIdentity,
  groupFinishedCommands,
} from "./command-runs.js";
import type { MessageAttachment } from "./components/message-attachments.js";

// The entries a conversation shows, in order, each with what it draws. An
// entry's `identity`, which comes from the backend's event identity, keeps its
// element while the conversation changes around it.
export type ConversationEntry =
  | StatusEntry
  | UserMessageEntry
  | GeneratedImageEntry
  | AssistantMessageEntry
  | ThinkingEntry
  | ToolEntry
  | CommandEntry
  | CommandGroupEntry
  | FileChangeEntry
  | TurnWorkEntry
  | ApprovalsEntry
  | ActiveTurnEntry;

interface EventEntry {
  identity: string;
  eventId: string;
  eventType: string;
  time: string;
}

export interface StatusEntry extends EventEntry {
  kind: "status";
  status: "danger" | "warning" | "muted";
  summary: string;
}

export interface UserMessageEntry extends EventEntry {
  kind: "user-message";
  text: string;
  attachments: MessageAttachment[];
  deliveryState: PromptSubmissionState | null;
  uploadLines: TaskUploadLine[];
}

export interface GeneratedImageEntry extends EventEntry {
  kind: "generated-image";
  attachments: MessageAttachment[];
}

export interface AssistantMessageEntry extends EventEntry {
  kind: "assistant-message";
  event: TaskEvent;
  phase: AssistantMessagePhase | null;
  turnCompletedMs: number | null;
}

export interface ThinkingEntry extends EventEntry {
  kind: "thinking";
  state: "active" | "complete";
  disclosureKey: string;
  text: string;
  threadId: string;
  fileLinks: TaskFileLink[];
}

export interface ToolEntry extends EventEntry {
  kind: "tool";
  label: string;
  text: string;
  tone: "danger" | "neutral";
}

export interface CommandEntry extends EventEntry {
  kind: "command";
  event: TaskEvent;
}

export interface CommandGroupEntry {
  kind: "command-group";
  identity: string;
  eventId: string;
  events: TaskEvent[];
}

export interface FileChangeEntry extends EventEntry {
  kind: "file-change";
  summary: string;
  files: TaskFilePath[];
}

export interface TurnWorkEntry {
  kind: "turn-work";
  identity: string;
  turnId: string;
  label: string;
  updateText: string;
  events: TaskEvent[];
  filePathPresentationBase: string;
}

export interface ApprovalsEntry {
  kind: "approvals";
  identity: string;
  requests: TaskEventPayload[];
}

export interface ActiveTurnEntry {
  kind: "active-turn";
  identity: string;
  turnId: string;
  startedMs: number | null;
  state: string;
}

type TurnGroup = Extract<ConversationGroup, { kind: "turn" }>;

interface EntryOptions {
  active?: boolean;
  messagePhase?: AssistantMessagePhase;
  turnCompletedMs?: number | null;
  filePathPresentationBase?: string;
}

interface PlacedEntry {
  entry: ConversationEntry;
  order: number;
}

export function conversationEntries(
  events: TaskEvent[],
  task: Task | null,
  approvals: TaskEvent[] = [],
  { controlsDisabled = false } = {},
): ConversationEntry[] {
  const filePathPresentationBase = effectiveTaskFileRoot(task);
  const conversationEvents = sortEventsChronologically(
    dedupeCanonicalEvents(events),
  );
  const groups = conversationGroups(conversationEvents);
  const liveStatusAvailable = !controlsDisabled;
  const activeGroupIndex = liveStatusAvailable
    ? activeTurnGroupIndex(groups, task)
    : -1;
  const eventOrder = new Map(
    conversationEvents.map((event, index) => [event, index]),
  );
  const placed = (entryEvents: TaskEvent[], entry: ConversationEntry | null) =>
    entry ? { entry, order: earliestOrder(entryEvents, eventOrder) } : null;
  const pendingApprovalIds = new Set(
    approvals.flatMap((event) => event.payload?.approvalId || []),
  );
  const userPrompts = new Set(
    conversationEvents
      .filter((event) => event.type === "user_message")
      .map((event) =>
        `${event.payload?.text ?? event.payload?.prompt ?? ""}`.trim(),
      )
      .filter(Boolean),
  );
  const entries = groups
    .flatMap((group, index): Array<PlacedEntry | null> => {
      if (group.kind === "turn") {
        return turnGroupEntries(group, task, {
          forceActive: index === activeGroupIndex,
          pendingApprovalIds,
          liveStatusAvailable,
          filePathPresentationBase,
        }).map(([entryEvents, entry]) => placed(entryEvents, entry));
      }
      if (
        group.event.type === "approval_requested" &&
        pendingApprovalIds.has(group.event.payload?.approvalId ?? "")
      ) {
        return [placed([group.event], approvalsEntry([group.event]))];
      }
      if (!shouldShowStandaloneEvent(group.event, userPrompts)) {
        return [];
      }
      return [
        placed(
          [group.event],
          conversationEventEntry(group.event, task, {
            active: false,
            filePathPresentationBase,
          }),
        ),
      ];
    })
    .filter((entry): entry is PlacedEntry => Boolean(entry))
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ entry }) => entry);
  if (liveStatusAvailable && isTaskActivelyWorking(task)) {
    const activeGroup = groups[activeGroupIndex];
    entries.push(
      activeTurnEntry(
        activeGroup?.kind === "turn"
          ? activeGroup
          : { turnId: task?.activeTurn?.id ?? "active-turn", events: [] },
        task,
      ),
    );
  }
  return entries;
}

// The entry one event draws on its own, outside a finished turn's work.
export function conversationEventEntry(
  event: TaskEvent,
  task: Task | null,
  options: EntryOptions = {},
): ConversationEntry {
  const payload = event.payload ?? {};
  if (event.type === "user_message") {
    return userMessageEntry(event);
  }
  if (event.type === "assistant_message") {
    return assistantMessageEntry(event, options);
  }
  if (event.type === "generated_image") {
    return generatedImageEntry(event);
  }
  if (event.type === "reasoning") {
    return thinkingEntry(event, reasoningText(payload), task, options);
  }
  if (event.type === "plan") {
    return toolEntry(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return { ...eventEntry(event), kind: "command", event };
  }
  if (event.type === "file_change") {
    return fileChangeEntry(event, options.filePathPresentationBase ?? "");
  }
  if (event.type === "tool_call") {
    const tool = toolCallPresentation(payload);
    return toolEntry(event, tool.label, tool.text, tool.tone);
  }
  if (event.type === "agent_failure") {
    return toolEntry(event, "Error", payload.text, "danger");
  }
  if (event.type === "task_failed") {
    return toolEntry(event, "Error", event.summary, "danger");
  }
  return statusEntry(event);
}

function activeTurnGroupIndex(groups: ConversationGroup[], task: Task | null) {
  if (!isTaskActivelyWorking(task)) {
    return -1;
  }
  const exactIndex = groups.findIndex(
    (group) => group.kind === "turn" && group.turnId === task?.activeTurn?.id,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const startedMs = Number(task?.activeTurn?.startedAtMs);
  if (!Number.isFinite(startedMs) || startedMs <= 0) {
    return -1;
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.kind !== "turn") {
      continue;
    }
    const hasCurrentEvent = group.events.some((event) => {
      const anchorMs = taskEventAnchorMs(event);
      return anchorMs !== null && anchorMs >= startedMs - 2_000;
    });
    if (hasCurrentEvent) {
      return index;
    }
  }
  return groups.findLastIndex((group) => group.kind === "turn");
}

// A turn's entries, each with the events it stands for: a finished turn shows
// its prompt, its work folded into one entry, and its answer; a turn still
// running shows each piece of work as it comes.
function turnGroupEntries(
  group: TurnGroup,
  task: Task | null,
  options: {
    forceActive: boolean;
    pendingApprovalIds: Set<string>;
    liveStatusAvailable: boolean;
    filePathPresentationBase: string;
  },
): Array<[TaskEvent[], ConversationEntry | null]> {
  const assistantEvents = group.events.filter(
    (event) => event.type === "assistant_message",
  );
  const terminalEvent = group.events
    .filter(isTurnStatusEvent)
    .find(isTerminalTurnEvent);
  const finalAssistantEvent =
    assistantEvents.findLast(isFinalAssistantEvent) ?? assistantEvents.at(-1);
  const isCurrentTurn = task?.activeTurn?.id === group.turnId;
  const isActive =
    options.liveStatusAvailable &&
    isTaskActivelyWorking(task) &&
    (options.forceActive || isCurrentTurn);
  const isComplete =
    Boolean(terminalEvent) ||
    (Boolean(
      finalAssistantEvent && isFinalAssistantEvent(finalAssistantEvent),
    ) &&
      !isActive);

  if (isComplete) {
    return completedTurnEntries(
      group,
      task,
      terminalEvent,
      finalAssistantEvent,
      options.pendingApprovalIds,
      options.filePathPresentationBase,
    );
  }

  return groupFinishedCommands(group.events, (event) =>
    isShownWhileTurnRuns(event, options.pendingApprovalIds),
  ).map((segment: CommandRunSegment) =>
    segment.group
      ? [segment.group, commandGroupEntry(segment.group)]
      : [
          [segment.event],
          runningTurnEntry(
            segment.event,
            task,
            options.pendingApprovalIds,
            options.filePathPresentationBase,
          ),
        ],
  );
}

function completedTurnEntries(
  group: TurnGroup,
  task: Task | null,
  terminalEvent: TaskEvent | undefined,
  finalAssistantEvent: TaskEvent | undefined,
  pendingApprovalIds: Set<string>,
  filePathPresentationBase: string,
): Array<[TaskEvent[], ConversationEntry | null]> {
  const output: Array<[TaskEvent[], ConversationEntry | null]> = [];
  const workEvents = group.events.filter(
    (event) =>
      isWorkEvent(event) ||
      (event.type === "assistant_message" && event !== finalAssistantEvent),
  );
  const approvals = group.events.filter(
    (event) =>
      event.type === "approval_requested" &&
      pendingApprovalIds.has(event.payload?.approvalId ?? ""),
  );
  const entryOf = (event: TaskEvent): [TaskEvent[], ConversationEntry] => [
    [event],
    conversationEventEntry(event, task, {
      active: false,
      filePathPresentationBase,
    }),
  ];

  output.push(
    ...group.events
      .filter((event) => event.type === "user_message")
      .map(entryOf),
  );
  const lastWork = workEvents.at(-1);
  if (lastWork) {
    output.push([
      [lastWork],
      turnWorkEntry(
        group,
        workEvents,
        terminalEvent,
        task,
        filePathPresentationBase,
      ),
    ]);
  }
  output.push(
    ...group.events
      .filter((event) => event.type === "generated_image")
      .map(entryOf),
  );
  // A failure stands on its own beside the messages: it is why nothing
  // happened, and must not need work details expanded to be seen.
  output.push(
    ...group.events
      .filter((event) => event.type === "agent_failure")
      .map(entryOf),
  );
  if (approvals.length > 0) {
    output.push([approvals, approvalsEntry(approvals)]);
  }
  if (finalAssistantEvent) {
    output.push([
      [finalAssistantEvent],
      conversationEventEntry(finalAssistantEvent, task, {
        active: false,
        messagePhase: "final",
        turnCompletedMs: taskEventObservedMs(terminalEvent),
        filePathPresentationBase,
      }),
    ]);
  }
  return output;
}

function runningTurnEntry(
  event: TaskEvent,
  task: Task | null,
  pendingApprovalIds: Set<string>,
  filePathPresentationBase: string,
) {
  if (!isShownWhileTurnRuns(event, pendingApprovalIds)) {
    return null;
  }
  if (event.type === "approval_requested") {
    return approvalsEntry([event]);
  }
  return conversationEventEntry(event, task, {
    active: isWorkEvent(event),
    filePathPresentationBase,
  });
}

// Whether an event of a turn not yet folded into work details is drawn as an
// entry of its own.
function isShownWhileTurnRuns(
  event: TaskEvent,
  pendingApprovalIds: Set<string>,
) {
  if (event.type === "approval_requested") {
    return pendingApprovalIds.has(event.payload?.approvalId ?? "");
  }
  return (
    event.type === "user_message" ||
    event.type === "assistant_message" ||
    event.type === "generated_image" ||
    // A failure stands beside the messages rather than folding into work
    // details: it is why nothing happened, and must not need expanding.
    event.type === "agent_failure" ||
    isWorkEvent(event)
  );
}

function shouldShowStandaloneEvent(event: TaskEvent, userPrompts: Set<string>) {
  if (event.type === "prompt_sent") {
    const prompt = `${
      event.payload?.prompt ?? event.payload?.text ?? ""
    }`.trim();
    return Boolean(prompt && !userPrompts.has(prompt));
  }
  return ![
    "thread_started",
    "turn_started",
    "turn_completed",
    "thread_status_changed",
    "approval_requested",
    "approval_resolved",
    "diff_updated",
    "tool_call",
  ].includes(event.type);
}

function activeTurnEntry(
  group: Pick<TurnGroup, "turnId" | "events">,
  task: Task | null,
): ActiveTurnEntry {
  const presentation = activeTurnPresentation(group.events, task);
  const threadId = task?.threadId ?? "";
  return {
    kind: "active-turn",
    identity: `active-turn:${threadId}:${group.turnId}`,
    turnId: group.turnId,
    ...presentation,
  };
}

function approvalsEntry(approvals: TaskEvent[]): ApprovalsEntry {
  const identity = `approvals:${JSON.stringify(
    approvals.map((approval) => approval.payload?.approvalId),
  )}`;
  return {
    kind: "approvals",
    identity,
    requests: approvals.map((approval) => approval.payload ?? {}),
  };
}

function eventEntry(event: TaskEvent): EventEntry {
  const observedMs = taskEventObservedMs(event);
  return {
    identity: eventIdentityKey(event) || event.id,
    eventId: event.id.trim(),
    eventType: event.type,
    time: observedMs === null ? "" : formatDate(observedMs),
  };
}

function statusEntry(event: TaskEvent): StatusEntry {
  return {
    ...eventEntry(event),
    kind: "status",
    status: statusTone(event.type),
    summary: event.summary,
  };
}

// A prompt, drawn by `caffold-task-user-message` from what it said and how far
// its delivery has got. The entry stays by identity while that changes, so an
// upload's progress and a picture's preview button survive each update.
function userMessageEntry(event: TaskEvent): ConversationEntry {
  const message = userMessagePresentation(event.payload ?? {});
  const text = message.text.trim();
  if (!text && !message.attachments.length) {
    return statusEntry(event);
  }
  return {
    ...eventEntry(event),
    kind: "user-message",
    text,
    attachments: message.attachments,
    deliveryState: promptSubmissionState(event),
    uploadLines: event.payload?.upload?.lines ?? [],
  };
}

// A picture the agent made, shown by the same list as a prompt's pictures.
function generatedImageEntry(event: TaskEvent): ConversationEntry {
  if (!event.payload?.available) {
    return statusEntry(event);
  }
  return {
    ...eventEntry(event),
    kind: "generated-image",
    attachments: [generatedImagePresentation(event)],
  };
}

// What the agent said, in whichever list the conversation is placing it.
// An inline message and the same message folded into a finished turn's work
// details are one component in two positions, so the card itself is owned by
// `caffold-task-assistant-message` rather than drawn here twice.
function assistantMessageEntry(
  event: TaskEvent,
  { messagePhase, turnCompletedMs = null }: EntryOptions,
): ConversationEntry {
  const suggestedPrompts = event.payload?.suggestedPrompts;
  if (
    !`${event.payload?.text ?? ""}`.trim() &&
    !(Array.isArray(suggestedPrompts) && suggestedPrompts.length)
  ) {
    return statusEntry(event);
  }
  return {
    ...eventEntry(event),
    kind: "assistant-message",
    event,
    phase: messagePhase ?? assistantMessagePhase(event.payload?.phase),
    turnCompletedMs,
  };
}

function thinkingEntry(
  event: TaskEvent,
  text: string,
  task: Task | null,
  { active }: EntryOptions,
): ConversationEntry {
  const value = text.trim();
  if (!value) {
    return statusEntry(event);
  }
  const identity = eventIdentityKey(event);
  return {
    ...eventEntry(event),
    kind: "thinking",
    state: (active ?? isTaskActivelyWorking(task)) ? "active" : "complete",
    disclosureKey: identity ? `thinking:${identity}` : "",
    text: value,
    threadId: event.threadId,
    fileLinks: event.fileLinks ?? [],
  };
}

function toolEntry(
  event: TaskEvent,
  label: string,
  text: string | undefined,
  tone: "danger" | "neutral" = "neutral",
): ConversationEntry {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return statusEntry(event);
  }
  return { ...eventEntry(event), kind: "tool", label, text: value, tone };
}

// The entry stands where the group's first entry stood, under that entry's
// event id, so a reader anchored on it keeps their place when the next command
// finishes beside it.
function commandGroupEntry(events: TaskEvent[]): CommandGroupEntry {
  const identity = commandGroupIdentity(events);
  return {
    kind: "command-group",
    identity,
    eventId: (events[0]?.id ?? "").trim(),
    events,
  };
}

function fileChangeEntry(
  event: TaskEvent,
  filePathPresentationBase: string,
): FileChangeEntry {
  const payload = event.payload ?? {};
  const count = Array.isArray(payload.paths) ? payload.paths.length : 0;
  const status = payload.status
    ? `Status: ${formatStatus(payload.status)}`
    : "";
  const summary = count === 1 ? "1 changed file" : `${count} changed files`;
  const identity =
    eventIdentityKey(event) ||
    [
      "file-change",
      event.threadId,
      taskEventAnchorMs(event),
      taskEventPositionIndex(event),
    ].join(":");
  return {
    ...eventEntry(event),
    identity,
    kind: "file-change",
    summary: status ? `${summary} · ${status}` : summary,
    files: fileChangePathPresentations([event], filePathPresentationBase),
  };
}

function turnWorkEntry(
  group: TurnGroup,
  workEvents: TaskEvent[],
  terminalEvent: TaskEvent | undefined,
  task: Task | null,
  filePathPresentationBase: string,
): TurnWorkEntry {
  const duration = turnDurationLabel(group.events, terminalEvent);
  const count = turnWorkItemCount(workEvents);
  const threadId = task?.threadId ?? workEvents[0]?.threadId ?? "";
  const identity = `${threadId}:turn-work:${turnGroupDisclosureIdentity(group)}`;
  return {
    kind: "turn-work",
    identity,
    turnId: group.turnId,
    label: duration ? `Worked for ${duration}` : "Work details",
    updateText: count === 1 ? "1 update" : `${count} updates`,
    events: [...workEvents],
    filePathPresentationBase,
  };
}

function turnGroupDisclosureIdentity(group: TurnGroup) {
  // A provider's turn id comes from the payload's unchecked JSON.
  const turnId = `${group.turnId}`.trim();
  if (turnId && !turnId.startsWith("implicit-")) {
    return turnId;
  }

  const eventId = group.events.map((event) => event.id.trim()).find(Boolean);
  return eventId || eventIdentityKey(group.events[0]) || turnId;
}

function turnWorkItemCount(events: TaskEvent[]) {
  let count = 0;
  let combinedType = "";
  for (const segment of groupFinishedCommands(events)) {
    const type = segment.event?.type ?? "";
    if (type === "reasoning" || type === "file_change") {
      if (combinedType !== type) {
        count += 1;
        combinedType = type;
      }
      continue;
    }
    combinedType = "";
    count += 1;
  }
  return count;
}

function turnDurationLabel(
  events: TaskEvent[],
  terminalEvent: TaskEvent | undefined,
) {
  const started = events.find((event) => event.type === "turn_started");
  const startMs = taskEventAnchorMs(started ?? events[0]);
  const endMs = taskEventAnchorMs(terminalEvent ?? events.at(-1));
  if (startMs === null || endMs === null || endMs <= startMs) {
    return "";
  }
  return formatDuration(endMs - startMs);
}

function reasoningText(payload: TaskEventPayload) {
  const summary = Array.isArray(payload.summary)
    ? payload.summary.filter(Boolean).join("\n\n")
    : "";
  const content = Array.isArray(payload.content)
    ? payload.content.filter(Boolean).join("\n\n")
    : "";
  return [summary, content].filter(Boolean).join("\n\n");
}

function userMessagePresentation(payload: TaskEventPayload) {
  const content = userMessageContent(payload);
  const text = userMessageText(payload);
  const imageItems = content.filter(
    (item) => item.type === "image" || item.type === "localImage",
  );

  if (!imageItems.length) {
    return { text, attachments: [] };
  }

  const parsed = parseCodexAttachmentPrompt(text);
  const names = parsed?.fileNames ?? [];
  return {
    text: parsed?.request ?? text,
    attachments: imageItems.map((item, index) => ({
      src: taskImageSource(item),
      name: item.name ?? names[index] ?? `Attached image ${index + 1}`,
    })),
  };
}

function generatedImagePresentation(event: TaskEvent): MessageAttachment {
  const payload = event.payload ?? {};
  const { threadId } = event;
  const itemId = `${payload.itemId ?? ""}`.trim();
  const src =
    threadId && itemId
      ? `/api/tasks/${encodeURIComponent(threadId)}/generated-images/${encodeURIComponent(itemId)}`
      : "";
  return {
    src,
    name: `${payload.name ?? "Generated image.png"}`.trim(),
  };
}

function userMessageText(payload: TaskEventPayload) {
  const prompt = `${payload.prompt ?? ""}`.trim();
  const payloadText = `${payload.text ?? ""}`.trim();
  const itemText = userMessageContent(payload)
    .filter((item) => item.type === "text" || item.type === "input_text")
    .map((item) => `${item.text ?? ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  return normalizedUserMessageText(payloadText || prompt || itemText);
}

function userMessageContent(payload: TaskEventPayload): TaskMessageContent[] {
  return Array.isArray(payload.content)
    ? payload.content.filter(
        (item): item is TaskMessageContent =>
          typeof item === "object" && item !== null,
      )
    : [];
}

function normalizedUserMessageText(text: string) {
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

function taskImageSource(item: TaskMessageContent) {
  if (item.type === "image") {
    return safeTaskImageSource(item.url);
  }
  if (item.type !== "localImage") {
    return "";
  }
  const path = `${item.path ?? ""}`.trim();
  if (!path.startsWith("/")) {
    return "";
  }
  return `/api/task-image?${new URLSearchParams({ path })}`;
}

function safeTaskImageSource(value: string | undefined) {
  const source = `${value ?? ""}`.trim();
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(source)
    ? source
    : "";
}

function parseCodexAttachmentPrompt(text: string) {
  const filesMarker = /^# Files mentioned by the user:\s*$/m;
  const requestMarker = /^## My request for Codex:\s*$/m;
  const filesMatch = filesMarker.exec(text);
  const requestMatch = requestMarker.exec(text);
  if (!filesMatch || !requestMatch || requestMatch.index <= filesMatch.index) {
    return null;
  }

  const fileSection = text.slice(
    filesMatch.index + filesMatch[0].length,
    requestMatch.index,
  );
  const fileNames = Array.from(
    fileSection.matchAll(/^##\s+(.+?):\s+\/.*$/gm),
    (match) => match[1].trim(),
  ).filter((name) => /\.(?:avif|gif|jpe?g|png|webp)$/i.test(name));
  const request = text
    .slice(requestMatch.index + requestMatch[0].length)
    .trim();

  return { fileNames, request };
}

function earliestOrder(
  events: TaskEvent[],
  eventOrder: Map<TaskEvent, number>,
) {
  return events.reduce(
    (earliest, event) => Math.min(earliest, eventOrder.get(event) ?? earliest),
    Number.MAX_SAFE_INTEGER,
  );
}

function statusTone(type: string) {
  if (type === "task_failed" || type === "turn_interrupted") {
    return "danger";
  }
  if (type === "approval_requested") {
    return "warning";
  }
  return "muted";
}
