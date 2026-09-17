import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_PLAN_NODE,
  currentPlanDocumentDisplayPath,
  currentPlanDocumentPaths,
  currentPlanPresentation,
  currentPlanTransitionAllowed,
  normalizeCurrentPlanProjection,
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
  const { INACTIVE, READING, SETTLED } = CURRENT_PLAN_NODE;
  const accepted = new Set([
    `${INACTIVE}->${READING}`,
    `${READING}->${READING}`,
    `${READING}->${SETTLED}`,
    `${READING}->${INACTIVE}`,
    `${SETTLED}->${READING}`,
    `${SETTLED}->${INACTIVE}`,
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
  assert.equal(currentPlanTransitionAllowed("unknown", READING), false);
});

test("the strip is visible only for a readable plan or a document problem", () => {
  const failures = {
    readError: new Error("Failed to fetch"),
    watchError: new Error("Live updates are unavailable."),
  };
  for (const projection of [null, { status: "absent", problems: [] }]) {
    for (const errors of [{}, failures]) {
      assert.deepEqual(
        currentPlanPresentation({ projection, ...errors }),
        {
          visible: false,
          presentation: "",
          label: "",
          issues: [],
          refreshAvailable: false,
        },
      );
    }
  }

  assert.deepEqual(
    currentPlanPresentation({ projection: readyProjection() }),
    {
      visible: true,
      presentation: "ready",
      label: "",
      issues: [],
      refreshAvailable: false,
    },
  );
});

test("a readable plan names update and read failures in a fixed order", () => {
  const watchError = new Error("Live updates are unavailable.");
  const readError = new Error("Failed to fetch");

  assert.deepEqual(
    currentPlanPresentation({ projection: readyProjection(), watchError }),
    {
      visible: true,
      presentation: "ready",
      label: "Plan updates paused",
      issues: [
        { label: "Plan updates paused", detail: "Live updates are unavailable." },
      ],
      refreshAvailable: true,
    },
  );
  const both = currentPlanPresentation({
    projection: readyProjection(),
    readError,
    watchError,
  });
  assert.equal(both.label, "Plan updates paused");
  assert.deepEqual(both.issues, [
    { label: "Plan updates paused", detail: "Live updates are unavailable." },
    { label: "Couldn't load plan", detail: "Failed to fetch" },
  ]);
  assert.equal(
    currentPlanPresentation({ projection: readyProjection(), readError }).label,
    "Couldn't load plan",
  );
});

test("document problems summarize missing and unreadable files", () => {
  const missingChecklist = problem("checklist", "missing");
  const binaryPlan = problem("plan", "binary_file");
  const missingPlan = problem("plan", "missing");

  const single = currentPlanPresentation({
    projection: problemProjection([missingChecklist]),
  });
  assert.equal(single.presentation, "problem");
  assert.equal(single.label, "CHECKLIST.md missing");
  assert.equal(single.refreshAvailable, false);
  assert.deepEqual(single.issues, [
    { label: "CHECKLIST.md missing", detail: missingChecklist.message },
  ]);

  assert.equal(
    currentPlanPresentation({ projection: problemProjection([binaryPlan]) }).label,
    "PLAN.md unreadable",
  );
  assert.equal(
    currentPlanPresentation({
      projection: problemProjection([missingPlan, missingChecklist]),
    }).label,
    "Plan files missing",
  );
  const mixed = currentPlanPresentation({
    projection: problemProjection([binaryPlan, missingChecklist]),
  });
  assert.equal(mixed.label, "Plan files unreadable");
  assert.deepEqual(
    mixed.issues.map(({ label }) => label),
    ["PLAN.md unreadable", "CHECKLIST.md missing"],
  );
});

test("a document problem keeps its summary while update failures join the issues", () => {
  const presentation = currentPlanPresentation({
    projection: problemProjection([problem("checklist", "missing")]),
    readError: new Error("Request timed out."),
    watchError: new Error("Live updates are unavailable."),
  });
  assert.equal(presentation.label, "CHECKLIST.md missing");
  assert.equal(presentation.refreshAvailable, true);
  assert.deepEqual(
    presentation.issues.map(({ label }) => label),
    ["CHECKLIST.md missing", "Plan updates paused", "Couldn't load plan"],
  );
});

test("document paths use only accepted response data", () => {
  assert.deepEqual(currentPlanDocumentPaths(readyProjection()), [
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

  for (const problems of [
    [],
    [{ document: "notes", code: "missing", message: "Missing" }],
  ]) {
    assert.throws(
      () =>
        normalizeCurrentPlanProjection({
          status: "problem",
          watchPath: "task/.caffold/plans/current",
          problems,
        }),
      /invalid problems/,
    );
  }

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

function readyProjection() {
  return {
    status: "ready",
    watchPath: "task/.caffold/plans/current",
    plan: {
      title: "Plan",
      completed: 1,
      total: 2,
      planDocument: { path: "task/.caffold/plans/current/PLAN.md" },
      checklistDocument: { path: "task/.caffold/plans/current/CHECKLIST.md" },
    },
    problems: [],
  };
}

function problemProjection(problems) {
  return {
    status: "problem",
    watchPath: "task/.caffold/plans/current",
    plan: null,
    problems,
  };
}

function problem(document, code) {
  const name = document === "plan" ? "PLAN.md" : "CHECKLIST.md";
  return {
    document,
    code,
    message: `${code}: task/.caffold/plans/current/${name}`,
  };
}
