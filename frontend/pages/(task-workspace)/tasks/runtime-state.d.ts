// What TypeScript modules use from runtime-state.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { Task, TaskEvent, TaskThreadStatus } from "#app/api.js";

export const TASK_TRANSPORT_STATE: Readonly<{
  IDLE: "idle";
  CONNECTING: "connecting";
  READY: "ready";
  VALIDATING: "validating";
  RECONNECTING: "reconnecting";
  UNAVAILABLE: "unavailable";
}>;

export type TaskTransportState =
  (typeof TASK_TRANSPORT_STATE)[keyof typeof TASK_TRANSPORT_STATE];

// Any Task shape that carries the agent's status: a Task, or a Task as the
// Active list shows it.
type StatusOf = { threadStatus: TaskThreadStatus } | null;

// How a Task's status reads where it is shown. Only these four are shown; a
// Task in any other state shows none.
export interface TaskStatusView {
  status:
    | "running"
    | "waiting_for_approval"
    | "waiting_on_user_input"
    | "failed";
  label: string;
  // The Lucide icon name, or "" for the spinner of a running Task.
  icon: string;
}

export function taskThreadStatusType(task: StatusOf): string;

export function taskStatusKey(task: StatusOf): string;

export function taskStatusView(task: StatusOf): TaskStatusView | null;

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
