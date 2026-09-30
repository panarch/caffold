import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./broken-delete-dialog.js");
const prototype = registry.element("caffold-broken-task-delete-dialog").prototype;
const original = { window: globalThis.window, fetch: globalThis.fetch };
after(() => registry.restore());
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

function ownerFixture() {
  const nodes = new Map();
  const dialog = { open: false, setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  nodes.set(":scope > dialog", dialog);
  const buttons = [{ value: "cancel" }, { value: "delete" }];
  nodes.set('button[value="delete"]', buttons[1]);
  const owner = Object.assign(Object.create(prototype), {
    phase: "idle", generation: 0, isConnected: true, intents: [],
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    querySelectorAll: () => buttons,
    intent(detail) { this.intents.push(detail); },
  });
  owner.setContext({ threadId: "broken", title: "Broken Task", error: {
    allowedActions: ["deleteTask"], worktreeId: "uuid", worktreePath: "/managed/uuid", worktreeMissing: false,
  } });
  globalThis.window = { location: { origin: "http://127.0.0.1" }, setTimeout, clearTimeout };
  return { owner, dialog, buttons, nodes };
}

test("all declared deletion edges and rejected events use one phase authority", () => {
  const edges = { idle: { open: "confirming", reset: "idle" },
    confirming: { cancel: "idle", confirm: "deleting", reset: "idle" },
    deleting: { success: "idle", failure: "confirming", refused: "idle", reset: "idle" } };
  for (const [phase, allowed] of Object.entries(edges)) {
    for (const event of ["open", "cancel", "confirm", "success", "failure", "refused", "reset", "stale"]) {
      const { owner, buttons } = ownerFixture();
      owner.phase = phase;
      assert.equal(owner.transition(event), event in allowed, `${phase}/${event}`);
      assert.equal(owner.phase, allowed[event] ?? phase);
      if (event in allowed) assert.equal(buttons[0].disabled, owner.phase === "deleting");
    }
  }
});

test("cancel and revoked confirmation have no mutation and invalidate the captured target", () => {
  const { owner, dialog } = ownerFixture();
  assert.equal(owner.openTask(), true);
  owner.cancel();
  assert.equal(owner.phase, "idle");
  assert.equal(dialog.open, false);
  assert.equal(owner.target, null);
  owner.openTask();
  const generation = owner.generation;
  owner.setContext({ threadId: "broken", error: { allowedActions: [] } });
  assert.equal(owner.phase, "idle");
  assert.equal(dialog.open, false);
  assert.ok(owner.generation > generation);
  assert.equal(owner.openTask(), false);
});

test("duplicate confirm and cancel cannot interrupt deletion, and stale completion cannot publish", async () => {
  const { owner, dialog, buttons } = ownerFixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; await gate; return { ok: true, json: async () => ({ threadId: "broken" }) }; };
  owner.openTask();
  const request = owner.confirm();
  await owner.confirm();
  owner.cancel();
  assert.equal(requests, 1);
  assert.equal(owner.phase, "deleting");
  assert.equal(dialog.open, true);
  assert.ok(buttons.every((button) => button.disabled));
  owner.setContext({ threadId: "other", error: { allowedActions: ["deleteTask"], worktreeId: "other-uuid" } });
  release();
  await request;
  assert.equal(owner.phase, "idle");
  assert.deepEqual(owner.intents, []);
});

test("current success publishes deletion, while a partial failure requires a fresh eligible diagnosis", async () => {
  const { owner, dialog } = ownerFixture();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ threadId: "broken" }) });
  owner.openTask();
  await owner.confirm();
  assert.equal(dialog.open, false);
  assert.deepEqual(owner.intents, [{ type: "task-deleted", threadId: "broken" }]);

  for (const eligible of [true, false]) {
    const { owner, dialog, nodes } = ownerFixture();
    globalThis.fetch = async (_url, options) => {
      const error = options.method === "DELETE" ? { message: "native delete failed" }
        : { message: "latest diagnosis", allowedActions: eligible ? ["deleteTask"] : [], worktreeId: "uuid" };
      return { ok: false, status: 409, json: async () => ({ error }) };
    };
    owner.openTask();
    await owner.confirm();
    assert.equal(owner.phase, eligible ? "confirming" : "idle");
    assert.equal(dialog.open, eligible);
    assert.equal(owner.intents.at(-1).type, "broken-delete-error");
    if (eligible) assert.equal(nodes.get("[data-broken-delete-error]").textContent, "native delete failed");
  }
});
