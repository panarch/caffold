import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_HINT_ACTION,
  TASK_HINT_ALPHABET,
  advanceHintBuffer,
  allocateActionHintCodes,
  automaticHintCodes,
  clampBadgePosition,
  matchesActionHintPolicy,
  normalizeActionHintKey,
  rectsEqual,
  sameActionHintSnapshot,
  sameActionHintTopology,
  sortByVisualOrder,
  visibleTargetRect,
} from "./model.js";

function target(id, actionId, controlKind = "button") {
  return { id, actionId, controlKind };
}

test("allocates fixed, ASDF-ordered Task, and automatic codes centrally", () => {
  const allocated = allocateActionHintCodes([
    target("new", ACTION_HINT_ACTION.TASK_CREATE),
    target("task-a", ACTION_HINT_ACTION.TASK_OPEN),
    target("task-b", ACTION_HINT_ACTION.TASK_OPEN),
    target("task-c", ACTION_HINT_ACTION.TASK_OPEN_RECOVERY),
    target("settings", ACTION_HINT_ACTION.WORKSPACE_SELECT),
    target("model", ACTION_HINT_ACTION.MODEL_CHOOSE),
    target("prompt", ACTION_HINT_ACTION.PROMPT_FOCUS, "textbox"),
  ]);

  assert.equal(TASK_HINT_ALPHABET, "ASDFGHJKLQWERTYUIOPZXCVBNM");
  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [
      ["new", "N"],
      ["task-a", "TA"],
      ["task-b", "TS"],
      ["task-c", "TD"],
      ["settings", "A"],
      ["model", "M"],
      ["prompt", "P"],
    ],
  );
});

test("keeps Task codes compact and balanced after the one-key suffix capacity", () => {
  const capacityCodes = taskCodes(26);
  const firstOverflowCodes = taskCodes(27);
  const tasks = Array.from({ length: 28 }, (_, index) =>
    target(`task-${index}`, ACTION_HINT_ACTION.TASK_OPEN)
  );
  const codes = allocateActionHintCodes(tasks).map(({ code }) => code);

  assert.deepEqual(codeLengthCounts(capacityCodes), { 2: 26 });
  assert.deepEqual(codeLengthCounts(firstOverflowCodes), { 2: 25, 3: 2 });
  assert.deepEqual(firstOverflowCodes.slice(-2), ["TMA", "TMS"]);
  assert.deepEqual(codes.slice(0, 3), ["TA", "TS", "TD"]);
  assert.equal(codes[24], "TN");
  assert.deepEqual(codes.slice(25), ["TMA", "TMS", "TMD"]);
  assert.deepEqual(codeLengthCounts(codes), { 2: 25, 3: 3 });
  assertBalancedPrefixFree(codes);
});

test("widens neighboring Task branches before adding another suffix depth", () => {
  const tasks = Array.from({ length: 52 }, (_, index) =>
    target(`task-${index}`, ACTION_HINT_ACTION.TASK_OPEN)
  );
  const codes = allocateActionHintCodes(tasks).map(({ code }) => code);

  assert.equal(codes[23], "TB");
  assert.equal(codes[24], "TNA");
  assert.equal(codes[49], "TNM");
  assert.deepEqual(codes.slice(50), ["TMA", "TMS"]);
  assert.deepEqual(codeLengthCounts(codes), { 2: 24, 3: 28 });
  assertBalancedPrefixFree(codes);
});

test("rejects unknown actions, duplicate identities, and fixed-code conflicts", () => {
  assert.throws(
    () => allocateActionHintCodes([target("unknown", "anything")]),
    /Unsupported Action Hint action/,
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("same", ACTION_HINT_ACTION.TASK_CREATE),
      target("same", ACTION_HINT_ACTION.MODEL_CHOOSE),
    ]),
    /Duplicate or empty Action Hint target id/,
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("new-a", ACTION_HINT_ACTION.TASK_CREATE),
      target("new-b", ACTION_HINT_ACTION.TASK_CREATE),
    ]),
    /codes must be unique/,
  );
});

