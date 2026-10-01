import { getNote, getNotes } from "#app/api.js";
import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { emptyScrollSurfaceScope, mergeScrollSurfaceScopes } from "#app/scroll-scope.js";
import { NotesSelection } from "./layout/selection.js";
import { NOTE_DOCUMENT_INTENT_EVENT } from "./components/document.js";
import { NOTES_NAVIGATOR_INTENT_EVENT } from "./components/navigator.js";
import { noteDirectoryKey } from "./tree.js";

// The Notes workspace: the documents the route names, read from the server each
// time Notes is entered, a Note is picked, or the app returns to the
// foreground on Notes. Agents write Notes through their tools; nothing here
// changes one.
//
// The tree is read one level at a time: the top, each directory a person
// opens, and the directories that hold the open Note. Every level and the
// two documents are independent reads, each with its own generation, so a late
// answer that is no longer wanted is dropped without touching the others.
class CaffoldNotesWorkspace extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.deactivate();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.noteId = "";
    this.secondaryNoteId = "";
    this.selection = new NotesSelection();
    this.active = false;
    this.levels = new Map();
    this.levelReads = new Map();
    this.noteRead = { generation: 0, controller: null };
    this.noteState = { state: "idle", note: null, message: "" };
    this.secondaryRead = { generation: 0, controller: null };
    this.secondaryState = { state: "idle", note: null, message: "" };
    this.boundNavigatorIntent = (event) => {
      event.stopPropagation();
      this.handleNavigatorIntent(event.detail);
    };
    this.innerHTML = '<caffold-note-document></caffold-note-document><caffold-note-document hidden></caffold-note-document>';
    [this.primaryDocument, this.secondaryDocument] = this.querySelectorAll(":scope > caffold-note-document");
    for (const document of [this.primaryDocument, this.secondaryDocument]) {
      document.addEventListener(NOTE_DOCUMENT_INTENT_EVENT, (event) => {
        event.stopPropagation();
        this.handleDocumentIntent(event.detail);
      });
    }
    this.renderDetail();
    this.syncPresentation();
  }

  connectNotesNavigator(navigator) {
    this.ensureRendered();
    if (this.connectedNotesNavigator === navigator) {
      return;
    }
    this.connectedNotesNavigator?.removeEventListener(
      NOTES_NAVIGATOR_INTENT_EVENT,
      this.boundNavigatorIntent,
    );
    this.connectedNotesNavigator = navigator ?? null;
    this.navigatorHome = navigator?.parentElement;
    this.connectedNotesNavigator?.addEventListener(
      NOTES_NAVIGATOR_INTENT_EVENT,
      this.boundNavigatorIntent,
    );
    this.syncNavigator();
  }

  connectPrimarySlot(slot) {
    this.primarySlot = slot;
    this.renderDetail();
  }

  prepareRoute(route) {
    this.ensureRendered();
    const noteId = route?.kind === "notes" ? `${route.noteId ?? ""}` : "";
    const secondaryNoteId = noteId && route?.secondaryNoteId !== noteId ? `${route.secondaryNoteId ?? ""}` : "";
    const changed = noteId !== this.noteId || secondaryNoteId !== this.secondaryNoteId;
    const previousPicker = this.selection.picker;
    const wasSplit = this.selection.split;
    if (noteId !== this.noteId) {
      this.noteId = noteId;
      this.cancelNoteRead();
      this.noteState = noteId
        ? { state: "loading", note: null, message: "" }
        : { state: "idle", note: null, message: "" };
      if (this.active && noteId) {
        void this.loadNote(noteId);
      }
    }
    if (secondaryNoteId !== this.secondaryNoteId) {
      this.secondaryNoteId = secondaryNoteId;
      this.cancelNoteRead("secondary");
      this.secondaryState = { state: secondaryNoteId ? "loading" : "idle", note: null, message: "" };
      if (this.active && secondaryNoteId) {
        void this.loadNote(secondaryNoteId, "secondary");
      }
    }
    if (changed) {
      this.selection.transition("route", { paired: Boolean(secondaryNoteId) });
    }
    this.syncNavigator();
    this.renderDetail();
    this.syncPresentation();
    if (changed && this.active && (previousPicker || (wasSplit && !secondaryNoteId))) {
      (previousPicker === "secondary" && secondaryNoteId ? this.secondaryDocument : this.primaryDocument)?.focusTitle();
    }
  }

  activate() {
    this.ensureRendered();
    if (this.active) {
      return;
    }
    this.reload();
  }

  // Foreground recovery also calls this, including after a disconnection
  // deactivated Notes while it stayed the workspace's mode.
  reload() {
    this.active = true;
    for (const directoryId of new Set(["", ...this.levels.keys()])) {
      void this.loadLevel(directoryId);
    }
    if (this.noteId) {
      void this.loadNote(this.noteId);
    }
    if (this.secondaryNoteId) {
      void this.loadNote(this.secondaryNoteId, "secondary");
    }
  }

  deactivate() {
    this.active = false;
    this.cancelLevelReads();
    this.cancelNoteRead();
    this.cancelNoteRead("secondary");
    this.info()?.deactivate();
    this.secondaryDocument?.info()?.deactivate();
  }

  handleNavigatorIntent(detail) {
    if (detail?.type === "retry") {
      void this.loadLevel("");
      return;
    }
    if (detail?.type === "cancel") {
      this.cancelPicker();
      return;
    }
    if (detail?.type === "close") {
      this.requestNote(this.noteId);
      return;
    }
    if (detail?.type === "load-directory" && detail.directoryId) {
      void this.loadLevel(detail.directoryId);
      return;
    }
    if (detail?.type !== "open-note" || !detail.noteId) {
      return;
    }
    const picker = this.selection.picker;
    if (picker) {
      const other = picker === "primary" ? this.secondaryNoteId : this.noteId;
      if (detail.noteId === other) return;
      const current = picker === "primary" ? this.noteId : this.secondaryNoteId;
      if (detail.noteId === current) {
        this.cancelPicker();
        void this.loadNote(current, picker);
      } else {
        this.requestNote(picker === "primary" ? detail.noteId : this.noteId,
          picker === "secondary" ? detail.noteId : this.secondaryNoteId);
      }
      return;
    }
    if (detail.noteId === this.noteId) {
      void this.loadNote(detail.noteId);
      return;
    }
    this.requestNote(detail.noteId);
  }

  requestNote(noteId, secondaryNoteId = "") {
    this.dispatchEvent(
      new CustomEvent("caffold:request-workspace-route", {
        bubbles: true,
        detail: { route: { kind: "notes", noteId: noteId ?? "", ...(secondaryNoteId ? { secondaryNoteId } : {}) } },
      }),
    );
  }

  handleDocumentIntent({ type, side }) {
    if (type === "back") this.requestNote("");
    else if (type === "close") this.requestNote(this.noteId);
    else if (type === "retry") void this.loadNote(side === "secondary" ? this.secondaryNoteId : this.noteId, side);
    else if (this.selection.transition(type === "split" ? "start" : side, {
      readable: Boolean(this.noteState.note),
    })) {
      this.syncNavigator();
      this.renderDetail();
      this.syncPresentation();
      this.connectedNotesNavigator?.focusPicker();
    }
  }

  cancelPicker() {
    const side = this.selection.picker;
    if (!this.selection.transition("cancel")) return;
    this.syncNavigator();
    this.renderDetail();
    this.syncPresentation();
    (side === "primary" || !this.secondaryNoteId ? this.primaryDocument : this.secondaryDocument)?.focusTitle({ preferSplit: !this.secondaryNoteId });
  }

  sideBySide() {
    return this.selection.split;
  }

  // Reads one level of the tree; "" is the top. What a level held stays shown
  // while it is read again, and a directory that no longer exists is dropped.
  async loadLevel(directoryId) {
    const previousRead = this.levelReads.get(directoryId);
    previousRead?.controller?.abort();
    const generation = (previousRead?.generation ?? 0) + 1;
    const controller = new AbortController();
    this.levelReads.set(directoryId, { generation, controller });
    const listing = this.levels.get(directoryId)?.listing ?? null;
    this.levels.set(directoryId, { state: "loading", listing, message: "" });
    this.syncNavigator();
    let next;
    try {
      const level = await getNotes(directoryId, controller.signal);
      next = {
        state: "ready",
        listing: { directories: level?.directories ?? [], notes: level?.notes ?? [] },
        message: "",
      };
    } catch (error) {
      next = directoryId && error?.status === 404
        ? null
        : {
            state: "failed",
            listing,
            message: error?.message || "Caffold could not load notes.",
          };
    }
    if (this.levelReads.get(directoryId)?.generation !== generation) {
      return;
    }
    this.levelReads.set(directoryId, { generation, controller: null });
    if (next) {
      this.levels.set(directoryId, next);
    } else {
      this.levels.delete(directoryId);
    }
    this.syncNavigator();
    this.renderDetail();
  }

  async loadNote(noteId, side = "primary") {
    const readKey = side === "secondary" ? "secondaryRead" : "noteRead";
    const stateKey = side === "secondary" ? "secondaryState" : "noteState";
    const generation = this[readKey].generation + 1;
    this[readKey].controller?.abort();
    const controller = new AbortController();
    this[readKey] = { generation, controller };
    const previous = this[stateKey].note?.id === noteId ? this[stateKey].note : null;
    if (!previous) {
      this[stateKey] = { state: "loading", note: null, message: "" };
      this.renderDetail();
    }
    let next;
    try {
      next = { state: "ready", note: await getNote(noteId, controller.signal), message: "" };
    } catch (error) {
      next = error?.status === 404
        ? { state: "missing", note: null, message: "" }
        : {
            state: "failed",
            note: previous,
            message: error?.message || "Caffold could not load this note.",
          };
    }
    if (this[readKey].generation !== generation) {
      return;
    }
    this[readKey] = { generation, controller: null };
    this[stateKey] = next;
    for (const directory of next.note?.location ?? []) {
      if (!this.levels.has(directory.id)) {
        void this.loadLevel(directory.id);
      }
    }
    this.syncNavigator();
    this.renderDetail();
  }

  cancelLevelReads() {
    for (const [directoryId, read] of this.levelReads) {
      read.controller?.abort();
      this.levelReads.set(directoryId, { generation: read.generation + 1, controller: null });
    }
  }

  cancelNoteRead(side = "primary") {
    const key = side === "secondary" ? "secondaryRead" : "noteRead";
    this[key].controller?.abort();
    this[key] = { generation: this[key].generation + 1, controller: null };
  }

  syncNavigator() {
    const picker = this.selection.picker;
    const selectedNoteId = picker === "secondary" ? this.secondaryNoteId : this.noteId;
    const note = picker === "secondary" ? this.secondaryState.note : this.noteState.note;
    const location = note?.id === selectedNoteId ? note.location ?? [] : [];
    this.connectedNotesNavigator?.setSnapshot({
      levels: new Map(this.levels),
      selectedNoteId,
      picker,
      companion: this.selection.node === "choose-companion",
      disabledNoteId: picker ? picker === "primary" ? this.secondaryNoteId : this.noteId : "",
      reveal: {
        noteId: selectedNoteId,
        keys: location.map((directory) => noteDirectoryKey(directory.id)),
      },
    });
  }

  syncPresentation() {
    const view = this.selection.split ? "split" : this.noteId ? "detail" : "list";
    const picker = this.selection.picker;
    if (this.dataset.notesView === view && this.dataset.notesPicker === picker) {
      return;
    }
    this.dataset.notesView = view;
    this.dataset.notesPicker = picker;
    this.dispatchEvent(
      new CustomEvent("caffold:notes-presentation-change", { bubbles: true }),
    );
  }

  renderDetail() {
    const top = this.levels.get("")?.listing;
    const emptyTree = Boolean(top) && top.directories.length === 0 && top.notes.length === 0;
    const split = this.selection.split;
    this.primaryDocument.setSnapshot({
      noteId: this.noteId, result: this.noteState, side: "primary", split,
      paired: Boolean(this.secondaryNoteId), readable: Boolean(this.noteState.note), emptyTree,
    });
    this.secondaryDocument.setSnapshot({
      noteId: this.secondaryNoteId, result: this.secondaryState,
      side: "secondary", split, paired: true, readable: false,
    });
    this.secondaryDocument.hidden = !this.secondaryNoteId || this.selection.picker === "secondary";
    if (!this.primarySlot || !this.navigatorHome) return;
    this.primaryDocument.place(split ? this.primarySlot : this, this.secondaryDocument);
    const navigator = this.connectedNotesNavigator;
    const rightPicker = this.selection.picker === "secondary";
    navigator.place(rightPicker ? this : this.navigatorHome,
      rightPicker ? this.secondaryDocument : this.primarySlot);
  }

  actionHintScope({ scopeId = "notes", leftClipRoots = [], rightClipRoots = [] } = {}) {
    if (this.hidden) return emptyActionHintScope();
    const primaryRoots = this.selection.split ? leftClipRoots : rightClipRoots;
    const navigatorRoots = this.selection.picker === "secondary" ? rightClipRoots : leftClipRoots;
    return mergeActionHintScopes(
      this.primaryDocument.actionHintScope({ scopeId: `${scopeId}:primary`, clipRoots: primaryRoots }),
      this.secondaryDocument.actionHintScope({ scopeId: `${scopeId}:secondary`, clipRoots: rightClipRoots }),
      hasActionHintLayoutBox(this.connectedNotesNavigator)
        ? this.connectedNotesNavigator.actionHintScope({ scopeId: `${scopeId}:navigator`, clipRoots: navigatorRoots }) : null,
    );
  }

  keyboardNavigationContexts({ scopeId = "notes" } = {}) {
    if (this.hidden) return [];
    return [
      ...this.primaryDocument.keyboardNavigationContexts({ scopeId: `${scopeId}:primary` }),
      ...this.secondaryDocument.keyboardNavigationContexts({ scopeId: `${scopeId}:secondary` }),
    ];
  }

  scrollSurfaceScope({ scopeId = "notes", leftClipRoots = [], rightClipRoots = [] } = {}) {
    if (this.hidden) return emptyScrollSurfaceScope();
    return mergeScrollSurfaceScopes(
      this.primaryDocument.scrollSurfaceScope({ scopeId: `${scopeId}:primary`, clipRoots: this.selection.split ? leftClipRoots : rightClipRoots }),
      this.secondaryDocument.scrollSurfaceScope({ scopeId: `${scopeId}:secondary`, clipRoots: rightClipRoots }),
      hasActionHintLayoutBox(this.connectedNotesNavigator)
        ? this.connectedNotesNavigator.scrollSurfaceScope({ scopeId: `${scopeId}:navigator`, clipRoots: this.selection.picker === "secondary" ? rightClipRoots : leftClipRoots }) : null,
    );
  }

  info() {
    return this.primaryDocument?.info();
  }
}

customElements.define("caffold-notes-workspace", CaffoldNotesWorkspace);
