// What TypeScript modules use from task-format.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { Task, TaskEvent, TaskEventPayload } from "#app/api.js";

// A path an agent reported, as a Task shows it: the file it names, the path
// as reported, and that path from the Task's root.
export interface TaskFilePath {
  fileIdentity: string;
  originalPath: string;
  displayPath: string;
}

export function cleanLogicalPath(path: string | null | undefined): string;

export function effectiveTaskFileRoot(task: Task | null): string;

export function toolCallPresentation(payload?: TaskEventPayload): {
  label: string;
  text: string;
  tone: "danger" | "neutral";
};

export function formatStatus(status: string | null | undefined): string;

export function formatDecision(decision: string): string;

export function formatDate(ms: number): string;

export function taskEventObservedMs(
  event: Pick<TaskEvent, "observedMs"> | null | undefined,
): number | null;

export function formatDuration(ms: number): string;

// The last segment of a Section's logical path, or "Directory".
export function sectionLabel(path: string | null | undefined): string;

// How long ago `ms` was: short text for a list cell and a spoken label.
export function formatRelativeAgePresentation(
  ms: number | null | undefined,
  now?: number,
): { text: string; label: string };
