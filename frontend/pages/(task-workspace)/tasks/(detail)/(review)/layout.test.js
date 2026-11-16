import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const review = registry.element("caffold-task-review").prototype;
after(() => registry.restore());

function scope(id) {
  return { targets: [{ id }], mutationRoots: [], scrollRoots: [] };
}

test("merges Review axes with only the active navigator and selected viewer", () => {
  const calls = { working: 0, branch: 0, files: 0, viewer: 0 };
  const actionOptions = {
    working: null,
    branch: null,
    files: null,
    viewer: null,
  };
  const pane = () => ({
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
  });
  const panes = { navigator: pane(), viewer: pane() };
  const owner = {
    active: true,
    hidden: false,
    task: { threadId: "thread-a", worktree: { rootPath: "/repo" } },
    contextKey: "thread-a\0/repo\0/repo",
    route: { navigator: "changes", scope: "working", viewer: "diff", path: "" },
    performUpdate() {},
    navigatorPane: { value: panes.navigator },
    viewerPane: { value: panes.viewer },
    axisControl(axis) {
      return { actionHintScope: () => scope(`${axis}-axis`) };
    },
    workingTreeChanges: {
      actionHintScope: (options) => {
        calls.working += 1;
        actionOptions.working = options;
        return scope("working");
      },
    },
    branchChanges: {
      actionHintScope: (options) => {
        calls.branch += 1;
        actionOptions.branch = options;
        return scope("branch");
      },
    },
    fileNavigator: {
      actionHintScope: (options) => {
        calls.files += 1;
        actionOptions.files = options;
        return scope("files");
      },
    },
    selectedFile: {
      actionHintScope: (options) => {
        calls.viewer += 1;
        actionOptions.viewer = options;
        return scope("viewer");
      },
    },
    split: {
      listShown: () => true,
      detailShown: () => true,
      actionHintScope: () => null,
    },
  };

  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "working"],
  );
  assert.deepEqual(calls, { working: 1, branch: 0, files: 0, viewer: 0 });
  assert.deepEqual(actionOptions.working.actions, {
    file: "navigation.file.open",
    disclosure: "disclosure.toggle",
    branch: "navigation.review.axis",
  });

  owner.route = { ...owner.route, scope: "branch", path: "src/a.js" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "branch", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 0, viewer: 1 });
  assert.equal(actionOptions.branch.actions.disclosure, "disclosure.toggle");
  assert.equal(actionOptions.branch.actions.select, "control.select.open");
  assert.equal(actionOptions.viewer.actions.link, "link.open");

  owner.route = { ...owner.route, navigator: "files" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "viewer-axis", "files", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 1, viewer: 2 });
  assert.equal(actionOptions.files.actions.disclosure, "disclosure.toggle");

  panes.navigator.visible = false;
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["viewer-axis", "viewer"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 1, viewer: 3 });

  panes.navigator.visible = true;
  panes.viewer.visible = false;
  owner.route = { ...owner.route, path: "" };
  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["navigator-axis", "files"],
  );
  assert.deepEqual(calls, { working: 1, branch: 1, files: 2, viewer: 3 });
});

test("composes the shared Review panel resizer through its public scope", () => {
  let options = null;
  const panelResizer = {
    actionHintScope(input) {
      options = input;
      return scope("separator");
    },
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    task: { threadId: "thread-a" },
    contextKey: "thread-a\0/repo",
    route: { navigator: "changes", scope: "working", path: "" },
    performUpdate() {},
    navigatorPane: { value: { getClientRects: () => [{}] } },
    viewerPane: { value: { getClientRects: () => [{}] } },
    axisControl: () => ({ actionHintScope: () => null }),
    workingTreeChanges: { actionHintScope: () => scope("working") },
    split: {
      listShown: () => true,
      detailShown: () => true,
      actionHintScope: panelResizer.actionHintScope,
    },
  };

  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["working", "separator"],
  );
  assert.deepEqual(options, {
    scopeId: "review:thread-a:navigator",
    actionId: "control.separator.focus",
    clipRoots: [owner],
  });
});

test("merges only visible Review navigator and viewer Scroll leaves", () => {
  const navigatorSurface = { id: "working-tree" };
  const viewerSurface = { id: "diff" };
  const pane = () => ({
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
  });
  const panes = { navigator: pane(), viewer: pane() };
  const shown = { list: true, detail: true };
  const owner = {
    active: true,
    hidden: false,
    task: { threadId: "thread-a" },
    contextKey: "thread-a\0/repo",
    route: { navigator: "changes", scope: "working", path: "src/a.js" },
    performUpdate() {},
    navigatorPane: { value: panes.navigator },
    viewerPane: { value: panes.viewer },
    split: {
      listShown: () => shown.list,
      detailShown: () => shown.detail,
    },
    workingTreeChanges: {
      scrollSurfaceScope: () => ({ surfaces: [navigatorSurface] }),
    },
    selectedFile: {
      scrollSurfaceScope: () => ({ surfaces: [viewerSurface] }),
    },
  };

  assert.deepEqual(
    review.scrollSurfaceScope.call(owner).surfaces,
    [navigatorSurface, viewerSurface],
  );
  shown.list = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
  shown.list = true;
  shown.detail = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, [navigatorSurface]);
  shown.detail = true;
  panes.navigator.visible = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, [viewerSurface]);
  panes.viewer.visible = false;
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, []);
});

