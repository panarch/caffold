import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./dialog.js");
const ActionHintDialog = registry.element("caffold-action-hint-dialog");
const dialog = ActionHintDialog.prototype;
const { DrawnRefs } = await import("../../components/drawn-refs.js");
after(() => registry.restore());

// A badge dialog with the given state, which draws only when a test asks.
function dialogOwner(state = {}) {
  const owner = Object.assign(Object.create(dialog), {
    titleId: "action-hint-title-test",
    descriptionId: "action-hint-description-test",
    targets: [],
    viewportRect: null,
    progress: { buffer: "", matches: [], status: "idle" },
    badgeSizes: new WeakMap(),
    draw() {},
    ...state,
  });
  owner.badges ??= new DrawnRefs(owner);
  return owner;
}

function drawn(owner) {
  return templateHtml(owner.render()).replace(/\s+/g, " ");
}

test("names each dialog by ids of its own", () => {
  const first = new ActionHintDialog();
  const second = new ActionHintDialog();

  assert.match(first.titleId, /^action-hint-title-/);
  assert.match(first.descriptionId, /^action-hint-description-/);
  assert.notEqual(first.titleId, second.titleId);
  assert.notEqual(first.descriptionId, second.descriptionId);
});

test("shows only the badges whose codes still match what was typed", () => {
  const owner = dialogOwner({
    targets: [target("TA", "Open task"), target("N", "New Task")],
  });

  dialog.updateInput.call(owner, {
    buffer: "T",
    matches: ["TA"],
    status: "partial",
  });
  const typed = drawn(owner);
  assert.match(typed, /data-input-state="partial" data-input="T"/);
  assert.match(typed, /aria-label="TA — Open task" \?hidden="false"/);
  assert.match(typed, /aria-label="N — New Task" \?hidden="true"/);
  assert.match(typed, />Typed T<\/output/);

  dialog.updateInput.call(owner, {
    buffer: "",
    matches: ["TA", "N"],
    status: "idle",
  });
  const cleared = drawn(owner);
  assert.match(cleared, /aria-label="N — New Task" \?hidden="false"/);
  assert.match(cleared, /aria-live="polite" ><\/output/);
});

test("places each badge where its target asks on the visible rect", () => {
  const button = {
    style: {},
    getBoundingClientRect: () => ({ width: 20, height: 10 }),
  };
  const owner = dialogOwner({
    badges: { get: () => button },
    targets: [
      {
        ...target("A", "Allow"),
        visibleRect: { left: 10, top: 6, right: 90, bottom: 30 },
      },
    ],
    viewportRect: { left: 0, top: 0, right: 100, bottom: 100 },
  });

  for (const [badgeAt, left, top] of [
    ["top-left", 10, 6],
    ["top-right", 70, 6],
    ["center-left", 10, 13],
    ["center", 40, 13],
  ]) {
    owner.targets[0].badgeAt = badgeAt;
    dialog.positionBadges.call(owner);
    assert.deepEqual(
      button.style,
      { left: `${left}px`, top: `${top}px` },
      badgeAt,
    );
  }
});

test("moves its badges only to targets that kept their codes", (t) => {
  const previousButton = globalThis.HTMLButtonElement;
  globalThis.HTMLButtonElement = class {};
  t.after(() => {
    if (previousButton === undefined) {
      delete globalThis.HTMLButtonElement;
    } else {
      globalThis.HTMLButtonElement = previousButton;
    }
  });
  const badges = { A: {}, D: {} };
  const positioned = [];
  const owner = dialogOwner({
    dialog: { value: { open: true, contains: () => false } },
    badges: { get: (code) => badges[code] },
    targets: ["A", "S", "D"].map((code) => target(code, code)),
    positionBadges() {
      positioned.push(this.targets.map(({ code }) => code));
    },
  });
  const viewport = { left: 0, top: 0, right: 100, bottom: 100 };

  assert.equal(
    dialog.reconcileTargets.call(owner, [target("F", "F")], viewport),
    false,
    "a code without a badge asks for a new session",
  );
  assert.equal(
    dialog.reconcileTargets.call(
      owner,
      [target("A", "A"), target("D", "D")],
      viewport,
    ),
    true,
  );
  assert.deepEqual(positioned, [["A", "D"]]);
  assert.equal(owner.viewportRect, viewport);

  owner.dialog.value.open = false;
  assert.equal(
    dialog.reconcileTargets.call(owner, [target("A", "A")], viewport),
    false,
  );
});

function target(code, label) {
  return {
    code,
    label,
    badgeAt: "top-left",
    visibleRect: { left: 0, top: 0, right: 10, bottom: 10 },
  };
}
