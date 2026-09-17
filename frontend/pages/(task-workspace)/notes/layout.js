import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "../../../components/markdown-preview.js";
import { getNote, getNotes } from "../../../api.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../../../action-hints.js";
import { emptyScrollSurfaceScope } from "../../../scroll-scope.js";
import "./components/info.js";
import { NOTES_NAVIGATOR_INTENT_EVENT } from "./components/navigator.js";
import { noteDirectoryKey } from "./tree.js";

const NO_SELECTION_MESSAGE = "Choose a note to read it.";
const LOADING_MESSAGE = "Loading note…";
const MISSING_MESSAGE = "This note no longer exists.";
const EMPTY_NOTE_MESSAGE = "This note is empty.";

// The Notes workspace: the Note the route names, read from the server each
// time Notes is entered, a Note is picked, or the app returns to the
// foreground on Notes. Agents write Notes through their tools; nothing here
// changes one.
//
// The tree is read one level at a time: the top, each directory a person
// opens, and the directories that hold the open Note. Every level and the
// open Note are independent reads, each with its own generation, so a late
// answer that is no longer wanted is dropped without touching the others.
class CaffoldNotesWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderBackIcon();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.deactivate();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.noteId = "";
    this.active = false;
    this.levels = new Map();
    this.levelReads = new Map();
    this.noteRead = { generation: 0, controller: null };
    this.noteState = { state: "idle", note: null, message: "" };
    this.renderedMarkdown = null;
    this.boundNavigatorIntent = (event) => {
      event.stopPropagation();
      this.handleNavigatorIntent(event.detail);
    };
    this.innerHTML = `
      <div
        class="notes-workspace-detail-pane"
        role="region"
        aria-labelledby="notes-workspace-title"
        tabindex="-1"
      >
        <header class="notes-workspace-detail-header" hidden>
          <button
            type="button"
            data-action="back-to-notes"
            title="Back to notes"
            aria-label="Back to notes"
          >
            <span data-notes-back-icon>
              ${renderInlineIcon("ArrowLeft", "Back to notes", "notes-workspace-back-icon")}
            </span>
          </button>
          <h1 id="notes-workspace-title"></h1>
          <caffold-notes-info></caffold-notes-info>
        </header>
        <p class="notes-workspace-location" hidden></p>
        <div class="notes-workspace-status" hidden>
          <p class="notes-workspace-message"></p>
          <button type="button" data-action="retry-note" hidden>Retry</button>
        </div>
        <caffold-markdown-preview hidden></caffold-markdown-preview>
      </div>
    `;
    this.backButton().addEventListener("click", () => this.requestNote(""));
    this.retryButton().addEventListener("click", () => {
      if (this.noteId) {
        void this.loadNote(this.noteId);
      }
    });
    warmIcons();
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
    this.connectedNotesNavigator?.addEventListener(
      NOTES_NAVIGATOR_INTENT_EVENT,
      this.boundNavigatorIntent,
    );
    this.syncNavigator();
  }

  prepareRoute(route) {
    this.ensureRendered();
    const noteId = route?.kind === "notes" ? `${route.noteId ?? ""}` : "";
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
    this.syncNavigator();
    this.renderDetail();
    this.syncPresentation();
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
  }

  deactivate() {
    this.active = false;
    this.cancelLevelReads();
    this.cancelNoteRead();
    this.info()?.deactivate();
  }

  handleNavigatorIntent(detail) {
    if (detail?.type === "retry") {
      void this.loadLevel("");
      return;
    }
    if (detail?.type === "load-directory" && detail.directoryId) {
      void this.loadLevel(detail.directoryId);
      return;
    }
    if (detail?.type !== "open-note" || !detail.noteId) {
      return;
    }
    if (detail.noteId === this.noteId) {
      void this.loadNote(detail.noteId);
      return;
    }
    this.requestNote(detail.noteId);
  }

  requestNote(noteId) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-workspace-route", {
        bubbles: true,
        detail: { route: { kind: "notes", noteId: noteId ?? "" } },
      }),
    );
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

  async loadNote(noteId) {
    const generation = this.noteRead.generation + 1;
    this.noteRead.controller?.abort();
    const controller = new AbortController();
    this.noteRead = { generation, controller };
    const previous = this.noteState.note?.id === noteId ? this.noteState.note : null;
    if (!previous) {
      this.noteState = { state: "loading", note: null, message: "" };
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
    if (this.noteRead.generation !== generation) {
      return;
    }
    this.noteRead = { generation, controller: null };
    this.noteState = next;
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

  cancelNoteRead() {
    this.noteRead.controller?.abort();
    this.noteRead = { generation: this.noteRead.generation + 1, controller: null };
  }

  syncNavigator() {
    const note = this.noteState.note;
    const location = note?.id === this.noteId ? note.location ?? [] : [];
    this.connectedNotesNavigator?.setSnapshot({
      levels: new Map(this.levels),
      selectedNoteId: this.noteId,
      reveal: {
        noteId: this.noteId,
        keys: location.map((directory) => noteDirectoryKey(directory.id)),
      },
    });
  }

  syncPresentation() {
    const view = this.noteId ? "detail" : "list";
    if (this.dataset.notesView === view) {
      return;
    }
    this.dataset.notesView = view;
    this.dispatchEvent(
      new CustomEvent("caffold:notes-presentation-change", { bubbles: true }),
    );
  }

  renderDetail() {
    const { state, note, message } = this.noteState;
    const header = this.querySelector(
      ":scope > .notes-workspace-detail-pane > .notes-workspace-detail-header",
    );
    header.hidden = !this.noteId;
    const title = header.querySelector(":scope > h1");
    title.textContent = state === "missing" ? "Note not found" : note?.name ?? "";
    title.title = title.textContent;
    this.info().setNote(this.noteId ? note : null);
    this.renderLocation(note);

    const top = this.levels.get("")?.listing;
    const treeIsEmpty = Boolean(top) && top.directories.length === 0 && top.notes.length === 0;
    const statusMessage = !this.noteId
      ? treeIsEmpty ? "" : NO_SELECTION_MESSAGE
      : state === "loading"
        ? LOADING_MESSAGE
        : state === "missing"
          ? MISSING_MESSAGE
          : state === "failed"
            ? message
            : note?.content === ""
              ? EMPTY_NOTE_MESSAGE
              : "";
    const status = this.querySelector(
      ":scope > .notes-workspace-detail-pane > .notes-workspace-status",
    );
    status.hidden = !statusMessage;
    status.dataset.state = state === "failed" ? "failed" : "info";
    status.querySelector(":scope > .notes-workspace-message").textContent = statusMessage;
    this.retryButton().hidden = state !== "failed";

    const preview = this.preview();
    const showsContent = Boolean(this.noteId && note && note.content !== "");
    preview.hidden = !showsContent;
    if (!showsContent) {
      return;
    }
    const rendered = this.renderedMarkdown;
    if (rendered?.noteId === note.id && rendered.content === note.content) {
      return;
    }
    preview.setMarkdown(note.content, rendered?.noteId === note.id
      ? { preserveScroll: true }
      : { scroll: { top: 0, left: 0 } });
    this.renderedMarkdown = { noteId: note.id, content: note.content };
  }

  // The directories that hold the Note, from the top; the details button
  // carries everything else about it.
  renderLocation(note) {
    const line = this.querySelector(
      ":scope > .notes-workspace-detail-pane > .notes-workspace-location",
    );
    const location = (note?.location ?? []).map((directory) => directory.name);
    line.textContent = location.join(" / ");
    line.hidden = location.length === 0;
  }

  actionHintScope({ scopeId = "notes", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const back = this.backButton();
    const backScope = this.noteId && hasActionHintLayoutBox(back)
      ? ownButtonScope(this, back, {
          id: `${scopeId}:parent:list`,
          actionId: ACTION_HINT_ACTION.PARENT,
          label: "Back to notes",
          clipRoots,
          isActionable: () => Boolean(this.noteId) && hasActionHintLayoutBox(back),
        })
      : null;
    const retry = this.retryButton();
    const retryScope = !retry.hidden
      ? ownButtonScope(this, retry, {
          id: `${scopeId}:retry`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: "Retry loading the note",
          clipRoots,
          isActionable: () => !retry.hidden,
        })
      : null;
    const infoScope = this.info().actionHintScope({
      scopeId,
      clipRoots: [this, ...clipRoots],
    });
    const preview = this.preview();
    const previewScope = !preview.hidden
      ? preview.actionHintScope({
          scopeId: `${scopeId}:content`,
          linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
          clipRoots: [this, ...clipRoots],
        })
      : null;
    return mergeActionHintScopes(backScope, retryScope, infoScope, previewScope);
  }

  keyboardNavigationContexts({ scopeId = "notes" } = {}) {
    this.ensureRendered();
    return this.hidden ? [] : this.info().keyboardNavigationContexts({ scopeId });
  }

  scrollSurfaceScope({ scopeId = "notes", clipRoots = [] } = {}) {
    this.ensureRendered();
    const preview = this.preview();
    if (this.hidden || preview.hidden) {
      return emptyScrollSurfaceScope();
    }
    return preview.scrollSurfaceScope({
      scopeId: `${scopeId}:content`,
      label: this.noteState.note?.name || "Note",
      clipRoots: [this, ...clipRoots],
    });
  }

  renderBackIcon() {
    const target = this.querySelector("[data-notes-back-icon]");
    if (target) {
      target.innerHTML = renderInlineIcon(
        "ArrowLeft",
        "Back to notes",
        "notes-workspace-back-icon",
      );
    }
  }

  backButton() {
    return this.querySelector(
      ':scope > .notes-workspace-detail-pane > .notes-workspace-detail-header > button[data-action="back-to-notes"]',
    );
  }

  retryButton() {
    return this.querySelector(
      ':scope > .notes-workspace-detail-pane > .notes-workspace-status > button[data-action="retry-note"]',
    );
  }

  info() {
    return this.querySelector(
      ":scope > .notes-workspace-detail-pane > .notes-workspace-detail-header > caffold-notes-info",
    );
  }

  preview() {
    return this.querySelector(
      ":scope > .notes-workspace-detail-pane > caffold-markdown-preview",
    );
  }
}

function ownButtonScope(owner, control, { id, actionId, label, clipRoots, isActionable }) {
  return {
    blocked: false,
    targets: [buttonActionHintTarget({
      invalidationOwner: owner,
      id,
      actionId,
      label,
      control,
      clipRoots: [owner, ...clipRoots],
      isActionable: () =>
        owner.isConnected &&
        !owner.hidden &&
        control.isConnected &&
        !control.disabled &&
        isActionable(),
    })],
    mutationRoots: [control],
    scrollRoots: [],
  };
}

customElements.define("caffold-notes-workspace", CaffoldNotesWorkspace);
