import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pull-detail-page").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) delete globalThis.CSS;
  else globalThis.CSS = previousCss;
});

test("provides PR Files through its existing native control", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let control = {
    dataset: { pullNumber: "7" },
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Open files for PR #7" : null;
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
    state: { status: "ready" },
    querySelector() {
      return control;
    },
  };

  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:pull:detail",
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
      id: "github:pull:detail:7:files",
      actionId: "navigation.pull.files",
      label: "Open files for PR #7",
      controlKind: "button",
    },
  );
  assert.deepEqual(target.clipRoots, [owner, clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  control = null;
  assert.equal(target.isActionable(), false);
});
