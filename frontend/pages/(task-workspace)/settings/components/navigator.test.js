import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.js");
const navigator = registry.element("caffold-settings-navigator").prototype;
after(() => registry.restore());

test("combines its Settings entries' Action Hints inside the section list", () => {
  const list = {};
  const pulls = [];
  const item = (section) => ({
    actionHintScope(pull) {
      pulls.push(pull);
      return { targets: [{ id: `settings:section:${section}` }] };
    },
  });
  const items = new Map([["keyboard", item("keyboard")], ["about", item("about")]]);
  const owner = Object.assign(Object.create(navigator), {
    hints: { scope: () => ({ targets: [], mutationRoots: [owner] }) },
    list: { value: list },
    items: { get: (section) => items.get(section) },
  });
  const pane = {};

  const scope = owner.actionHintScope({ clipRoots: [pane] });
  assert.deepEqual(
    scope.targets.map(({ id }) => id),
    ["settings:section:keyboard", "settings:section:about"],
  );
  assert.deepEqual(pulls, [
    { scopeId: "settings", clipRoots: [pane, list] },
    { scopeId: "settings", clipRoots: [pane, list] },
  ]);
});
