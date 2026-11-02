import assert from "node:assert/strict";
import test from "node:test";

import {
  fileHasRepresentation,
  isReviewViewer,
  representationForFile,
} from "./representations.js";

test("a representation a file lacks gives way to its partner", () => {
  assert.equal(representationForFile("diff", "assets/logo.png"), "visual");
  assert.equal(representationForFile("visual", "src/main.rs"), "diff");
  assert.equal(representationForFile("source", "assets/logo.png"), "preview");
  assert.equal(representationForFile("preview", "src/main.rs"), "source");
  for (const viewer of ["diff", "visual", "source", "preview"]) {
    assert.equal(representationForFile(viewer, "assets/logo.svg"), viewer, viewer);
    assert.equal(representationForFile(viewer, ""), viewer, `${viewer} without a file`);
  }
  assert.equal(representationForFile("diff", "docs/report.pdf"), "diff");
});

test("names the representations each kind of file has", () => {
  const has = (path) =>
    ["diff", "visual", "source", "preview"].filter((viewer) =>
      fileHasRepresentation(path, viewer),
    );
  assert.deepEqual(has("assets/logo.png"), ["visual", "preview"]);
  assert.deepEqual(has("assets/logo.svg"), ["diff", "visual", "source", "preview"]);
  assert.deepEqual(has("README.md"), ["diff", "source", "preview"]);
  assert.deepEqual(has("src/main.rs"), ["diff", "source"]);
  assert.deepEqual(has("docs/report.pdf"), ["diff", "preview"]);
});

test("reads only the four representations from an address", () => {
  for (const viewer of ["diff", "visual", "source", "preview"]) {
    assert.equal(isReviewViewer(viewer), true, viewer);
  }
  for (const value of ["toString", "constructor", "", undefined, null, 1]) {
    assert.equal(isReviewViewer(value), false, String(value));
  }
});
