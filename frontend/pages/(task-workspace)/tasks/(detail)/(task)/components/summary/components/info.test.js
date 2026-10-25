import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { taskInfoSnapshot } = await import("./info.ts");
const info = registry.element("caffold-task-detail-info").prototype;
const actions = registry.element(
  "caffold-task-detail-info-actions",
).prototype;
after(() => registry.restore());

// One of the components with the state and stand-ins a test gives it, drawn
// by nothing until the test asks.
function owner(prototype, state) {
  return Object.create(prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    performUpdate() {},
    ...state,
  }));
}

function drawnActions(snapshot) {
  const markup = templateHtml(
    owner(actions, { snapshot: taskInfoSnapshot(snapshot) }).render(),
  ).replace(/\s+/g, " ");
  const button = (type) =>
    markup.match(new RegExp(`data-task-info-action="${type}"[^>]*>`))?.[0] ?? "";
  return {
    markup,
    disabled: (type) => button(type).includes('?disabled="true"'),
  };
}

test("keeps Task details opener at the info owner", () => {
  const control = button("Task details, idle");
  const popover = {
    id: "task-details",
    matches: () => false,
  };
  control.popoverId = popover.id;
  const infoOwner = owner(info, {
    snapshot: { task: { threadId: "thread-a" } },
    infoButton: control,
    infoPopover: popover,
  });

  const target = info.actionHintScope.call(infoOwner, {
    scopeId: "detail:task:thread-a",
  }).targets[0];
  assert.deepEqual(
    { id: target.id, actionId: target.actionId, label: target.label },
    {
      id: "detail:task:thread-a:thread-a:details:open",
      actionId: "task.details.open",
      label: "Task details, idle",
    },
  );
  assert.equal(target.isActionable(), true);
});

test("keeps enabled Fork and Archive actions at their direct owner", () => {
  const controls = {
    fork: button("Fork task", "fork"),
    archive: button("Archive task", "archive"),
  };
  const actionsOwner = owner(actions, {
    snapshot: { task: { threadId: "thread-a" } },
    actionButton: (type) => controls[type],
  });

  const scope = actions.actionHintScope.call(actionsOwner, {
    scopeId: "detail:task:thread-a:details",
    clipRoots: [{}],
  });
  assert.equal(scope.targets.every(({ badgeAtEnd }) => badgeAtEnd), true);
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      {
        id: "detail:task:thread-a:details:thread-a:fork",
        actionId: "task.fork",
      },
      {
        id: "detail:task:thread-a:details:thread-a:archive",
        actionId: "task.archive",
      },
    ],
  );
  controls.archive.disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  assert.equal(
    actions.actionHintScope.call(actionsOwner, {
      scopeId: "detail:task:thread-a:details",
    }).targets.length,
    1,
  );
});

test("offers reading what a Task's prompts settled only under the reviewed mode", () => {
  const controls = {
    fork: button("Fork task", "fork"),
    archive: button("Archive task", "archive"),
    "permission-instructions": button(
      "What your prompts settled",
      "permission-instructions",
    ),
  };
  const actionsOwner = owner(actions, {
    snapshot: { task: { threadId: "thread-a" }, permissionMode: "approveForMe" },
    actionButton: (type) => controls[type],
  });

  assert.deepEqual(
    actions.actionHintScope
      .call(actionsOwner, { scopeId: "details" })
      .targets.map(({ actionId }) => actionId),
    ["task.fork", "task.archive"],
  );

  actionsOwner.snapshot = {
    ...actionsOwner.snapshot,
    permissionMode: "caffold:ask-jev-first",
  };
  const offered = actions.actionHintScope.call(actionsOwner, { scopeId: "details" });

  assert.deepEqual(
    offered.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      { id: "details:thread-a:fork", actionId: "task.fork" },
      { id: "details:thread-a:archive", actionId: "task.archive" },
      {
        id: "details:thread-a:permission-instructions",
        actionId: "button.activate",
      },
    ],
  );
  assert.equal(offered.targets[2].isActionable(), true);
  actionsOwner.snapshot = { ...actionsOwner.snapshot, permissionMode: "approveForMe" };
  assert.equal(offered.targets[2].isActionable(), false);
});

test("hides what a Task's prompts settled outside the reviewed mode", () => {
  const task = { threadId: "thread-a", threadStatus: { type: "idle" } };
  const hidden = (permissionMode) =>
    /data-task-info-permission-instructions \?hidden="true"/.test(
      drawnActions({ task, permissionMode }).markup,
    );

  assert.equal(hidden("approveForMe"), true);
  assert.equal(hidden("caffold:ask-jev-first"), false);
});

test("keeps Archive available through stale transport unless canonical status is active", () => {
  const task = {
    threadId: "thread-a",
    threadStatus: { type: "active", activeFlags: [] },
  };

  assert.equal(
    drawnActions({ task, transportState: "unavailable" }).disabled("archive"),
    false,
  );
  assert.equal(
    drawnActions({
      task,
      transportState: "unavailable",
      archiveBlockedByActive: true,
    }).disabled("archive"),
    true,
  );
});

test("keeps Fork unavailable without canonical Detail", () => {
  const drawn = drawnActions({
    task: { threadId: "thread-a", threadStatus: { type: "idle" } },
    canonicalTaskAvailable: false,
    transportState: "ready",
    provider: "codex",
  });

  assert.equal(drawn.disabled("fork"), true);
  assert.match(
    drawn.markup,
    /task-detail-fork-availability" \?hidden="false" >Fork is unavailable until Task details load\.</,
  );
});

test("declares a session-bound Action Hint context for the Task details popover context", () => {
  const presentation = {
    actionHintDialog: () => ({}),
    scrollModeHud: () => ({}),
    scrollSurfaceSelector: () => ({}),
  };
  const popover = {
    id: "task-details",
    matches: () => false,
    querySelector: (selector) =>
      selector.includes("presentation") ? presentation : null,
  };
  const infoOwner = owner(info, {
    snapshot: { task: { threadId: "thread-a" } },
    infoPopover: popover,
  });

  const [context] = info.keyboardNavigationContexts.call(infoOwner, {
    scopeId: "detail:task:thread-a",
  });

  assert.equal(context.id, "detail:task:thread-a:thread-a:details");
  assert.equal(context.kind, "popover");
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.sessionBound, true);
});

test("closes the Task details popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const infoOwner = owner(info, { infoPopover: popover });
  info.handleDismiss.call(infoOwner, { target: {} });
  assert.equal(hidden, 0);
  info.handleDismiss.call(infoOwner, { target: popover });
  assert.equal(hidden, 1);
});

function button(label, action = "") {
  return {
    attributes: new Map(),
    dataset: action ? { taskInfoAction: action } : {},
    disabled: false,
    textContent: label,
    popoverId: "",
    focus() {},
    click() {},
    getAttribute(name) {
      if (name === "aria-label") {
        return label;
      }
      if (name === "popovertarget") {
        return this.popoverId;
      }
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
}
