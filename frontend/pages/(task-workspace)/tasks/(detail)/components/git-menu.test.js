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
  assert.equal(scope.targets.every(({ badgeAtEnd }) => badgeAtEnd), true);
  assert.equal(opener.badgeAtEnd, false);
});

test("closes its popover when the bound Action Hint session is dismissed", () => {
  const { owner, popover } = menuOwner([]);
  owner.deactivate = gitMenu.deactivate;
  let hidden = 0;
  popover.open = true;
  popover.hidePopover = () => {
    hidden += 1;
    popover.open = false;
  };
  gitMenu.handleDismiss.call(owner, { target: {} });
  assert.equal(hidden, 0);
  gitMenu.handleDismiss.call(owner, { target: popover });
  assert.equal(hidden, 1);
});

test("declares a session-bound Action Hint context for its retained popover context", () => {
  const { owner, popover } = menuOwner([option("compare", "Compare")]);
  popover.querySelector = () => presentation();
  owner.gitActionHintScope = gitMenu.gitActionHintScope;

  const [context] = gitMenu.keyboardNavigationContexts.call(owner, {
    scopeId: "detail:task:a",
  });

  assert.equal(context.id, "detail:task:a:git");
  assert.equal(context.kind, "popover");
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.sessionBound, true);
});

function presentation() {
  return {
    actionHintDialog: () => ({}),
    scrollModeHud: () => ({}),
    scrollSurfaceSelector: () => ({}),
  };
}

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
