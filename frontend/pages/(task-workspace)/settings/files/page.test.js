import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const files = registry.element("caffold-settings-files-page").prototype;
after(() => registry.restore());

test("provides only the exact retained file settings scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: (selector) =>
      selector === ":scope > .settings-files-scroll" ? scrollport : null,
  };

  assert.deepEqual(files.actionHintScope.call(owner).targets, []);
  const scope = files.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.deepEqual(files.scrollSurfaceScope.call(owner).surfaces, []);
});

test("provides only the alternative file ordering through its native radio", () => {
  const scrollport = {};
  const foldersFirst = radio({ checked: true });
  const name = radio();
  const controls = new Map([
    [":scope > .settings-files-scroll", scrollport],
    [
      'input[type="radio"][data-file-sort-mode][value="folders-first"]',
      foldersFirst,
    ],
    ['input[type="radio"][data-file-sort-mode][value="name"]', name],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector: (selector) => controls.get(selector) ?? null,
  };

  const scope = files.actionHintScope.call(owner);
  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].id, "settings:files:sort:name");
  assert.equal(scope.targets[0].controlKind, "radio");
  assert.equal(scope.targets[0].label, "Use All entries by name ordering");
  scope.targets[0].activate();
  assert.equal(name.focused, 1);
  assert.equal(name.clicks, 1);

  name.checked = true;
  assert.equal(scope.targets[0].isActionable(), false);
  controls.set(
    'input[type="radio"][data-file-sort-mode][value="name"]',
    radio(),
  );
  assert.equal(scope.targets[0].isActionable(), false);
});

function radio({ checked = false } = {}) {
  return {
    checked,
    disabled: false,
    hidden: false,
    focused: 0,
    clicks: 0,
    closest: () => null,
    getClientRects: () => [{}],
    focus() {
      this.focused += 1;
    },
    click() {
      this.clicks += 1;
    },
  };
}
