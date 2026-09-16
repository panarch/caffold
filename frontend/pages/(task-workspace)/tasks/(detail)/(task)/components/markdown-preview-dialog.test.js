import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown-preview-dialog.js");
const previewDialog = registry.element(
  "caffold-task-markdown-preview-dialog",
).prototype;
after(() => registry.restore());

test("renders each requested Markdown from the top of the retained preview", () => {
  const rendered = [];
  const preview = {
    setMarkdown: (markdown, options) => rendered.push([markdown, options]),
  };
  let shown = 0;
  const dialog = {
    open: false,
    showModal() {
      shown += 1;
      this.open = true;
    },
  };
  const owner = { dialog: () => dialog, preview: () => preview };

  previewDialog.openMarkdown.call(owner, { markdown: "# One" });
  previewDialog.openMarkdown.call(owner, { markdown: "# Two" });

  assert.deepEqual(rendered, [
    ["# One", { scroll: { top: 0, left: 0 } }],
    ["# Two", { scroll: { top: 0, left: 0 } }],
  ]);
  assert.equal(shown, 1);
  assert.equal(owner.opener, null);
});

test("provides Close and merges the current preview link scope", () => {
  const close = actionControl("Close Markdown preview");
  const previewTarget = { id: "preview-link" };
  let received;
  const preview = {
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
  const dialog = {
    open: true,
    querySelector: (selector) =>
      selector === ".task-markdown-preview-close" ? close : null,
  };
  const owner = dialogOwner({ dialog, preview });

  const scope = previewDialog.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task-markdown-preview:thread%2F1:close",
    "preview-link",
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  assert.equal(received.scopeId, "task-markdown-preview:thread%2F1:preview");
  assert.equal(received.linkActionId, "link.open");
  assert.deepEqual(received.clipRoots, [dialog]);
  assert.equal(received.isCurrent(), true);
  dialog.open = false;
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(received.isCurrent(), false);
  dialog.open = true;
  owner.threadId = "thread/2";
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(received.isCurrent(), false);
});

test("provides its exact modal context and preview scrollport", () => {
  const hintDialog = {};
  const hud = { show() {}, close() {}, updateLabel() {} };
  const selector = {};
  const presentation = {
    actionHintDialog: () => hintDialog,
    scrollModeHud: () => hud,
    scrollSurfaceSelector: () => selector,
  };
  const actionScope = { targets: [{ id: "close" }] };
  const preview = {
    clientHeight: 300,
    scrollHeight: 900,
    hidden: false,
    getClientRects: () => [{}],
    scrollSurfaceScope(options) {
      return {
        blocked: false,
        surfaces: [{
          id: `${options.scopeId}:scroll`,
          label: options.label,
          scrollport: this,
          axes: ["vertical", "horizontal"],
          clipRoots: [this, ...options.clipRoots],
          isEligible: options.isCurrent,
        }],
        mutationRoots: [this],
        resizeElements: [this],
        scrollRoots: [this],
      };
    },
  };
  const dialog = {
    open: true,
    getClientRects: () => [{}],
    querySelector(selectorText) {
      assert.equal(
        selectorText,
        ":scope > caffold-keyboard-navigation-presentation",
      );
      return presentation;
    },
  };
  const owner = {
    ...dialogOwner({ dialog, preview }),
    actionHintScope: () => actionScope,
  };

  const [context] = previewDialog.keyboardNavigationContexts.call(owner);
  const surface = context.scroll.scope.surfaces[0];

  assert.equal(context.id, "task-markdown-preview:thread%2F1");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, dialog);
  assert.equal(context.actionHints.dialog, hintDialog);
  assert.deepEqual(context.actionHints.scope.targets, actionScope.targets);
  assert.equal(context.scroll.hud, hud);
  assert.equal(context.scroll.selector, selector);
  assert.equal(surface.id, "task-markdown-preview:thread%2F1:preview:scroll");
  assert.equal(surface.label, "Markdown preview");
  assert.equal(surface.scrollport, preview);
  assert.deepEqual(surface.axes, ["vertical", "horizontal"]);
  assert.equal(surface.isEligible(), true);
  owner.threadId = "thread/2";
  assert.equal(surface.isEligible(), false);
});

test("returns focus to a connected opener only once the dialog has closed", () => {
  let focused = 0;
  const opener = {
    isConnected: true,
    focus() {
      focused += 1;
    },
  };
  const dialog = { open: true };
  const owner = { opener, dialog: () => dialog };

  previewDialog.handleClose.call(owner);
  assert.equal(focused, 0);
  assert.equal(owner.opener, opener);

  dialog.open = false;
  previewDialog.handleClose.call(owner);
  assert.equal(focused, 1);
  assert.equal(owner.opener, null);

  owner.opener = {
    isConnected: false,
    focus() {
      focused += 1;
    },
  };
  previewDialog.handleClose.call(owner);
  assert.equal(focused, 1);
  assert.equal(owner.opener, null);
});

test("closes without returning focus when its Task changes", () => {
  let closed = 0;
  const dialog = {
    open: true,
    close() {
      closed += 1;
      this.open = false;
    },
  };
  const opener = { isConnected: true, focus() {} };
  const owner = {
    threadId: "",
    opener,
    dialog: () => dialog,
    dismiss: previewDialog.dismiss,
  };

  previewDialog.setThreadId.call(owner, "thread/1");
  previewDialog.setThreadId.call(owner, "thread/1");
  assert.equal(closed, 0);
  assert.equal(owner.opener, opener);

  previewDialog.setThreadId.call(owner, "thread/2");
  assert.equal(closed, 1);
  assert.equal(owner.opener, null);
  assert.equal(owner.threadId, "thread/2");
});

function dialogOwner({ dialog, preview }) {
  return {
    isConnected: true,
    threadId: "thread/1",
    dialog: () => dialog,
    preview: () => preview,
    isCurrentDialog: previewDialog.isCurrentDialog,
  };
}

function actionControl(label) {
  return {
    disabled: false,
    getAttribute: (name) => name === "aria-label" ? label : "",
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}
