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
  const list = { children: [] };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    getClientRects: () => [{}],
    scroller: () => scrollport,
    conversationList: () => list,
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

test("composes direct tool and approval command scrollports with Conversation", () => {
  const toolOutput = layoutElement();
  let currentToolOutput = toolOutput;
  const toolEntry = {
    dataset: { conversationEntryKey: "tool-a" },
    matches: (selector) => selector === ".task-tool-card",
    querySelector(selector) {
      if (selector === ":scope > pre") return currentToolOutput;
      if (selector === ":scope > header > strong") {
        return { textContent: "Plan" };
      }
      return null;
    },
  };
  let currentApproval = true;
  const approvalCard = {
    approvalId: "approval-a",
    scrollSurfaceScope(options) {
      return {
        surfaces: [{
          id: `${options.scopeId}:output:0`,
          label: "Approval command",
          axes: ["horizontal"],
          isEligible: () => currentApproval && options.isCurrent(),
        }],
      };
    },
  };
  const approvalEntry = {
    dataset: { conversationEntryKey: "approval-flow-a" },
    matches: (selector) => selector === ".task-approval-flow",
    querySelector: () => null,
    querySelectorAll: () => [approvalCard],
  };
  const list = { children: [toolEntry, approvalEntry] };
  const scrollport = layoutElement();
  const owner = layoutElement({
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    scroller: () => scrollport,
    conversationList: () => list,
    approvalComponents: (entry) => entry === approvalEntry && currentApproval ? [approvalCard] : [],
  });

  const scope = conversation.scrollSurfaceScope.call(owner);
  assert.deepEqual(scope.surfaces.map(({ id, label, axes }) => ({
    id,
    label,
    axes,
  })), [
    {
      id: "task:thread-a:conversation",
      label: "Conversation",
      axes: undefined,
    },
    {
      id: "task:thread-a:conversation:tool-output:tool-a:scroll",
      label: "Plan output",
      axes: ["horizontal"],
    },
    {
      id:
        "task:thread-a:conversation:approval:approval-a:approval-flow-a:output:0",
      label: "Approval command",
      axes: ["horizontal"],
    },
  ]);
  assert.equal(scope.surfaces[1].isEligible(), true);
  assert.equal(scope.surfaces[2].isEligible(), true);
  currentToolOutput = layoutElement();
  assert.equal(scope.surfaces[1].isEligible(), false);
  currentToolOutput = toolOutput;
  currentApproval = false;
  assert.equal(scope.surfaces[2].isEligible(), false);
  currentApproval = true;
  owner.snapshot = { threadId: "thread-a", task: null };
  assert.equal(scope.surfaces[1].isEligible(), false);
  assert.equal(scope.surfaces[2].isEligible(), false);
});

test("returns an empty scope before a Conversation owns a Task scrollport", () => {
  const scope = conversation.scrollSurfaceScope.call({
    snapshot: { threadId: "", task: null },
    ensureState() {},
    scroller: () => null,
    conversationList: () => null,
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

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}

test("merges owned Conversation actions with direct retained child providers", () => {
  const detailButton = conversationButton({ conversationAction: "retry-detail" }, "Older messages");
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
  const approvalTarget = { id: "approval-choice" };
  let approvalOptions;
  const approvalCard = {
    approvalId: "approval-a",
    actionHintScope(options) {
      approvalOptions = options;
      return { targets: [approvalTarget], mutationRoots: [approvalCard] };
    },
  };
  approvalTarget.invalidationOwner = approvalCard;
  const command = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:conversation:command:command-a");
      return { targets: [childTarget], mutationRoots: [command] };
    },
  };
  const childTarget = { id: "command-output", invalidationOwner: command };
  const olderHistory = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "task:thread-a:conversation:older-history");
      assert.deepEqual(options.clipRoots, [owner, scrollport]);
      return { targets: [historyTarget], mutationRoots: [olderHistory] };
    },
  };
  const historyTarget = { id: "older-page", invalidationOwner: olderHistory };
  const entry = {
    dataset: { conversationEntryKey: "command-a" },
    querySelector(selector) {
      return selector.includes("caffold-task-command") ? command : null;
    },
  };
  const list = { children: [entry] };
  const scrollport = {};
  let controls = [detailButton, earlierPreview, preview];
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    scroller: () => scrollport,
    conversationList: () => list,
    olderHistory: () => olderHistory,
    approvalComponents: () => [approvalCard],
    contains: (control) => controls.includes(control),
    querySelector(selector) {
      return selector.includes("retry-detail") ? detailButton : null;
    },
    querySelectorAll(selector) {
      if (selector.includes("preview-image")) {
        return [earlierPreview, preview];
      }
      return [];
    },
  };

  const scope = conversation.actionHintScope.call(owner, {
    scopeId: "task:thread-a:conversation",
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task:thread-a:conversation:retry-detail",
    "task:thread-a:conversation:preview-image:event-earlier:1",
    "task:thread-a:conversation:preview-image:event-a:1",
    "older-page",
    "approval-choice",
    "command-output",
  ]);
  assert.deepEqual(scope.targets.map(({ invalidationOwner }) =>
    invalidationOwner
  ), [owner, earlierPreviewEntry, previewEntry, olderHistory, approvalCard, command]);
  scope.targets.slice(0, 3).forEach((target) => target.activate());
  assert.deepEqual(
    [detailButton, earlierPreview, preview].map(({ clicks }) => clicks),
    [1, 1, 1],
  );
  previewEntry.dataset.conversationEntryKey = "event-b";
  assert.equal(scope.targets[2].isActionable(), false);
  previewEntry.dataset.conversationEntryKey = "event-a";
  assert.equal(approvalOptions.scopeId, "task:thread-a:conversation:approval:approval-a:command-a");
  assert.equal(approvalOptions.isCurrent(), true);
  owner.snapshot = { threadId: "thread-b", task: { threadId: "thread-b" } };
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(approvalOptions.isCurrent(), false);
  controls = [];
});

