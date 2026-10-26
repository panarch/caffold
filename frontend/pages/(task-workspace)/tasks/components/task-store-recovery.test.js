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
const { ActionHints } = await import("#app/action-hints.ts");
const { ScrollSurfaces } = await import("#app/scroll-scope.ts");
const Recovery = registry.element("caffold-task-store-recovery");
after(() => registry.restore());

function draw({ readiness = null, retryAvailable = false }) {
  const owner = Object.create(Recovery.prototype, {
    snapshot: { value: { readiness, retryAvailable } },
  });
  owner.hints = new ActionHints(owner, () => {});
  owner.surfaces = new ScrollSurfaces(owner, () => {});
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
  Recovery.prototype.requestRetry.call({
    dispatchEvent: (event) => events.push(event),
  });

  assert.deepEqual(events.map(({ type, bubbles }) => ({ type, bubbles })), [
    { type: TASK_STORE_RETRY_REQUEST_EVENT, bubbles: true },
  ]);
});
