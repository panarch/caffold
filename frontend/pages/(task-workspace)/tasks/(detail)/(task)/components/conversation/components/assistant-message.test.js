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
