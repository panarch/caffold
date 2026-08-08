import {
  cleanLogicalPath,
  cleanRelativeTaskPath,
  shortId,
} from "./task-format.js";

export function taskThreadId(task) {
  return `${task?.threadId ?? task?.id ?? ""}`;
}

export function taskDetailThreadId(detail) {
  return `${detail?.threadId ?? taskThreadId(detail?.task)}`;
}

export function taskUpdatedMs(task) {
  const value = Number(task?.recencyMs ?? task?.updatedMs ?? task?.createdMs ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function taskRepositoryPath(task) {
  return cleanLogicalPath(
    task?.worktree?.repositoryRootPath ??
      task?.worktree?.rootPath ??
      task?.cwdPath ??
      task?.cwd ??
      task?.relativeCwd,
  );
}

export function taskRepositoryKey(task) {
  const prefix = task?.worktree ? "repository" : "cwd";
  return `${prefix}:${taskRepositoryPath(task)}`;
}

export function taskRepositoryLabel(task) {
  const path = taskRepositoryPath(task);
  return path.split("/").filter(Boolean).at(-1) ?? "Directory";
}

export function sortTasksByRecency(tasks) {
  return [...tasks].sort((left, right) => taskUpdatedMs(right) - taskUpdatedMs(left));
}

export function mergeTaskListPage(current, incoming) {
  const tasks = new Map(current.map((task) => [taskThreadId(task), task]));
  for (const task of incoming) {
    tasks.set(taskThreadId(task), task);
  }
  return [...tasks.values()];
}

export function groupTasksByRepository(tasks) {
  const groupsByKey = new Map();
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

function taskWorktreeRef(task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  if (branch) {
    return branch;
  }
  return shortId(task?.worktree?.headSha ?? "");
}

export function taskWorktreeRootName(task) {
  const rootPath = cleanRelativeTaskPath(task?.worktree?.rootPath);
  return rootPath.split("/").filter(Boolean).at(-1) ?? "Worktree";
}

export function taskWorktreeLabel(task) {
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

export function upsertTask(tasks, task) {
  const threadId = taskThreadId(task);
  const existing = tasks.filter((entry) => taskThreadId(entry) !== threadId);
  existing.unshift(task);
  return existing;
}
