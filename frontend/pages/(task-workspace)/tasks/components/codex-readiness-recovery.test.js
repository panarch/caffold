import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./codex-readiness-recovery.js");
const readiness = registry.element("caffold-codex-readiness-recovery").prototype;
after(() => registry.restore());

function button(action, { hidden = false } = {}) {
  return {
    dataset: { codexReadinessAction: action },
    disabled: false,
    hidden,
    textContent: action,
    clicks: 0,
    getAttribute: () => null,
    getClientRects() {
      return this.hidden ? [] : [{}];
    },
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides only visible readiness actions and its retained surface", () => {
  const controls = new Map([
    ["copy-command", button("copy-command")],
    ["restart", button("restart", { hidden: true })],
    ["retry", button("retry")],
    ["settings", button("settings")],
  ]);
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector.includes("codex-readiness-surface")) return scrollport;
      for (const [action, control] of controls) {
        if (selector.includes(`\"${action}\"`)) return control;
      }
      return null;
    },
  };

  const scope = readiness.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "codex-readiness:copy-command",
    "codex-readiness:retry",
    "codex-readiness:settings",
  ]);
  scope.targets.forEach((target) => target.activate());
  assert.deepEqual(
    ["copy-command", "retry", "settings"].map(
      (action) => controls.get(action).clicks,
    ),
    [1, 1, 1],
  );
  controls.get("retry").disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  const scrollScope = readiness.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  controls.get("restart").hidden = false;
  assert.deepEqual(
    readiness.actionHintScope.call(owner).targets.map(({ id }) => id),
    [
      "codex-readiness:copy-command",
      "codex-readiness:restart",
      "codex-readiness:settings",
    ],
  );
  scrollport.scrollHeight = 100;
  assert.equal(scrollScope.surfaces[0].isEligible(), false);
});
