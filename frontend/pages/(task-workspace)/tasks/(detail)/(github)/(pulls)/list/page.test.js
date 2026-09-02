import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pulls-list-page").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) delete globalThis.CSS;
  else globalThis.CSS = previousCss;
});

test("provides Pull Request rows through their existing native controls", () => {
  const focusOptions = [];
  let clicks = 0;
  const control = {
    dataset: { pullNumber: "7" },
    disabled: false,
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
    selectedPullNumber: null,
    state: { status: "ready", payload: { pulls: [{ number: 7, title: "Ship it" }] } },
    querySelectorAll: () => [control],
    querySelector(selector) {
      if (selector.includes("caffold-pagination")) return null;
      if (selector.endsWith(" > .github-pulls-list")) return {};
      if (selector.includes("button.github-pull-button")) return control;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const target = page.actionHintScope.call(owner).targets[0];
  assert.equal(target.id, "github:pulls:pull:7");
  assert.equal(target.actionId, "navigation.pull.open");
  assert.equal(target.label, "Open pull request #7: Ship it");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  owner.selectedPullNumber = 7;
  assert.equal(target.isActionable(), false);
});

test("provides only the retained Pull Request list", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 360,
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
  scrollport.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), true);
});
