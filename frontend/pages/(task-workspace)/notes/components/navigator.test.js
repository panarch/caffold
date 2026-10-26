import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.ts");
const navigator = registry.element("caffold-notes-navigator").prototype;
after(() => registry.restore());

const SNAPSHOT_CHANGED = new Map([["snapshot", undefined]]);

function treeOwner({ levels, selectedNoteId = "", reveal = { noteId: "", keys: [] } }) {
  const fileTree = {
    model: null,
    expanded: [],
    setModel(model) {
      this.model = model;
    },
    hasKey(key) {
      const visit = (nodes) => nodes.some((node) =>
        node.key === key || visit(node.children?.nodes ?? []));
      return visit(this.model?.nodes ?? []);
    },
    expandKeys(keys) {
      this.expanded.push([...keys]);
    },
  };
  const owner = {
    snapshot: {
      levels,
      selectedNoteId,
      picker: "",
      companion: false,
      disabledNoteId: "",
      reveal,
    },
    dataset: {},
    revealSignature: "",
    pendingRevealKeys: [],
    fileTree,
  };
  owner.revealOpenNote = navigator.revealOpenNote.bind(owner);
  return owner;
}

function ready(directories, notes = []) {
  return { state: "ready", listing: { directories, notes }, message: "" };
}

const projects = { id: "projects", name: "Projects", updatedAtMs: 1, directoryCount: 1, noteCount: 1 };
const decisions = { id: "decisions", name: "Decisions", updatedAtMs: 1, directoryCount: 0, noteCount: 1 };
const storage = { id: "storage", name: "Storage", updatedAtMs: 1 };

test("hands the tree the workspace snapshot once the top has been read", () => {
  const unread = treeOwner({ levels: new Map() });
  navigator.updated.call(unread, SNAPSHOT_CHANGED);
  assert.equal(unread.fileTree.model, null);

  const shown = treeOwner({
    levels: new Map([["", ready([projects])], ["projects", ready([], [storage])]]),
    selectedNoteId: "storage",
  });
  navigator.updated.call(shown, SNAPSHOT_CHANGED);
  assert.equal(shown.fileTree.model.entityKey, "notes");
  assert.equal(shown.fileTree.model.selectedKey, "note:storage");
  assert.equal(shown.fileTree.model.expandNewDirectories, false, "directories start closed");
  assert.equal(shown.fileTree.model.nodes[0].children.nodes[0].source, "storage");
});

test("opens each directory that holds the open Note once its row exists, and only once", () => {
  const reveal = { noteId: "storage", keys: ["directory:projects", "directory:decisions"] };
  const owner = treeOwner({
    levels: new Map([["", ready([projects])]]),
    selectedNoteId: "storage",
    reveal,
  });

  navigator.updated.call(owner, SNAPSHOT_CHANGED);
  assert.deepEqual(owner.fileTree.expanded, [["directory:projects"]]);

  owner.snapshot = {
    ...owner.snapshot,
    levels: new Map([
      ["", ready([projects])],
      ["projects", ready([decisions])],
      ["decisions", ready([], [storage])],
    ]),
  };
  navigator.updated.call(owner, SNAPSHOT_CHANGED);
  assert.deepEqual(owner.fileTree.expanded, [["directory:projects"], ["directory:decisions"]]);

  navigator.updated.call(owner, SNAPSHOT_CHANGED);
  assert.deepEqual(
    owner.fileTree.expanded,
    [["directory:projects"], ["directory:decisions"]],
    "a directory a person closes afterwards stays closed",
  );

  owner.snapshot = { ...owner.snapshot, reveal: { noteId: "inbox", keys: [] } };
  navigator.updated.call(owner, SNAPSHOT_CHANGED);
  owner.snapshot = { ...owner.snapshot, reveal };
  navigator.updated.call(owner, SNAPSHOT_CHANGED);
  assert.deepEqual(
    owner.fileTree.expanded.at(-1),
    ["directory:projects", "directory:decisions"],
    "opening the Note again reveals it again",
  );
});

test("adds the tree's Notes and folders to its own controls", () => {
  let treePull = null;
  const fileTree = {
    actionHintScope(pull) {
      treePull = pull;
      return { targets: [{ id: "notes:tree:file:storage" }] };
    },
  };
  const owner = Object.assign(Object.create(navigator), {
    hints: { scope: (pull) => ({ targets: [{ id: `${pull.scopeId}:retry` }] }) },
    tree: { value: fileTree },
  });

  const scope = owner.actionHintScope({ clipRoots: ["pane"] });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "notes:retry",
    "notes:tree:file:storage",
  ]);
  assert.deepEqual(treePull, {
    scopeId: "notes:tree",
    actions: { file: "navigation.note.open", disclosure: "disclosure.toggle" },
    clipRoots: [owner, "pane"],
  });
});
