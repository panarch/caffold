import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { ChangesReading } from "../changes-reading.js";

const registry = installCustomElementUnitRegistry();
await import("./branch-changes.js");
const branchChanges = registry.element("caffold-review-branch-changes").prototype;
after(() => registry.restore());

test("drops a Branch compare that returns after Review leaves Branch", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const compares = [];
  globalThis.window = { location: { origin: "http://caffold.test" } };
  globalThis.fetch = (input, ...options) => {
    if (new URL(input).pathname !== "/api/git/compare") {
      return previousFetch(input, ...options);
    }
    const response = Promise.withResolvers();
    compares.push(response);
    return response.promise;
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const payload = {
    baseRef: "origin/main",
    headRef: "main",
    files: [{ path: "src/planner.rs", repoRelativePath: "planner.rs", status: "M" }],
  };
  const drawn = [];
  const tree = {
    setBaseSelection() {},
    setLoading() {},
    setEmptyMessage() {},
    setSelectedPath() {},
    setCompare: (compare) => drawn.push(compare),
    updateCompare: (compare) => drawn.push(compare),
  };
  const owner = {
    isConnected: true,
    shown: true,
    rootPath: "/repo",
    branch: "main",
    baseRef: "origin/main",
    refs: {
      repository: { rootPath: "/repo" },
      refs: [{ name: "origin/main", kind: "remote" }],
      defaultBaseRef: "origin/main",
    },
    compare: null,
    error: null,
    reading: new ChangesReading(),
    generation: 0,
    selectedPath: "",
    acceptsRead: branchChanges.acceptsRead,
    showReadingState() {},
    headRef: branchChanges.headRef,
    announceRead() {},
    tree: () => tree,
  };

  const current = branchChanges.read.call(owner);
  compares.at(-1).resolve(new Response(JSON.stringify(payload)));
  assert.deepEqual(await current, payload);
  assert.equal(drawn.length, 1);

  const late = branchChanges.read.call(owner);
  owner.shown = false;
  compares.at(-1).resolve(new Response(JSON.stringify(payload)));
  assert.equal(await late, null);
  assert.equal(drawn.length, 1);
});