test("accepts only the central semantic action and control-kind policy", () => {
  const nonButtonKinds = new Map([
    [ACTION_HINT_ACTION.PROMPT_FOCUS, "textbox"],
    [ACTION_HINT_ACTION.DIALOG_TEXTBOX_FOCUS, "textbox"],
    [ACTION_HINT_ACTION.CONTROL_SELECT_OPEN, "select"],
    [ACTION_HINT_ACTION.CONTROL_RADIO_SELECT, "radio"],
    [ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE, "switch"],
    [ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS, "range"],
    [ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS, "separator"],
    [ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS, "reorder-handle"],
    [ACTION_HINT_ACTION.DISCLOSURE_TOGGLE, "disclosure"],
    [ACTION_HINT_ACTION.LINK_OPEN, "link"],
  ]);
  for (const actionId of Object.values(ACTION_HINT_ACTION)) {
    const controlKind = nonButtonKinds.get(actionId) ?? "button";
    assert.equal(matchesActionHintPolicy({
      actionId,
      controlKind,
    }), true, actionId);
  }
  assert.equal(
    matchesActionHintPolicy({
      actionId: "task.delete",
      controlKind: "button",
    }),
    false,
  );
  assert.equal(
    matchesActionHintPolicy({
      actionId: "task.prompt.focus",
      controlKind: "button",
    }),
    false,
  );
});

test("allocates owner-declared disclosures through the automatic pool", () => {
  const allocated = allocateActionHintCodes([
    target(
      "directory-src",
      ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
      "disclosure",
    ),
    target(
      "thinking",
      ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
      "disclosure",
    ),
  ]);

  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [["directory-src", "A"], ["thinking", "S"]],
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("wrong-kind", ACTION_HINT_ACTION.DISCLOSURE_TOGGLE),
    ]),
    /Unsupported Action Hint action/,
  );
});

test("allocates native controls through one automatic pool", () => {
  const allocated = allocateActionHintCodes([
    target("cancel", ACTION_HINT_ACTION.DIALOG_BUTTON),
    target("thread", ACTION_HINT_ACTION.DIALOG_TEXTBOX_FOCUS, "textbox"),
    target("base", ACTION_HINT_ACTION.CONTROL_SELECT_OPEN, "select"),
    target("theme", ACTION_HINT_ACTION.CONTROL_RADIO_SELECT, "radio"),
    target("keyboard", ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE, "switch"),
    target("scale", ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS, "range"),
    target(
      "split",
      ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      "separator",
    ),
    target(
      "task-handle",
      ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS,
      "reorder-handle",
    ),
    target("finish", ACTION_HINT_ACTION.REORDER_FINISH),
  ]);

  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [
      ["cancel", "A"],
      ["thread", "S"],
      ["base", "D"],
      ["theme", "F"],
      ["keyboard", "G"],
      ["scale", "H"],
      ["split", "J"],
      ["task-handle", "K"],
      ["finish", "L"],
    ],
  );

  for (
    const [actionId, wrongKind] of [
      [ACTION_HINT_ACTION.CONTROL_RADIO_SELECT, "button"],
      [ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE, "button"],
      [ACTION_HINT_ACTION.CONTROL_SELECT_OPEN, "button"],
      [ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS, "button"],
      [ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS, "button"],
      [ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS, "button"],
    ]
  ) {
    assert.throws(
      () => allocateActionHintCodes([target("wrong", actionId, wrongKind)]),
      /Unsupported Action Hint action/,
    );
  }
});

test("allocates Current Plan document openers through the automatic pool", () => {
  const allocated = allocateActionHintCodes([
    target("plan", ACTION_HINT_ACTION.CURRENT_PLAN_DOCUMENT_OPEN),
    target("checklist", ACTION_HINT_ACTION.CURRENT_PLAN_DOCUMENT_OPEN),
  ]);

  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [["plan", "A"], ["checklist", "S"]],
  );
});

test("allocates explicitly owned ordinary buttons through the automatic pool", () => {
  const allocated = allocateActionHintCodes([
    target("refresh", ACTION_HINT_ACTION.BUTTON_ACTIVATE),
    target("copy", ACTION_HINT_ACTION.BUTTON_ACTIVATE),
  ]);

  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [["refresh", "A"], ["copy", "S"]],
  );
});

