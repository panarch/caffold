import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-git-log-list-page").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) delete globalThis.CSS;
  else globalThis.CSS = previousCss;
});

test("provides Open commit but excludes commit-body disclosure", () => {
  const focusOptions = [];
  let clicks = 0;
  const open = {
    dataset: { commitSha: "abcdef123456" },
    disabled: false,
    getAttribute: () => "Open commit diff for abcdef1 Fix",
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
    querySelectorAll: () => [open],
    querySelector(selector) {
      if (selector.includes("caffold-pagination")) return null;
      if (selector.endsWith(" > .log-list")) return {};
      if (selector.includes('button[data-action="open-commit"]')) return open;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const target = page.actionHintScope.call(owner).targets[0];
  assert.equal(target.id, "git:log:commit:abcdef123456");
  assert.equal(target.actionId, "navigation.commit.open");
  assert.equal(target.label, "Open commit diff for abcdef1 Fix");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);
});
