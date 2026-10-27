import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown-preview-dialog.js");
const PreviewDialog = registry.element("caffold-task-markdown-preview-dialog");
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
  const owner = dialogHost({
    dialog: { value: dialog },
    preview: { value: preview },
  });

  owner.openMarkdown({ markdown: "# One" });
  owner.openMarkdown({ markdown: "# Two" });

  assert.deepEqual(rendered, [
    ["# One", { scroll: { top: 0, left: 0 } }],
    ["# Two", { scroll: { top: 0, left: 0 } }],
  ]);
  assert.equal(shown, 1);
  assert.equal(owner.opener, null);
});

test("merges its own Close with its preview's links and scrolling", () => {
  const previewPulls = {};
  const preview = {
    actionHintScope(pull) {
      previewPulls.actions = pull;
      return { targets: [{ id: "preview-link" }] };
    },
    scrollSurfaceScope(pull) {
      previewPulls.scroll = pull;
      return { surfaces: [{ id: "preview" }] };
    },
  };
  const owner = dialogHost({
    hints: { scope: () => ({ targets: [{ id: "close" }] }) },
    keyboard: { contexts: (capabilities) => [capabilities] },
    preview: { value: preview },
  });
  const [capabilities] = owner.keyboardNavigationContexts();
  const root = {};
  const pull = {
    scopeId: "task-markdown-preview:thread%2F1",
    clipRoots: [root],
    contextRoot: root,
  };

  assert.deepEqual(
    capabilities.actionHints(pull).targets.map(({ id }) => id),
    ["close", "preview-link"],
  );
  assert.deepEqual(previewPulls.actions, {
    ...pull,
    scopeId: "task-markdown-preview:thread%2F1:preview",
    actions: { link: "link.open" },
  });
  assert.deepEqual(
    capabilities.scroll(pull).surfaces.map(({ id }) => id),
    ["preview"],
  );
  assert.deepEqual(previewPulls.scroll, {
    ...pull,
    scopeId: "task-markdown-preview:thread%2F1:preview",
    label: "Markdown preview",
  });
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
  const owner = dialogHost({ opener, dialog: { value: dialog } });

  owner.handleClose();
  assert.equal(focused, 0);
  assert.equal(owner.opener, opener);

  dialog.open = false;
  owner.handleClose();
  assert.equal(focused, 1);
  assert.equal(owner.opener, null);

  owner.opener = {
    isConnected: false,
    focus() {
      focused += 1;
    },
  };
  owner.handleClose();
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
  const owner = dialogHost({ threadId: "", opener, dialog: { value: dialog } });

  owner.setThreadId("thread/1");
  owner.setThreadId("thread/1");
  assert.equal(closed, 0);
  assert.equal(owner.opener, opener);

  owner.setThreadId("thread/2");
  assert.equal(closed, 1);
  assert.equal(owner.opener, null);
  assert.equal(owner.threadId, "thread/2");
});

// A dialog whose native dialog and preview are the given stand-ins.
function dialogHost(properties) {
  return Object.create(PreviewDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      threadId: "thread/1",
      opener: null,
      dialog: { value: undefined },
      preview: { value: undefined },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}
