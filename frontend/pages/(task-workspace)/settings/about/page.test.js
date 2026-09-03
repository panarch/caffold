import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const buildInfoHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("build-info.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const BUILD_INFO={id:'test',version:'test',number:0}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const about = registry.element("caffold-settings-about-page").prototype;
after(() => {
  registry.restore();
  buildInfoHook.deregister();
});

function button(label) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}

test("provides current About actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const reload = button("Reload to update");
  const copy = button("Copy diagnostics");
  const controls = new Map([
    ['button[data-action="reload-update"]', reload],
    ['button[data-action="copy-diagnostics"]', copy],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = about.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:about:reload-update",
    "settings:about:copy-diagnostics",
  ]);
  assert.equal(about.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  reload.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
});
