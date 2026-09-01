import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown.js");
const markdown = registry.element("caffold-task-markdown").prototype;
after(() => registry.restore());

test("merges only code-block providers mounted in the retained Markdown body", () => {
  const targets = [{ id: "wrap" }, { id: "copy" }];
  const blocks = targets.map((target) => ({
    actionHintScope: () => ({ targets: [target] }),
  }));
  const body = { querySelectorAll: () => blocks };
  const owner = {
    hidden: false,
    dataset: { renderState: "markdown" },
    body: () => body,
  };
  assert.deepEqual(
    markdown.actionHintScope.call(owner, { scopeId: "message:a" }).targets,
    targets,
  );
  owner.dataset.renderState = "plain";
  assert.deepEqual(markdown.actionHintScope.call(owner, { scopeId: "message:a" }).targets, []);
});
