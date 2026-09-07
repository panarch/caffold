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
  assert.equal(scope.targets.every(({ badgeAtEnd }) => badgeAtEnd), true);
  assert.equal(opener.badgeAtEnd, false);
});

test("closes its popover when the bound Action Hint session is dismissed", () => {
  const { owner, popover } = menuOwner([]);
  owner.deactivate = githubMenu.deactivate;
  let hidden = 0;
  popover.open = true;
  popover.hidePopover = () => {
    hidden += 1;
    popover.open = false;
  };
  githubMenu.handleDismiss.call(owner, { target: {} });
  assert.equal(hidden, 0);
  githubMenu.handleDismiss.call(owner, { target: popover });
  assert.equal(hidden, 1);
});

test("declares a session-bound Action Hint context for its retained popover context", () => {
  const { owner, popover } = menuOwner([option("pulls", "Pull requests")]);
  popover.querySelector = () => presentation();
  owner.githubActionHintScope = githubMenu.githubActionHintScope;

  const [context] = githubMenu.keyboardNavigationContexts.call(owner, {
    scopeId: "detail:task:a",
  });

  assert.equal(context.id, "detail:task:a:github");
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
