import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation.js");
const conversation = registry.element("caffold-task-conversation").prototype;
after(() => registry.restore());

test("provides only the exact active Conversation scrollport", () => {
  const scrollport = {
    clientHeight: 200,
    scrollHeight: 800,
    getClientRects: () => [{}],
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    getClientRects: () => [{}],
    scroller: () => scrollport,
  };

  const scope = conversation.scrollSurfaceScope.call(owner);
  const surface = scope.surfaces[0];
  assert.deepEqual(
    {
      id: surface.id,
      label: surface.label,
      scrollport: surface.scrollport,
      clipRoots: surface.clipRoots,
    },
    {
      id: "task:thread-a:conversation",
      label: "Conversation",
      scrollport,
      clipRoots: [owner, scrollport],
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner, scrollport]);
  assert.equal(surface.isEligible(), true);
  owner.active = false;
  assert.equal(surface.isEligible(), false);
  owner.active = true;
  owner.snapshot = { threadId: "thread-b", task: { threadId: "thread-b" } };
  assert.equal(surface.isEligible(), false);
});

test("returns an empty scope before a Conversation owns a Task scrollport", () => {
  const scope = conversation.scrollSurfaceScope.call({
    snapshot: { threadId: "", task: null },
    ensureState() {},
    scroller: () => null,
  });
  assert.deepEqual(scope.surfaces, []);
});

function conversationButton(dataset, label) {
  return {
    dataset,
    disabled: false,
    textContent: label,
    title: "",
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("merges owned Conversation actions with direct retained child providers", () => {
  const retry = conversationButton({ conversationAction: "retry-history" }, "Retry");
  const earlierPreviewEntry = {
    dataset: { conversationEntryKey: "event-earlier" },
  };
  const earlierPreview = conversationButton(
    { conversationAction: "preview-image", imageName: "earlier.png" },
    "Preview earlier.png",
  );
  earlierPreview.closest = () => earlierPreviewEntry;
  const previewEntry = { dataset: { conversationEntryKey: "event-a" } };
  const preview = conversationButton(
    { conversationAction: "preview-image", imageName: "shot.png" },
    "Preview shot.png",
  );
  preview.closest = () => previewEntry;
  const approval = conversationButton({
    taskAction: "approval",
    approvalId: "approval-a",
    decision: "accept",
  }, "Accept");
  const childTarget = { id: "command-output" };
  const command = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:conversation:command:command-a");
      return { targets: [childTarget], mutationRoots: [command] };
    },
  };
  const entry = {
    dataset: { conversationEntryKey: "command-a" },
    querySelector(selector) {
      return selector.includes("caffold-task-command") ? command : null;
    },
  };
  const list = { children: [entry] };
  const scrollport = {};
  let controls = [retry, earlierPreview, preview, approval];
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    scroller: () => scrollport,
    conversationList: () => list,
    contains: (control) => controls.includes(control),
    querySelector(selector) {
      return selector.includes("retry-history") ? retry : null;
    },
    querySelectorAll(selector) {
      if (selector.includes("preview-image")) {
        return [earlierPreview, preview];
      }
      if (selector.includes("data-approval-id")) return [approval];
      return [];
    },
  };

  const scope = conversation.actionHintScope.call(owner, {
    scopeId: "task:thread-a:conversation",
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task:thread-a:conversation:retry-history",
    "task:thread-a:conversation:preview-image:event-earlier:1",
    "task:thread-a:conversation:preview-image:event-a:1",
    "task:thread-a:conversation:approval:approval-a:accept",
    "command-output",
  ]);
  scope.targets.slice(0, 4).forEach((target) => target.activate());
  assert.deepEqual(
    [retry, earlierPreview, preview, approval].map(({ clicks }) => clicks),
    [1, 1, 1, 1],
  );
  previewEntry.dataset.conversationEntryKey = "event-b";
  assert.equal(scope.targets[2].isActionable(), false);
  previewEntry.dataset.conversationEntryKey = "event-a";
  approval.dataset.decision = "decline";
  assert.equal(scope.targets[3].isActionable(), false);
  approval.dataset.decision = "accept";
  owner.snapshot = { threadId: "thread-b", task: { threadId: "thread-b" } };
  assert.equal(scope.targets[0].isActionable(), false);
  controls = [];
});
