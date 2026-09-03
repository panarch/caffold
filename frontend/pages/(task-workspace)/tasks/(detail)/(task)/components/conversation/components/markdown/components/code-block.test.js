import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./code-block.js");
const codeBlock = registry.element("caffold-task-markdown-code-block").prototype;
after(() => registry.restore());

function button(action, label) {
  return {
    dataset: { codeAction: action },
    disabled: false,
    title: "",
    attributes: new Map(),
    clicks: 0,
    getAttribute(name) {
      return this.attributes.get(name) ?? (name === "aria-label" ? label : null);
    },
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides retained Wrap and Copy code buttons", () => {
  const wrap = button("wrap", "Wrap code lines");
  const copy = button("copy", "Copy code");
  const controls = new Map([["wrap", wrap], ["copy", copy]]);
  const owner = {
    connected: true,
    hidden: false,
    isConnected: true,
    ensureDom() {},
    querySelector(selector) {
      for (const [action, control] of controls) {
        if (selector.includes(`\"${action}\"`)) return control;
      }
      return null;
    },
  };
  const scope = codeBlock.actionHintScope.call(owner, {
    scopeId: "message:a:code-block:1",
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "message:a:code-block:1:wrap",
    "message:a:code-block:1:copy",
  ]);
  scope.targets.forEach((target) => target.activate());
  assert.deepEqual([wrap.clicks, copy.clicks], [1, 1]);
  copy.attributes.set("aria-disabled", "true");
  assert.equal(scope.targets[1].isActionable(), false);
  owner.connected = false;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("provides only its exact retained horizontal code scrollport", () => {
  const pre = layoutElement();
  let currentPre = pre;
  let current = true;
  const owner = layoutElement({
    connected: true,
    hidden: false,
    isConnected: true,
    pre: () => currentPre,
  });

  const scope = codeBlock.scrollSurfaceScope.call(owner, {
    scopeId: "message:a:code-block:1",
    label: "JavaScript code block 1",
    isCurrent: () => current,
  });
  const surface = scope.surfaces[0];
  assert.equal(surface.id, "message:a:code-block:1:scroll");
  assert.equal(surface.label, "JavaScript code block 1");
  assert.equal(surface.scrollport, pre);
  assert.deepEqual(surface.axes, ["horizontal"]);
  assert.equal(surface.isEligible(), true);
  currentPre = layoutElement();
  assert.equal(surface.isEligible(), false);
  currentPre = pre;
  current = false;
  assert.equal(surface.isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
