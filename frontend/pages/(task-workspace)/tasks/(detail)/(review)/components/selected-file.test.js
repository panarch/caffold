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
      },
      base: "HEAD",
      diffKind: "vs HEAD",
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
    setDiff: (diff, options) =>
      drawn.push({ path: diff.path, subtitle: options.presentation.subtitle }),
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

  assert.deepEqual(drawn, [
    { path: "repo/b.js", subtitle: "Modified · vs HEAD" },
  ]);
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
    kind: "HEAD",
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
  assert.equal(shown[0].position, null, "a first look opens where nothing was kept");
  assert.equal("position" in shown[1], false, "a background load keeps the place being read");
  assert.equal(shown[0].presentation.title, "logo.png");
  assert.equal(shown[0].presentation.downloadPath, undefined, "a change offers no Download");
  assert.equal(owner.shownStateKey, "working:logo.png:visual");
});

test("reads Source against the scope's base and a Markdown preview without one", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const requested = [];
  globalThis.window = { location: { origin: "http://caffold.test" } };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requested.push([url.searchParams.get("path"), url.searchParams.get("base")]);
    return new Response(JSON.stringify({ path: url.searchParams.get("path"), content: "" }));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const shown = [];
  const owner = {
    isConnected: true,
    generation: 0,
    shownStateKey: "",
    positions: new Map(),
    pendingLines: new Map(),
    rootPath: "repo",
    worktreeRootPath: "repo",
    viewer: {
      state: { status: "empty" },
      setLoading() {},
      setFile: (file) => shown.push(["file", file.path]),
      setMarkdown: (file) => shown.push(["markdown", file.path]),
    },
    diffPresentation: selectedFile.diffPresentation,
    acceptsLoad: selectedFile.acceptsLoad,
    restorePosition() {},
  };
  const fileView = (path, representation, base) => ({
    ...diffView(path),
    stateKey: `branch:${path}:${representation}`,
    representation,
    changes: { ...diffView(path).changes, base },
  });

  owner.view = fileView("planner.rs", "source", "origin/main");
  await selectedFile.load.call(owner);
  owner.view = fileView("notes.md", "preview", "origin/main");
  await selectedFile.load.call(owner);
  owner.view = fileView("plain.rs", "source", "");
  await selectedFile.load.call(owner);

  assert.deepEqual(requested, [
    ["repo/planner.rs", "origin/main"],
    ["repo/notes.md", null],
    ["repo/plain.rs", null],
  ]);
  assert.deepEqual(shown, [
    ["file", "repo/planner.rs"],
    ["markdown", "repo/notes.md"],
    ["file", "repo/plain.rs"],
  ]);
});

test("keeps the position of a view it leaves and carries the line to another representation", () => {
  const owner = {
    view: diffView("a.js"),
    positions: new Map(),
    pendingLines: new Map(),
    viewer: {
      visibleLine: () => 42,
      readingPosition: () => ({ top: 10, left: 0 }),
    },
  };
  const source = {
    ...diffView("a.js"),
    stateKey: "working:a.js:source",
    representation: "source",
  };

  selectedFile.rememberPosition.call(owner, source);
  assert.deepEqual(owner.positions.get("working:a.js:diff"), {
    reading: { top: 10, left: 0 },
    line: 42,
  });
  assert.equal(owner.pendingLines.get("working:a.js:source"), 42);

  owner.view = source;
  selectedFile.rememberPosition.call(owner, diffView("b.js"));
  assert.equal(owner.pendingLines.has("working:b.js:diff"), false);
});

test("keeps where the shown view was last read when it is read again, without the line on screen", () => {
  const anchor = { page: 2, fraction: 0.4 };
  const owner = {
    view: diffView("deck.pptx"),
    positions: new Map(),
    pendingLines: new Map(),
    viewer: {
      visibleLine: () => assert.fail("a viewer just put back reads its first line"),
      readingPosition: () => anchor,
    },
  };

  selectedFile.rememberPosition.call(owner, diffView("deck.pptx"));
  assert.equal(owner.positions.size, 0, "showing the same view again keeps what was kept");

  selectedFile.rememberPosition.call(owner, diffView("deck.pptx"), { reread: true });
  assert.deepEqual(owner.positions.get("working:deck.pptx:diff"), {
    reading: anchor,
    line: null,
  });
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
