import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.ts");
const jevPage = registry.element("caffold-settings-jev-page").prototype;
after(() => registry.restore());

function control({ disabled = false, label = "" } = {}) {
  return {
    disabled,
    hidden: false,
    labels: label ? [{ textContent: label }] : [],
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}

test("offers its rules and key fields while they can be edited", () => {
  const scrollport = { getClientRects: () => [{}] };
  const saveRules = control();
  const rules = control({ label: "Extra rules" });
  const key = control({ label: "Replace API key" });
  const controls = new Map([
    ['form[data-jev-form="criteria"] button[type="submit"]', saveRules],
    ['textarea[name="criteria"]', rules],
    ['input[name="key"]', key],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = jevPage.actionHintScope.call(owner);

  assert.deepEqual(
    scope.targets.map(({ id, actionId, controlKind, label }) => ({
      id,
      actionId,
      controlKind,
      label,
    })),
    [
      {
        id: "settings:jev:save-criteria",
        actionId: "button.activate",
        controlKind: "button",
        label: "Save the extra rules",
      },
      {
        id: "settings:jev:criteria",
        actionId: "control.textbox.focus",
        controlKind: "textbox",
        label: "Focus Extra rules",
      },
      {
        id: "settings:jev:key",
        actionId: "control.textbox.focus",
        controlKind: "textbox",
        label: "Focus Replace API key",
      },
    ],
  );
  rules.disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  assert.deepEqual(
    jevPage.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["settings:jev:save-criteria", "settings:jev:key"],
  );
  controls.set('input[name="key"]', control({ label: "API key" }));
  assert.equal(scope.targets[2].isActionable(), false);
});
