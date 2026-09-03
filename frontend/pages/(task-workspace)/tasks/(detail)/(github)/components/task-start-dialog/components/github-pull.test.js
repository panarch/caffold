import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-pull.js");
const pullSource = registry.element("caffold-github-pull-task-source").prototype;
after(() => registry.restore());

test("provides Refresh PR only from the exact current error control", () => {
  const control = {
    disabled: false,
    textContent: "Refresh PR",
    focus() {},
    click() {},
  };
  const owner = {
    isConnected: true,
    hidden: false,
    repository: { rootPath: "repo" },
    pending: false,
    locked: false,
    source: () => ({ number: 7 }),
    querySelector: () => control,
  };
  const target = pullSource.actionHintScope.call(owner, {
    scopeId: "github-task-start:pull:7",
  }).targets[0];

  assert.equal(target.id, "github-task-start:pull:7:refresh");
  assert.equal(target.isActionable(), true);
  owner.pending = true;
  assert.equal(target.isActionable(), false);
});

test("provides the exact Pull base and head relationship scrollport", () => {
  const relationship = layoutElement();
  let current = relationship;
  const owner = layoutElement({
    isConnected: true,
    hidden: false,
    repository: { rootPath: "repo" },
    source: () => ({ number: 7 }),
    querySelector: () => current,
  });

  const scope = pullSource.scrollSurfaceScope.call(owner, {
    scopeId: "github-task-start:pull:7:source",
  });
  const surface = scope.surfaces[0];
  assert.equal(
    surface.id,
    "github-task-start:pull:7:source:relationship",
  );
  assert.equal(surface.scrollport, relationship);
  assert.deepEqual(surface.axes, ["horizontal"]);
  assert.equal(surface.isEligible(), true);
  current = layoutElement();
  assert.equal(surface.isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
