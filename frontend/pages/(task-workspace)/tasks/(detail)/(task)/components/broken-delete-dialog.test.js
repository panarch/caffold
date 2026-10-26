import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./broken-delete-dialog.ts");
const Dialog = registry.element("caffold-broken-task-delete-dialog");
const { ActionHints } = await import("#app/action-hints.ts");
const { KeyboardContexts } = await import("#app/keyboard-navigation.ts");
const original = { window: globalThis.window, fetch: globalThis.fetch };
after(() => registry.restore());
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

// A dialog whose drawing is kept as markup, with a native dialog stand-in.
function dialogFixture() {
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const owner = Object.create(Dialog.prototype, Object.getOwnPropertyDescriptors({
    phase: "idle", generation: 0, context: null, target: null, failure: null,
    isConnected: true, intents: [], drawn: "",
    dialog: { value: dialog },
    draw() { this.drawn = templateHtml(this.render()).replace(/\s+/g, " "); },
    intent(detail) { this.intents.push(detail); },
  }));
  owner.hints = new ActionHints(owner, () => {});
  owner.keyboard = new KeyboardContexts(owner, () => {});
  owner.setContext({ threadId: "broken", title: "Broken Task", error: {
    allowedActions: ["deleteTask"], worktreeId: "uuid", worktreePath: "/managed/uuid", worktreeMissing: false,
  } });
  globalThis.window = { location: { origin: "http://127.0.0.1" }, setTimeout, clearTimeout };
  return { owner, dialog };
}

test("all declared deletion edges and rejected events use one phase authority", () => {
  const edges = { idle: { open: "confirming", reset: "idle" },
    confirming: { cancel: "idle", confirm: "deleting", reset: "idle" },
    deleting: { success: "idle", failure: "confirming", refused: "idle", reset: "idle" } };
  for (const [phase, allowed] of Object.entries(edges)) {
    for (const event of ["open", "cancel", "confirm", "success", "failure", "refused", "reset", "stale"]) {
      const { owner } = dialogFixture();
      owner.phase = phase;
      owner.drawn = "";
      assert.equal(owner.transition(event), event in allowed, `${phase}/${event}`);
      assert.equal(owner.phase, allowed[event] ?? phase);
      if (event in allowed) {
        const deleting = owner.phase === "deleting";
        assert.match(owner.drawn, new RegExp(`closedby="${deleting ? "none" : "any"}"`));
        assert.equal((owner.drawn.match(/\?disabled="true"/g) ?? []).length, deleting ? 2 : 0);
      }
    }
  }
});

test("cancel and revoked confirmation have no mutation and invalidate the captured target", () => {
  const { owner, dialog } = dialogFixture();
  assert.equal(owner.openTask(), true);
  assert.match(owner.drawn, /Delete task and remaining worktree files\?/);
  assert.match(owner.drawn, /data-broken-delete-path >\/managed\/uuid</);
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
  const { owner, dialog } = dialogFixture();
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
  assert.match(owner.drawn, />Deleting…<\/button>/);
  owner.setContext({ threadId: "other", error: { allowedActions: ["deleteTask"], worktreeId: "other-uuid" } });
  release();
  await request;
  assert.equal(owner.phase, "idle");
  assert.deepEqual(owner.intents, []);
});

test("current success publishes deletion, while a partial failure requires a fresh eligible diagnosis", async () => {
  const { owner, dialog } = dialogFixture();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ threadId: "broken" }) });
  owner.openTask();
  await owner.confirm();
  assert.equal(dialog.open, false);
  assert.deepEqual(owner.intents, [{ type: "task-deleted", threadId: "broken" }]);

  for (const eligible of [true, false]) {
    const { owner, dialog } = dialogFixture();
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
    if (eligible) assert.match(owner.drawn, /role="alert" \?hidden="false"\s*>native delete failed</);
  }
});
