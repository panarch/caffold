import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-viewer.js");
const fileViewer = registry.element("caffold-review-file-viewer").prototype;
after(() => registry.restore());

test("provides only the visible owned Back or close button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Back to changed files" : null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    closeLabel: "Close file",
    querySelector() {
      return control;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:close",
      actionId: "navigation.parent",
      label: "Back to changed files",
      controlKind: "button",
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  control = null;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
  }).targets, []);
});

test("provides a direct notice representation action through its owned button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let noticeControl = {
    dataset: { action: "view-preview" },
    disabled: false,
    textContent: "View rendered preview",
    getAttribute() {
      return null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector.includes('data-action="close-browser-viewer"')) {
        return null;
      }
      return noticeControl;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    noticeActionId: "navigation.review.axis",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:notice:view-preview",
      actionId: "navigation.review.axis",
      label: "View rendered preview",
      controlKind: "button",
    },
  );
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  noticeControl = null;
  assert.equal(target.isActionable(), false);
});
