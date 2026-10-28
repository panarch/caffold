import { html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type {
  CaffoldFileTree,
  FileTreeSelectDetail,
} from "#components/file-tree.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "../../components/workspace-brand.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import type { FileTreeLoadChildrenDetail } from "#components/file-tree.js";
import type { NotesPicker } from "../layout/selection.js";
import { moveIntoPane } from "../move-into-pane.js";
import {
  directoryIdFromKey,
  type NotesLevels,
  noteIdOf,
  noteKey,
  notesTreeNodes,
} from "../tree.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import styles from "./navigator.css.js";

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
@customElement("caffold-notes-navigator")
export class CaffoldNotesNavigator extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: NotesNavigatorSnapshot = {
    levels: new Map(),
    selectedNoteId: "",
    picker: "",
    companion: false,
    disabledNoteId: "",
    reveal: { noteId: "", keys: [] },
  };

  static override styles = [
    scopedStyle(compactIconButton, ".notes-picker-back"),
    scopedStyle(compactIconButton, ".notes-picker-close"),
    styles,
  ];

  private revealSignature = "";
  private pendingRevealKeys: string[] = [];
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly tree = new DrawnRef<CaffoldFileTree>(this);

  constructor() {
    super();
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
      // A listener on the host sees the host as the target.
      const [target] = event.composedPath();
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.dispatchIntent({ type: "cancel" });
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
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
          ${this.hints.button({
            id: "cancel",
            label: "Cancel note selection",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
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
          ${this.hints.button({
            id: "close",
            label: "Close side by side",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
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
          ${this.hints.button({
            id: "retry",
            label: "Retry loading notes",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          data-action="retry-notes"
          ?hidden=${top?.state !== "failed"}
          @click=${this.retry}
        >Retry</button>
      </div>
      <caffold-file-tree
        ${drawn(this.tree)}
        file-sort-mode="folders-first"
        ?hidden=${!listing || isEmpty}
        @caffold:file-tree-select=${this.openNote}
        @caffold:file-tree-load-children=${this.loadDirectory}
      ></caffold-file-tree>
    `;
  }

  override updated(changed: PropertyValues<this>) {
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

  actionHintScope({ scopeId = "notes", ...pull }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId });
    return mergeActionHintScopes(
      own,
      this.fileTree.actionHintScope({
        scopeId: `${scopeId}:tree`,
        actions: {
          file: ACTION_HINT_ACTION.NOTE_OPEN,
          disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
        },
        clipRoots: [this, ...(pull.clipRoots ?? [])],
      }),
    );
  }

  scrollSurfaceScope({ scopeId = "notes", ...pull }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, scopeId });
    return mergeScrollSurfaceScopes(
      own,
      this.fileTree.scrollSurfaceScope({
        scopeId: `${scopeId}:tree`,
        label: "Notes",
        clipRoots: [this, ...(pull.clipRoots ?? [])],
      }),
    );
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
  place(parent: ParentNode, before: Element | null = null) {
    moveIntoPane(this, parent, before, () => this.fileTree.scroller());
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

  private loadDirectory(event: CustomEvent<FileTreeLoadChildrenDetail>) {
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
      new CustomEvent<NotesNavigatorIntent>(NOTES_NAVIGATOR_INTENT_EVENT, {
        bubbles: true,
        detail,
      }),
    );
  }

  private get fileTree() {
    return this.tree.value as CaffoldFileTree;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-notes-navigator": CaffoldNotesNavigator;
  }

  interface HTMLElementEventMap {
    [NOTES_NAVIGATOR_INTENT_EVENT]: CustomEvent<NotesNavigatorIntent>;
  }
}
