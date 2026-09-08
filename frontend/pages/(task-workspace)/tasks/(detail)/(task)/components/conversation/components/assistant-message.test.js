import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./assistant-message.js");
const message = registry.element("caffold-task-assistant-message").prototype;
after(() => registry.restore());

function messageOwner({ copyButton, markdown } = {}) {
  return Object.assign(Object.create(message), {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector.includes("copy-button")) {
        return copyButton ?? null;
      }
      return selector.includes("caffold-task-markdown")
        ? markdown ?? null
        : null;
    },
  });
}

function childScope(target) {
  return {
    actionHintScope(options) {
      this.options = options;
      return { targets: [target], mutationRoots: [this] };
    },
  };
}

test("merges only the Copy and Markdown children it mounts", () => {
  const copyTarget = { id: "message:a:copy-button:copy" };
  const markdownTarget = { id: "message:a:markdown:link:1" };
  const copyButton = childScope(copyTarget);
  const markdown = childScope(markdownTarget);
  const owner = messageOwner({ copyButton, markdown });
  const conversation = { id: "conversation" };

  const scope = owner.actionHintScope({
    scopeId: "message:a",
    clipRoots: [conversation],
  });
  assert.deepEqual(scope.targets, [copyTarget, markdownTarget]);
  assert.deepEqual(scope.mutationRoots, [copyButton, markdown]);
  assert.equal(copyButton.options.scopeId, "message:a:copy-button");
  assert.equal(markdown.options.scopeId, "message:a:markdown");
  for (const child of [copyButton, markdown]) {
    assert.deepEqual(child.options.clipRoots, [owner, conversation]);
  }

  owner.hidden = true;
  assert.deepEqual(owner.actionHintScope({ scopeId: "message:a" }).targets, []);
});

test("publishes nothing before its children are mounted", () => {
  const scope = messageOwner().actionHintScope({ scopeId: "message:a" });
  assert.deepEqual(scope.targets, []);
  assert.deepEqual(scope.mutationRoots, []);
});

test("delegates Scroll only to its exact current Markdown child", () => {
  const surfaces = { surfaces: [{ id: "markdown-table" }] };
  const child = {
    scrollSurfaceScope(options) {
      this.options = options;
      return surfaces;
    },
  };
  let markdown = child;
  const owner = messageOwner();
  owner.querySelector = () => markdown;

  assert.equal(
    owner.scrollSurfaceScope({
      scopeId: "message:a",
      clipRoots: [{ id: "conversation" }],
    }),
    surfaces,
  );
  assert.equal(child.options.scopeId, "message:a:markdown");
  assert.equal(child.options.isCurrent(), true);
  markdown = null;
  assert.equal(child.options.isCurrent(), false);
});
