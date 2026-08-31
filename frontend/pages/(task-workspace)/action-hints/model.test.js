import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_HINT_CATEGORY,
  TASK_HINT_ALPHABET,
  advanceHintBuffer,
  allocateActionHintCodes,
  clampBadgePosition,
  matchesActionHintPolicy,
  normalizeActionHintKey,
  rectsEqual,
  sameActionHintSnapshot,
  sameActionHintTopology,
  sortByVisualOrder,
  taskHintSuffixWidth,
  visibleTargetRect,
} from "./model.js";

function target(id, category) {
  return { id, category };
}

test("allocates semantic fixed codes and ASDF-ordered Task codes", () => {
  const allocated = allocateActionHintCodes([
    target("new", ACTION_HINT_CATEGORY.NEW_TASK),
    target("task-a", ACTION_HINT_CATEGORY.TASK),
    target("task-b", ACTION_HINT_CATEGORY.TASK),
    target("task-c", ACTION_HINT_CATEGORY.TASK),
    target("model", ACTION_HINT_CATEGORY.MODEL),
    target("prompt", ACTION_HINT_CATEGORY.PROMPT),
  ]);

  assert.equal(TASK_HINT_ALPHABET, "ASDFGHJKLQWERTYUIOPZXCVBNM");
  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [
      ["new", "N"],
      ["task-a", "TA"],
      ["task-b", "TS"],
      ["task-c", "TD"],
      ["model", "M"],
      ["prompt", "P"],
    ],
  );
});

test("grows every Task suffix to the same prefix-free width after 26", () => {
  const tasks = Array.from({ length: 27 }, (_, index) =>
    target(`task-${index}`, ACTION_HINT_CATEGORY.TASK)
  );
  const codes = allocateActionHintCodes(tasks).map(({ code }) => code);

  assert.equal(taskHintSuffixWidth(26), 1);
  assert.equal(taskHintSuffixWidth(27), 2);
  assert.equal(codes[0], "TAA");
  assert.equal(codes[25], "TAM");
  assert.equal(codes[26], "TSA");
  assert.ok(codes.every((code) => code.length === 3));
  assert.ok(codes.every((code) =>
    codes.every((other) => code === other || !other.startsWith(code))
  ));
});

test("rejects unknown categories and duplicate identities", () => {
  assert.throws(
    () => allocateActionHintCodes([target("unknown", "anything")]),
    /Unknown Action Hint category/,
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("same", ACTION_HINT_CATEGORY.NEW_TASK),
      target("same", ACTION_HINT_CATEGORY.MODEL),
    ]),
    /Duplicate or empty Action Hint target id/,
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("new-a", ACTION_HINT_CATEGORY.NEW_TASK),
      target("new-b", ACTION_HINT_CATEGORY.NEW_TASK),
    ]),
    /codes must be unique/,
  );
});

test("accepts only the central semantic action, category, and control-kind policy", () => {
  for (const descriptor of [
    { actionId: "task.open", category: "task", controlKind: "button" },
    { actionId: "task.open-recovery", category: "task", controlKind: "button" },
    { actionId: "task.create", category: "new-task", controlKind: "button" },
    { actionId: "task.model.choose", category: "model", controlKind: "button" },
    { actionId: "task.prompt.focus", category: "prompt", controlKind: "textbox" },
  ]) {
    assert.equal(matchesActionHintPolicy(descriptor), true);
  }
  assert.equal(
    matchesActionHintPolicy({
      actionId: "task.delete",
      category: "task",
      controlKind: "button",
    }),
    false,
  );
  assert.equal(
    matchesActionHintPolicy({
      actionId: "task.prompt.focus",
      category: "task",
      controlKind: "button",
    }),
    false,
  );
});

test("normalizes Latin keys and uses physical Latin fallback only outside composition", () => {
  assert.equal(normalizeActionHintKey({ key: "f", code: "KeyQ" }), "F");
  assert.equal(normalizeActionHintKey({ key: "F", code: "KeyQ", shiftKey: true }), "F");
  assert.equal(normalizeActionHintKey({ key: "ㄹ", code: "KeyF" }), "F");
  assert.equal(
    normalizeActionHintKey(
      { key: "ㄹ", code: "KeyF" },
      { compositionActive: true },
    ),
    "",
  );
  assert.equal(
    normalizeActionHintKey({ key: "f", code: "KeyF", isComposing: true }),
    "",
  );
  assert.equal(normalizeActionHintKey({ key: "f", code: "KeyF", repeat: true }), "");
  assert.equal(normalizeActionHintKey({ key: "f", code: "KeyF", metaKey: true }), "");
  assert.equal(normalizeActionHintKey({ key: "/", code: "Slash" }), "");
});

test("keeps invalid input until Backspace recovers and reports exact matches", () => {
  const codes = ["TA", "TS", "N"];
  assert.deepEqual(advanceHintBuffer("", "T", codes), {
    buffer: "T",
    matches: ["TA", "TS"],
    exact: "",
    status: "partial",
  });
  assert.deepEqual(advanceHintBuffer("T", "X", codes), {
    buffer: "TX",
    matches: [],
    exact: "",
    status: "no-match",
  });
  assert.deepEqual(advanceHintBuffer("TX", "Backspace", codes), {
    buffer: "T",
    matches: ["TA", "TS"],
    exact: "",
    status: "partial",
  });
  assert.deepEqual(advanceHintBuffer("T", "A", codes), {
    buffer: "TA",
    matches: ["TA"],
    exact: "TA",
    status: "exact",
  });
});

