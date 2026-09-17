import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const claude = registry.element("caffold-settings-claude-page").prototype;
after(() => registry.restore());

test("provides the current refresh and restart actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refreshRequests = [];
  const restart = {
    disabled: false,
    hidden: false,
    textContent: "Restart runtime",
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    refreshButton: {
      actionHintScope(request) {
        refreshRequests.push(request);
        return { targets: [{ id: `${request.scopeId}:refresh` }] };
      },
    },
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      if (selector === 'button[data-action="open-claude-restart"]') {
        return restart;
      }
      return null;
    },
  };

  const scope = claude.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:claude:refresh",
    "settings:claude:restart-runtime",
  ]);
  assert.deepEqual(refreshRequests[0].clipRoots, [owner, scrollport]);
  assert.equal(refreshRequests[0].isCurrent(), true);
  assert.equal(claude.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  restart.disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  assert.deepEqual(claude.actionHintScope.call(owner).targets.map(({ id }) => id), [
    "settings:claude:refresh",
  ]);
  owner.hidden = true;
  assert.equal(refreshRequests[0].isCurrent(), false);
});
