import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { getNote, getNotes } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "./components/document.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { ParsedRoute } from "#app/navigation-routes.js";
import type {
  CaffoldNoteDocument,
  NoteDocumentIntent,
  NoteDocumentSnapshot,
  NoteRead,
  NoteSide,
} from "./components/document.js";
import {
  type CaffoldNotesNavigator,
  NOTES_NAVIGATOR_INTENT_EVENT,
  type NotesNavigatorIntent,
  type NotesNavigatorSnapshot,
} from "./components/navigator.js";
import { NotesSelection } from "./layout/selection.js";
import {
  type NotesLevelRead,
  type NotesLevels,
  noteDirectoryKey,
} from "./tree.js";

import styles from "./layout.css.js";

export interface RequestWorkspaceRouteDetail {
  route: ParsedRoute;
}

// A level with nothing to show yet is marked loading only once its read
// outlasts this wait, so a quick read never flashes a loading row.
const LEVEL_LOADING_DELAY_MS = 180;

interface NotesRoute {
  kind?: string;
  noteId?: string;
  secondaryNoteId?: string;
}

interface NoteReadRequest {
  generation: number;
  controller: AbortController | null;
}

interface LevelReadRequest extends NoteReadRequest {
  loadingTimer: number | null;
}

interface PaneScopeOptions {
  scopeId?: string;
  leftClipRoots?: Element[];
  rightClipRoots?: Element[];
}

// The Notes workspace: the documents the route names, read from the server each
// time Notes is entered, a Note is picked, or the app returns to the
// foreground on Notes. Agents write Notes through their tools; nothing here
// changes one.
//
// The tree is read one level at a time: the top, each directory a person
// opens, and the directories that hold the open Note. Every level and the
// two documents are independent reads, each with its own generation, so a late
// answer that is no longer wanted is dropped without touching the others.
@customElement("caffold-notes-workspace")
export class CaffoldNotesWorkspace extends CaffoldElement {
  @state()
  private accessor noteId = "";
  @state()
  private accessor secondaryNoteId = "";
  @state()
  private accessor levels: NotesLevels = new Map();
  @state()
  private accessor noteState: NoteRead = {
    state: "idle",
    note: null,
    message: "",
  };
  @state()
  private accessor secondaryState: NoteRead = {
    state: "idle",
    note: null,
    message: "",
  };

  static override styles = styles;

  // Changes of the selection are followed by a requested update.
  private readonly selection = new NotesSelection();
  private active = false;
  private readonly levelReads = new Map<string, LevelReadRequest>();
  private noteRead: NoteReadRequest = { generation: 0, controller: null };
  private secondaryRead: NoteReadRequest = { generation: 0, controller: null };
  private connectedNotesNavigator: CaffoldNotesNavigator | null = null;
  private navigatorHome: Element | null = null;
  private primarySlot: Element | null = null;
  // Kept from the first render: in a split view the documents sit in other
  // panes than this element.
  // The two documents, kept once drawn: they move to the panes the selection
  // puts them in, out of this element.
  private documents: Record<NoteSide, CaffoldNoteDocument> | null = null;
  private readonly primaryDocument = new DrawnRef<CaffoldNoteDocument>(this);
  private readonly secondaryDocument = new DrawnRef<CaffoldNoteDocument>(this);
  private readonly navigatorIntent = (
    event: CustomEvent<NotesNavigatorIntent>,
  ) => {
    event.stopPropagation();
    this.handleNavigatorIntent(event.detail);
  };

  override connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  override render() {
    const top = this.levels.get("")?.listing;
    const split = this.selection.split;
    const primary: NoteDocumentSnapshot = {
      noteId: this.noteId,
      result: this.noteState,
      side: "primary",
      split,
      paired: Boolean(this.secondaryNoteId),
      readable: Boolean(this.noteState.note),
      emptyTree:
        Boolean(top) && top?.directories.length === 0 && top.notes.length === 0,
    };
    const secondary: NoteDocumentSnapshot = {
      noteId: this.secondaryNoteId,
      result: this.secondaryState,
      side: "secondary",
      split,
      paired: true,
      readable: false,
    };
    const secondaryHidden =
      !this.secondaryNoteId || this.selection.picker === "secondary";
    return html`
      <caffold-note-document
        ${drawn(this.primaryDocument)}
        .snapshot=${primary}
        @caffold:note-document-intent=${this.documentIntent}
      ></caffold-note-document>
      <caffold-note-document
        ${drawn(this.secondaryDocument)}
        ?hidden=${secondaryHidden}
        .snapshot=${secondary}
        @caffold:note-document-intent=${this.documentIntent}
      ></caffold-note-document>
    `;
  }

