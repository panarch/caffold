import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let singlePane = false;
globalThis.window = { matchMedia: () => ({ matches: singlePane }) };
const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-git-log-commit-page").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("composes only active Commit tree/viewer leaves", () => {
  const treeTarget = { id: "file" };
  const viewerTarget = { id: "back" };
  const treeSurface = { id: "tree" };
  const viewerSurface = { id: "viewer" };
  let resizerOptions = null;
  let treeOptions = null;
  let viewerOptions = null;
  const commitTree = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      treeOptions = options;
      return { targets: [treeTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [treeSurface] }),
  };
  const fileViewer = {
    getClientRects: () => [{}],
    actionHintScope(options) {
      viewerOptions = options;
      return { targets: [viewerTarget] };
    },
    scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
  };
  const panelResizer = {
    collapsed: false,
    getClientRects: () => singlePane || panelResizer.collapsed ? [] : [{}],
    actionHintScope(options) {
      resizerOptions = options;
      return { targets: [{ id: "separator" }] };
    },
  };
  const owner = {
    hidden: false,
    detailView: "viewer",
    commitTree,
    fileViewer,
    panelResizer,
    sidePaneCollapsed: page.sidePaneCollapsed,
    currentCommitSha: () => "abcdef123456",
  };
  assert.deepEqual(page.actionHintScope.call(owner).targets, [
    treeTarget,
    { id: "separator" },
    viewerTarget,
  ]);
  assert.equal(treeOptions.actions.disclosure, "disclosure.toggle");
  assert.equal(viewerOptions.actions.refresh, "button.activate");
  assert.equal(viewerOptions.actions.link, "link.open");
  assert.equal(resizerOptions.actionId, "control.separator.focus");
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [
    treeSurface,
    viewerSurface,
  ]);
  panelResizer.collapsed = true;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
  panelResizer.collapsed = false;
  singlePane = true;
  assert.deepEqual(page.actionHintScope.call(owner).targets, [viewerTarget]);
  assert.deepEqual(page.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
});

test("opens each file's change the way it can be shown, and offers both only for SVG", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  window.location = new URL("http://caffold.test");
  globalThis.fetch = async (url) => {
    requests.push(new URL(url).pathname);
    return Response.json({ path: "repo/file", before: null, after: null, diff: "" });
  };
  after(() => {
    globalThis.fetch = previousFetch;
    delete window.location;
  });
  const shown = [];
  const offered = [];
  const owner = {
    currentPath: "repo",
    changeView: "diff",
    fileViewer: {
      setChangeChoices: ({ choices }) => offered.push(choices.map(({ value }) => value)),
      setVisual: () => shown.push("visual"),
      setDiff: () => shown.push("diff"),
    },
    diffPresentation: () => ({ title: "file" }),
  };
  const open = (path) => page.loadChange.call(owner, path, "abc1234", "M", () => true);

  await open("assets/logo.png");
  await open("src/main.rs");
  await open("assets/icon.svg");
  owner.refreshSelectedDiff = async () => {
    shown.push("reloaded");
  };
  page.chooseChange.call(owner, { detail: { representation: "visual" } });
  page.chooseChange.call(owner, { detail: { representation: "source" } });

  assert.deepEqual(shown, ["visual", "diff", "diff", "reloaded"]);
  assert.deepEqual(offered, [[], [], ["diff", "visual"]]);
  assert.deepEqual(requests, [
    "/api/git/commit-diff-versions",
    "/api/git/commit-diff",
    "/api/git/commit-diff",
  ]);
  assert.equal(owner.changeView, "visual");
});