test("intersects targets with every clip and requires the original center", () => {
  const viewport = { left: 0, top: 0, right: 300, bottom: 300 };
  const visible = visibleTargetRect(
    { left: 10, top: 90, right: 110, bottom: 130 },
    [{ left: 0, top: 100, right: 200, bottom: 200 }],
    viewport,
  );
  assert.deepEqual(visible, {
    left: 10,
    top: 100,
    right: 110,
    bottom: 130,
    width: 100,
    height: 30,
  });
  assert.equal(
    visibleTargetRect(
      { left: 10, top: 70, right: 110, bottom: 110 },
      [{ left: 0, top: 100, right: 200, bottom: 200 }],
      viewport,
    ),
    null,
  );
});

test("clamps badges to the visual viewport and compares captured geometry", () => {
  assert.deepEqual(
    clampBadgePosition(
      { left: 295, top: -20 },
      { width: 40, height: 20 },
      { left: 0, top: 0, right: 300, bottom: 200 },
    ),
    { left: 256, top: 4 },
  );
  assert.equal(
    rectsEqual(
      { left: 1, top: 2, right: 10, bottom: 20 },
      { left: 1.4, top: 2, right: 10, bottom: 20.4 },
    ),
    true,
  );
  assert.equal(
    rectsEqual(
      { left: 1, top: 2, right: 10, bottom: 20 },
      { left: 2, top: 2, right: 10, bottom: 20 },
    ),
    false,
  );
});

test("freezes target topology by semantic order and DOM identity", () => {
  const firstControl = {};
  const secondControl = {};
  const firstClipRoot = {};
  const secondClipRoot = {};
  const topology = [
    {
      id: "task-a",
      actionId: "task.open",
      category: ACTION_HINT_CATEGORY.TASK,
      controlKind: "button",
      actionable: true,
      control: firstControl,
      anchor: firstControl,
      clipRoots: [firstClipRoot],
    },
    {
      id: "new",
      actionId: "task.create",
      category: ACTION_HINT_CATEGORY.NEW_TASK,
      controlKind: "button",
      actionable: true,
      control: secondControl,
      anchor: secondControl,
      clipRoots: [secondClipRoot],
    },
  ];
  assert.equal(sameActionHintTopology(topology, topology.map((entry) => ({ ...entry }))), true);
  assert.equal(sameActionHintTopology(topology, [...topology].reverse()), false);
  assert.equal(
    sameActionHintTopology(topology, [
      { ...topology[0], control: {} },
      topology[1],
    ]),
    false,
  );
  assert.equal(
    sameActionHintTopology(topology, [
      { ...topology[0], actionable: false },
      topology[1],
    ]),
    false,
  );
  assert.equal(
    sameActionHintTopology(topology, [
      { ...topology[0], clipRoots: [secondClipRoot] },
      topology[1],
    ]),
    false,
  );
});

test("keeps presentation label changes but rejects frozen binding changes", () => {
  const control = {};
  const dependency = {};
  const mutationRoot = {};
  const scrollRoot = {};
  const snapshot = {
    topology: [{
      id: "task-a",
      actionId: "task.open",
      category: ACTION_HINT_CATEGORY.TASK,
      controlKind: "button",
      actionable: true,
      control,
      anchor: control,
      clipRoots: [dependency],
    }],
    targets: [{
      id: "task-a",
      actionId: "task.open",
      category: ACTION_HINT_CATEGORY.TASK,
      controlKind: "button",
      code: "TA",
      control,
      anchor: control,
      label: "Original title",
      visibleRect: { left: 1, top: 2, right: 101, bottom: 42 },
    }],
    viewport: {
      rect: { left: 0, top: 0, right: 300, bottom: 200 },
      scale: 1,
      devicePixelRatio: 2,
    },
    dependencies: [{
      element: dependency,
      rect: { left: 0, top: 0, right: 120, bottom: 200 },
    }],
    mutationRoots: [mutationRoot],
    scrollRoots: [scrollRoot],
  };
  const harmless = structuredClone(snapshot);
  harmless.topology[0].control = control;
  harmless.topology[0].anchor = control;
  harmless.topology[0].clipRoots = [dependency];
  harmless.targets[0].control = control;
  harmless.targets[0].anchor = control;
  harmless.targets[0].label = "Updated title";
  harmless.dependencies[0].element = dependency;
  harmless.mutationRoots = [mutationRoot];
  harmless.scrollRoots = [scrollRoot];
  assert.equal(sameActionHintSnapshot(snapshot, harmless), true);

  assert.equal(
    sameActionHintSnapshot(snapshot, {
      ...harmless,
      targets: [{ ...harmless.targets[0], controlKind: "textbox" }],
    }),
    false,
  );
  assert.equal(
    sameActionHintSnapshot(snapshot, {
      ...harmless,
      targets: [{
        ...harmless.targets[0],
        visibleRect: { left: 3, top: 2, right: 103, bottom: 42 },
      }],
    }),
    false,
  );
  assert.equal(
    sameActionHintSnapshot(snapshot, {
      ...harmless,
      dependencies: [{
        ...harmless.dependencies[0],
        rect: { left: 0, top: 0, right: 130, bottom: 200 },
      }],
    }),
    false,
  );
  assert.equal(
    sameActionHintSnapshot(snapshot, {
      ...harmless,
      mutationRoots: [{}],
    }),
    false,
  );
  assert.equal(
    sameActionHintSnapshot(snapshot, {
      ...harmless,
      scrollRoots: [{}],
    }),
    false,
  );
});

test("sorts badge and allocation order by visual reading order", () => {
  const targets = [
    { id: "third", visibleRect: { top: 30, left: 10 } },
    { id: "second", visibleRect: { top: 10, left: 80 } },
    { id: "first", visibleRect: { top: 10, left: 20 } },
  ];
  assert.deepEqual(
    sortByVisualOrder(targets).map(({ id }) => id),
    ["first", "second", "third"],
  );
});
