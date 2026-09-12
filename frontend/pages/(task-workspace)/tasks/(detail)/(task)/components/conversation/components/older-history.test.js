import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./older-history.js");
const olderHistory = registry.element("caffold-task-older-history").prototype;
after(() => registry.restore());

function host() {
  const owner = Object.assign(Object.create(olderHistory), {
    isConnected: true,
    hidden: false,
    writes: 0,
    events: [],
    html: "",
    control: null,
    querySelector: () => owner.control,
    dispatchEvent: (event) => owner.events.push(event.detail),
  });
  Object.defineProperty(owner, "innerHTML", {
    get: () => owner.html,
    set(html) {
      owner.writes += 1;
      owner.html = html;
      const label = html.match(/<button[^>]*>([^<]+)<\/button>/)?.[1];
      owner.control = label ? {
        textContent: label,
        disabled: false,
        getAttribute: () => null,
        getClientRects: () => [{}],
        focus() {},
        click() {
          owner.handleClick({
            target: { closest: () => this },
            stopPropagation() {},
          });
        },
      } : null;
    },
  });
  owner.ensureState();
  return owner;
}

test("retains the same control or spinner for equivalent display snapshots", () => {
  const owner = host();
  const ready = { threadId: "a", hasOlder: true };
  assert.equal(owner.setSnapshot(ready), true);
  const button = owner.button();
  assert.equal(owner.setSnapshot({ ...ready }), false);
  assert.equal(owner.button(), button);
  assert.equal(owner.writes, 1);

  assert.equal(owner.setSnapshot({ ...ready, loading: true }), true);
  assert.equal(owner.setSnapshot({ ...ready, loading: true }), false);
  assert.equal(owner.writes, 2);
  assert.equal(owner.button(), null);

  assert.equal(owner.setSnapshot({ ...ready, error: new Error("Unavailable") }), true);
  assert.equal(owner.setSnapshot({ ...ready, error: new Error("Unavailable") }), false);
  assert.equal(owner.writes, 3);
  assert.equal(owner.setSnapshot({ ...ready, threadId: "b", error: new Error("Unavailable") }), true);
});

test("owns load and retry actions and only emits the requested intent", () => {
  const owner = host();
  const ready = { threadId: "a", hasOlder: true };
  owner.setSnapshot(ready);
  const scope = owner.actionHintScope({ scopeId: "conversation:older-history" });
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.equal(scope.targets[0].invalidationOwner, owner);
  assert.equal(scope.targets[0].label, "Load older messages");
  scope.targets[0].activate();
  assert.deepEqual(owner.events, [{ threadId: "a", retry: false }]);
  assert.equal(owner.snapshot.loading, false);

  owner.setSnapshot({ ...ready, error: new Error("<unsafe>") });
  assert.equal(scope.targets[0].isActionable(), false);
  assert.match(owner.innerHTML, /&lt;unsafe&gt;/);
  const retry = owner.actionHintScope({ scopeId: "conversation:older-history" }).targets[0];
  assert.equal(retry.label, "Retry loading older messages");
  retry.activate();
  assert.deepEqual(owner.events.at(-1), { threadId: "a", retry: true });
});

test("rejects actions while waiting, exhausted, inactive, detached, or replaced", () => {
  const owner = host();
  const ready = { threadId: "a", hasOlder: true };
  const scope = () => owner.actionHintScope({ scopeId: "conversation:older-history" });
  owner.setSnapshot(ready);
  const target = scope().targets[0];
  assert.equal(target.isActionable(), true);
  owner.setActive(false);
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.button().click();
  assert.deepEqual(owner.events, []);
  owner.setActive(true);
  owner.isConnected = false;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.isConnected = true;

  owner.setSnapshot({ ...ready, loading: true });
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.setSnapshot({ ...ready, threadId: "b" });
  assert.equal(target.isActionable(), false);
  assert.equal(scope().targets[0].isActionable(), true);
  owner.setSnapshot({ threadId: "b" });
  assert.equal(owner.hidden, true);
  assert.deepEqual(scope().targets, []);
});

test("a gap without a cursor exposes its error without offering an unusable retry", () => {
  const owner = host();
  owner.setSnapshot({ threadId: "a", hasOlder: false, error: new Error("Reopen the Task to refresh its history.") });
  assert.equal(owner.hidden, false);
  assert.match(owner.innerHTML, /Reopen the Task/);
  assert.equal(owner.button(), null);
  assert.deepEqual(owner.actionHintScope({ scopeId: "conversation:older-history" }).targets, []);
  owner.setSnapshot({ threadId: "a", hasOlder: false });
  assert.equal(owner.hidden, true);
});
