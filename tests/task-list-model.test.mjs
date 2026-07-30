import assert from "node:assert/strict";
import test from "node:test";

import {
  groupTasksByRepository,
  mergeTaskListPage,
  sortTasksByRecency,
  taskDetailThreadId,
  upsertTask,
} from "../frontend/pages/(codex)/tasks/task-list-model.js";

function task(threadId, recencyMs, overrides = {}) {
  return {
    id: threadId,
    threadId,
    title: threadId,
    cwdPath: "workspace/project",
    recencyMs,
    ...overrides,
  };
}

test("incoming canonical list records replace cached page records by thread ID", () => {
  const stale = task("thread-1", 200, { title: "Stale" });
  const canonical = task("thread-1", 100, { title: "Canonical" });
  const other = task("thread-2", 150);

  const merged = mergeTaskListPage([stale, other], [canonical]);

  assert.equal(merged.length, 2);
  assert.equal(merged.find(({ threadId }) => threadId === "thread-1").title, "Canonical");
  assert.deepEqual(sortTasksByRecency(merged).map(({ threadId }) => threadId), [
    "thread-2",
    "thread-1",
  ]);
});

test("repository grouping sorts groups and tasks by canonical recency", () => {
  const grouped = groupTasksByRepository([
    task("cwd-old", 10),
    task("repo-new", 40, {
      worktree: {
        repositoryRootPath: "workspace/repository",
        rootPath: "workspace/repository/.worktrees/new",
        relativeCwd: "",
        branch: "feature",
      },
    }),
    task("cwd-new", 30),
    task("repo-old", 20, {
      worktree: {
        repositoryRootPath: "workspace/repository",
        rootPath: "workspace/repository/.worktrees/old",
        relativeCwd: "",
        branch: "old",
      },
    }),
  ]);

  assert.deepEqual(grouped.map(({ key }) => key), [
    "repository:workspace/repository",
    "cwd:workspace/project",
  ]);
  assert.deepEqual(grouped[0].tasks.map(({ threadId }) => threadId), [
    "repo-new",
    "repo-old",
  ]);
  assert.deepEqual(grouped[1].tasks.map(({ threadId }) => threadId), [
    "cwd-new",
    "cwd-old",
  ]);
});

test("upsert and detail identity accept canonical threadId before legacy id", () => {
  const next = task("thread-1", 20, { title: "Next" });
  const tasks = upsertTask([task("thread-1", 10), task("thread-2", 5)], next);

  assert.deepEqual(tasks.map(({ threadId }) => threadId), ["thread-1", "thread-2"]);
  assert.equal(tasks[0].title, "Next");
  assert.equal(taskDetailThreadId({ threadId: "detail-thread", task: next }), "detail-thread");
});
