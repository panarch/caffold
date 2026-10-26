import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { TASK_STORE_RETRY_REQUEST_EVENT } = await import(
  "../../task-store-status.ts"
);
await import("./task-store-recovery.ts");
const Recovery = registry.element("caffold-task-store-recovery");
const recovery = Recovery.prototype;
after(() => registry.restore());

function draw({ readiness = null, retryAvailable = false }) {
  const owner = Object.create(Recovery.prototype, {
    snapshot: { value: { readiness, retryAvailable } },
  });
  return templateHtml(owner.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> ", ">")
    .replaceAll(" <", "<");
}

test("shows preparing while the store migrates, with retry held back", () => {
  const drawn = draw({
    readiness: {
      state: "migrating",
      blocksTaskOperations: true,
      diagnosticMessage: "Caffold is preparing the Task store.",
    },
  });

  assert.match(drawn, /data-task-store-state="migrating"/);
  assert.match(drawn, /data-task-store-title>Preparing Tasks…<\/h2>/);
  assert.match(
    drawn,
    /role="status">Caffold is preparing the local Task navigator before Tasks start.<\/p>/,
  );
  assert.match(
    drawn,
    /instruction">This finishes automatically when the local upgrade succeeds.<\/p>/,
  );
  assert.match(drawn, /\?disabled="true" @click="">Preparing…<\/button>/);
  assert.match(
    drawn,
    /\?hidden="false">Caffold is preparing the Task store.<\/p>/,
  );
});

test("offers Retry Task setup only while the store failed and no retry runs", () => {
  const failed = {
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "Task-store migration failed: disk full",
  };
  const waiting = draw({ readiness: failed, retryAvailable: true });
  assert.match(waiting, /data-task-store-state="failed"/);
  assert.match(waiting, /data-task-store-title>Task data upgrade failed<\/h2>/);
  assert.match(
    waiting,
    /instruction">Retry the upgrade. The existing Task database remains unchanged until it succeeds.<\/p>/,
  );
  assert.match(waiting, /\?disabled="false" @click="">Retry Task setup<\/button>/);

  const retrying = draw({ readiness: failed });
  assert.match(retrying, /\?disabled="true" @click="">Retry Task setup<\/button>/);

  const quiet = draw({
    readiness: { ...failed, diagnosticMessage: "" },
    retryAvailable: true,
  });
  assert.match(quiet, /diagnostic" \?hidden="true"><\/p>/);
});

test("Retry asks the store owner through one intent event", () => {
  const events = [];
  recovery.requestRetry.call({
    dispatchEvent: (event) => events.push(event),
  });

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
    performUpdate() {},
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
