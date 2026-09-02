import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-viewer.js");
const fileViewer = registry.element("caffold-review-file-viewer").prototype;
after(() => registry.restore());

test("provides only the visible owned Back or close button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Back to changed files" : null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    closeLabel: "Close file",
    querySelector() {
      return control;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:close",
      actionId: "navigation.parent",
      label: "Back to changed files",
      controlKind: "button",
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  control = null;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
  }).targets, []);
});

test("provides a direct notice representation action through its owned button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let noticeControl = {
    dataset: { action: "view-preview" },
    disabled: false,
    textContent: "View rendered preview",
    getAttribute() {
      return null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector.includes('data-action="close-browser-viewer"')) {
        return null;
      }
      return noticeControl;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    noticeActionId: "navigation.review.axis",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:notice:view-preview",
      actionId: "navigation.review.axis",
      label: "View rendered preview",
      controlKind: "button",
    },
  );
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  noticeControl = null;
  assert.equal(target.isActionable(), false);
});

test("provides file details opener but no invented action inside its popover", () => {
  const control = {
    disabled: false,
    focus() {},
    click() {},
    getAttribute(name) {
      return name === "aria-label"
        ? "Show details for PLAN.md"
        : name === "popovertarget"
          ? "file-details"
          : null;
    },
  };
  const dialog = {};
  const hud = {};
  const selector = {};
  const presentation = {
    actionHintDialog: () => dialog,
    scrollModeHud: () => hud,
    scrollSurfaceSelector: () => selector,
  };
  const popover = {
    id: "file-details",
    matches: () => false,
    querySelector(selector) {
      return selector.includes("keyboard-navigation-presentation")
        ? presentation
        : {};
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    detailsPopover: () => popover,
    hasDetailsMetadata: () => true,
    querySelector(selector) {
      if (selector.includes("viewer-info-button")) {
        return control;
      }
      return null;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    detailsActionId: "navigation.file-details.open",
  });
  assert.equal(scope.targets[0].actionId, "navigation.file-details.open");
  assert.equal(scope.targets[0].label, "Show details for PLAN.md");
  assert.equal(scope.targets[0].isActionable(), true);

  const [context] = fileViewer.keyboardNavigationContexts.call(owner, {
    scopeId: "review:viewer",
  });
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.dialog, dialog);
  assert.deepEqual(context.actionHints.scope.targets, []);
  assert.equal(context.scroll.hud, hud);
  assert.equal(context.scroll.selector, selector);
  assert.equal(context.scroll.scope.surfaces[0].scrollport, popover);
});

test("provides its owned refresh button beside existing viewer actions", () => {
  let current;
  let clicks = 0;
  const refresh = {
    disabled: false,
    getAttribute: () => "Refresh file",
    focus() {},
    click() {
      clicks += 1;
    },
  };
  current = refresh;
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      return selector.includes("viewer-refresh-button") ? current : null;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    refreshActionId: "button.activate",
  });
  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].id, "review:viewer:refresh");
  assert.equal(scope.targets[0].label, "Refresh file");
  scope.targets[0].activate();
  assert.equal(clicks, 1);

  current = null;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("merges only the current Markdown preview Action Hint scope", () => {
  const state = { status: "markdown" };
  const previewTarget = { id: "preview-link" };
  let received;
  let preview = {
    actionHintScope(options) {
      received = options;
      return {
        blocked: false,
        targets: [previewTarget],
        mutationRoots: [this],
        scrollRoots: [this],
      };
    },
  };
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      return selector.includes("caffold-markdown-preview") ? preview : null;
    },
  };
  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    linkActionId: "link.open",
    clipRoots: [{ id: "layout" }],
  });

  assert.deepEqual(scope.targets, [previewTarget]);
  assert.equal(received.scopeId, "review:viewer:preview");
  assert.equal(received.linkActionId, "link.open");
  assert.deepEqual(received.clipRoots, [owner, { id: "layout" }]);
  assert.equal(received.isCurrent(), true);
  preview = null;
  assert.equal(received.isCurrent(), false);
  owner.state = { status: "file" };
  assert.deepEqual(fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
  }).targets, []);
});

test("delegates source scrolling and invalidates it when viewer state changes", () => {
  const state = {
    status: "file",
    presentation: { title: "PLAN.md" },
  };
  let received;
  const childScope = { surfaces: [{ id: "source" }] };
  const codeViewer = {
    scrollSurfaceScope(options) {
      received = options;
      return childScope;
    },
  };
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    querySelector: () => codeViewer,
  };

  assert.equal(fileViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer",
  }), childScope);
  assert.equal(received.scopeId, "review:viewer:source");
  assert.equal(received.label, "PLAN.md source");
  assert.equal(received.isCurrent(), true);

  owner.state = { ...state };
  assert.equal(received.isCurrent(), false);
});

test("keeps an owned image surface bound to its exact retained scrollport", () => {
  const state = { status: "image", image: { name: "shot.png" } };
  const scrollport = {
    isConnected: true,
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  let current = scrollport;
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => current,
    ownScrollSurfaceScope(options) {
      return fileViewer.ownScrollSurfaceScope.call(this, options);
    },
  };

  const scope = fileViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer",
  });
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = { ...scrollport };
  assert.equal(scope.surfaces[0].isEligible(), false);
});