test("allocates owner-declared links through the automatic pool", () => {
  const allocated = allocateActionHintCodes([
    target("guide", ACTION_HINT_ACTION.LINK_OPEN, "link"),
    target("external", ACTION_HINT_ACTION.LINK_OPEN, "link"),
  ]);

  assert.deepEqual(
    allocated.map(({ id, code }) => [id, code]),
    [["guide", "A"], ["external", "S"]],
  );
  assert.throws(
    () => allocateActionHintCodes([
      target("wrong-kind", ACTION_HINT_ACTION.LINK_OPEN),
    ]),
    /Unsupported Action Hint action/,
  );
});

test("automatic codes reserve fixed and Task prefixes and overflow compactly", () => {
  const oneCharacterCodes = automaticHintCodes(22);
  assert.deepEqual(oneCharacterCodes, [
    "A", "S", "D", "F", "G", "H", "J", "K", "L", "Q", "W",
    "E", "R", "Y", "U", "I", "O", "Z", "X", "C", "V", "B",
  ]);
  assert.ok(oneCharacterCodes.includes("F"));
  assert.ok(oneCharacterCodes.every((code) => !/[NMPT]/.test(code[0])));

  const twoCharacterCodes = automaticHintCodes(23);
  assert.deepEqual(twoCharacterCodes.slice(0, 3), ["A", "S", "D"]);
  assert.equal(twoCharacterCodes[20], "V");
  assert.deepEqual(twoCharacterCodes.slice(21), ["BA", "BS"]);
  assert.deepEqual(codeLengthCounts(twoCharacterCodes), { 1: 21, 2: 2 });
  assert.ok(twoCharacterCodes.every((code) => !/[NMPT]/.test(code[0])));
  assertBalancedPrefixFree(twoCharacterCodes);

  const threeCharacterCodes = automaticHintCodes(573);
  assert.deepEqual(codeLengthCounts(threeCharacterCodes), { 2: 571, 3: 2 });
  assert.deepEqual(threeCharacterCodes.slice(-2), ["BMA", "BMS"]);
  assert.ok(threeCharacterCodes.every((code) => !/[NMPT]/.test(code[0])));
  assertBalancedPrefixFree(threeCharacterCodes);
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

test("reports partial, unmatched, recoverable, and exact buffer progression", () => {
  const codes = ["TA", "TS", "TMA", "TMS", "N"];
  assert.deepEqual(advanceHintBuffer("", "T", codes), {
    buffer: "T",
    matches: ["TA", "TS", "TMA", "TMS"],
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
    matches: ["TA", "TS", "TMA", "TMS"],
    exact: "",
    status: "partial",
  });
  assert.deepEqual(advanceHintBuffer("T", "A", codes), {
    buffer: "TA",
    matches: ["TA"],
    exact: "TA",
    status: "exact",
  });
  assert.deepEqual(advanceHintBuffer("T", "M", codes), {
    buffer: "TM",
    matches: ["TMA", "TMS"],
    exact: "",
    status: "partial",
  });
  assert.deepEqual(advanceHintBuffer("TM", "A", codes), {
    buffer: "TMA",
    matches: ["TMA"],
    exact: "TMA",
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
      controlKind: "button",
      activationKey: "",
      actionable: true,
      control: firstControl,
      anchor: firstControl,
      clipRoots: [firstClipRoot],
    },
    {
      id: "new",
      actionId: "task.create",
      controlKind: "button",
      activationKey: "",
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
  assert.equal(
    sameActionHintTopology(topology, [
      { ...topology[0], activationKey: "changed" },
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
      controlKind: "button",
      activationKey: "",
      actionable: true,
      control,
      anchor: control,
      clipRoots: [dependency],
    }],
    targets: [{
      id: "task-a",
      actionId: "task.open",
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

function taskCodes(count) {
  return allocateActionHintCodes(
    Array.from({ length: count }, (_, index) =>
      target(`task-${index}`, ACTION_HINT_ACTION.TASK_OPEN)
    ),
  ).map(({ code }) => code);
}

function codeLengthCounts(codes) {
  return Object.fromEntries(
    [...new Set(codes.map((code) => code.length))].map((length) => [
      length,
      codes.filter((code) => code.length === length).length,
    ]),
  );
}

function assertBalancedPrefixFree(codes) {
  const lengths = codes.map((code) => code.length);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
  for (const code of codes) {
    assert.ok(codes.every((other) =>
      code === other || !other.startsWith(code)
    ));
  }
}
