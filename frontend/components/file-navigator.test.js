import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-navigator.js");
const navigator = registry.element("caffold-file-navigator").prototype;
after(() => registry.restore());

test("forwards the pull to the list it draws, clipped by itself", () => {
  const target = { id: "refresh" };
  const surface = { id: "tree" };
  let actionPull = null;
  let scrollPull = null;
  const fileList = {
    actionHintScope(pull) {
      actionPull = pull;
      return { targets: [target] };
    },
    scrollSurfaceScope(pull) {
      scrollPull = pull;
      return { surfaces: [surface] };
    },
  };
  const owner = Object.assign(Object.create(navigator), {
    list: { value: fileList },
    performUpdate() {},
  });
  const clipRoot = {};
  const actions = {
    file: "navigation.file.open",
    disclosure: "disclosure.toggle",
    refresh: "button.activate",
  };
  assert.deepEqual(owner.actionHintScope({
    scopeId: "review:files",
    actions,
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.deepEqual(actionPull, {
    scopeId: "review:files",
    actions,
    clipRoots: [owner, clipRoot],
  });
  assert.deepEqual(owner.scrollSurfaceScope({
    scopeId: "review:files",
    label: "Repository files",
    clipRoots: [clipRoot],
  }).surfaces, [surface]);
  assert.deepEqual(scrollPull, {
    scopeId: "review:files",
    label: "Repository files",
    clipRoots: [owner, clipRoot],
  });
});
