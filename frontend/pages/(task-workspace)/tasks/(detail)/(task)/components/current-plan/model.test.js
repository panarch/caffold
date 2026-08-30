import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_PLAN_NODE,
  currentPlanDocumentDisplayPath,
  currentPlanDocumentPaths,
  currentPlanTransitionAllowed,
  normalizeCurrentPlanProjection,
  sameCurrentPlanProjection,
} from "./model.js";

test("current-plan document labels are relative only inside the Task project root", () => {
  assert.equal(
    currentPlanDocumentDisplayPath(
      "workspace/project/.caffold/plans/current/PLAN.md",
      "workspace/project",
    ),
    ".caffold/plans/current/PLAN.md",
  );
  assert.equal(
    currentPlanDocumentDisplayPath(
      "workspace/project/packages/app/.caffold/plans/current/CHECKLIST.md",
      "workspace/project",
    ),
    "packages/app/.caffold/plans/current/CHECKLIST.md",
  );
  assert.equal(
    currentPlanDocumentDisplayPath(
      "workspace/project-copy/.caffold/plans/current/PLAN.md",
      "workspace/project",
    ),
    "workspace/project-copy/.caffold/plans/current/PLAN.md",
  );
  assert.equal(
    currentPlanDocumentDisplayPath("workspace/project/PLAN.md", ""),
    "workspace/project/PLAN.md",
  );
});

test("the current-plan lifecycle accepts exactly its declared control edges", () => {
  const { INACTIVE, RESOLVING, SUBSCRIBED, DEGRADED } = CURRENT_PLAN_NODE;
  const accepted = new Set([
    `${INACTIVE}->${RESOLVING}`,
    `${RESOLVING}->${RESOLVING}`,
    `${RESOLVING}->${SUBSCRIBED}`,
    `${RESOLVING}->${DEGRADED}`,
    `${RESOLVING}->${INACTIVE}`,
    `${SUBSCRIBED}->${SUBSCRIBED}`,
    `${SUBSCRIBED}->${RESOLVING}`,
    `${SUBSCRIBED}->${DEGRADED}`,
    `${SUBSCRIBED}->${INACTIVE}`,
    `${DEGRADED}->${RESOLVING}`,
    `${DEGRADED}->${INACTIVE}`,
  ]);
  for (const from of Object.values(CURRENT_PLAN_NODE)) {
    for (const to of Object.values(CURRENT_PLAN_NODE)) {
      assert.equal(
        currentPlanTransitionAllowed(from, to),
        accepted.has(`${from}->${to}`),
        `${from}->${to}`,
      );
    }
  }
  assert.equal(currentPlanTransitionAllowed("unknown", RESOLVING), false);
});

test("projection equality and document paths use only accepted response data", () => {
  const projection = {
    status: "ready",
    watchPath: "task/.caffold/plans/current",
    plan: {
      title: "Plan",
      completed: 1,
      total: 2,
      planDocument: { path: "task/.caffold/plans/current/PLAN.md" },
      checklistDocument: {
        path: "task/.caffold/plans/current/CHECKLIST.md",
      },
    },
    problems: [],
  };
  assert.equal(sameCurrentPlanProjection(projection, structuredClone(projection)), true);
  assert.equal(
    sameCurrentPlanProjection(projection, {
      ...projection,
      plan: { ...projection.plan, completed: 2 },
    }),
    false,
  );
  assert.deepEqual(currentPlanDocumentPaths(projection), [
    "task/.caffold/plans/current/PLAN.md",
    "task/.caffold/plans/current/CHECKLIST.md",
  ]);
  assert.deepEqual(currentPlanDocumentPaths({ status: "problem" }), []);
});

test("projection normalization rejects malformed status, progress, and documents", () => {
  assert.throws(
    () => normalizeCurrentPlanProjection({ status: "unknown", watchPath: "task" }),
    /invalid status/,
  );
  assert.throws(
    () => normalizeCurrentPlanProjection({ status: "absent" }),
    /watch path/,
  );
  assert.throws(
    () =>
      normalizeCurrentPlanProjection({
        status: "ready",
        watchPath: "task",
        plan: { completed: 2, total: 1 },
      }),
    /invalid progress or documents/,
  );

  assert.deepEqual(
    normalizeCurrentPlanProjection({
      status: "problem",
      watchPath: "task/.caffold/plans/current",
      plan: { title: "must be ignored" },
      problems: [{ document: "plan", code: "missing", message: "Missing" }],
    }),
    {
      status: "problem",
      watchPath: "task/.caffold/plans/current",
      plan: null,
      problems: [{ document: "plan", code: "missing", message: "Missing" }],
    },
  );
});
