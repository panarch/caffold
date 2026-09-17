import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.js");
const navigator = registry.element("caffold-notes-navigator").prototype;
after(() => registry.restore());

function presentationOwner({ levels, selectedNoteId = "", reveal = { noteId: "", keys: [] } }) {
  const message = { textContent: "" };
  const status = { hidden: true, dataset: {}, message };
  const retry = { hidden: true };
  const fileTree = {
    hidden: true,
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
    snapshotValue: { levels, selectedNoteId, reveal },
    revealSignature: "",
    pendingRevealKeys: [],
    status,
    retry,
    fileTree: () => fileTree,
    retryButton: () => retry,
    querySelector(selector) {
      if (selector.endsWith(".notes-navigator-message")) {
        return message;
      }
      return status;
    },
    tree: fileTree,
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

test("shows loading, failure, emptiness, and the tree from the workspace snapshot", () => {
  const loading = presentationOwner({ levels: new Map() });
  navigator.render.call(loading);
  assert.equal(loading.status.hidden, false);
  assert.equal(loading.status.message.textContent, "Loading notes…");
  assert.equal(loading.retry.hidden, true);
  assert.equal(loading.tree.hidden, true);

  const failed = presentationOwner({
    levels: new Map([["", {
      state: "failed",
      listing: null,
      message: "Caffold is preparing the Task store.",
    }]]),
  });
  navigator.render.call(failed);
  assert.equal(failed.status.dataset.state, "failed");
  assert.equal(failed.status.message.textContent, "Caffold is preparing the Task store.");
  assert.equal(failed.retry.hidden, false);

  const empty = presentationOwner({ levels: new Map([["", ready([])]]) });
  navigator.render.call(empty);
  assert.equal(empty.status.message.textContent, "No notes yet. Ask an agent in a Task to save one.");
  assert.equal(empty.tree.hidden, true);

  const shown = presentationOwner({
    levels: new Map([["", ready([projects])], ["projects", ready([], [storage])]]),
    selectedNoteId: "storage",
  });
  navigator.render.call(shown);
  assert.equal(shown.status.hidden, true);
  assert.equal(shown.tree.hidden, false);
  assert.equal(shown.tree.model.entityKey, "notes");
  assert.equal(shown.tree.model.selectedKey, "note:storage");
  assert.equal(shown.tree.model.expandNewDirectories, false, "directories start closed");
  assert.equal(shown.tree.model.nodes[0].children.nodes[0].noteId, "storage");

  const refreshFailed = presentationOwner({
    levels: new Map([["", {
      state: "failed",
      listing: { directories: [projects], notes: [] },
      message: "Request failed with HTTP 500",
    }]]),
  });
  navigator.render.call(refreshFailed);
  assert.equal(refreshFailed.status.hidden, false);
  assert.equal(refreshFailed.retry.hidden, false);
  assert.equal(refreshFailed.tree.hidden, false, "a failed refresh keeps the last tree");
});

test("opens each directory that holds the open Note once its row exists, and only once", () => {
  const reveal = { noteId: "storage", keys: ["directory:projects", "directory:decisions"] };
  const owner = presentationOwner({
    levels: new Map([["", ready([projects])]]),
    selectedNoteId: "storage",
    reveal,
  });

  navigator.render.call(owner);
  assert.deepEqual(owner.tree.expanded, [["directory:projects"]]);

  owner.snapshotValue = {
    levels: new Map([
      ["", ready([projects])],
      ["projects", ready([decisions])],
      ["decisions", ready([], [storage])],
    ]),
    selectedNoteId: "storage",
    reveal,
  };
  navigator.render.call(owner);
  assert.deepEqual(owner.tree.expanded, [["directory:projects"], ["directory:decisions"]]);

  navigator.render.call(owner);
  assert.deepEqual(
    owner.tree.expanded,
    [["directory:projects"], ["directory:decisions"]],
    "a directory a person closes afterwards stays closed",
  );

  owner.snapshotValue = { ...owner.snapshotValue, reveal: { noteId: "inbox", keys: [] } };
  navigator.render.call(owner);
  owner.snapshotValue = { ...owner.snapshotValue, reveal };
  navigator.render.call(owner);
  assert.deepEqual(
    owner.tree.expanded.at(-1),
    ["directory:projects", "directory:decisions"],
    "opening the Note again reveals it again",
  );
});

test("offers the tree's Notes and folders, and Retry only while it is shown", () => {
  let treeOptions = null;
  const retry = { hidden: false, disabled: false, focus() {}, click() {} };
  const fileTree = {
    hidden: false,
    actionHintScope(options) {
      treeOptions = options;
      return { blocked: false, targets: [{ id: "tree-target" }], mutationRoots: [], scrollRoots: [] };
    },
  };
  const owner = {
    rendered: true,
    hidden: false,
    isConnected: true,
    snapshotValue: { selectedNoteId: "storage" },
    fileTree: () => fileTree,
    retryButton: () => retry,
  };

  const scope = navigator.actionHintScope.call(owner, { scopeId: "notes", clipRoots: ["pane"] });
  assert.deepEqual(scope.targets.map(({ id }) => id), ["notes:retry", "tree-target"]);
  assert.equal(scope.targets[0].actionId, "button.activate");
  assert.equal(treeOptions.scopeId, "notes:tree");
  assert.equal(treeOptions.actionId, "navigation.note.open");
  assert.equal(treeOptions.disclosureActionId, "disclosure.toggle");
  assert.deepEqual(treeOptions.clipRoots, [owner, "pane"]);
  assert.equal(treeOptions.isCurrent({ noteId: "storage" }), true);
  assert.equal(treeOptions.isCurrent({ noteId: "other" }), false);
  assert.equal(treeOptions.labelForNode({ name: "Storage" }), "Open Storage");

  retry.hidden = true;
  fileTree.hidden = true;
  assert.deepEqual(navigator.actionHintScope.call(owner).targets, []);
  owner.hidden = true;
  assert.deepEqual(navigator.scrollSurfaceScope.call(owner).surfaces, []);
});
