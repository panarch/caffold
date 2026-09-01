import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const codex = registry.element("caffold-settings-codex-page").prototype;
after(() => registry.restore());

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

test("provides current Codex actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refresh = button("Refresh");
  const copy = button("Copy command");
  const restart = button("Restart runtime");
  const controls = new Map([
    ['button[data-action="refresh-codex-status"]', refresh],
    ['button[data-action="copy-codex-install"]', copy],
    ['button[data-action="open-codex-restart"]', restart],
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

  const scope = codex.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:codex:refresh",
    "settings:codex:copy-install-command",
    "settings:codex:restart-runtime",
  ]);
  assert.equal(codex.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  refresh.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
});
