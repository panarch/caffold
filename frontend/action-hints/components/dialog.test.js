import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./dialog.js");
const ActionHintDialog = registry.element("caffold-action-hint-dialog");
const dialog = ActionHintDialog.prototype;
after(() => registry.restore());

test("allocates unique accessible labeling IDs per retained instance", () => {
  const first = new ActionHintDialog();
  const second = new ActionHintDialog();
  first.ensureState();
  second.ensureState();

  assert.match(first.titleId, /^action-hint-title-/);
  assert.match(first.descriptionId, /^action-hint-description-/);
  assert.notEqual(first.titleId, second.titleId);
  assert.notEqual(first.descriptionId, second.descriptionId);
});

test("shows only matching retained badges and restores them", () => {
  const badges = ["TA", "N"].map((code) => ({
    dataset: { actionHintCode: code },
    hidden: false,
  }));
  const owner = {
    dialog: { dataset: {} },
    badges: { querySelectorAll: () => badges },
    status: { textContent: "" },
  };

  dialog.updateInput.call(owner, {
    buffer: "T",
    matches: ["TA"],
    status: "partial",
  });

  assert.deepEqual(badges.map(({ hidden }) => hidden), [false, true]);
  assert.deepEqual(owner.dialog.dataset, {
    input: "T",
    inputState: "partial",
  });
  assert.equal(owner.status.textContent, "Typed T");

  dialog.updateInput.call(owner, {
    buffer: "",
    matches: ["TA", "N"],
    status: "idle",
  });

  assert.deepEqual(badges.map(({ hidden }) => hidden), [false, false]);
  assert.equal(owner.status.textContent, "");
});

test("removes retired badges while retaining and repositioning survivors", () => {
  const previousDocument = globalThis.document;
  const previousButton = globalThis.HTMLButtonElement;
  class FakeButton {
    constructor(code) {
      this.dataset = { actionHintCode: code };
      this.attributes = new Map();
      this.hidden = false;
      this.isConnected = true;
      this.style = {};
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    getBoundingClientRect() {
      return this.hidden
        ? { width: 0, height: 0 }
        : { width: 20, height: 20 };
    }

    remove() {
      this.isConnected = false;
    }
  }
  const first = new FakeButton("A");
  const retired = new FakeButton("S");
  const last = new FakeButton("D");
  const badges = [first, retired, last];
  const dialogElement = {
    open: true,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
  };
  const owner = {
    dialog: dialogElement,
    badges: {
      contains: (element) => badges.includes(element),
      querySelectorAll: () => badges.filter(({ isConnected }) => isConnected),
    },
    badgeSizes: new WeakMap(),
    targets: [],
    viewportRect: null,
    positionBadges() {
      return dialog.positionBadges.call(this);
    },
  };
  Object.defineProperty(globalThis, "HTMLButtonElement", {
    configurable: true,
    value: FakeButton,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: retired },
  });
  try {
    last.hidden = true;
    owner.badgeSizes.set(last, { width: 20, height: 20 });
    const targets = [
      {
        code: "A",
        label: "First updated",
        visibleRect: { left: 5, top: 6 },
      },
      {
        code: "D",
        label: "Last updated",
        visibleRect: { left: 95, top: 96 },
      },
    ];

    assert.equal(dialog.reconcileTargets.call(
      owner,
      targets,
      { left: 0, top: 0, right: 100, bottom: 100 },
    ), true);

    assert.equal(first.isConnected, true);
    assert.equal(last.isConnected, true);
    assert.equal(retired.isConnected, false);
    assert.equal(first.getAttribute("aria-label"), "A — First updated");
    assert.equal(last.getAttribute("aria-label"), "D — Last updated");
    assert.deepEqual(first.style, { left: "5px", top: "6px" });
    assert.deepEqual(last.style, { left: "76px", top: "76px" });
    last.hidden = false;
    assert.deepEqual(last.style, { left: "76px", top: "76px" });
    assert.equal(dialogElement.focusCount, 1);
    assert.equal(owner.targets[0], targets[0]);
    assert.equal(owner.targets[1], targets[1]);

    assert.equal(dialog.reconcileTargets.call(
      owner,
      [...targets, {
        code: "F",
        label: "New",
        visibleRect: { left: 10, top: 10 },
      }],
      owner.viewportRect,
    ), false);
  } finally {
    if (previousButton === undefined) {
      delete globalThis.HTMLButtonElement;
    } else {
      Object.defineProperty(globalThis, "HTMLButtonElement", {
        configurable: true,
        value: previousButton,
      });
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  }
});
