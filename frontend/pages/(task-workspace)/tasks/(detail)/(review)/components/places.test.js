import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { groupReviewPlaces, lineText } = await import("./places.js");
after(() => registry.restore());

function place(path, line, fileName = path?.split("/").at(-1) ?? "") {
  return { path, fileName, line, character: 0, length: null, text: null };
}

test("groups places by file in the order each file first comes", () => {
  const groups = groupReviewPlaces([
    place("caffold/src/fs/syntax.rs", 470),
    place("caffold/src/fs/read.rs", 232),
    place("caffold/src/fs/syntax.rs", 523),
    place("/home/me/.rustup/lib/core/time.rs", 224),
    place("main.rs", 3),
  ]);

  assert.deepEqual(
    groups.map(({ fileName, folder, places }) => [
      fileName,
      folder,
      places.map(({ line }) => line),
    ]),
    [
      ["syntax.rs", "caffold/src/fs", [470, 523]],
      ["read.rs", "caffold/src/fs", [232]],
      ["time.rs", "/home/me/.rustup/lib/core", [224]],
      ["main.rs", "", [3]],
    ],
  );
});

test("keeps places outside Caffold's root apart by file name", () => {
  const groups = groupReviewPlaces([
    place(null, 10, "time.rs"),
    place(null, 12, "time.rs"),
    place(null, 1, "mod.rs"),
    place("time.rs", 4),
  ]);

  assert.deepEqual(
    groups.map(({ fileName, folder, places }) => [fileName, folder, places.length]),
    [
      ["time.rs", "", 2],
      ["mod.rs", "", 1],
      ["time.rs", "", 1],
    ],
  );
});

test("draws a line without its indentation and with the name in bold", () => {
  const drawn = lineText({
    ...place("lib.rs", 3),
    character: 17,
    length: 5,
    text: "\t        let x = limit + 1;",
  });

  assert.deepEqual(drawn.values, ["let x = ", "limit", " + 1;"]);
  assert.equal(
    lineText({ ...place("lib.rs", 3), character: 4, text: "    helper()" }),
    "helper()",
  );
  assert.equal(lineText(place(null, 3, "time.rs")), "");
});
