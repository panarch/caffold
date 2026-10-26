import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./navigation.ts");
const Navigation = registry.element("caffold-task-workspace-navigation");
const { ActionHints } = await import("#app/action-hints.ts");
after(() => registry.restore());

test("marks exactly the chosen workspace mode as current", () => {
  const owner = Object.create(
    Navigation.prototype,
    Object.getOwnPropertyDescriptors({ mode: "tasks", draw() {} }),
  );

  for (const mode of ["notes", "settings", "tasks"]) {
    owner.setMode(mode);
    assert.equal(owner.mode, mode);
    assert.deepEqual(currentModes(owner), [mode]);
  }
  owner.setMode("unknown");
  assert.equal(owner.mode, "tasks");
  assert.deepEqual(currentModes(owner), ["tasks"]);
});

test("marks the Settings button and its name while a newer Caffold exists", () => {
  const owner = Object.create(
    Navigation.prototype,
    Object.getOwnPropertyDescriptors({
      mode: "tasks",
      updateAvailable: false,
      reloadReady: false,
      draw() {},
    }),
  );

  owner.setCaffoldUpdate({ checking: false, status: { updateAvailable: true } });
  assert.deepEqual(settingsButton(owner), {
    marked: true,
    label: "Settings — Caffold update available",
  });

  owner.setCaffoldUpdate({ checking: false, status: { updateAvailable: false } });
  assert.deepEqual(settingsButton(owner), { marked: false, label: null });

  owner.setCaffoldUpdate(null);
  assert.deepEqual(settingsButton(owner), { marked: false, label: null });

  // A new build this window can load marks the same button.
  owner.setUpdateStatus({ state: "ready", preparedUpdate: { ready: true } });
  assert.deepEqual(settingsButton(owner), {
    marked: true,
    label: "Settings — reload to update",
  });
  owner.setCaffoldUpdate({ checking: false, status: { updateAvailable: true } });
  assert.deepEqual(settingsButton(owner), {
    marked: true,
    label: "Settings — Caffold update available, reload to update",
  });
  owner.setCaffoldUpdate(null);
  owner.setUpdateStatus({ state: "settled", preparedUpdate: { ready: false } });
  assert.deepEqual(settingsButton(owner), { marked: false, label: null });
});

function buttons(owner) {
  owner.hints ??= new ActionHints(owner, () => {});
  return templateHtml(owner.render())
    .replace(/\s+/g, " ")
    .split("<button")
    .slice(1);
}

function currentModes(owner) {
  return buttons(owner)
    .filter((button) => button.includes('?aria-current="true"'))
    .map((button) => button.match(/data-workspace-mode="([^"]+)"/)[1]);
}

function settingsButton(owner) {
  const settings = buttons(owner).find((button) =>
    button.includes('data-workspace-mode="settings"')
  );
  return {
    marked: settings.includes('?data-update-available="true"'),
    label: settings.match(/aria-label="([^"]+)"/)?.[1] ?? null,
  };
}
