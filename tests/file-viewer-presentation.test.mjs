import assert from "node:assert/strict";
import test from "node:test";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "../frontend/components/file-viewer-presentation.js";

test("source presentation keeps a stable basename while metadata becomes available", () => {
  const loading = sourceViewerPresentation({ path: "src/planner/mod.rs" });
  const loaded = sourceViewerPresentation({
    path: "src/planner/mod.rs",
    name: "mod.rs",
    size: 2048,
    modifiedMs: 1_767_000_000_000,
    languageHint: "rust",
  });

  assert.equal(loading.title, "mod.rs");
  assert.equal(loaded.title, loading.title);
  assert.equal(loading.subtitle, "");
  assert.equal(loaded.subtitle, loading.subtitle);
  assert.deepEqual(
    loaded.metadata.map(({ field }) => field),
    ["path", "size", "modified", "language"],
  );
});

test("loaded source keeps explicit unknown metadata instead of looking incomplete", () => {
  const presentation = sourceViewerPresentation({
    path: "notes/README",
    name: "README",
    size: 0,
    modifiedMs: null,
    languageHint: null,
  });

  assert.deepEqual(presentation.metadata, [
    { field: "path", label: "Path", value: "notes/README" },
    { field: "size", label: "Size", value: "0 B" },
    { field: "modified", label: "Modified", value: "Unknown" },
    { field: "language", label: "Language", value: "Text" },
  ]);
});

test("diff presentation derives one title and subtitle before content arrives", () => {
  const presentation = diffViewerPresentation({
    repository: { rootPath: "src" },
    path: "src/planner/mod.rs",
    kind: "commit abcdef1",
    status: " M",
  });

  assert.equal(presentation.title, "planner/mod.rs");
  assert.equal(presentation.subtitle, "Modified · Commit abcdef1");
  assert.equal(presentation.lineStats, null);
  assert.deepEqual(
    presentation.metadata.map(({ field }) => field),
    ["path", "kind", "repository"],
  );
});

test("diff presentation exposes authoritative line statistics when available", () => {
  const presentation = diffViewerPresentation({
    path: "src/planner/mod.rs",
    kind: "unstaged",
    status: " M",
    additions: 42,
    deletions: 17,
  });

  assert.deepEqual(presentation.lineStats, { additions: 42, deletions: 17 });
});

test("diff presentation omits unavailable line statistics", () => {
  const presentation = diffViewerPresentation({
    path: "assets/logo.png",
    kind: "unstaged",
    status: " M",
    additions: null,
    deletions: null,
  });

  assert.equal(presentation.lineStats, null);
});

test("diff presentation does not repeat equivalent status and kind labels", () => {
  const presentation = diffViewerPresentation({
    path: "new-file.rs",
    kind: "untracked",
    status: "??",
  });

  assert.equal(presentation.title, "new-file.rs");
  assert.equal(presentation.subtitle, "Added");
});
