import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const remoteAccess = registry.element(
  "caffold-settings-remote-access-page",
).prototype;
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

test("provides only current retained actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refresh = button("Refresh");
  const retry = button("Retry");
  const copy = button("Copy link");
  copy.getClientRects = () => [];
  const controls = new Map([
    ['button[data-action="refresh"]', refresh],
    ['button[data-action="retry"]', retry],
    ['button[data-action="copy"]', copy],
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

  const scope = remoteAccess.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:remote-access:refresh",
    "settings:remote-access:retry",
  ]);
  retry.hidden = true;
  assert.equal(scope.targets[1].isActionable(), false);
  assert.equal(
    remoteAccess.scrollSurfaceScope.call(owner).surfaces[0].scrollport,
    scrollport,
  );
});
