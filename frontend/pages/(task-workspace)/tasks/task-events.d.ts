// What TypeScript modules use from task-events.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { TaskEvent } from "#app/api.js";
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
