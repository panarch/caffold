import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./segmented-control.js");
const segmentedControl = registry.element("caffold-segmented-control").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) {
    delete globalThis.CSS;
  } else {
    globalThis.CSS = previousCss;
  }
});

test("provides non-current choices through the owned segmented intent buttons", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  const buttons = new Map([
    ["changes", { disabled: false }],
    ["files", {
      disabled: false,
      focus(options) {
        focusOptions.push(options);
      },
      click() {
        clicks += 1;
      },
    }],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    snapshot: {
      selected: "changes",
      choices: [
        { value: "changes", label: "Changes" },
        { value: "files", label: "Files" },
      ],
    },
    ensureState() {},
    querySelector(selector) {
      const value = selector.match(/data-segmented-value="([^"]+)"/)?.[1];
      return buttons.get(value) ?? null;
    },
  };

  const scope = segmentedControl.actionHintScope.call(owner, {
    scopeId: "review:navigator",
    actionId: "navigation.review.axis",
    clipRoots: [clipRoot],
    labelForChoice: (choice) => `Show ${choice.label}`,
  });

  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.scrollRoots, []);
  assert.equal(scope.targets.length, 1);
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:navigator:choice:files",
      actionId: "navigation.review.axis",
      label: "Show Files",
      controlKind: "button",
    },
  );
  assert.equal(target.control, buttons.get("files"));
  assert.equal(target.anchor, buttons.get("files"));
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);

  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  owner.snapshot.selected = "files";
  assert.equal(target.isActionable(), false);
});
