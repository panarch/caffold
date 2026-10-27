import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { taskInfoSnapshot } = await import("./info.js");
const info = registry.element("caffold-task-detail-info").prototype;
const actions = registry.element(
  "caffold-task-detail-info-actions",
).prototype;
const { ActionHints } = await import("#app/action-hints.js");
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
  const host = owner(actions, { snapshot: taskInfoSnapshot(snapshot) });
  host.hints = new ActionHints(host);
  const markup = templateHtml(host.render()).replace(/\s+/g, " ");
  const button = (type) =>
    markup.match(new RegExp(`data-task-info-action="${type}"[^>]*>`))?.[0] ?? "";
  return {
    markup,
    disabled: (type) => button(type).includes('?disabled="true"'),
  };
}

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

test("closes the Task details popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const infoOwner = owner(info, { infoPopover: { value: popover } });
  info.handleDismiss.call(infoOwner, { target: {} });
  assert.equal(hidden, 0);
  info.handleDismiss.call(infoOwner, { target: popover });
  assert.equal(hidden, 1);
});
