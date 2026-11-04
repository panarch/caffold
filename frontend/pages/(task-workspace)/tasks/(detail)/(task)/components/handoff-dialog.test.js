import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
const registry = installCustomElementUnitRegistry();
await import("./handoff-dialog.js");
const dialog = registry.element("caffold-task-handoff-dialog").prototype;
after(() => registry.restore());

test("opens with the requested agent as an initial choice for a new conversation", async () => {
  const resets = [];
  let shown = 0;
  const opener = {};
  const owner = {
    state: { phase: "closed" }, generation: 0, updateComplete: Promise.resolve(),
    options: { value: { reset: context => resets.push(context) } },
    dialog: { value: { showModal() { shown += 1; } } },
    transition(next) { dialog.transition.call(this, next); }, requestUpdate() {},
  };
  await dialog.open.call(owner, { taskId: "source", cwd: "src", managed: true, targetProvider: "grok" }, opener);
  assert.equal(shown, 1);
  assert.equal(owner.opener, opener);
  assert.deepEqual(resets, [{ cwd: "src", initialSelection: { provider: "grok" }, placement: "below" }]);
});

test("one transition owner accepts the declared lifecycle and rejects creation from closed", () => {
  const owner = { state: { phase: "closed" }, requestUpdate() {} };
  const source = { taskId: "source", cwd: "src", managed: true };
  assert.throws(() => dialog.transition.call(owner, { phase: "creating", source, error: null }));
  for (const phase of ["choosing", "creating", "choosing", "creating", "closed", "closed", "choosing", "closed"]) {
    dialog.transition.call(owner, phase === "closed" ? { phase } : { phase, source, error: null });
    assert.equal(owner.state.phase, phase);
  }
});

test("deactivation invalidates pending completions and releases dialog focus ownership", () => {
  const effects = [];
  const owner = {
    generation: 1, state: { phase: "creating" }, opener: {}, requestUpdate() {},
    options: { value: { hidePopovers: () => effects.push("hide") } },
    dialog: { value: { close: () => effects.push("close") } },
    transition(next) { dialog.transition.call(this, next); },
  };
  dialog.deactivate.call(owner);
  assert.equal(owner.generation, 2);
  assert.equal(owner.state.phase, "closed");
  assert.equal(owner.opener, null);
  assert.deepEqual(effects, ["hide", "close"]);
});

test("retries adoption of the same created Task with its original options while the picker is locked", async () => {
  const created = { activeTask: { threadId: "created" }, prompt: "Preparation only" };
  const original = { provider: "codex", model: "original-model" };
  const submissions = [];
  const locks = [];
  let accept = false;
  const owner = {
    state: { phase: "choosing", source: { taskId: "source", cwd: "src" }, error: null },
    ready: false, created, createdOptions: original, generation: 1, isConnected: true,
    options: { value: { submissionOptions() { throw new Error("must retain original options"); }, setContext: context => locks.push(context.locked), hidePopovers() {} } },
    dialog: { value: { close() {} } },
    transition(next) { dialog.transition.call(this, next); }, requestUpdate() {},
    dispatchEvent(event) { submissions.push(event.detail); event.detail.adopted = accept; },
  };
  await dialog.start.call(owner);
  assert.equal(owner.state.phase, "choosing");
  assert.match(owner.state.error.message, /Retry to open the same Task/);
  assert.equal(owner.created, created);
  assert.equal(locks.at(-1), true);
  accept = true;
  await dialog.start.call(owner);
  assert.equal(owner.state.phase, "closed");
  assert.equal(submissions.length, 2);
  for (const handoff of submissions) {
    assert.equal(handoff.created, created);
    assert.equal(handoff.submission.options, original);
    assert.equal(handoff.submission.prompt, "Preparation only");
    assert.equal(handoff.submission.submissionId, "handoff:created");
  }
});

test("a response received after deactivation cannot adopt or submit the created Task", { timeout: 5000 }, async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost" }, setTimeout, clearTimeout, dispatchEvent() {} };
  let complete;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  globalThis.fetch = async () => {
    requested();
    return new Promise(resolve => { complete = resolve; });
  };
  let adopted = 0;
  const owner = {
    state: { phase: "choosing", source: { taskId: "source", cwd: "src" }, error: null },
    ready: true, created: null, createdOptions: null, generation: 1, isConnected: true, opener: null,
    options: { value: { submissionOptions: () => ({ provider: "codex" }), setContext() {}, hidePopovers() {} } },
    dialog: { value: { close() {} } },
    transition(next) { dialog.transition.call(this, next); }, requestUpdate() {},
    dispatchEvent() { adopted += 1; },
  };
  try {
    const pending = dialog.start.call(owner);
    await Promise.race([started, pending.then(() => { throw new Error("Creation ended before calling fetch"); })]);
    dialog.deactivate.call(owner);
    complete(new Response(JSON.stringify({ activeTask: { threadId: "created" }, prompt: "Preparation" }), { status: 200, headers: { "content-type": "application/json" } }));
    await pending;
    assert.equal(adopted, 0);
    assert.equal(owner.created, null);
    assert.equal(owner.state.phase, "closed");
  } finally { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
