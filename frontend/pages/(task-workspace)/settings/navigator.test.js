import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.js");
const navigator = registry.element("caffold-settings-navigator").prototype;
after(() => registry.restore());

test("combines its Settings entries' Action Hints inside the section list", () => {
  const scroller = {};
  const requests = [];
  const items = ["keyboard", "about"].map((section) => ({
    actionHintScope(options) {
      requests.push(options);
      return {
        blocked: false,
        targets: [{ id: `settings:section:${section}` }],
        mutationRoots: [this],
        scrollRoots: [],
      };
    },
  }));
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    querySelector: () => scroller,
    items: () => items,
  };

  const scope = navigator.actionHintScope.call(owner, {
    clipRoots: [owner],
  });
  assert.deepEqual(
    scope.targets.map(({ id }) => id),
    ["settings:section:keyboard", "settings:section:about"],
  );
  assert.deepEqual(scope.mutationRoots, [owner, ...items]);
  assert.deepEqual(scope.scrollRoots, [scroller]);
  assert.ok(requests.every(({ scopeId, clipRoots }) =>
    scopeId === "settings" &&
    clipRoots.length === 2 &&
    clipRoots[0] === owner &&
    clipRoots[1] === scroller
  ));

  assert.equal(requests[0].isCurrent(), true);
  owner.hidden = true;
  assert.equal(requests[0].isCurrent(), false);
  assert.deepEqual(navigator.actionHintScope.call(owner).targets, []);
});

test("provides only its exact retained section list as a Scroll surface", () => {
  const scroller = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => scroller,
  };
  const scope = navigator.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scroller);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scroller.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.deepEqual(navigator.scrollSurfaceScope.call(owner).surfaces, []);
});

test("hands the update mark to the About entry only", () => {
  const marks = new Map();
  const items = ["codex", "about"].map((section) => ({
    section,
    setUpdateAvailable(available) {
      marks.set(section, available);
    },
  }));
  const owner = { items: () => items };
  owner.syncUpdateAvailable = () => navigator.syncUpdateAvailable.call(owner);

  navigator.setCaffoldUpdate.call(owner, {
    checking: false,
    status: { updateAvailable: true },
  });
  assert.deepEqual([...marks], [["about", true]]);

  navigator.setCaffoldUpdate.call(owner, { checking: true, status: null });
  assert.deepEqual([...marks], [["about", false]]);
});
