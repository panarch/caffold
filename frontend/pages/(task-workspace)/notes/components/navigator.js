import {
  FILE_TREE_LOAD_EVENT,
  FILE_TREE_SELECT_EVENT,
} from "#components/file-tree.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import "../../components/workspace-brand.js";
import { compactIconButton } from "#app/component-styles.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";
import { showLoadingText } from "#components/loading-text.js";
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
    window.addEventListener("caffold:icons-ready", this.boundPickerIcons);
    this.renderPickerIcons();
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
        <button type="button" class="notes-picker-back" data-picker-action="cancel" aria-label="Cancel note selection" title="Return to the open note" hidden></button>
        <h2 class="notes-picker-title" hidden></h2>
        <button type="button" class="notes-picker-close" data-picker-action="close" aria-label="Close side by side" title="Close side by side" hidden></button>
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
    this.addEventListener("click", (event) => {
      const control = event.target.closest("button[data-picker-action]");
      if (control) this.dispatchIntent({ type: control.dataset.pickerAction });
    });
    this.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !this.snapshotValue.picker) return;
      if (event.target.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      event.stopPropagation();
      this.dispatchIntent({ type: "cancel" });
    });
    this.renderPickerIcons();
    this.boundPickerIcons ??= () => this.renderPickerIcons();
    window.addEventListener("caffold:icons-ready", this.boundPickerIcons);
    void warmIcons();
    this.render();
  }

  setSnapshot(snapshot) {
    this.ensureRendered();
    this.snapshotValue = snapshot;
    const header = this.querySelector(":scope > .notes-navigator-header");
    const picker = snapshot.picker || "";
    this.dataset.picker = picker;
    header.querySelector("caffold-workspace-brand").hidden = Boolean(picker);
    header.querySelector(".notes-picker-back").hidden = !picker;
    const title = header.querySelector("h2");
    title.hidden = !picker;
    title.textContent = snapshot.companion ? "Choose a note to read alongside" : "Choose another note";
    header.querySelector(".notes-picker-close").hidden = picker !== "secondary" || snapshot.companion;
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
    const message = this.querySelector(
      ":scope > .notes-navigator-status > .notes-navigator-message",
    );
    if (statusMessage === LOADING_MESSAGE) {
      showLoadingText(message, LOADING_MESSAGE);
    } else {
      message.textContent = statusMessage;
    }
    this.retryButton().hidden = top?.state !== "failed";

    const fileTree = this.fileTree();
    fileTree.hidden = !listing || isEmpty;
    if (listing) {
      fileTree.setModel({
        entityKey: "notes",
        nodes: notesTreeNodes(levels, { disabledNoteId: this.snapshotValue.disabledNoteId }),
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
    const pickerControls = [...this.querySelectorAll("button[data-picker-action]")].filter((control) => !control.hidden);
    const pickerScope = {
      blocked: false,
      targets: pickerControls.map((control) => buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:${control.dataset.pickerAction}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label"), control, clipRoots: [this, ...clipRoots],
        isActionable: () => this.isConnected && !this.hidden && !control.hidden,
      })), mutationRoots: pickerControls, scrollRoots: [],
    };
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
    return mergeActionHintScopes(pickerScope, retryScope, treeScope);
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

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundPickerIcons);
  }

  renderPickerIcons() {
    this.querySelector('[data-picker-action="cancel"]').innerHTML = renderInlineIcon("ArrowLeft", "Cancel note selection", "notes-picker-icon");
    this.querySelector('[data-picker-action="close"]').innerHTML = renderInlineIcon("X", "Close side by side", "notes-picker-icon");
  }

  focusPicker() { this.fileTree().focusFirstEntry(); }

  place(parent, before = null) {
    if (this.parentElement === parent) return;
    const target = before?.parentElement === parent ? before : null;
    const scrollport = this.fileTree().scrollSurfaceScope({ scopeId: "notes:placement" }).surfaces[0]?.scrollport;
    const scroll = scrollport ? { top: scrollport.scrollTop, left: scrollport.scrollLeft } : null;
    if (parent.moveBefore && this.isConnected) parent.moveBefore(this, target);
    else parent.insertBefore(this, target);
    if (scroll) { scrollport.scrollTop = scroll.top; scrollport.scrollLeft = scroll.left; }
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

await Promise.all(["back", "close"].map((action) => compactIconButton.register("caffold-notes-navigator", `> .notes-navigator-header > .notes-picker-${action}`)));
customElements.define("caffold-notes-navigator", CaffoldNotesNavigator);
