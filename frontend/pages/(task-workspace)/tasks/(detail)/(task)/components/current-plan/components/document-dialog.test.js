import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./document-dialog.ts");
const DocumentDialog = registry.element("caffold-current-plan-document-dialog");
after(() => registry.restore());

test("merges its own Close and Retry with its preview's links and scrolling", () => {
  const previewPulls = {};
  const preview = {
    actionHintScope(pull) {
      previewPulls.actions = pull;
      return { targets: [{ id: "document-link" }] };
    },
    scrollSurfaceScope(pull) {
      previewPulls.scroll = pull;
      return { surfaces: [{ id: "preview" }] };
    },
  };
  const owner = dialogHost({
    current: { path: "task/PLAN.md", label: "Plan" },
    hints: { scope: () => ({ targets: [{ id: "close" }] }) },
    keyboard: { contexts: (capabilities) => [capabilities] },
    preview: { value: preview },
  });
  const [capabilities] = owner.keyboardNavigationContexts();
  const root = {};
  const pull = {
    scopeId: "current-plan-document:task/PLAN.md",
    clipRoots: [root],
    contextRoot: root,
  };

  assert.deepEqual(
    capabilities.actionHints(pull).targets.map(({ id }) => id),
    ["close", "document-link"],
  );
  assert.deepEqual(previewPulls.actions, {
    ...pull,
    scopeId: "current-plan-document:task/PLAN.md:preview",
    actions: { link: "link.open" },
  });
  assert.deepEqual(
    capabilities.scroll(pull).surfaces.map(({ id }) => id),
    ["preview"],
  );
  assert.deepEqual(previewPulls.scroll, {
    ...pull,
    scopeId: "current-plan-document:task/PLAN.md:preview",
    label: "Plan document",
  });
});

test("ignores a stale native close event after the retained dialog reopens", () => {
  let aborted = false;
  const current = { path: "task/PLAN.md" };
  const opener = {};
  const controller = {
    abort() {
      aborted = true;
    },
  };
  const owner = dialogHost({
    requestId: 4,
    requestController: controller,
    current,
    opener,
    dialog: { value: { open: true } },
  });

  owner.handleClose();

  assert.equal(owner.requestId, 4);
  assert.equal(owner.requestController, controller);
  assert.equal(owner.current, current);
  assert.equal(owner.opener, opener);
  assert.equal(aborted, false);
});

test("restores the opener before native close handling returns", () => {
  let focused = false;
  const opener = {
    isConnected: true,
    focus() {
      focused = true;
    },
  };
  let imagesReleased = false;
  const owner = dialogHost({
    requestId: 4,
    requestController: null,
    current: { path: "task/PLAN.md" },
    opener,
    dialog: { value: { open: false } },
    preview: {
      value: {
        releaseImages() {
          imagesReleased = true;
        },
      },
    },
  });

  owner.handleClose();

  assert.equal(focused, true);
  assert.equal(imagesReleased, true);
  assert.equal(owner.requestId, 5);
  assert.equal(owner.current, null);
  assert.equal(owner.opener, null);
});

// A document dialog whose native dialog and preview are the given stand-ins.
function dialogHost(properties) {
  return Object.create(DocumentDialog.prototype, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      preview: { value: undefined },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}
