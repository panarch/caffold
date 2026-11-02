import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./selected-file.js");
const selectedFile = registry.element("caffold-review-selected-file").prototype;
after(() => registry.restore());

function diffView(path, readDiff) {
  return {
    stateKey: `working:${path}:diff`,
    scope: "working",
    path,
    logicalPath: `repo/${path}`,
    representation: "diff",
    line: null,
    entry: null,
    changes: {
      ready: true,
      outdated: false,
      error: null,
      change: {
        file: { path: `repo/${path}`, status: "M" },
        deleted: false,
        kind: "unstaged",
      },
      diffKind: "",
      readDiff,
    },
  };
}

test("drops a diff that returns after another file is shown", async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const drawn = [];
  const viewer = {
    state: { status: "diff" },
    setLoading() {},
    setNotice() {},
    setError() {},
    setDiff: (diff) => drawn.push(diff.path),
  };
  const owner = {
    isConnected: true,
    generation: 0,
    shownStateKey: "",
    positions: new Map(),
    pendingLines: new Map(),
    rootPath: "repo",
    worktreeRootPath: "repo",
    view: diffView("a.js", () => first.promise),
    viewer,
    diffPresentation: selectedFile.diffPresentation,
    acceptsLoad: selectedFile.acceptsLoad,
    restorePosition() {},
  };

  const firstLoad = selectedFile.load.call(owner);
  owner.view = diffView("b.js", () => second.promise);
  const secondLoad = selectedFile.load.call(owner);
  second.resolve({ path: "repo/b.js", diff: "" });
  await secondLoad;
  first.resolve({ path: "repo/a.js", diff: "" });
  await firstLoad;

  assert.deepEqual(drawn, ["repo/b.js"]);
  assert.equal(owner.shownStateKey, "working:b.js:diff");
});

function visualView(path, readVersions) {
  const view = diffView(path, null);
  return {
    ...view,
    stateKey: `working:${path}:visual`,
    representation: "visual",
    changes: { ...view.changes, readVersions },
  };
}

test("shows an image's change as Visual, asking again on a background load", async () => {
  const shown = [];
  const loading = [];
  const viewer = {
    state: { status: "empty" },
    setLoading: (presentation) => loading.push(presentation.title),
    setNotice() {},
    setError() {},
    setVisual: (versions, options) => shown.push({ path: versions.path, ...options }),
  };
  const versions = {
    path: "repo/logo.png",
    repoRelativePath: "logo.png",
    kind: "unstaged",
    before: { source: "blob", oid: "a".repeat(40) },
    after: { source: "workingTree" },
  };
  const owner = {
    isConnected: true,
    generation: 0,
    shownStateKey: "",
    positions: new Map(),
    pendingLines: new Map(),
    rootPath: "repo",
    worktreeRootPath: "repo",
    view: visualView("logo.png", async () => versions),
    viewer,
    diffPresentation: selectedFile.diffPresentation,
    acceptsLoad: selectedFile.acceptsLoad,
    loadVisual: selectedFile.loadVisual,
  };

  await selectedFile.load.call(owner);
  await selectedFile.load.call(owner, { background: true });

  assert.deepEqual(loading, ["logo.png"], "a background load keeps what is shown");
  assert.deepEqual(
    shown.map(({ path, recheck }) => ({ path, recheck })),
    [
      { path: "repo/logo.png", recheck: false },
      { path: "repo/logo.png", recheck: true },
    ],
  );
  assert.equal(shown[0].presentation.title, "logo.png");
  assert.equal(shown[0].presentation.downloadPath, undefined, "a change offers no Download");
  assert.equal(owner.shownStateKey, "working:logo.png:visual");
});

test("keeps the position of a view it leaves and carries the line to another representation", () => {
  const owner = {
    view: diffView("a.js"),
    positions: new Map(),
    pendingLines: new Map(),
    viewer: {
      visibleLine: () => 42,
      captureContentScroll: () => ({ top: 10 }),
    },
  };
  const source = {
    ...diffView("a.js"),
    stateKey: "working:a.js:source",
    representation: "source",
  };

  selectedFile.rememberPosition.call(owner, source);
  assert.deepEqual(owner.positions.get("working:a.js:diff"), {
    scroll: { top: 10 },
    line: 42,
  });
  assert.equal(owner.pendingLines.get("working:a.js:source"), 42);

  owner.view = source;
  selectedFile.rememberPosition.call(owner, diffView("b.js"));
  assert.equal(owner.pendingLines.has("working:b.js:diff"), false);
});

test("keeps the reading position on a reread only while it shows the same view", () => {
  const loads = [];
  const owner = {
    shownStateKey: "working:a.js:diff",
    load: (options) => loads.push(options.background),
  };
  const source = {
    ...diffView("a.js"),
    stateKey: "working:a.js:source",
    representation: "source",
  };

  selectedFile.reload.call(owner, diffView("a.js"), { reread: true });
  selectedFile.reload.call(owner, source, { reread: true });
  selectedFile.reload.call(owner, source, { background: true });
  selectedFile.reload.call(owner, diffView("a.js"));

  assert.deepEqual(loads, [true, false, true, false]);
});
