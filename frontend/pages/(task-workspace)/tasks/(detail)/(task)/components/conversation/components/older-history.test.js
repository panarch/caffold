import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./older-history.ts");
const olderHistory = registry.element("caffold-task-older-history").prototype;
after(() => registry.restore());

// The row as its conversation sets it. `show` stands in for drawing: it
// gives the row the control its template would draw.
function host(properties = {}) {
  const owner = Object.create(olderHistory, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      hidden: false,
      threadId: "a",
      hasOlder: true,
      loading: false,
      error: null,
      active: true,
      events: [],
      button: null,
      dispatchEvent(event) {
        this.events.push(event.detail);
        return true;
      },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  owner.show = (state = {}) => {
    Object.assign(owner, state);
    owner.updated();
    const label = templateHtml(owner.render()).match(
      /<button[^>]*>([^<]+)<\/button>/,
    )?.[1];
    owner.button = label
      ? {
          textContent: label,
          disabled: false,
          getAttribute: () => null,
          getClientRects: () => [{}],
          focus() {},
          click() {
            owner.request({ stopPropagation() {} });
          },
        }
      : null;
  };
  return owner;
}

test("says it is loading with the phrase alone, and offers loading or retrying", () => {
  const owner = host();
  assert.match(templateHtml(owner.render()), />Load older messages<\/button>/);
  const loading = templateHtml(host({ loading: true }).render());
  assert.match(
    loading,
    /<caffold-loading-text\s+class="task-older-history-loading"\s*>Loading older messages\.\.\.<\/caffold-loading-text>/,
  );
  assert.doesNotMatch(loading, /spinner/, "a waiting row shows the phrase without a ring");
  assert.doesNotMatch(loading, /<button/);
  assert.match(
    templateHtml(host({ error: "Unavailable" }).render()),
    />Retry loading older messages<\/button>/,
  );
});

test("owns load and retry actions and only emits the requested intent", () => {
  const owner = host();
  owner.show();
  const scope = owner.actionHintScope({ scopeId: "conversation:older-history" });
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.equal(scope.targets[0].invalidationOwner, owner);
  assert.equal(scope.targets[0].label, "Load older messages");
  scope.targets[0].activate();
  assert.deepEqual(owner.events, [{ threadId: "a", retry: false }]);
  assert.equal(owner.loading, false);

  owner.show({ error: "<unsafe>" });
  assert.equal(scope.targets[0].isActionable(), false);
  assert.match(templateHtml(owner.render()), /&lt;unsafe&gt;/);
  const retry = owner.actionHintScope({ scopeId: "conversation:older-history" }).targets[0];
  assert.equal(retry.label, "Retry loading older messages");
  retry.activate();
  assert.deepEqual(owner.events.at(-1), { threadId: "a", retry: true });
});

test("rejects actions while waiting, exhausted, inactive, detached, or replaced", () => {
  const owner = host();
  const scope = () => owner.actionHintScope({ scopeId: "conversation:older-history" });
  owner.show();
  const target = scope().targets[0];
  assert.equal(target.isActionable(), true);
  owner.active = false;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.button.click();
  assert.deepEqual(owner.events, []);
  owner.active = true;
  owner.isConnected = false;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.isConnected = true;

  owner.show({ loading: true });
  assert.equal(target.isActionable(), false);
  assert.deepEqual(scope().targets, []);
  owner.show({ loading: false, threadId: "b" });
  assert.equal(target.isActionable(), false);
  assert.equal(scope().targets[0].isActionable(), true);
  owner.show({ hasOlder: false });
  assert.equal(owner.hidden, true);
  assert.deepEqual(scope().targets, []);
});

test("a gap without a cursor exposes its error without offering an unusable retry", () => {
  const owner = host();
  owner.show({ hasOlder: false, error: "Reopen the Task to refresh its history." });
  assert.equal(owner.hidden, false);
  assert.match(templateHtml(owner.render()), /Reopen the Task/);
  assert.equal(owner.button, null);
  assert.deepEqual(owner.actionHintScope({ scopeId: "conversation:older-history" }).targets, []);
  owner.show({ error: null });
  assert.equal(owner.hidden, true);
});
