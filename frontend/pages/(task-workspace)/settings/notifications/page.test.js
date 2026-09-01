import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const notifications = registry.element(
  "caffold-settings-notifications-page",
).prototype;
after(() => registry.restore());

test("notification permission is requested only by the explicit Enable action", () => {
  const pagePath = fileURLToPath(new URL("./page.js", import.meta.url));
  const source = readFileSync(pagePath, "utf8");
  const enableBranch = source.slice(
    source.indexOf('if (action === "enable")'),
    source.indexOf('if (action === "disable")'),
  );
  assert.equal(source.match(/Notification\.requestPermission\(\)/g)?.length, 1);
  assert.match(enableBranch, /Notification\.requestPermission\(\)/);
});

function button(label) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    dataset: {},
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides current notification actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refresh = button("Refresh");
  const enable = button("Enable");
  const remove = button("Remove");
  remove.dataset.clientId = "browser-a";
  const controls = new Map([
    ['button[data-action="refresh"]', refresh],
    ['button[data-action="enable"]', enable],
    ['button[data-action="remove-installation"][data-client-id]', remove],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    installations: [{ clientId: "browser-a", installationLabel: "Laptop" }],
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
    querySelectorAll(selector) {
      const control = controls.get(selector);
      return control ? [control] : [];
    },
  };

  const scope = notifications.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:notifications:refresh",
    "settings:notifications:enable",
    "settings:notifications:remove-installation:browser-a",
  ]);
  assert.equal(scope.targets[2].label, "Remove Laptop");
  scope.targets[2].activate();
  assert.equal(remove.clicks, 1);
  remove.disabled = true;
  assert.equal(scope.targets[2].isActionable(), false);
  assert.equal(
    notifications.scrollSurfaceScope.call(owner).surfaces[0].scrollport,
    scrollport,
  );
});
