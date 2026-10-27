import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./list.js");
const list = registry.element("caffold-file-list").prototype;
after(() => registry.restore());

test("merges its Refresh files with the tree it draws and passes the pull down", () => {
  const clipRoot = {};
  const received = {};
  const tree = {
    actionHintScope(pull) {
      received.actions = pull;
      return { targets: [{ id: "review:files:file:a.js" }] };
    },
    scrollSurfaceScope(pull) {
      received.scroll = pull;
      return { surfaces: [{ id: "review:files:scroll" }] };
    },
  };
  const owner = elementStandIn(list, {
    state: { status: "ready" },
    tree: { value: tree },
    hints: {
      scope: () => ({ targets: [{ id: "review:files:refresh" }] }),
    },
    surfaces: { scope: () => ({ surfaces: [] }) },
  });
  const actions = {
    file: "navigation.file.open",
    disclosure: "disclosure.toggle",
    refresh: "button.activate",
  };

  const scope = owner.actionHintScope({
    scopeId: "review:files",
    actions,
    clipRoots: [clipRoot],
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "review:files:refresh",
    "review:files:file:a.js",
  ]);
  assert.deepEqual(received.actions, {
    scopeId: "review:files",
    actions,
    clipRoots: [owner, clipRoot],
  });

  const scrollScope = owner.scrollSurfaceScope({ scopeId: "review:files" });
  assert.deepEqual(scrollScope.surfaces.map(({ id }) => id), [
    "review:files:scroll",
  ]);
  assert.deepEqual(received.scroll, {
    scopeId: "review:files",
    label: "Files",
    clipRoots: [owner],
  });

  owner.state = { status: "loading" };
  assert.deepEqual(owner.actionHintScope({ scopeId: "review:files", actions }).targets.map(({ id }) => id), [
    "review:files:refresh",
  ]);
});
