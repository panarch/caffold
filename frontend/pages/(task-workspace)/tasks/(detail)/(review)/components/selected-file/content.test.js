import assert from "node:assert/strict";
import test from "node:test";

import { contentFor } from "./content.js";

const modified = {
  file: { path: "repo/src/a.js", status: "M" },
  deleted: false,
  kind: "unstaged",
};

function view(path, representation, changes = {}) {
  return {
    logicalPath: `repo/${path}`,
    representation,
    changes: {
      ready: true,
      outdated: false,
      failed: false,
      error: null,
      change: null,
      ...changes,
    },
  };
}

test("waits for the changes before deciding a diff", () => {
  assert.deepEqual(
    contentFor(view("src/a.js", "diff", { ready: false })),
    { kind: "unchanged" },
  );
  assert.equal(contentFor(view("src/a.js", "source", { ready: false })).kind, "file");
});

test("loads a changed file's diff, source, or Markdown preview", () => {
  assert.deepEqual(
    contentFor(view("src/a.js", "diff", { change: modified })),
    { kind: "diff", change: modified },
  );
  assert.deepEqual(contentFor(view("src/a.js", "source")), { kind: "file" });
  assert.deepEqual(contentFor(view("README.md", "preview")), { kind: "markdown" });
});

test("hands images and documents to the viewer", () => {
  assert.deepEqual(contentFor(view("art/logo.png", "preview")), { kind: "image" });
  assert.deepEqual(
    contentFor(view("docs/report.pdf", "preview")),
    { kind: "document", documentKind: "pdf" },
  );
});

test("explains files the scope or representation cannot show", () => {
  assert.deepEqual(
    contentFor(view("src/a.js", "source", { change: { ...modified, deleted: true } })),
    {
      kind: "notice",
      message: "This file was deleted in the selected scope. Diff remains available.",
      options: { title: "a.js" },
    },
  );
  assert.deepEqual(contentFor(view("art/logo.png", "source")), {
    kind: "notice",
    message: "Source is unavailable for this file.",
    options: { actionLabel: "View preview", action: "view-preview", title: "logo.png" },
  });
  assert.deepEqual(contentFor(view("src/a.js", "preview")), {
    kind: "notice",
    message: "Preview is unavailable for this file.",
    options: { actionLabel: "View source", action: "view-source", title: "a.js" },
  });
  assert.deepEqual(contentFor(view("src/a.js", "diff")), {
    kind: "notice",
    message: "No changes in this scope.",
    options: { actionLabel: "View source", action: "view-source", title: "a.js" },
  });
});

test("does not say a file is unchanged from changes read before the page came back", () => {
  const error = new Error("compare unavailable");
  assert.deepEqual(
    contentFor(view("src/a.js", "diff", { outdated: true })),
    { kind: "loading" },
  );
  assert.deepEqual(
    contentFor(view("src/a.js", "diff", { outdated: true, failed: true, error })),
    { kind: "error", error },
  );
  assert.deepEqual(
    contentFor(view("src/a.js", "diff", { outdated: true, change: modified })),
    { kind: "diff", change: modified },
  );
});
