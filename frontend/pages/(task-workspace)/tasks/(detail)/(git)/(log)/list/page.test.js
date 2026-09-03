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

test("provides commit actions and the exact Git log scrollport", () => {
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
  let commitBodyExpanded = false;
  const toggle = {
    dataset: { commitSha: "abcdef123456" },
    disabled: false,
    getAttribute: () => `${
      commitBodyExpanded ? "Collapse" : "Expand"
    } commit body for abcdef1`,
    focus() {},
    click() {},
  };
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 420,
    getClientRects: () => [{}],
  };
  let currentToggle = toggle;
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready" },
    getClientRects: () => [{}],
    querySelectorAll(selector) {
      return selector.includes("toggle-commit-body") ? [currentToggle] : [open];
    },
    querySelector(selector) {
      if (selector.includes("caffold-pagination")) return null;
      if (selector.endsWith(" > .log-list")) return scrollport;
      if (selector.includes('button[data-action="toggle-commit-body"]')) {
        return currentToggle;
      }
      if (selector.includes('button[data-action="open-commit"]')) return open;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const scope = page.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "git:log:commit:abcdef123456",
    "git:log:commit-body:abcdef123456",
  ]);
  const target = scope.targets[0];
  assert.equal(target.id, "git:log:commit:abcdef123456");
  assert.equal(target.actionId, "navigation.commit.open");
  assert.equal(target.label, "Open commit diff for abcdef1 Fix");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);
  assert.equal(scope.targets[1].actionId, "disclosure.toggle");
  assert.equal(scope.targets[1].controlKind, "disclosure");
  assert.equal(scope.targets[1].label, "Expand commit body for abcdef1");
  assert.equal(scope.targets[1].isActionable(), true);
  commitBodyExpanded = true;
  const expandedTarget = page.actionHintScope.call(owner).targets[1];
  assert.equal(expandedTarget.id, scope.targets[1].id);
  assert.equal(expandedTarget.label, "Collapse commit body for abcdef1");
  toggle.disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  toggle.disabled = false;
  currentToggle = { id: "replacement-toggle" };
  assert.equal(scope.targets[1].isActionable(), false);
  currentToggle = toggle;
  owner.hidden = true;
  assert.equal(scope.targets[1].isActionable(), false);
  owner.hidden = false;
  owner.state = { status: "loading" };
  assert.equal(scope.targets[1].isActionable(), false);
  owner.state = { status: "ready" };

  const scrollScope = page.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
});
