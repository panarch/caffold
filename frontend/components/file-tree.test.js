import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-tree.js");
const fileTree = registry.element("caffold-file-tree").prototype;
after(() => registry.restore());

const file = (path) => ({
  key: `file:${path}`,
  kind: "file",
  name: path.split("/").at(-1),
  path,
});
const directory = (path, nodes) => ({
  key: `directory:${path}`,
  kind: "directory",
  name: path.split("/").at(-1),
  path,
  children: { status: "ready", nodes },
});
const group = (name, order, nodes) => ({
  key: `group:${name}`,
  kind: "group",
  name,
  order,
  children: { status: "ready", nodes },
});

test("lists every file in the order of its rows, closed directories included", () => {
  const nodes = [
    group("Staged", 1, [file("a.rs")]),
    group("Unstaged", 0, [
      file("b.rs"),
      directory("src", [file("src/z.rs"), file("src/a.rs")]),
      directory("unread", undefined),
      file("a.rs"),
    ]),
  ];
  const tree = (mode) =>
    elementStandIn(fileTree, {
      nodes,
      expandedKeys: new Set(),
      hiddenEntriesLast: false,
      globalFileSortMode: mode,
      getAttribute: () => null,
    });

  assert.deepEqual(tree("folders-first").filePathsInOrder(), [
    "src/a.rs",
    "src/z.rs",
    "a.rs",
    "b.rs",
    "a.rs",
  ]);
  assert.deepEqual(tree("name").filePathsInOrder(), [
    "a.rs",
    "b.rs",
    "src/a.rs",
    "src/z.rs",
    "a.rs",
  ]);
});
