import { html, LitElement, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import type {
  CaffoldFileTree,
  FileTreeSelectDetail,
} from "#components/file-tree.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "../../components/workspace-brand.ts";
import type { NotesPicker } from "../layout/selection.ts";
import {
  directoryIdFromKey,
  type NotesLevels,
  noteIdOf,
  noteKey,
  notesTreeNodes,
} from "../tree.ts";

export const NOTES_NAVIGATOR_INTENT_EVENT = "caffold:notes-navigator-intent";

export type NotesNavigatorIntent =
  | { type: "open-note"; noteId: string }
  | { type: "load-directory"; directoryId: string }
  | { type: "retry" | "cancel" | "close" };

// What the Notes workspace shows in the tree: what was read, the open Note,
// and whether a person is choosing a Note for one pane.
export interface NotesNavigatorSnapshot {
  levels: NotesLevels;
  selectedNoteId: string;
  picker: NotesPicker;
  companion: boolean;
  disabledNoteId: string;
  // The directories that hold the open Note.
  reveal: { noteId: string; keys: string[] };
}

const LOADING_MESSAGE = "Loading notes…";
const EMPTY_MESSAGE = "No notes yet. Ask an agent in a Task to save one.";
const ICON = "notes-picker-icon";

// The Notes tree in the workspace's navigation pane. The Notes workspace owns
// what is read and which Note is open; this shows that snapshot and says which
// Note a person picked and which directory they opened.
export class CaffoldNotesNavigator extends LitElement {
  static properties = {
    snapshot: { attribute: false },
  };

  declare snapshot: NotesNavigatorSnapshot;
  private revealSignature = "";
  private pendingRevealKeys: string[] = [];
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.snapshot = {
      levels: new Map(),
      selectedNoteId: "",
      picker: "",
      companion: false,
      disabledNoteId: "",
      reveal: { noteId: "", keys: [] },
    };
    this.addEventListener("keydown", (event) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !this.snapshot.picker
      ) {
        return;
      }
      const target = event.target as Element;
      if (target.closest("input, textarea, [contenteditable]")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.dispatchIntent({ type: "cancel" });
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const { levels, picker, companion } = this.snapshot;
    const top = levels.get("");
    const listing = top?.listing ?? null;
    const isEmpty =
      Boolean(listing) &&
      listing?.directories.length === 0 &&
      listing.notes.length === 0;
    const statusMessage =
      top?.state === "failed"
        ? top.message
        : !listing
          ? LOADING_MESSAGE
          : isEmpty
            ? EMPTY_MESSAGE
            : "";
    const message =
      statusMessage === LOADING_MESSAGE
        ? html`<caffold-loading-text>${statusMessage}</caffold-loading-text>`
        : statusMessage;
    const cancelIcon = inlineIcon("ArrowLeft", "Cancel note selection", ICON);
    const closeIcon = inlineIcon("X", "Close side by side", ICON);
    return html`
      <header class="notes-navigator-header">
        <caffold-workspace-brand
          ?hidden=${Boolean(picker)}
        ></caffold-workspace-brand>
        <button
          type="button"
          class="notes-picker-back"
          data-picker-action="cancel"
          aria-label="Cancel note selection"
          title="Return to the open note"
          ?hidden=${!picker}
          @click=${this.pickerAction}
        >${cancelIcon}</button>
        <h2 class="notes-picker-title" ?hidden=${!picker}>${
          companion ? "Choose a note to read alongside" : "Choose another note"
        }</h2>
        <button
          type="button"
          class="notes-picker-close"
          data-picker-action="close"
          aria-label="Close side by side"
          title="Close side by side"
          ?hidden=${picker !== "secondary" || companion}
          @click=${this.pickerAction}
        >${closeIcon}</button>
      </header>
      <div
        class="notes-navigator-status"
        data-state=${top?.state === "failed" ? "failed" : "info"}
        ?hidden=${!statusMessage}
      >
        <p class="notes-navigator-message">${message}</p>
        <button
          type="button"
          data-action="retry-notes"
          ?hidden=${top?.state !== "failed"}
          @click=${this.retry}
        >Retry</button>
      </div>
      <caffold-file-tree
        file-sort-mode="folders-first"
        ?hidden=${!listing || isEmpty}
        @caffold:file-tree-select=${this.openNote}
        @caffold:file-tree-load-children=${this.loadDirectory}
      ></caffold-file-tree>
    `;
  }

  updated(changed: PropertyValues<this>) {
    if (!changed.has("snapshot")) {
      return;
    }
    const { levels, selectedNoteId, picker, disabledNoteId } = this.snapshot;
    if (this.dataset.picker !== picker) {
      this.dataset.picker = picker;
    }
    if (!levels.get("")?.listing) {
      return;
    }
    this.fileTree.setModel({
      entityKey: "notes",
      nodes: notesTreeNodes(levels, { disabledNoteId }),
      selectedKey: selectedNoteId ? noteKey(selectedNoteId) : "",
      expandNewDirectories: false,
    });
    this.revealOpenNote();
  }

  actionHintScope({
    scopeId = "notes",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    if (!this.hasUpdated || this.hidden) {
      return emptyActionHintScope();
    }
    const retry = this.retryButton;
    const retryScope =
      retry && !retry.hidden && !retry.disabled
        ? {
            blocked: false,
            targets: [
              buttonActionHintTarget({
                invalidationOwner: this,
                id: `${scopeId}:retry`,
                actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                label: "Retry loading notes",
                control: retry,
                clipRoots: [this, ...clipRoots],
                isActionable: () =>
                  this.isConnected &&
                  !this.hidden &&
                  this.retryButton === retry &&
                  !retry.hidden &&
                  !retry.disabled,
              }),
            ],
            mutationRoots: [retry],
            scrollRoots: [],
          }
        : null;
    const pickerControls = [
      ...this.querySelectorAll<HTMLButtonElement>("button[data-picker-action]"),
    ].filter((control) => !control.hidden);
    const pickerScope = {
      blocked: false,
      targets: pickerControls.map((control) =>
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${control.dataset.pickerAction}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: control.getAttribute("aria-label") ?? "",
          control,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            this.isConnected && !this.hidden && !control.hidden,
        }),
      ),
      mutationRoots: pickerControls,
      scrollRoots: [],
    };
    const fileTree = this.fileTree;
    const treeScope = !fileTree.hidden
      ? fileTree.actionHintScope({
          scopeId: `${scopeId}:tree`,
          actionId: ACTION_HINT_ACTION.NOTE_OPEN,
          disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          clipRoots: [this, ...clipRoots],
          isCurrent: (node) => noteIdOf(node) === this.snapshot.selectedNoteId,
          labelForNode: (node) => `Open ${node.name}`,
        })
      : null;
    return mergeActionHintScopes(pickerScope, retryScope, treeScope);
  }

  scrollSurfaceScope({
    scopeId = "notes",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (!this.hasUpdated || this.hidden || this.fileTree.hidden) {
      return emptyScrollSurfaceScope();
    }
    return this.fileTree.scrollSurfaceScope({
      scopeId: `${scopeId}:tree`,
      label: "Notes",
      clipRoots: [this, ...clipRoots],
    });
  }

  scrollToTop() {
    this.fileTree.scrollToTop();
  }

  // The snapshot that opens the picker reaches the tree when this draws it.
  async focusPicker() {
    await this.updateComplete;
    this.fileTree.focusFirstEntry();
  }

  // Moves the tree into another pane and keeps where it was scrolled.
  place(parent: Element, before: Element | null = null) {
    if (this.parentElement === parent) {
      return;
    }
    const target = before?.parentElement === parent ? before : null;
    const scrollport = this.fileTree.scrollSurfaceScope({
      scopeId: "notes:placement",
    }).surfaces[0]?.scrollport;
    const scroll = scrollport
      ? { top: scrollport.scrollTop, left: scrollport.scrollLeft }
      : null;
    const movable = parent as Element & {
      moveBefore?: (node: Node, child: Node | null) => void;
    };
    if (movable.moveBefore && this.isConnected) {
      movable.moveBefore(this, target);
    } else {
      parent.insertBefore(this, target);
    }
    if (scrollport && scroll) {
      scrollport.scrollTop = scroll.top;
      scrollport.scrollLeft = scroll.left;
    }
  }

  // Opens each directory that holds the open Note once its row exists. Each is
  // opened once, so a person closing it afterwards keeps it closed.
  private revealOpenNote() {
    const { reveal } = this.snapshot;
    const signature = [reveal.noteId, ...reveal.keys].join("\n");
    if (signature !== this.revealSignature) {
      this.revealSignature = signature;
      this.pendingRevealKeys = [...reveal.keys];
    }
    const fileTree = this.fileTree;
    const arrived = this.pendingRevealKeys.filter((key) =>
      fileTree.hasKey(key),
    );
    if (arrived.length === 0) {
      return;
    }
    fileTree.expandKeys(arrived);
    this.pendingRevealKeys = this.pendingRevealKeys.filter(
      (key) => !arrived.includes(key),
    );
  }

  private openNote(event: CustomEvent<FileTreeSelectDetail>) {
    event.stopPropagation();
    const noteId = noteIdOf(event.detail?.node);
    if (noteId) {
      this.dispatchIntent({ type: "open-note", noteId });
    }
  }

  private loadDirectory(event: CustomEvent<{ key?: string }>) {
    event.stopPropagation();
    const directoryId = directoryIdFromKey(event.detail?.key);
    if (directoryId) {
      this.dispatchIntent({ type: "load-directory", directoryId });
    }
  }

  private retry() {
    this.dispatchIntent({ type: "retry" });
  }

  private pickerAction(event: Event) {
    const control = event.currentTarget as HTMLElement;
    this.dispatchIntent({
      type: control.dataset.pickerAction as "cancel" | "close",
    });
  }

  private dispatchIntent(detail: NotesNavigatorIntent) {
    this.dispatchEvent(
      new CustomEvent(NOTES_NAVIGATOR_INTENT_EVENT, {
        bubbles: true,
        detail,
      }),
    );
  }

  private get fileTree() {
    return this.querySelector(":scope > caffold-file-tree") as CaffoldFileTree;
  }

  private get retryButton() {
    return this.querySelector<HTMLButtonElement>(
      ':scope > .notes-navigator-status > button[data-action="retry-notes"]',
    );
  }
}

await Promise.all(
  ["back", "close"].map((action) =>
    compactIconButton.register(
      "caffold-notes-navigator",
      `> .notes-navigator-header > .notes-picker-${action}`,
    ),
  ),
);
customElements.define("caffold-notes-navigator", CaffoldNotesNavigator);
