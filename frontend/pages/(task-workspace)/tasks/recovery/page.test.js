import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const { ActionHints } = await import("#app/action-hints.js");
const { ScrollSurfaces } = await import("#app/scroll-scope.js");
const Recovery = registry.element("caffold-task-recovery");
const recovery = Recovery.prototype;
after(() => registry.restore());

test("draws only the actions the server offers, all held while one runs", () => {
  const { view } = recoveryView(recoveryTask());
  const idle = drawn(view);
  assert.match(idle, /<h2 id="task-recovery-task-title">Recovery Task<\/h2>/);
  assert.match(idle, /<h3>Thread unavailable<\/h3>/);
  assert.match(
    idle,
    /<p>Caffold still has this Task.<\/p><p>Its Codex Thread could not be found.<\/p>/,
  );
  assert.doesNotMatch(idle, /data-task-recovery-action="restore"/);
  assert.doesNotMatch(idle, /data-task-recovery-action="archive"/);
  assert.match(idle, /data-task-recovery-action="remove" \?disabled="false"/);
  assert.match(idle, /data-task-recovery-action="recheck" \?disabled="false"/);
  assert.match(idle, /<code>thread-recovery<\/code>/);

  view.pendingAction = "recheck";
  const busy = drawn(view);
  assert.match(busy, /data-task-recovery-action="remove" \?disabled="true"/);
  assert.match(busy, /role="status">Checking Task state…<\/p>/);
});

test("asks before removing, and says why an action failed", () => {
  const { view } = recoveryView(recoveryTask());
  view.confirmingRemoval = true;
  view.actionError = new Error("Removal failed");
  const confirming = drawn(view);

  assert.match(confirming, /<strong>Remove this Task from Caffold\?<\/strong>/);
  assert.match(
    confirming,
    /<p>The Codex Thread could not be found. Caffold will remove its membership and managed Task resources. This cannot be undone.<\/p>/,
  );
  assert.match(confirming, /data-task-recovery-action="cancel-remove"/);
  assert.match(confirming, /data-task-recovery-action="confirm-remove"/);
  assert.doesNotMatch(confirming, /data-task-recovery-action="remove"/);
  assert.match(confirming, /role="alert">Removal failed<\/p>/);
});

test("an absent Task's notice takes the screen, and its Restore is answered here", () => {
  const { view } = recoveryView(recoveryTask());
  view.absence = "archived";
  assert.match(
    drawn(view),
    /^<caffold-task-absence @caffold:task-absence-intent=""><\/caffold-task-absence>$/,
  );

  let restores = 0;
  let stopped = 0;
  const owner = { restoreArchived: () => { restores += 1; } };
  const intent = (type) => ({
    detail: { type },
    stopPropagation: () => { stopped += 1; },
  });
  recovery.absenceIntent.call(owner, intent("restore"));
  recovery.absenceIntent.call(owner, intent("other"));
  assert.equal(restores, 1);
  assert.equal(stopped, 2);
});

test("stores an equivalent fresh projection without clearing confirmation or error", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  const error = new Error("Removal failed");
  view.confirmingRemoval = true;
  view.actionError = error;
  const refreshed = {
    ...current,
    updatedMs: 2,
    unseen: true,
    recovery: { ...current.recovery, actions: [...current.recovery.actions] },
  };

  view.updateRecovery(refreshed);

  assert.equal(view.recovery, refreshed);
  assert.deepEqual(renders, []);
  assert.equal(view.confirmingRemoval, true);
  assert.equal(view.actionError, error);
});

test("keeps a pending action through an equivalent projection update", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  view.pendingAction = "recheck";
  const refreshed = { ...current, updatedMs: 2 };

  view.updateRecovery(refreshed);

  assert.equal(view.recovery, refreshed);
  assert.equal(view.pendingAction, "recheck");
  assert.deepEqual(renders, []);
});

test("preparing the same Task explicitly resets interaction and renders its entry state", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  view.confirmingRemoval = true;
  view.actionError = new Error("Removal failed");

  view.prepare(current);

  assert.equal(view.confirmingRemoval, false);
  assert.equal(view.actionError, null);
  assert.deepEqual(renders, [current]);
});

for (const [name, change] of [
  ["title", { title: "Renamed recovery" }],
  ["reason", {
    recovery: { reason: "temporarilyUnavailable", actions: ["removeFromCaffold", "recheck"] },
  }],
  ["actions", {
    recovery: { reason: "threadMissing", actions: ["recheck"] },
  }],
  ["Task identity", { threadId: "another-thread" }],
  ["unavailable projection", null],
]) {
  test(`renders a changed Recovery ${name} and resets obsolete interaction state`, () => {
    const current = recoveryTask();
    const { view, renders } = recoveryView(current);
    view.confirmingRemoval = true;
    view.actionError = new Error("Removal failed");
    const refreshed = change === null ? null : { ...current, ...change };

    view.updateRecovery(refreshed);

    assert.equal(view.recovery, refreshed);
    assert.equal(view.confirmingRemoval, false);
    assert.equal(view.actionError, null);
    assert.deepEqual(renders, [refreshed]);
  });
}

function recoveryTask() {
  return {
    threadId: "thread-recovery",
    title: "Recovery Task",
    updatedMs: 1,
    recovery: { reason: "threadMissing", actions: ["removeFromCaffold", "recheck"] },
  };
}

function recoveryView(current) {
  const renders = [];
  const view = Object.create(
    Recovery.prototype,
    Object.getOwnPropertyDescriptors({
      recovery: current,
      absence: null,
      pendingAction: "",
      actionError: null,
      confirmingRemoval: false,
      draw() {
        renders.push(this.recovery);
      },
    }),
  );
  view.hints = new ActionHints(view);
  view.surfaces = new ScrollSurfaces(view);
  return { view, renders };
}

function drawn(view) {
  return templateHtml(view.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> ", ">")
    .replaceAll(" <", "<")
    .trim();
}
