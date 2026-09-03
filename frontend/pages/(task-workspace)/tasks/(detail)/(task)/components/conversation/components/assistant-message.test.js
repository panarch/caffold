import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./assistant-message.js");
const message = registry.element("caffold-task-assistant-message").prototype;
after(() => registry.restore());

test("delegates only to its direct Markdown child", () => {
  const target = { id: "copy" };
  const markdown = {
    actionHintScope(options) {
      assert.equal(options.scopeId, "message:a:markdown");
      return { targets: [target] };
    },
  };
  const owner = {
    hidden: false,
    querySelector: () => markdown,
  };
  assert.deepEqual(
    message.actionHintScope.call(owner, { scopeId: "message:a" }).targets,
    [target],
  );
  owner.hidden = true;
  assert.deepEqual(message.actionHintScope.call(owner, { scopeId: "message:a" }).targets, []);
});

test("delegates Scroll only to its exact current Markdown child", () => {
  const childScope = { surfaces: [{ id: "markdown-table" }] };
  const child = {
    scrollSurfaceScope(options) {
      this.options = options;
      return childScope;
    },
  };
  let markdown = child;
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector: () => markdown,
  };

  assert.equal(message.scrollSurfaceScope.call(owner, {
    scopeId: "message:a",
    clipRoots: [{ id: "conversation" }],
  }), childScope);
  assert.equal(child.options.scopeId, "message:a:markdown");
  assert.equal(child.options.isCurrent(), true);
  markdown = null;
  assert.equal(child.options.isCurrent(), false);
});
