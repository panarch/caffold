import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setImmediate } from "node:timers/promises";
import { elementStandIn, installCustomElementUnitRegistry } from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./mermaid-view.js");
const prototype = registry.element("caffold-mermaid-view").prototype;
after(() => registry.restore());

function viewer() {
  return elementStandIn(prototype, {
    source: "flowchart LR\nA --> B", active: true, isConnected: true, displayed: true,
    renderState: { kind: "inactive", result: null },
  });
}

function transport(t) {
  const pending = [];
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((resolve, reject) => pending.push({ options, resolve, reject })));
  return pending;
}
const svgResponse = (svg) => ({ ok: true, text: async () => svg });

test("same input is a no-op and Code/Preview reuses only the current artifact", async (t) => {
  const pending = transport(t);
  const owner = viewer();
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "pending");
  owner.transition({ type: "input" });
  assert.equal(pending.length, 1);
  pending[0].resolve(svgResponse("<svg>current</svg>"));
  await setImmediate();
  assert.equal(owner.renderState.kind, "ready");
  const result = owner.renderState.result;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.result, result);
  owner.active = false;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "inactive");
  assert.equal(owner.renderState.result, result);
  owner.active = true;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "ready");
  assert.equal(pending.length, 1);
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "pending");
  assert.equal(pending.length, 2);
});

test("superseded and disconnected requests cannot replace current output", async (t) => {
  const pending = transport(t);
  const owner = viewer();
  owner.transition({ type: "input" });
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve(svgResponse("old"));
  await setImmediate();
  assert.equal(owner.renderState.kind, "pending");
  owner.isConnected = false;
  owner.transition({ type: "input" });
  assert.equal(pending[1].options.signal.aborted, true);
  pending[1].reject(new Error("late error"));
  await setImmediate();
  assert.deepEqual(owner.renderState, { kind: "inactive", result: null });
  owner.isConnected = true;
  owner.transition({ type: "input" });
  pending[2].resolve(svgResponse("new"));
  await setImmediate();
  assert.equal(owner.renderState.result.svg, "new");
});

test("errors stay local, reject unchanged input, and retry or recover on new input", async (t) => {
  const pending = transport(t);
  const owner = viewer();
  owner.transition({ type: "retry" });
  assert.equal(pending.length, 0);
  owner.transition({ type: "input" });
  pending[0].resolve({ ok: false, status: 400, json: async () => ({ error: { code: "mermaid_invalid_source", message: "Incomplete diagram" } }) });
  await setImmediate();
  assert.equal(owner.renderState.kind, "error");
  assert.equal(owner.renderState.message, "Incomplete diagram");
  owner.transition({ type: "input" });
  assert.equal(pending.length, 1);
  owner.transition({ type: "retry" });
  assert.equal(pending.length, 2);
  pending[1].reject(new Error("offline"));
  await setImmediate();
  assert.equal(owner.renderState.kind, "error");
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  pending[2].resolve(svgResponse("recovered"));
  await setImmediate();
  assert.equal(owner.renderState.result.svg, "recovered");
});