test("shows a find's list in the navigator's place for Action Hints and Scroll", () => {
  const options = { hints: null, scroll: null };
  const owner = {
    active: true,
    hidden: false,
    task: { threadId: "thread-a", worktree: { rootPath: "/repo" } },
    contextKey: "thread-a\0/repo\0/repo",
    route: {
      navigator: "changes",
      scope: "working",
      viewer: "source",
      path: "",
      find: { kind: "references", path: "src/a.rs", line: 3, character: 4 },
    },
    performUpdate() {},
    navigatorPane: { value: { getClientRects: () => [{}] } },
    viewerPane: { value: { getClientRects: () => [{}] } },
    axisControl: () => ({ actionHintScope: () => scope("axis") }),
    places: {
      actionHintScope: (input) => {
        options.hints = input;
        return scope("places");
      },
      scrollSurfaceScope: (input) => {
        options.scroll = input;
        return { surfaces: [{ id: "places" }] };
      },
    },
    split: {
      listShown: () => true,
      detailShown: () => true,
      actionHintScope: () => null,
    },
  };

  assert.deepEqual(
    review.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["axis", "places"],
  );
  assert.equal(options.hints.scopeId, "review:thread-a:places");
  assert.deepEqual(options.hints.actions, {
    place: "navigation.file.open",
    close: "button.activate",
  });
  assert.deepEqual(review.scrollSurfaceScope.call(owner).surfaces, [
    { id: "places" },
  ]);
  assert.equal(options.scroll.label, "References");
});

test("answers a name: one definition opens, none or one outside the root shows a message, more open the list", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://caffold.test" } };
  const answers = [];
  const asked = [];
  globalThis.fetch = async (input, init) => {
    asked.push([new URL(input).pathname, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ places: answers.shift() }), {
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const shown = { messages: [], opened: [], finds: [] };
  const owner = {
    route: {
      scope: "working",
      navigator: "changes",
      viewer: "diff",
      path: "src/main.rs",
      line: null,
      baseRef: "",
      find: null,
    },
    task: { threadId: "thread-a", worktree: { rootPath: "work/app" } },
    codeNameAsking: null,
    placesReading: null,
    placesRead: null,
    logicalSelectedPath: () => "work/app/src/main.rs",
    reviewPlace: review.reviewPlace,
    selectedFile: {
      showCodeNameMessage: (position, message) =>
        shown.messages.push([position.line, position.character, message]),
    },
    openFileAt: (path, line) => shown.opened.push([path, line]),
    openFind: (find) => shown.finds.push(find),
  };
  const ask = (action) =>
    review.answerCodeName.call(owner, {
      stopPropagation() {},
      detail: { action, line: 7, character: 12, name: "root" },
    });

  answers.push([
    { path: "work/app/src/lib.rs", name: "lib.rs", line: 40, character: 4 },
  ]);
  await ask("definition");
  answers.push([
    { path: "work/shared/util.rs", name: "util.rs", line: 2, character: 0 },
  ]);
  await ask("definition");
  answers.push([]);
  await ask("definition");
  answers.push([{ path: null, name: "time.rs", line: 224, character: 8 }]);
  await ask("definition");
  answers.push([]);
  await ask("references");

  assert.deepEqual(asked[0], [
    "/api/language-servers/definition",
    { path: "work/app/src/main.rs", line: 7, character: 12 },
  ]);
  assert.deepEqual(shown.opened, [
    ["src/lib.rs", 40],
    ["/work/shared/util.rs", 2],
  ]);
  assert.deepEqual(shown.messages, [
    [7, 12, "No definition found."],
    [
      7,
      12,
      "Defined in time.rs, line 224, outside the folder Caffold serves.",
    ],
    [7, 12, "No references found."],
  ]);
  assert.deepEqual(shown.finds, []);

  const both = [
    { path: "work/app/src/main.rs", name: "main.rs", line: 5, character: 8, length: 4, text: "    Ok(root) =>" },
    { path: "work/app/src/repo.rs", name: "repo.rs", line: 9, character: 4, length: 4, text: "    root: PathBuf," },
  ];
  answers.push(both);
  await ask("definition");
  assert.deepEqual(shown.finds, [
    { kind: "definitions", path: "src/main.rs", line: 7, character: 12 },
  ]);
  assert.equal(owner.placesRead.status, "ready");
  assert.equal(owner.placesRead.name, "root");
  assert.deepEqual(
    owner.placesRead.places.map(({ path, line }) => [path, line]),
    [
      ["src/main.rs", 5],
      ["src/repo.rs", 9],
    ],
  );

  answers.push(both.slice(1));
  await ask("references");
  assert.deepEqual(shown.finds.at(-1), {
    kind: "references",
    path: "src/main.rs",
    line: 7,
    character: 12,
  });
});
