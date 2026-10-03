import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { TASK_STORE_RETRY_REQUEST_EVENT } = await import(
  "../../task-store-status.js"
);
function createTaskStoreStatusSnapshot({ readiness = null, retryAvailable = false }) {
  return { readiness, retryAvailable };
}
await import("./task-store-recovery.js");
const recovery = registry.element("caffold-task-store-recovery").prototype;
after(() => registry.restore());

function fakeCard() {
  const element = () => ({
    textContent: "",
    hidden: false,
    disabled: false,
    toggleAttribute(name, force) {
      this[name] = force;
    },
  });
  const parts = {
    title: element(),
    message: element(),
    instruction: element(),
    retry: element(),
    diagnostic: element(),
  };
  const card = {
    dataset: {},
    querySelector(selector) {
      if (selector === "[data-task-store-title]") return parts.title;
      if (selector === "[data-task-store-message]") return parts.message;
      if (selector === ".task-store-recovery-instruction") return parts.instruction;
      if (selector.includes('data-task-store-recovery-action="retry"')) return parts.retry;
      if (selector === ".task-store-recovery-diagnostic") return parts.diagnostic;
      return null;
    },
  };
  return { card, parts };
}

function rendered(snapshot) {
  const { card, parts } = fakeCard();
  const owner = {
    rendered: true,
    snapshotValue: snapshot,
    querySelector: (selector) =>
      selector === ".task-store-recovery-card" ? card : null,
  };
  recovery.patch.call(owner);
  return { card, parts };
}

test("shows preparing while the store migrates, with retry held back", () => {
  const { card, parts } = rendered(createTaskStoreStatusSnapshot({
    readiness: {
      state: "migrating",
      blocksTaskOperations: true,
      diagnosticMessage: "Caffold is preparing the Task store.",
    },
  }));

  assert.equal(card.dataset.taskStoreState, "migrating");
  assert.equal(parts.title.textContent, "Preparing Tasks…");
  assert.equal(
    parts.message.textContent,
    "Caffold is preparing the local Task navigator before Tasks start.",
  );
  assert.equal(
    parts.instruction.textContent,
    "This finishes automatically when the local upgrade succeeds.",
  );
  assert.equal(parts.retry.textContent, "Preparing…");
  assert.equal(parts.retry.disabled, true);
  assert.equal(parts.diagnostic.hidden, false);
  assert.equal(parts.diagnostic.textContent, "Caffold is preparing the Task store.");
});

test("offers Retry Task setup only while the store failed and no retry runs", () => {
  const failed = {
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "Task-store migration failed: disk full",
  };
  const waiting = rendered(createTaskStoreStatusSnapshot({
    readiness: failed,
    retryAvailable: true,
  }));
  assert.equal(waiting.card.dataset.taskStoreState, "failed");
  assert.equal(waiting.parts.title.textContent, "Task data upgrade failed");
  assert.equal(
    waiting.parts.instruction.textContent,
    "Retry the upgrade. The existing Task database remains unchanged until it succeeds.",
  );
  assert.equal(waiting.parts.retry.textContent, "Retry Task setup");
  assert.equal(waiting.parts.retry.disabled, false);

  const retrying = rendered(createTaskStoreStatusSnapshot({ readiness: failed }));
  assert.equal(retrying.parts.retry.textContent, "Retry Task setup");
  assert.equal(retrying.parts.retry.disabled, true);

  const quiet = rendered(createTaskStoreStatusSnapshot({
    readiness: { ...failed, diagnosticMessage: "" },
    retryAvailable: true,
  }));
  assert.equal(quiet.parts.diagnostic.hidden, true);
});

test("Retry asks the store owner through one intent event", (t) => {
  const previousElement = globalThis.Element;
  globalThis.Element ??= class Element {};
  t.after(() => {
    if (previousElement === undefined) {
      delete globalThis.Element;
    }
  });
  const events = [];
  const retry = { dataset: { taskStoreRecoveryAction: "retry" } };
  const owner = {
    contains: (element) => element === retry,
    dispatchEvent: (event) => events.push(event),
  };
  const target = Object.create(globalThis.Element.prototype);
  target.closest = () => retry;

  recovery.handleClick.call(owner, { target });

  assert.deepEqual(events.map(({ type, bubbles }) => ({ type, bubbles })), [
    { type: TASK_STORE_RETRY_REQUEST_EVENT, bubbles: true },
  ]);
});

test("exposes its retry action and scroll surface only while shown", () => {
  const retry = {
    disabled: false,
    hidden: false,
    textContent: "Retry Task setup",
    clicks: 0,
    getAttribute: () => null,
    getClientRects() {
      return this.hidden ? [] : [{}];
    },
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
  const scrollport = { getClientRects: () => [{}] };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector.includes("task-store-recovery-surface")) return scrollport;
      if (selector.includes('data-task-store-recovery-action="retry"')) return retry;
      return null;
    },
  };

  const scope = recovery.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), ["task-store-recovery:retry"]);
  scope.targets[0].activate();
  assert.equal(retry.clicks, 1);
  retry.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
  assert.deepEqual(recovery.actionHintScope.call(owner).targets, []);

  const scrollScope = recovery.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);

  owner.hidden = true;
  assert.deepEqual(recovery.actionHintScope.call(owner).targets, []);
  assert.deepEqual(recovery.scrollSurfaceScope.call(owner).surfaces, []);
});
