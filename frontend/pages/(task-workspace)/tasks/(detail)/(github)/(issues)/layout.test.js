import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const layout = registry.element("caffold-github-issues-layout").prototype;
after(() => registry.restore());

test("provides only the active Issue list or detail scope", () => {
  const calls = [];
  const owner = {
    hidden: false,
    view: "detail",
    page: 3,
    ensureRendered() {},
    detailPage: {
      actionHintScope(options) {
        calls.push(["detail", options]);
        return { targets: [{ id: "start-task" }] };
      },
    },
    listPage: {
      actionHintScope(options) {
        calls.push(["list", options]);
        return { targets: [{ id: "issue-row" }] };
      },
    },
  };
  const clipRoot = {};

  assert.deepEqual(layout.actionHintScope.call(owner, {
    scopeId: "github:issues",
    clipRoots: [clipRoot],
  }).targets, [{ id: "start-task" }]);
  assert.deepEqual(calls, [["detail", {
    scopeId: "github:issues:detail",
    clipRoots: [owner, clipRoot],
  }]]);

  owner.view = "list";
  assert.deepEqual(layout.actionHintScope.call(owner, {
    scopeId: "github:issues",
    clipRoots: [clipRoot],
  }).targets, [{ id: "issue-row" }]);
  assert.equal(calls[1][0], "list");
  assert.equal(calls[1][1].scopeId, "github:issues:page:3");
});

test("delegates Scroll only to the active Issue view", () => {
  const listSurface = { id: "issues" };
  const detailSurface = { id: "issue-body" };
  const owner = {
    hidden: false,
    view: "list",
    page: 2,
    ensureRendered() {},
    listPage: { scrollSurfaceScope: () => ({ surfaces: [listSurface] }) },
    detailPage: { scrollSurfaceScope: () => ({ surfaces: [detailSurface] }) },
  };
  assert.deepEqual(layout.scrollSurfaceScope.call(owner).surfaces, [listSurface]);
  owner.view = "detail";
  assert.deepEqual(layout.scrollSurfaceScope.call(owner).surfaces, [detailSurface]);
});
