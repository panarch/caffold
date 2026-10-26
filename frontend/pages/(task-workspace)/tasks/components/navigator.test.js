import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const { KeyboardContexts } = await import("#app/keyboard-navigation.ts");
const { ScrollSurfaces } = await import("#app/scroll-scope.ts");
const Navigator = registry.element("caffold-task-navigator");
after(() => registry.restore());

const ready = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

test("merges its header's actions with both lists', clipped by the navigator and the list's scroll", () => {
  const pulls = [];
  const scope = (name) => (pull) => {
    pulls.push([name, pull]);
    return { targets: [{ id: name }] };
  };
  const scrollRoot = {};
  const navigator = navigatorHost({
    scrollRoot,
    hints: { scope: scope("header") },
    activeTaskList: { actionHintScope: scope("active") },
    archivedTaskList: { actionHintScope: scope("archived") },
  });
  const clipRoots = [navigator, scrollRoot];

  assert.deepEqual(
    navigator.actionHintScope().targets.map(({ id }) => id),
    ["header", "active", "archived"],
  );
  assert.deepEqual(pulls, [
    ["header", { clipRoots: [navigator] }],
    ["active", { clipRoots }],
    ["archived", { scopeId: "task-list:archived", clipRoots }],
  ]);

  navigator.reorderMode = "tasks";
  assert.deepEqual(
    navigator.actionHintScope().targets.map(({ id }) => id),
    ["header", "active"],
  );
});

test("keeps Scroll mode off the Task list while it reorders", () => {
  const navigator = navigatorHost({
    surfaces: { scope: () => ({ blocked: false, surfaces: [] }) },
  });

  assert.equal(navigator.scrollSurfaceScope().blocked, false);
  navigator.reorderMode = "sections";
  assert.equal(navigator.scrollSurfaceScope().blocked, true);
});

test("asks for the Task switcher without touching reorder mode or blocked Task operations", () => {
  const intents = [];
  const navigator = navigatorHost({
    reorderMode: "tasks",
    taskOperations: { ...ready, key: "blocked", blocked: true },
    dispatchIntent: (detail) => intents.push(detail),
    setReorderMode() {
      throw new Error("Opening the switcher must not change reorder mode.");
    },
    exitReorderMode() {
      throw new Error("Opening the switcher must not end reorder mode.");
    },
  });
  let stopped = false;

  navigator.openSwitcher({
    stopPropagation() {
      stopped = true;
    },
  });

  assert.deepEqual(intents, [{ type: "open-task-switcher" }]);
  assert.equal(stopped, true);
});

test("closes the Reorder popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const navigator = navigatorHost({ reorderPopover: popover });
  navigator.handleDismiss({ target: {} });
  assert.equal(hidden, 0);
  navigator.handleDismiss({ target: popover });
  assert.equal(hidden, 1);
});

test("exits active reorder only for an unclaimed Escape key", () => {
  let exits = 0;
  const navigator = navigatorHost({
    reorderMode: "tasks",
    exitReorderMode() {
      exits += 1;
      this.reorderMode = "none";
    },
  });
  const escape = keyboardEvent();

  navigator.exitReorderOnEscape(escape);

  assert.equal(exits, 1);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);

  for (const ignored of [
    keyboardEvent({ key: "Enter" }),
    keyboardEvent({ defaultPrevented: true }),
    keyboardEvent({ isComposing: true }),
    keyboardEvent({ ctrlKey: true }),
    keyboardEvent({ altKey: true }),
    keyboardEvent({ metaKey: true }),
  ]) {
    navigator.reorderMode = "sections";
    navigator.exitReorderOnEscape(ignored);
    assert.equal(ignored.prevented, false);
    assert.equal(ignored.stopped, false);
  }
  navigator.reorderMode = "none";
  navigator.exitReorderOnEscape(keyboardEvent());
  assert.equal(exits, 1);
});

test("reveals the Archived list once both lists have first answered", () => {
  const revealed = [];
  const active = {
    initialRequestSettled: false,
    listState: () => ({
      count: 2,
      loaded: true,
      loading: false,
      error: "",
      selectedSection: null,
      selectedRecovery: null,
    }),
  };
  const archived = {
    initialRequestSettled: true,
    setRevealed: (value) => revealed.push(value),
    listState: () => ({ count: 1, loaded: true, loading: false, error: "" }),
  };
  const published = [];
  const navigator = navigatorHost({
    activeTaskList: active,
    archivedTaskList: archived,
    lastPublishedListState: "",
    dispatchEvent: (event) => published.push(event.detail),
  });
  const settled = { stopPropagation() {} };

  navigator.listSettled(settled);
  active.initialRequestSettled = true;
  navigator.listSettled(settled);

  assert.deepEqual(revealed, [false, true]);
  assert.deepEqual(published, [
    {
      count: 3,
      activeCount: 2,
      activeError: "",
      archivedCount: 1,
      loaded: true,
      loading: false,
      error: "",
      selectedSection: null,
      selectedRecovery: null,
    },
  ]);
});

test("draws the header's actions for the reorder mode and the Task store", () => {
  const idle = html(navigatorHost({}));
  assert.match(idle, /aria-label="Choose what to reorder" aria-pressed="false" title="Reorder" popovertarget="task-list-reorder-test"/);
  assert.match(idle, /class="task-list-header-action task-list-new-task" data-task-action="open-new" aria-label="New Task" title="New Task" \?disabled="false"/);
  assert.match(idle, /<div class="task-list-scroll"><caffold-active-task-list [^>]*><\/caffold-active-task-list><caffold-archived-task-list hidden [^>]*><\/caffold-archived-task-list><\/div>$/);

  const reordering = html(navigatorHost({
    reorderMode: "sections",
    taskOperations: {
      ...ready,
      key: "blocked",
      blocked: true,
      title: "The Task store is unavailable",
    },
  }));
  assert.match(reordering, /aria-label="Finish reordering Sections" aria-pressed="true" title="Finish reordering Sections"/);
  assert.match(reordering, /title="The Task store is unavailable" \?disabled="true"/);
});

// A navigator whose children and controls are the given stand-ins.
function navigatorHost(properties) {
  const navigator = Object.create(Navigator.prototype, {
    ...Object.getOwnPropertyDescriptors({
      active: true,
      hidden: false,
      isConnected: true,
      reorderMode: "none",
      taskOperations: ready,
      reorderPopoverId: "task-list-reorder-test",
      scrollRoot: {},
      primaryHeader: {},
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  navigator.hints ??= new ActionHints(navigator, () => {});
  navigator.surfaces ??= new ScrollSurfaces(navigator, () => {});
  navigator.keyboard ??= new KeyboardContexts(navigator, () => {});
  return navigator;
}

function html(navigator) {
  return templateHtml(navigator.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}

function keyboardEvent(overrides = {}) {
  return {
    key: "Escape",
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...overrides,
  };
}
