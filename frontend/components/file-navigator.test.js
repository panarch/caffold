import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-navigator.js");
const navigator = registry.element("caffold-file-navigator").prototype;
after(() => registry.restore());

test("forwards semantic Action and Scroll options to its retained list owner", () => {
  const target = { id: "refresh" };
  const surface = { id: "tree" };
  let actionOptions = null;
  let scrollOptions = null;
  const fileList = {
    actionHintScope(options) {
      actionOptions = options;
      return { targets: [target] };
    },
    scrollSurfaceScope(options) {
      scrollOptions = options;
      return { surfaces: [surface] };
    },
  };
  const owner = {
    hidden: false,
    fileList,
    ensureRendered() {},
  };
  const clipRoot = {};
  assert.deepEqual(navigator.actionHintScope.call(owner, {
    scopeId: "review:files",
    actionId: "navigation.file.open",
    refreshActionId: "button.activate",
    clipRoots: [clipRoot],
  }).targets, [target]);
  assert.deepEqual(actionOptions, {
    scopeId: "review:files",
    actionId: "navigation.file.open",
    refreshActionId: "button.activate",
    clipRoots: [owner, clipRoot],
  });
  assert.deepEqual(navigator.scrollSurfaceScope.call(owner, {
    scopeId: "review:files",
    label: "Repository files",
    clipRoots: [clipRoot],
  }).surfaces, [surface]);
  assert.equal(scrollOptions.label, "Repository files");
  assert.deepEqual(scrollOptions.clipRoots, [owner, clipRoot]);
});
