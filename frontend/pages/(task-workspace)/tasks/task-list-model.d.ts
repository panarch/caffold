// What TypeScript modules use from task-list-model.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

import type { ActiveTask, ActiveTaskRecovery, Task } from "#app/api.js";

// A Task as the Task list holds it: the Active list's own listing, one the
// person must recover, or a whole Task an owner handed in after creating,
// restoring, or updating it.
export type ListedTask = ActiveTask | ActiveTaskRecovery | Task;

export function taskThreadId(
  task: { threadId?: string | null; id?: string | null } | null | undefined,
): string;

// The Tasks of one repository or directory, most recently active first.
export interface TaskRepositoryGroup {
  key: string;
  label: string;
  rootPath: string;
  repository: boolean;
  updatedMs: number;
  tasks: Task[];
}

export function sortTasksByRecency(tasks: Task[]): Task[];

// One more page of Tasks laid over the ones already held, by thread.
export function mergeTaskListPage(current: Task[], incoming: Task[]): Task[];

export function groupTasksByRepository(tasks: Task[]): TaskRepositoryGroup[];

// Where a Task's worktree is, read as branch, worktree, and directory.
export function taskWorktreeLabel(task: Task): string;

// The Tasks with `task` first in place of any it replaces.
export function upsertTask(tasks: Task[], task: Task): Task[];