  override firstUpdated() {
    this.documents = {
      primary: this.primaryDocument.value as CaffoldNoteDocument,
      secondary: this.secondaryDocument.value as CaffoldNoteDocument,
    };
  }

  // The navigator is not part of this element's template, so it takes its
  // snapshot here, and the documents and navigator go to the panes the
  // selection puts them in.
  override updated() {
    const navigator = this.connectedNotesNavigator;
    if (navigator) {
      navigator.snapshot = this.navigatorSnapshot();
    }
    const documents = this.documents;
    if (documents && navigator && this.primarySlot && this.navigatorHome) {
      const split = this.selection.split;
      documents.primary.place(
        split ? this.primarySlot : this.renderRoot,
        documents.secondary,
      );
      const rightPicker = this.selection.picker === "secondary";
      navigator.place(
        rightPicker ? this.renderRoot : this.navigatorHome,
        rightPicker ? documents.secondary : this.primarySlot,
      );
    }
    this.publishPresentation();
  }

  connectNotesNavigator(navigator: CaffoldNotesNavigator | null) {
    if (this.connectedNotesNavigator === navigator) {
      return;
    }
    this.connectedNotesNavigator?.removeEventListener(
      NOTES_NAVIGATOR_INTENT_EVENT,
      this.navigatorIntent,
    );
    this.connectedNotesNavigator = navigator ?? null;
    this.navigatorHome = navigator?.parentElement ?? null;
    this.connectedNotesNavigator?.addEventListener(
      NOTES_NAVIGATOR_INTENT_EVENT,
      this.navigatorIntent,
    );
    this.requestUpdate();
    this.performUpdate();
  }

  connectPrimarySlot(slot: Element | null) {
    this.primarySlot = slot;
    this.requestUpdate();
    this.performUpdate();
  }

