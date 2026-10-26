import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./older-history.ts");
const { ActionHints } = await import("#app/action-hints.ts");
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
  owner.hints = new ActionHints(owner, () => {});
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

test("a gap without a cursor exposes its error without offering an unusable retry", () => {
  const owner = host();
  owner.show({ hasOlder: false, error: "Reopen the Task to refresh its history." });
  assert.equal(owner.hidden, false);
  assert.match(templateHtml(owner.render()), /Reopen the Task/);
  assert.equal(owner.button, null);
  owner.show({ error: null });
  assert.equal(owner.hidden, true);
});
