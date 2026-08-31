import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-shortcuts.js");
const shortcuts = registry.element("caffold-section-github-shortcuts").prototype;
after(() => registry.restore());

test("provides available direct Issues and Pull Requests native controls", () => {
  let clicks = 0;
  const controls = new Map(["issues", "pulls"].map((kind) => [kind, {
    disabled: false,
    focus() {},
    click() {
      clicks += 1;
    },
  }]));
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    githubStatus: { github: { nameWithOwner: "openai/caffold" } },
    ensureRendered() {},
    querySelector(selector) {
      const kind = selector.match(/data-section-github-kind="([^"]+)"/)?.[1];
      return controls.get(kind) ?? null;
    },
  };

  const scope = shortcuts.actionHintScope.call(owner, {
    scopeId: "section:section-a",
    clipRoots: [owner],
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      {
        id: "section:section-a:github:issues",
        actionId: "navigation.github.mode",
      },
      {
        id: "section:section-a:github:pulls",
        actionId: "navigation.github.mode",
      },
    ],
  );
  assert.ok(scope.targets.every(({ isActionable }) => isActionable()));
  scope.targets[0].activate();
  assert.equal(clicks, 1);

  owner.githubStatus = null;
  assert.ok(scope.targets.every(({ isActionable }) => !isActionable()));
});
