import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const layout = registry.element("caffold-github-pulls-layout").prototype;
after(() => registry.restore());

test("delegates Action and Scroll to the exact active Pull Request view", () => {
  const children = Object.fromEntries(["list", "detail", "files"].map((view) => [
    view,
    {
      actionHintScope: () => ({ targets: [{ id: `${view}-action` }] }),
      scrollSurfaceScope: () => ({ surfaces: [{ id: `${view}-scroll` }] }),
    },
  ]));
  const owner = {
    hidden: false,
    view: "list",
    page: 4,
    ensureRendered() {},
    listPage: children.list,
    detailPage: children.detail,
    filesPage: children.files,
  };
  for (const view of ["list", "detail", "files"]) {
    owner.view = view;
    assert.deepEqual(layout.actionHintScope.call(owner).targets, [
      { id: `${view}-action` },
    ]);
    assert.deepEqual(layout.scrollSurfaceScope.call(owner).surfaces, [
      { id: `${view}-scroll` },
    ]);
  }
});
