import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const {
  directoryIdFromKey,
  noteDirectoryKey,
  noteKey,
  notesTreeNodes,
} = await import("./tree.js");
after(() => registry.restore());

function ready(directories, notes = []) {
  return { state: "ready", listing: { directories, notes }, message: "" };
}

function directory(id, name, { directoryCount = 0, noteCount = 1 } = {}) {
  return { id, name, updatedAtMs: 1, directoryCount, noteCount };
}

test("builds each directory from its own read, and leaves unread ones to load when opened", () => {
  const levels = new Map([
    ["", ready(
      [
        directory("projects", "Projects", { directoryCount: 2, noteCount: 1 }),
        directory("empty", "Empty", { noteCount: 0 }),
        directory("unread", "Unread", { noteCount: 3 }),
      ],
      [{ id: "inbox", name: "Inbox", updatedAtMs: 1 }],
    )],
    ["projects", ready(
      [directory("reading", "Reading"), directory("broken", "Broken")],
      [{ id: "plan", name: "Plan", updatedAtMs: 1 }],
    )],
    ["reading", { state: "loading", listing: null, message: "" }],
    ["broken", { state: "failed", listing: null, message: "Request failed with HTTP 500" }],
  ]);

  assert.deepEqual(notesTreeNodes(levels), [
    {
      key: "directory:projects",
      kind: "directory",
      name: "Projects",
      children: {
        status: "ready",
        nodes: [
          {
            key: "directory:reading",
            kind: "directory",
            name: "Reading",
            children: { status: "loading", message: "Loading…" },
          },
          {
            key: "directory:broken",
            kind: "directory",
            name: "Broken",
            children: { status: "error", message: "Request failed with HTTP 500" },
          },
          { key: "note:plan", kind: "file", name: "Plan", noteId: "plan" },
        ],
      },
    },
    {
      key: "directory:empty",
      kind: "directory",
      name: "Empty",
      children: { status: "ready", nodes: [] },
    },
    {
      key: "directory:unread",
      kind: "directory",
      name: "Unread",
      children: { status: "unloaded" },
    },
    { key: "note:inbox", kind: "file", name: "Inbox", noteId: "inbox" },
  ]);
});

test("a directory read again, or failing again, keeps showing what it held", () => {
  const held = { directories: [], notes: [{ id: "plan", name: "Plan", updatedAtMs: 1 }] };
  const plan = [{ key: "note:plan", kind: "file", name: "Plan", noteId: "plan" }];
  for (const read of [
    { state: "loading", listing: held, message: "" },
    { state: "failed", listing: held, message: "Request failed with HTTP 500" },
  ]) {
    const levels = new Map([
      ["", ready([directory("projects", "Projects")])],
      ["projects", read],
    ]);
    assert.deepEqual(notesTreeNodes(levels)[0].children, { status: "ready", nodes: plan });
  }
});

test("nothing is built before the top of the tree has been read", () => {
  assert.deepEqual(notesTreeNodes(new Map()), []);
  assert.deepEqual(
    notesTreeNodes(new Map([["", { state: "loading", listing: null, message: "" }]])),
    [],
  );
});

test("keys name Notes and directories, and give a directory's id back", () => {
  assert.equal(noteKey("storage"), "note:storage");
  assert.equal(noteDirectoryKey("projects"), "directory:projects");
  assert.equal(directoryIdFromKey("directory:projects"), "projects");
  assert.equal(directoryIdFromKey("note:storage"), "");
  assert.equal(directoryIdFromKey(undefined), "");
});
