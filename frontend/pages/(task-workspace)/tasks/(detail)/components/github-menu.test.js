import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-menu.js");
const githubMenu = registry.element("caffold-task-detail-github").prototype;
after(() => registry.restore());

test("provides the GitHub opener and exact retained popover actions", () => {
  const pulls = option("pulls", "Pull Requests");
  const issues = option("issues", "Issues");
  const { owner, control, popover } = menuOwner([pulls, issues]);

  const opener = githubMenu.actionHintScope.call(owner, {
    scopeId: "detail:task:a",
  }).targets[0];
  assert.equal(opener.actionId, "navigation.github.open");
  assert.equal(opener.isActionable(), true);
  opener.activate();
  assert.equal(control.clicks, 1);

  popover.open = true;
  const scope = githubMenu.githubActionHintScope.call(owner, {
    contextId: "detail:task:a:github",
    popover,
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      {
        id: "detail:task:a:github:pulls",
        actionId: "navigation.github.destination",
      },
      {
        id: "detail:task:a:github:issues",
        actionId: "navigation.github.destination",
      },
    ],
  );
  assert.equal(scope.targets.every(({ isActionable }) => isActionable()), true);
});

function menuOwner(options) {
  const control = {
    disabled: false,
    clicks: 0,
    focus() {},
    click() {
      this.clicks += 1;
    },
    getAttribute(name) {
      return name === "aria-label"
        ? "Open GitHub workspace"
        : name === "popovertarget"
          ? "github-actions"
          : null;
    },
  };
  const popover = {
    id: "github-actions",
    open: false,
    matches: () => popover.open,
    contains: (candidate) => options.includes(candidate),
    querySelectorAll: () => options,
  };
  const owner = {
    isConnected: true,
    snapshot: { available: true },
    ensureState() {},
    githubTrigger: () => control,
    githubPopover: () => popover,
  };
  return { owner, control, popover };
}

function option(reviewKind, label) {
  return {
    dataset: { reviewKind },
    disabled: false,
    textContent: label,
    focus() {},
    click() {},
  };
}
