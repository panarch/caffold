import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./work-details.ts");
const workDetails = registry.element("caffold-task-work-details").prototype;
after(() => registry.restore());

test("merges its root disclosure with what each of its work items offers", () => {
  const pulls = [];
  const part = (id) => ({
    actionHintScope(pull) {
      pulls.push(pull);
      return { targets: [{ id }] };
    },
  });
  const parts = {
    "command:command-a": part("view-output"),
    "message:message-a": part("copy"),
  };
  const body = {};
  const owner = Object.assign(Object.create(workDetails), {
    items: [
      { kind: "command", identity: "command-a" },
      { kind: "shell", key: "shell-a" },
      { kind: "message", identity: "message-a" },
    ],
    hints: { scope: () => ({ targets: [{ id: "disclosure" }] }) },
    body: { value: body },
    parts: { get: (key) => parts[key] },
  });
  const pull = { scopeId: "work:a", clipRoots: [{}] };

  assert.deepEqual(
    workDetails.actionHintScope.call(owner, pull).targets.map(({ id }) => id),
    ["disclosure", "view-output", "copy"],
  );
  assert.deepEqual(pulls, [
    {
      scopeId: "work:a:command:command-a",
      clipRoots: [owner, body, ...pull.clipRoots],
    },
    {
      scopeId: "work:a:message:message-a",
      clipRoots: [owner, body, ...pull.clipRoots],
    },
  ]);

  owner.body = { value: undefined };
  assert.deepEqual(workDetails.actionHintScope.call(owner, pull).targets, []);
});

test("offers its printed outputs and its items' Scroll surfaces only while open", () => {
  const pulls = [];
  const part = (id) => ({
    scrollSurfaceScope(pull) {
      pulls.push(pull);
      return { surfaces: [{ id }] };
    },
  });
  const parts = {
    "command:command-a": part("command-output"),
    "command-group:group-a": part("group"),
    "message:message-a": part("table"),
  };
  const details = { open: false };
  const body = {};
  const owner = Object.assign(Object.create(workDetails), {
    items: [
      { kind: "command", identity: "command-a" },
      { kind: "command-group", identity: "group-a" },
      { kind: "message", identity: "message-a" },
    ],
    surfaces: { scope: () => ({ surfaces: [{ id: "raw:1" }] }) },
    details: { value: details },
    body: { value: body },
    parts: { get: (key) => parts[key] },
  });
  const pull = { scopeId: "work:a", clipRoots: [{}] };
  const ids = () =>
    workDetails.scrollSurfaceScope
      .call(owner, pull)
      .surfaces.map(({ id }) => id);

  assert.deepEqual(ids(), []);
  assert.deepEqual(pulls, []);

  details.open = true;
  assert.deepEqual(ids(), ["raw:1", "command-output", "table"]);
  assert.deepEqual(
    pulls.map(({ scopeId }) => scopeId),
    ["work:a:command:command-a", "work:a:message:message-a"],
  );
  assert.deepEqual(pulls[0].clipRoots, [owner, body, ...pull.clipRoots]);
});
