import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./git-menu.js");
const gitMenu = registry.element("caffold-task-detail-git").prototype;
after(() => registry.restore());

test("provides the Git opener and exact retained popover actions", () => {
  const compare = option("compare", "Compare");
  const log = option("log", "Log");
  const { owner, control, popover } = menuOwner([compare, log]);

  const opener = gitMenu.actionHintScope.call(owner, {
    scopeId: "detail:task:a",
  }).targets[0];
  assert.equal(opener.actionId, "navigation.git.open");
  assert.equal(opener.isActionable(), true);
  opener.activate();
  assert.equal(control.clicks, 1);

  popover.open = true;
  const scope = gitMenu.gitActionHintScope.call(owner, {
    contextId: "detail:task:a:git",
    popover,
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      {
        id: "detail:task:a:git:compare",
        actionId: "navigation.git.destination",
      },
      {
        id: "detail:task:a:git:log",
        actionId: "navigation.git.destination",
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
        ? "Open Git workspace"
        : name === "popovertarget"
          ? "git-actions"
          : null;
    },
  };
  const popover = {
    id: "git-actions",
    open: false,
    matches: () => popover.open,
    contains: (candidate) => options.includes(candidate),
    querySelectorAll: () => options,
  };
  const owner = {
    isConnected: true,
    snapshot: { available: true },
    ensureState() {},
    gitTrigger: () => control,
    gitPopover: () => popover,
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
