// What TypeScript modules use from task-events.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type {
  TaskEvent,
  TaskEventPosition,
  TaskEventsRange,
} from "#app/api.js";
import type { TaskFilePath } from "./task-format.js";

// A turn's events in conversation order, or an event outside any turn.
export type ConversationGroup =
  | { kind: "turn"; turnId: string; events: TaskEvent[] }
  | { kind: "event"; event: TaskEvent };

export type AssistantMessagePhase = "final" | "progress";

export function conversationGroups(events: TaskEvent[]): ConversationGroup[];

export function dedupeCanonicalEvents(events: TaskEvent[]): TaskEvent[];

export function sortEventsChronologically(events: TaskEvent[]): TaskEvent[];

export function pendingApprovals(events: TaskEvent[]): TaskEvent[];

export function eventIdentityKey(event: TaskEvent | null | undefined): string;

export function fileChangePathPresentations(
  events: TaskEvent[],
  rootPath?: string,
): TaskFilePath[];

export function isWorkEvent(event: TaskEvent): boolean;

export function isTurnStatusEvent(event: TaskEvent): boolean;

export function isTerminalTurnEvent(event: TaskEvent): boolean;

export function isFinalAssistantEvent(
  event: TaskEvent | null | undefined,
): boolean;

export function taskEventAnchorMs(
  event: TaskEvent | null | undefined,
): number | null;

export function taskEventPositionIndex(
  event: TaskEvent | null | undefined,
): number | null;

export function assistantMessagePhase(
  phase: string | null | undefined,
): AssistantMessagePhase | null;

export function taskEventPosition(
  event: TaskEvent | null | undefined,
): TaskEventPosition | null;

export function applyProjectionDelta(
  events: TaskEvent[],
  event: TaskEvent,
): TaskEvent[];

export function appendOptimisticEvent(
  events: TaskEvent[],
  optimisticEvent: TaskEvent,
): TaskEvent[];

// A Detail answer's items laid over the retained ones: inside `range` the
// answer owns membership, outside it only the identities it repeats.
export function applyDetailRange(
  retainedEvents: TaskEvent[],
  detailEvents: TaskEvent[],
  range: TaskEventsRange | null,
): TaskEvent[];

// The prompt this browser sent, in place of its local stand-in, at the
// position the confirmed item has.
export function handoffOptimisticSubmission(
  events: TaskEvent[],
  optimisticEventId: string,
  confirmedEvent: TaskEvent,
): TaskEvent[];

export function optimisticUserMessageEvent(
  threadId: string,
  prompt: string,
  images: Array<{ dataUrl: string; name: string }>,
  requestId: string | number,
  uploadPaths?: string[],
): TaskEvent;
