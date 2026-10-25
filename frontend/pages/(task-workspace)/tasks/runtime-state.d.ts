// What TypeScript modules use from runtime-state.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { Task, TaskEvent } from "#app/api.js";

// The values of `TASK_TRANSPORT_STATE`.
export type TaskTransportState =
  | "idle"
  | "connecting"
  | "ready"
  | "validating"
  | "reconnecting"
  | "unavailable";

export const PROMPT_SUBMISSION_STATE: Readonly<{
  UPLOADING: "uploading";
  SENDING: "sending";
  ACCEPTED: "accepted";
  OUTCOME_UNKNOWN: "outcomeUnknown";
  REJECTED: "rejected";
}>;

export type PromptSubmissionState =
  (typeof PROMPT_SUBMISSION_STATE)[keyof typeof PROMPT_SUBMISSION_STATE];

export function isTaskTransportStale(state: TaskTransportState): boolean;

export function isTaskActivelyWorking(task: Task | null): boolean;

export function taskActiveFlagLabel(task: Task | null): string | null;

export function promptSubmissionState(
  event: TaskEvent,
): PromptSubmissionState | null;
