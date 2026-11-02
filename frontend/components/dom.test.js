import assert from "node:assert/strict";
import test from "node:test";

import {
  changeRepresentationChoices,
  changeRepresentationFor,
  changeRepresentations,
} from "./dom.js";

test("a picture other than SVG changes as pictures alone, and SVG both ways", () => {
  for (const path of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.avif"]) {
    assert.deepEqual(changeRepresentations(path), { diff: false, visual: true }, path);
  }
  assert.deepEqual(changeRepresentations("assets/logo.svg"), {
    diff: true,
    visual: true,
  });
  for (const path of ["README.md", "report.pdf", "src/main.rs", "Makefile", ""]) {
    assert.deepEqual(changeRepresentations(path), { diff: true, visual: false }, path);
  }
});

test("a file's change opens the way the last one showed when it can", () => {
  assert.equal(changeRepresentationFor("a.png", "diff"), "visual");
  assert.equal(changeRepresentationFor("a.rs", "visual"), "diff");
  assert.equal(changeRepresentationFor("logo.svg", "visual"), "visual");
  assert.equal(changeRepresentationFor("logo.svg", "diff"), "diff");
});

test("a viewer offers the choice only for a file that has both", () => {
  assert.deepEqual(changeRepresentationChoices("logo.svg", "visual"), {
    choices: [
      { value: "diff", label: "Diff" },
      { value: "visual", label: "Visual" },
    ],
    selected: "visual",
  });
  assert.deepEqual(changeRepresentationChoices("a.png", "visual"), {
    choices: [],
    selected: "visual",
  });
  assert.deepEqual(changeRepresentationChoices("a.rs", "diff"), {
    choices: [],
    selected: "diff",
  });
});
