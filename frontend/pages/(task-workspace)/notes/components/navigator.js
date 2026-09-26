import {
  FILE_TREE_LOAD_EVENT,
  FILE_TREE_SELECT_EVENT,
} from "../../../../components/file-tree.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../../../../action-hints.js";
import { emptyScrollSurfaceScope } from "../../../../scroll-scope.js";
import "../../components/workspace-brand.js";
import { directoryIdFromKey, noteKey, notesTreeNodes } from "../tree.js";

export const NOTES_NAVIGATOR_INTENT_EVENT = "caffold:notes-navigator-intent";

const LOADING_MESSAGE = "Loading notes…";
const EMPTY_MESSAGE = "No notes yet. Ask an agent in a Task to save one.";

// The Notes tree in the workspace's navigation pane. The Notes workspace owns
// what is read and which Note is open; this shows that snapshot and says which
// Note a person picked and which directory they opened.
class CaffoldNotesNavigator extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.snapshotValue = {
      levels: new Map(),
      selectedNoteId: "",
      reveal: { noteId: "", keys: [] },
    };
    this.revealSignature = "";
    this.pendingRevealKeys = [];
    this.innerHTML = `
      <header class="notes-navigator-header">
        <caffold-workspace-brand></caffold-workspace-brand>
      </header>
      <div class="notes-navigator-status" hidden>
        <p class="notes-navigator-message"></p>
        <button type="button" data-action="retry-notes" hidden>Retry</button>
      </div>
      <caffold-file-tree file-sort-mode="folders-first" hidden></caffold-file-tree>
    `;
    this.addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      event.stopPropagation();
      const noteId = event.detail?.node?.noteId;
      if (noteId) {
        this.dispatchIntent({ type: "open-note", noteId });
      }
    });
    this.addEventListener(FILE_TREE_LOAD_EVENT, (event) => {
      event.stopPropagation();
      const directoryId = directoryIdFromKey(event.detail?.key);
      if (directoryId) {
        this.dispatchIntent({ type: "load-directory", directoryId });
      }
    });
    this.retryButton().addEventListener("click", () => {
      this.dispatchIntent({ type: "retry" });
    });
    this.render();
  }

  setSnapshot(snapshot) {
    this.ensureRendered();
    this.snapshotValue = snapshot;
    this.render();
  }

  render() {
    const { levels, selectedNoteId } = this.snapshotValue;
    const top = levels.get("");
    const listing = top?.listing ?? null;
    const isEmpty = Boolean(listing) &&
      listing.directories.length === 0 &&
      listing.notes.length === 0;
    const statusMessage = top?.state === "failed"
      ? top.message
      : !listing
        ? LOADING_MESSAGE
        : isEmpty
          ? EMPTY_MESSAGE
          : "";
    const status = this.querySelector(":scope > .notes-navigator-status");
    status.hidden = !statusMessage;
    status.dataset.state = top?.state === "failed" ? "failed" : "info";
    this.querySelector(":scope > .notes-navigator-status > .notes-navigator-message")
      .textContent = statusMessage;
    this.retryButton().hidden = top?.state !== "failed";

    const fileTree = this.fileTree();
    fileTree.hidden = !listing || isEmpty;
    if (listing) {
      fileTree.setModel({
        entityKey: "notes",
        nodes: notesTreeNodes(levels),
        selectedKey: selectedNoteId ? noteKey(selectedNoteId) : "",
        expandNewDirectories: false,
      });
      this.revealOpenNote();
    }
  }

  // Opens each directory that holds the open Note once its row exists. Each is
  // opened once, so a person closing it afterwards keeps it closed.
  revealOpenNote() {
    const { reveal } = this.snapshotValue;
    const signature = [reveal.noteId, ...reveal.keys].join("\n");
    if (signature !== this.revealSignature) {
      this.revealSignature = signature;
      this.pendingRevealKeys = [...reveal.keys];
    }
    const fileTree = this.fileTree();
    const arrived = this.pendingRevealKeys.filter((key) => fileTree.hasKey(key));
    if (arrived.length === 0) {
      return;
    }
    fileTree.expandKeys(arrived);
    this.pendingRevealKeys = this.pendingRevealKeys.filter((key) => !arrived.includes(key));
  }

  actionHintScope({ scopeId = "notes", clipRoots = [] } = {}) {
    if (!this.rendered || this.hidden) {
      return emptyActionHintScope();
    }
    const retry = this.retryButton();
    const retryScope = !retry.hidden && !retry.disabled
      ? {
          blocked: false,
          targets: [buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:retry`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label: "Retry loading notes",
            control: retry,
            clipRoots: [this, ...clipRoots],
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              this.retryButton() === retry &&
              !retry.hidden &&
              !retry.disabled,
          })],
          mutationRoots: [retry],
          scrollRoots: [],
        }
      : null;
    const fileTree = this.fileTree();
    const treeScope = !fileTree.hidden
      ? fileTree.actionHintScope({
          scopeId: `${scopeId}:tree`,
          actionId: ACTION_HINT_ACTION.NOTE_OPEN,
          disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          clipRoots: [this, ...clipRoots],
          isCurrent: (node) => node.noteId === this.snapshotValue.selectedNoteId,
          labelForNode: (node) => `Open ${node.name}`,
        })
      : null;
    return mergeActionHintScopes(retryScope, treeScope);
  }

  scrollSurfaceScope({ scopeId = "notes", clipRoots = [] } = {}) {
    if (!this.rendered || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const fileTree = this.fileTree();
    if (fileTree.hidden) {
      return emptyScrollSurfaceScope();
    }
    return fileTree.scrollSurfaceScope({
      scopeId: `${scopeId}:tree`,
      label: "Notes",
      clipRoots: [this, ...clipRoots],
    });
  }

  scrollToTop() {
    this.ensureRendered();
    this.fileTree().scrollToTop();
  }

  dispatchIntent(detail) {
    this.dispatchEvent(new CustomEvent(NOTES_NAVIGATOR_INTENT_EVENT, {
      bubbles: true,
      detail,
    }));
  }

  fileTree() {
    return this.querySelector(":scope > caffold-file-tree");
  }

  retryButton() {
    return this.querySelector(
      ':scope > .notes-navigator-status > button[data-action="retry-notes"]',
    );
  }
}

customElements.define("caffold-notes-navigator", CaffoldNotesNavigator);
