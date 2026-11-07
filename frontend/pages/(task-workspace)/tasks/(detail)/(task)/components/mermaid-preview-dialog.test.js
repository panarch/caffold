import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./mermaid-preview-dialog.js");
const PreviewDialog = registry.element("caffold-task-mermaid-preview-dialog");
after(() => registry.restore());

test("hands each requested source to its retained diagram and draws it", () => {
  const diagram = { source: "", active: false };
  let shown = 0;
  const dialog = {
    open: false,
    showModal() {
      shown += 1;
      this.open = true;
    },
  };
  const opener = { isConnected: true, focus() {} };
  const owner = dialogHost({
    dialog: { value: dialog },
    diagram: { value: diagram },
  });

  owner.openMermaid({ source: "flowchart LR\n  A --> B", opener });
  assert.deepEqual(diagram, { source: "flowchart LR\n  A --> B", active: true });
  assert.equal(owner.opener, null);

  owner.openMermaid({ source: "pie\n  \"A\" : 1" });
  assert.equal(diagram.source, "pie\n  \"A\" : 1");
  assert.equal(shown, 1);
});

test("keeps an opener that is a control to return focus to", () => {
  const opener = new globalThis.HTMLElement();
  const owner = dialogHost({
    dialog: { value: { open: true } },
    diagram: { value: { source: "", active: false } },
  });

  owner.openMermaid({ source: "flowchart LR\n  A --> B", opener });
  assert.equal(owner.opener, opener);
});

test("merges its own Close with its diagram's links and scrolling", () => {
  const diagramPulls = {};
  const diagram = {
    actionHintScope(pull) {
      diagramPulls.actions = pull;
      return { targets: [{ id: "diagram-link" }] };
    },
    scrollSurfaceScope(pull) {
      diagramPulls.scroll = pull;
      return { surfaces: [{ id: "diagram" }] };
    },
  };
  const owner = dialogHost({
    hints: { scope: () => ({ targets: [{ id: "close" }] }) },
    keyboard: { contexts: (capabilities) => [capabilities] },
    diagram: { value: diagram },
  });
  const [capabilities] = owner.keyboardNavigationContexts();
  const root = {};
  const pull = {
    scopeId: "task-mermaid-preview:thread%2F1",
    clipRoots: [root],
    contextRoot: root,
  };

  assert.deepEqual(
    capabilities.actionHints(pull).targets.map(({ id }) => id),
    ["close", "diagram-link"],
  );
  assert.deepEqual(diagramPulls.actions, {
    ...pull,
    scopeId: "task-mermaid-preview:thread%2F1:diagram",
  });
  assert.deepEqual(
    capabilities.scroll(pull).surfaces.map(({ id }) => id),
    ["diagram"],
  );
  assert.deepEqual(diagramPulls.scroll, {
    ...pull,
    scopeId: "task-mermaid-preview:thread%2F1:diagram",
    label: "Mermaid preview",
  });
});

test("stops its diagram and returns focus only once the dialog has closed", () => {
  let focused = 0;
  const opener = {
    isConnected: true,
    focus() {
      focused += 1;
    },
  };
  const diagram = { active: true };
  const dialog = { open: true };
  const owner = dialogHost({
    opener,
    dialog: { value: dialog },
    diagram: { value: diagram },
  });

  owner.handleClose();
  assert.equal(focused, 0);
  assert.equal(diagram.active, true);
  assert.equal(owner.opener, opener);

  dialog.open = false;
  owner.handleClose();
  assert.equal(focused, 1);
  assert.equal(diagram.active, false);
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

// A dialog whose native dialog and diagram are the given stand-ins.
function dialogHost(properties) {
  return Object.create(PreviewDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      threadId: "thread/1",
      opener: null,
      dialog: { value: undefined },
      diagram: { value: undefined },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}
