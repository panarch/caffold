import type { ActiveTask, ActiveTaskRecovery, Task } from "#app/api.ts";
import {
  cleanLogicalPath,
  cleanRelativeTaskPath,
  shortId,
} from "./task-format.ts";

// A Task as the Task list holds it: the Active list's own listing, one the
// person must recover, or a whole Task an owner handed in after creating,
// restoring, or updating it.
export type ListedTask = ActiveTask | ActiveTaskRecovery | Task;

// The Tasks of one repository or directory, most recently active first.
export interface TaskRepositoryGroup {
  key: string;
  label: string;
  rootPath: string;
  repository: boolean;
  updatedMs: number;
  tasks: Task[];
}

export function taskThreadId(
  task: { threadId?: string | null; id?: string | null } | null | undefined,
) {
  return `${task?.threadId ?? task?.id ?? ""}`;
}

// The Task a Task detail answers for.
export function taskDetailThreadId(
  detail:
    | {
        threadId?: string | null;
        task?: { threadId?: string | null } | null;
      }
    | null
    | undefined,
) {
  return `${detail?.threadId ?? taskThreadId(detail?.task)}`;
}

export function taskUpdatedMs(task: Task) {
  const value = Number(
    task?.recencyMs ?? task?.updatedMs ?? task?.createdMs ?? 0,
  );
  return Number.isFinite(value) ? value : 0;
}

// The repository a Task works in, or its directory outside one.
export function taskRepositoryPath(task: Task | null | undefined) {
  return cleanLogicalPath(
    task?.worktree?.repositoryRootPath ??
      task?.worktree?.rootPath ??
      task?.cwdPath ??
      task?.cwd ??
      task?.relativeCwd,
  );
}

export function taskRepositoryKey(task: Task) {
  const prefix = task?.worktree ? "repository" : "cwd";
  return `${prefix}:${taskRepositoryPath(task)}`;
}

export function taskRepositoryLabel(task: Task) {
  const path = taskRepositoryPath(task);
  return path.split("/").filter(Boolean).at(-1) ?? "Directory";
}

export function sortTasksByRecency(tasks: Task[]) {
  return [...tasks].sort(
    (left, right) => taskUpdatedMs(right) - taskUpdatedMs(left),
  );
}

// One more page of Tasks laid over the ones already held, by thread.
export function mergeTaskListPage(current: Task[], incoming: Task[]) {
  const tasks = new Map(current.map((task) => [taskThreadId(task), task]));
  for (const task of incoming) {
    tasks.set(taskThreadId(task), task);
  }
  return [...tasks.values()];
}

export function groupTasksByRepository(tasks: Task[]) {
  const groupsByKey = new Map<string, TaskRepositoryGroup>();
  for (const task of tasks) {
    const key = taskRepositoryKey(task);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.tasks.push(task);
      existing.updatedMs = Math.max(existing.updatedMs, taskUpdatedMs(task));
      continue;
    }
    const rootPath = taskRepositoryPath(task);
    groupsByKey.set(key, {
      key,
      label: taskRepositoryLabel(task),
      rootPath,
      repository: Boolean(task?.worktree),
      updatedMs: taskUpdatedMs(task),
      tasks: [task],
    });
  }

  return [...groupsByKey.values()]
    .map((group) => ({
      ...group,
      tasks: sortTasksByRecency(group.tasks),
    }))
    .sort((left, right) => right.updatedMs - left.updatedMs);
}

function taskWorktreeRef(task: Task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  if (branch) {
    return branch;
  }
  return shortId(task?.worktree?.headSha ?? "");
}

export function taskWorktreeRootName(task: Task) {
  const rootPath = cleanRelativeTaskPath(task?.worktree?.rootPath);
  return rootPath.split("/").filter(Boolean).at(-1) ?? "Worktree";
}

// Where a Task's worktree is, read as branch, worktree, and directory.
export function taskWorktreeLabel(task: Task) {
  if (!task?.worktree) {
    return task?.cwdPath ?? task?.relativeCwd ?? "";
  }

  return [
    taskWorktreeRef(task),
    taskWorktreeRootName(task),
    cleanRelativeTaskPath(task.worktree.relativeCwd),
  ]
    .filter(Boolean)
    .join(" · ");
}

// The Tasks with `task` first in place of any it replaces.
export function upsertTask(tasks: Task[], task: Task) {
  const threadId = taskThreadId(task);
  const existing = tasks.filter((entry) => taskThreadId(entry) !== threadId);
  existing.unshift(task);
  return existing;
}
