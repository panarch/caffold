import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./info.js");
const info = registry.element("caffold-task-detail-info").prototype;
const actions = registry.element(
  "caffold-task-detail-info-actions",
).prototype;
after(() => registry.restore());

test("keeps Task details opener at the info owner", () => {
  const control = button("Task details, idle");
  const popover = {
    id: "task-details",
    matches: () => false,
  };
  const owner = {
    isConnected: true,
    snapshot: { task: { threadId: "thread-a" } },
    infoButton: () => control,
    infoPopover: () => popover,
  };
  control.popoverId = popover.id;

  const target = info.actionHintScope.call(owner, {
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
  const owner = {
    isConnected: true,
    snapshot: { task: { threadId: "thread-a" } },
    actionButton: (type) => controls[type],
  };

  const scope = actions.actionHintScope.call(owner, {
    scopeId: "detail:task:thread-a:details",
    clipRoots: [{}],
  });
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
    actions.actionHintScope.call(owner, {
      scopeId: "detail:task:thread-a:details",
    }).targets.length,
    1,
  );
});

test("keeps Archive available through stale transport unless canonical status is active", () => {
  const archive = button("Archive task", "archive");
  const error = { textContent: "", hidden: true };
  const owner = {
    snapshot: {
      task: {
        threadId: "thread-a",
        threadStatus: { type: "active", activeFlags: [] },
      },
      transportState: "unavailable",
      archiveBlockedByActive: false,
      archiveState: { loading: false, error: null },
      forkState: { loading: false, error: null },
    },
    actionButton: () => archive,
    querySelector: () => error,
  };

  actions.patchArchive.call(owner);
  assert.equal(archive.disabled, false);

  owner.snapshot.archiveBlockedByActive = true;
  actions.patchArchive.call(owner);
  assert.equal(archive.disabled, true);
});

test("keeps Fork unavailable without canonical Detail", () => {
  const fork = button("Fork task", "fork");
  const availability = { textContent: "", hidden: true };
  const error = { textContent: "", hidden: true };
  const owner = {
    snapshot: {
      task: { threadId: "thread-a", threadStatus: { type: "idle" } },
      canonicalTaskAvailable: false,
      transportState: "ready",
      provider: "codex",
      archiveState: { loading: false, error: null },
      forkState: { loading: false, error: null },
    },
    actionButton: () => fork,
    querySelector(selector) {
      return selector.includes("availability") ? availability : error;
    },
  };

  actions.patchFork.call(owner);

  assert.equal(fork.disabled, true);
  assert.equal(
    availability.textContent,
    "Fork is unavailable until Task details load.",
  );
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
