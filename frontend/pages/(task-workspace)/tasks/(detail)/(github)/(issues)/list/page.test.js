import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-issues-list-page").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) delete globalThis.CSS;
  else globalThis.CSS = previousCss;
});

test("provides Issue rows and pagination without synthesizing navigation", () => {
  let clicks = 0;
  const control = {
    dataset: { issueNumber: "42" },
    disabled: false,
    focus() {},
    click() { clicks += 1; },
  };
  const scroller = {};
  const pagination = { actionHintScope: () => ({ targets: [{ id: "page-next" }] }) };
  const owner = {
    hidden: false,
    isConnected: true,
    selectedIssueNumber: null,
    state: { status: "ready", payload: { issues: [{ number: 42, title: "Fix it" }] } },
    querySelectorAll: () => [control],
    querySelector(selector) {
      if (selector.includes("caffold-pagination")) return pagination;
      if (selector.endsWith(" > .github-issues-list")) return scroller;
      if (selector.includes("button.github-issue-button")) return control;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const scope = page.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "github:issues:issue:42",
    "page-next",
  ]);
  assert.equal(scope.targets[0].label, "Open issue #42: Fix it");
  assert.equal(scope.targets[0].isActionable(), true);
  scope.targets[0].activate();
  assert.equal(clicks, 1);
});

test("provides only the retained Issue list", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 300,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready" },
    getClientRects: () => [{}],
    querySelector: () => scrollport,
  };
  const scope = page.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.state = { status: "loading" };
  assert.equal(scope.surfaces[0].isEligible(), false);
});