test("forwards only the current direct history child's intent", () => {
  const child = {};
  const intents = [];
  const owner = {
    active: true,
    snapshot: { threadId: "a" },
    olderHistory: () => child,
    dispatchIntent: (...intent) => intents.push(intent),
  };
  const emit = (target, threadId, retry = false) =>
    conversation.handleOlderHistoryIntent.call(owner, {
      target, detail: { threadId, retry }, stopPropagation() {},
    });
  emit({}, "a");
  emit(child, "old-task");
  assert.deepEqual(intents, []);
  emit(child, "a");
  emit(child, "a", true);
  assert.deepEqual(intents, [
    ["older-history", { retry: false }],
    ["older-history", { retry: true }],
  ]);
  owner.active = false;
  emit(child, "a");
  assert.equal(intents.length, 2);
});

test("provides only direct owner-known Thinking disclosures with inner Markdown", () => {
  let clicks = 0;
  const anchor = { id: "thinking-chevron" };
  const summary = {
    getClientRects: () => [{}],
    querySelector: () => anchor,
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const disclosure = {
    dataset: { disclosureKey: "thinking:event-a" },
    open: false,
    querySelector: () => summary,
  };
  const markdownTarget = { id: "thinking-markdown-copy" };
  const markdown = {
    actionHintScope: () => ({ targets: [markdownTarget] }),
  };
  const entry = {
    dataset: { conversationEntryKey: "event-a" },
    querySelector(selector) {
      if (selector.includes('data-disclosure-key^="thinking:"')) {
        return disclosure;
      }
      if (selector.includes("caffold-task-markdown")) {
        return markdown;
      }
      return null;
    },
  };
  const arbitraryEntry = {
    dataset: { conversationEntryKey: "event-b" },
    querySelector: () => null,
  };
  const list = { children: [entry, arbitraryEntry] };
  const scrollport = {};
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    scroller: () => scrollport,
    conversationList: () => list,
    olderHistory: () => null,
    approvalComponents: () => [],
    contains: (control) => control === summary,
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const collapsed = conversation.actionHintScope.call(owner, {
    scopeId: "task:thread-a:conversation",
  });
  assert.deepEqual(collapsed.targets.slice(1), [markdownTarget]);
  assert.deepEqual(
    {
      id: collapsed.targets[0].id,
      actionId: collapsed.targets[0].actionId,
      label: collapsed.targets[0].label,
      controlKind: collapsed.targets[0].controlKind,
      anchor: collapsed.targets[0].anchor,
    },
    {
      id: "task:thread-a:conversation:thinking:event-a:thinking%3Aevent-a",
      actionId: "disclosure.toggle",
      label: "Expand Thinking",
      controlKind: "disclosure",
      anchor,
    },
  );
  assert.equal(collapsed.targets[0].isActionable(), true);
  collapsed.targets[0].activate();
  assert.equal(clicks, 1);

  disclosure.open = true;
  const expanded = conversation.actionHintScope.call(owner, {
    scopeId: "task:thread-a:conversation",
  }).targets[0];
  assert.equal(expanded.id, collapsed.targets[0].id);
  assert.equal(expanded.label, "Collapse Thinking");
  entry.dataset.conversationEntryKey = "event-b";
  assert.equal(collapsed.targets[0].isActionable(), false);
  entry.dataset.conversationEntryKey = "event-a";
  const originalSummaryQuery = summary.querySelector;
  summary.querySelector = () => ({ id: "replacement-chevron" });
  assert.equal(collapsed.targets[0].isActionable(), false);
  summary.querySelector = originalSummaryQuery;
  disclosure.dataset.disclosureKey = "thinking:event-c";
  assert.equal(collapsed.targets[0].isActionable(), false);
});

test("forwards approval intent only from the current Task's mounted card", () => {
  const card = { approvalId: 'mcp:"42"' };
  const intents = [];
  const owner = {
    active: true,
    snapshot: { threadId: "thread-a", transportState: "live" },
    approvalComponents: () => [card],
    dispatchIntent: (...intent) => intents.push(intent),
  };
  const emit = (target, threadId) => conversation.handleApprovalIntent.call(owner, {
    target, detail: { threadId, approvalId: card.approvalId, decision: "cancel" },
    stopPropagation() {},
  });
  emit({}, "thread-a");
  emit(card, "old-thread");
  assert.deepEqual(intents, []);
  emit(card, "thread-a");
  assert.deepEqual(intents, [["approval", { approvalId: 'mcp:"42"', decision: "cancel" }]]);
  owner.snapshot.transportState = "reconnecting";
  emit(card, "thread-a");
  owner.snapshot.transportState = "live";
  owner.active = false;
  emit(card, "thread-a");
  assert.equal(intents.length, 1);
});
