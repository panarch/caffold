import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { ChangesReading } from "../changes-reading.js";

const registry = installCustomElementUnitRegistry();
await import("./working-tree-changes.js");
const workingTreeChanges = registry
  .element("caffold-review-working-tree-changes")
  .prototype;
after(() => registry.restore());

test("drops a Working Tree status read sent before the page came back", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const statuses = [];
  globalThis.window = { location: { origin: "http://caffold.test" } };
  globalThis.fetch = (input, ...options) => {
    if (new URL(input).pathname !== "/api/git/status") {
      return previousFetch(input, ...options);
    }
    const response = Promise.withResolvers();
    statuses.push(response);
    return response.promise;
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const clean = { repository: { rootPath: "/repo" }, files: [] };
  const changed = {
    repository: { rootPath: "/repo" },
    files: [{ path: "src/planner.rs", status: "M" }],
  };
  const drawn = [];
  const announced = [];
  const tree = {
    setLoading() {},
    setSelectedPath() {},
    setStatus: (status) => drawn.push(status),
    updateStatus: (status) => drawn.push(status),
  };
  const reading = new ChangesReading();
  reading.start();
  reading.succeed();
  const owner = {
    isConnected: true,
    rootPath: "/repo",
    branch: "main",
    status: clean,
    error: null,
    reading,
    generation: 0,
    selectedPath: "",
    acceptsRead: workingTreeChanges.acceptsRead,
    showReadingState() {},
    announceRead: (detail) => announced.push(detail),
    tree,
  };

  const sentBefore = workingTreeChanges.read.call(owner, { background: true });
  workingTreeChanges.markOutdated.call(owner);
  statuses.at(-1).resolve(new Response(JSON.stringify(changed)));
  assert.equal(await sentBefore, null);
  assert.equal(owner.status, clean);
  assert.equal(owner.reading.state.fromBeforeReturn, true);
  assert.equal(drawn.length, 0);
  assert.deepEqual(announced, []);

  const sentAfter = workingTreeChanges.read.call(owner, { background: true });
  statuses.at(-1).resolve(new Response(JSON.stringify(changed)));
  assert.deepEqual(await sentAfter, changed);
  assert.equal(owner.reading.state.fromBeforeReturn, false);
  assert.deepEqual(drawn, [changed]);
  assert.deepEqual(announced, [
    { ok: true, hadData: true, wasOutdated: true, background: true },
  ]);
});

test("reads each diff from the last commit, whichever way the file is staged", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const requested = [];
  globalThis.window = { location: { origin: "http://caffold.test" } };
  globalThis.fetch = async (input) => {
    requested.push(new URL(input));
    return new Response("{}");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const owner = {
    rootPath: "/repo",
    base: workingTreeChanges.base,
    status: {
      files: [
        { path: "repo/both.rs", status: "M", category: "unstaged", staged: true, unstaged: true, untracked: false },
        { path: "repo/gone.rs", status: "D", category: "unstaged", staged: false, unstaged: true, untracked: false },
      ],
    },
  };

  await workingTreeChanges.readDiff.call(owner, "repo/both.rs");
  await workingTreeChanges.readVersions.call(owner, "repo/both.rs");

  assert.deepEqual(
    requested.map((url) => [url.pathname, url.searchParams.get("base")]),
    [
      ["/api/git/diff", "HEAD"],
      ["/api/git/diff-versions", "HEAD"],
    ],
  );
  assert.equal(workingTreeChanges.diffKind.call(owner), "vs HEAD");
  assert.equal(workingTreeChanges.change.call(owner, "repo/both.rs").deleted, false);
  assert.equal(workingTreeChanges.change.call(owner, "repo/gone.rs").deleted, true);
});