  prepareRoute(route: NotesRoute | null | undefined) {
    const noteId = route?.kind === "notes" ? `${route.noteId ?? ""}` : "";
    const secondaryNoteId =
      noteId && route?.secondaryNoteId !== noteId
        ? `${route?.secondaryNoteId ?? ""}`
        : "";
    const changed =
      noteId !== this.noteId || secondaryNoteId !== this.secondaryNoteId;
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
      this.secondaryState = {
        state: secondaryNoteId ? "loading" : "idle",
        note: null,
        message: "",
      };
      if (this.active && secondaryNoteId) {
        void this.loadNote(secondaryNoteId, "secondary");
      }
    }
    if (changed) {
      this.selection.transition("route", { paired: Boolean(secondaryNoteId) });
      this.requestUpdate();
    }
    this.performUpdate();
    if (
      changed &&
      this.active &&
      (previousPicker || (wasSplit && !secondaryNoteId))
    ) {
      const document =
        previousPicker === "secondary" && secondaryNoteId
          ? this.documents?.secondary
          : this.documents?.primary;
      void document?.focusTitle();
    }
  }

  activate() {
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
    this.documents?.primary.deactivate();
    this.documents?.secondary.deactivate();
  }

  sideBySide() {
    return this.selection.split;
  }

  actionHintScope({
    scopeId = "notes",
    leftClipRoots = [],
    rightClipRoots = [],
  }: PaneScopeOptions = {}) {
    const documents = this.documents;
    if (this.hidden || !documents) {
      return emptyActionHintScope();
    }
    const navigator = this.connectedNotesNavigator;
    const primaryRoots = this.selection.split ? leftClipRoots : rightClipRoots;
    const navigatorRoots =
      this.selection.picker === "secondary" ? rightClipRoots : leftClipRoots;
    return mergeActionHintScopes(
      documents.primary.actionHintScope({
        scopeId: `${scopeId}:primary`,
        clipRoots: primaryRoots,
      }),
      documents.secondary.actionHintScope({
        scopeId: `${scopeId}:secondary`,
        clipRoots: rightClipRoots,
      }),
      navigator?.actionHintScope({
        scopeId: `${scopeId}:navigator`,
        clipRoots: navigatorRoots,
      }),
    );
  }

  keyboardNavigationContexts({ scopeId = "notes" } = {}) {
    const documents = this.documents;
    if (this.hidden || !documents) {
      return [];
    }
    return [
      ...documents.primary.keyboardNavigationContexts({
        scopeId: `${scopeId}:primary`,
      }),
      ...documents.secondary.keyboardNavigationContexts({
        scopeId: `${scopeId}:secondary`,
      }),
    ];
  }

  scrollSurfaceScope({
    scopeId = "notes",
    leftClipRoots = [],
    rightClipRoots = [],
  }: PaneScopeOptions = {}) {
    const documents = this.documents;
    if (this.hidden || !documents) {
      return emptyScrollSurfaceScope();
    }
    const navigator = this.connectedNotesNavigator;
    return mergeScrollSurfaceScopes(
      documents.primary.scrollSurfaceScope({
        scopeId: `${scopeId}:primary`,
        clipRoots: this.selection.split ? leftClipRoots : rightClipRoots,
      }),
      documents.secondary.scrollSurfaceScope({
        scopeId: `${scopeId}:secondary`,
        clipRoots: rightClipRoots,
      }),
      navigator?.scrollSurfaceScope({
        scopeId: `${scopeId}:navigator`,
        clipRoots:
          this.selection.picker === "secondary"
            ? rightClipRoots
            : leftClipRoots,
      }),
    );
  }

  private handleNavigatorIntent(detail: NotesNavigatorIntent | null) {
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
        this.requestNote(
          picker === "primary" ? detail.noteId : this.noteId,
          picker === "secondary" ? detail.noteId : this.secondaryNoteId,
        );
      }
      return;
    }
    if (detail.noteId === this.noteId) {
      void this.loadNote(detail.noteId);
      return;
    }
    this.requestNote(detail.noteId);
  }

  private documentIntent(event: CustomEvent<NoteDocumentIntent>) {
    event.stopPropagation();
    const { type, side } = event.detail;
    if (type === "back") {
      this.requestNote("");
    } else if (type === "close") {
      this.requestNote(this.noteId);
    } else if (type === "retry") {
      void this.loadNote(
        side === "secondary" ? this.secondaryNoteId : this.noteId,
        side,
      );
    } else if (
      this.selection.transition(type === "split" ? "start" : side, {
        readable: Boolean(this.noteState.note),
      })
    ) {
      this.requestUpdate();
      this.performUpdate();
      void this.connectedNotesNavigator?.focusPicker();
    }
  }

  private cancelPicker() {
    const side = this.selection.picker;
    if (!this.selection.transition("cancel")) return;
    this.requestUpdate();
    this.performUpdate();
    const document =
      side === "primary" || !this.secondaryNoteId
        ? this.documents?.primary
        : this.documents?.secondary;
    void document?.focusTitle({ preferSplit: !this.secondaryNoteId });
  }

  private requestNote(noteId: string, secondaryNoteId = "") {
    this.dispatchEvent(
      new CustomEvent<RequestWorkspaceRouteDetail>(
        "caffold:request-workspace-route",
        {
          bubbles: true,
          composed: true,
          detail: {
            route: {
              kind: "notes",
              noteId: noteId ?? "",
              ...(secondaryNoteId ? { secondaryNoteId } : {}),
            },
          },
        },
      ),
    );
  }

  // Reads one level of the tree; "" is the top. What a level held stays shown
  // while it is read again, and a directory that no longer exists is dropped.
  // A level with nothing to show stays "pending" until the read has lasted
  // LEVEL_LOADING_DELAY_MS.
  private async loadLevel(directoryId: string) {
    const previousRead = this.levelReads.get(directoryId);
    previousRead?.controller?.abort();
    window.clearTimeout(previousRead?.loadingTimer ?? undefined);
    const generation = (previousRead?.generation ?? 0) + 1;
    const controller = new AbortController();
    const listing = this.levels.get(directoryId)?.listing ?? null;
    const loadingTimer = listing
      ? null
      : window.setTimeout(() => {
          if (this.levelReads.get(directoryId)?.generation === generation) {
            this.setLevel(directoryId, {
              state: "loading",
              listing: null,
              message: "",
            });
          }
        }, LEVEL_LOADING_DELAY_MS);
    this.levelReads.set(directoryId, { generation, controller, loadingTimer });
    this.setLevel(directoryId, {
      state: listing ? "loading" : "pending",
      listing,
      message: "",
    });
    let next: NotesLevelRead | null;
    try {
      const level = await getNotes(directoryId, controller.signal);
      next = {
        state: "ready",
        listing: {
          directories: level?.directories ?? [],
          notes: level?.notes ?? [],
        },
        message: "",
      };
    } catch (error) {
      const failure = error as { status?: number; message?: string } | null;
      next =
        directoryId && failure?.status === 404
          ? null
          : {
              state: "failed",
              listing,
              message: failure?.message || "Caffold could not load notes.",
            };
    }
    if (this.levelReads.get(directoryId)?.generation !== generation) {
      return;
    }
    window.clearTimeout(loadingTimer ?? undefined);
    this.levelReads.set(directoryId, {
      generation,
      controller: null,
      loadingTimer: null,
    });
    this.setLevel(directoryId, next);
  }

  private async loadNote(noteId: string, side: NoteSide = "primary") {
    const readKey = side === "secondary" ? "secondaryRead" : "noteRead";
    const stateKey = side === "secondary" ? "secondaryState" : "noteState";
    const generation = this[readKey].generation + 1;
    this[readKey].controller?.abort();
    const controller = new AbortController();
    this[readKey] = { generation, controller };
    const previous =
      this[stateKey].note?.id === noteId ? this[stateKey].note : null;
    if (!previous) {
      this[stateKey] = { state: "loading", note: null, message: "" };
    }
    let next: NoteRead;
    try {
      next = {
        state: "ready",
        note: await getNote(noteId, controller.signal),
        message: "",
      };
    } catch (error) {
      const failure = error as { status?: number; message?: string } | null;
      next =
        failure?.status === 404
          ? { state: "missing", note: null, message: "" }
          : {
              state: "failed",
              note: previous,
              message: failure?.message || "Caffold could not load this note.",
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
  }

  private setLevel(directoryId: string, read: NotesLevelRead | null) {
    const levels = new Map(this.levels);
    if (read) {
      levels.set(directoryId, read);
    } else {
      levels.delete(directoryId);
    }
    this.levels = levels;
  }

  private cancelLevelReads() {
    for (const [directoryId, read] of this.levelReads) {
      read.controller?.abort();
      window.clearTimeout(read.loadingTimer ?? undefined);
      this.levelReads.set(directoryId, {
        generation: read.generation + 1,
        controller: null,
        loadingTimer: null,
      });
    }
  }

  private cancelNoteRead(side: NoteSide = "primary") {
    const key = side === "secondary" ? "secondaryRead" : "noteRead";
    this[key].controller?.abort();
    this[key] = { generation: this[key].generation + 1, controller: null };
  }

  private navigatorSnapshot(): NotesNavigatorSnapshot {
    const picker = this.selection.picker;
    const selectedNoteId =
      picker === "secondary" ? this.secondaryNoteId : this.noteId;
    const note =
      picker === "secondary" ? this.secondaryState.note : this.noteState.note;
    const location = note?.id === selectedNoteId ? (note?.location ?? []) : [];
    return {
      levels: new Map(this.levels),
      selectedNoteId,
      picker,
      companion: this.selection.node === "choose-companion",
      disabledNoteId: picker
        ? picker === "primary"
          ? this.secondaryNoteId
          : this.noteId
        : "",
      reveal: {
        noteId: selectedNoteId,
        keys: location.map((directory) => noteDirectoryKey(directory.id)),
      },
    };
  }

  private publishPresentation() {
    const view = this.selection.split
      ? "split"
      : this.noteId
        ? "detail"
        : "list";
    const picker = this.selection.picker;
    if (
      this.dataset.notesView === view &&
      this.dataset.notesPicker === picker
    ) {
      return;
    }
    this.dataset.notesView = view;
    this.dataset.notesPicker = picker;
    this.dispatchEvent(
      new CustomEvent("caffold:notes-presentation-change", { bubbles: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-notes-workspace": CaffoldNotesWorkspace;
  }

  interface HTMLElementEventMap {
    "caffold:request-workspace-route": CustomEvent<RequestWorkspaceRouteDetail>;
  }
}
