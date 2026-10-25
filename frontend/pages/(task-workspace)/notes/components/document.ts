import { html, LitElement, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { Note } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "#components/markdown-preview.ts";
import type { CaffoldMarkdownPreview } from "#components/markdown-preview.ts";
import "./info.ts";
import type { CaffoldNotesInfo } from "./info.ts";

export const NOTE_DOCUMENT_INTENT_EVENT = "caffold:note-document-intent";

export type NoteSide = "primary" | "secondary";

// The latest read of one document's Note.
export interface NoteRead {
  state: "idle" | "loading" | "ready" | "missing" | "failed";
  note: Note | null;
  message: string;
}

export interface NoteDocumentSnapshot {
  noteId: string;
  result: NoteRead;
  side: NoteSide;
  split: boolean;
  paired: boolean;
  readable: boolean;
  emptyTree?: boolean;
}

export interface NoteDocumentIntent {
  type: "back" | "choose" | "split" | "close" | "retry";
  side: NoteSide;
}

const IDLE_DOCUMENT: NoteDocumentSnapshot = {
  noteId: "",
  result: { state: "idle", note: null, message: "" },
  side: "primary",
  split: false,
  paired: false,
  readable: false,
};

const ICON = "note-document-icon";

let documentInstanceId = 0;

// A retained document view. Notes Workspace owns reads and selection; this
// owns the header, preview, Info, focus and scroll across placement changes.
export class CaffoldNoteDocument extends LitElement {
  static properties = {
    snapshot: { attribute: false },
  };

  declare snapshot: NoteDocumentSnapshot;
  private readonly titleId = `notes-document-title-${++documentInstanceId}`;
  // The Markdown the preview was last given.
  private renderedMarkdown: { noteId: string; content: string } | null = null;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.snapshot = IDLE_DOCUMENT;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.deactivate();
  }

  render() {
    const { noteId, result, side, split, paired, readable } = this.snapshot;
    const { state, note, message } = result;
    const title = state === "missing" ? "Note not found" : note?.name || "";
    const location = (note?.location ?? [])
      .map((directory) => directory.name)
      .join(" / ");
    const loading = Boolean(noteId) && state === "loading";
    const statusMessage = !noteId
      ? this.snapshot.emptyTree
        ? ""
        : "Choose a note to read it."
      : loading
        ? "Loading note…"
        : state === "missing"
          ? "This note no longer exists."
          : state === "failed"
            ? message
            : note?.content === ""
              ? "This note is empty."
              : "";
    const statusState =
      state === "failed" ? "failed" : loading ? "loading" : "info";
    const statusText = loading
      ? html`<caffold-loading-text>${statusMessage}</caffold-loading-text>`
      : statusMessage;
    const backIcon = inlineIcon("ArrowLeft", "Back to notes", ICON);
    const chevron = inlineIcon("ChevronDown", "", ICON);
    const splitIcon = inlineIcon("Columns2", "View side by side", ICON);
    const closeIcon = inlineIcon("X", "Close side by side", ICON);
    return html`
      <div
        class="notes-workspace-detail-pane"
        role="region"
        aria-labelledby=${this.titleId}
        tabindex="-1"
      >
        <header class="notes-workspace-detail-header" ?hidden=${!noteId}>
          <button
            type="button"
            class="note-document-back"
            data-action="back"
            title="Back to notes"
            aria-label="Back to notes"
            @click=${this.intent}
          >${backIcon}</button>
          <h1 id=${this.titleId} title=${title}><span
            class="note-document-title-text"
          >${title}</span><button
            type="button"
            class="note-document-title-picker"
            data-action="choose"
            aria-label=${`${title || "Note"}, choose another note`}
            @click=${this.intent}
          ><span>${paired ? title : ""}</span><span
            data-title-chevron
          >${chevron}</span></button></h1>
          <div class="note-document-actions">
            <button
              type="button"
              class="note-document-split"
              data-action="split"
              title="View side by side"
              aria-label="View side by side"
              ?hidden=${split || !readable}
              @click=${this.intent}
            >${splitIcon}</button>
            <button
              type="button"
              class="note-document-close"
              data-action="close"
              title="Close side by side"
              aria-label="Close side by side"
              ?hidden=${!paired || side !== "secondary"}
              @click=${this.intent}
            >${closeIcon}</button>
            <caffold-notes-info
              .note=${noteId ? note : null}
            ></caffold-notes-info>
          </div>
        </header>
        <p class="notes-workspace-location" ?hidden=${!location}>${location}</p>
        <div
          class="notes-workspace-status"
          data-state=${statusState}
          ?hidden=${!statusMessage}
        ><p class="notes-workspace-message">${statusText}</p><button
          type="button"
          data-action="retry"
          ?hidden=${state !== "failed"}
          @click=${this.intent}
        >Retry</button></div>
        <caffold-markdown-preview
          ?hidden=${!noteId || !note || note.content === ""}
        ></caffold-markdown-preview>
      </div>
    `;
  }

  // The preview keeps its reading position while the same Note is read again
  // and opens another Note at its top.
  updated(changed: PropertyValues<this>) {
    if (!changed.has("snapshot")) {
      return;
    }
    const { noteId, side, split, paired, result } = this.snapshot;
    const data = { noteSide: side, split: `${split}`, paired: `${paired}` };
    for (const [name, value] of Object.entries(data)) {
      if (this.dataset[name] !== value) {
        this.dataset[name] = value;
      }
    }
    if (noteId !== this.renderedMarkdown?.noteId) {
      this.renderedMarkdown = null;
    }
    const note = result.note;
    const preview = this.preview;
    if (!note || !preview || preview.hidden) {
      return;
    }
    const previous = this.renderedMarkdown;
    if (previous?.noteId === note.id && previous.content === note.content) {
      return;
    }
    preview.setMarkdown(
      note.content,
      previous?.noteId === note.id
        ? { preserveScroll: true }
        : { scroll: { top: 0, left: 0 } },
    );
    this.renderedMarkdown = { noteId: note.id, content: note.content };
  }

  async focusTitle({ preferSplit = false } = {}) {
    await this.updateComplete;
    const split = this.querySelector<HTMLElement>('[data-action="split"]');
    if (preferSplit && hasActionHintLayoutBox(split)) {
      split?.focus();
      return;
    }
    const choose = this.querySelector<HTMLElement>('[data-action="choose"]');
    if (hasActionHintLayoutBox(choose)) {
      choose?.focus();
    } else {
      this.querySelector<HTMLElement>(".notes-workspace-detail-pane")?.focus();
    }
  }

  // Moves this document into another pane and keeps where it was read.
  place(parent: Element, before: Element | null = null) {
    const target = before?.parentElement === parent ? before : null;
    if (this.parentElement === parent) {
      return;
    }
    const preview = this.preview;
    const scroll = preview?.getScrollState();
    const movable = parent as Element & {
      moveBefore?: (node: Node, child: Node | null) => void;
    };
    if (movable.moveBefore && this.isConnected) {
      movable.moveBefore(this, target);
    } else {
      parent.insertBefore(this, target);
    }
    if (preview && scroll) {
      preview.scrollTop = scroll.top;
      preview.scrollLeft = scroll.left;
    }
  }

  // Closes the details popover, as leaving Notes does.
  deactivate() {
    this.info?.deactivate();
  }

  actionHintScope({
    scopeId,
    clipRoots = [],
  }: {
    scopeId: string;
    clipRoots?: Element[];
  }): ActionHintScope {
    if (this.hidden || !hasActionHintLayoutBox(this)) {
      return emptyActionHintScope();
    }
    const controls = [
      ...this.querySelectorAll<HTMLButtonElement>("button[data-action]"),
    ].filter(hasActionHintLayoutBox);
    const buttons: ActionHintScope = {
      blocked: false,
      targets: controls.map((control) =>
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${control.dataset.action}`,
          actionId:
            control.dataset.action === "back"
              ? ACTION_HINT_ACTION.PARENT
              : ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") || control.textContent || "",
          control,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            !control.hidden &&
            hasActionHintLayoutBox(control),
        }),
      ),
      mutationRoots: [this],
      scrollRoots: [],
    };
    return mergeActionHintScopes(
      buttons,
      this.info?.actionHintScope({ scopeId, clipRoots: [this, ...clipRoots] }),
      this.preview?.actionHintScope({
        scopeId: `${scopeId}:content`,
        linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
        clipRoots: [this, ...clipRoots],
      }),
    );
  }

  keyboardNavigationContexts({ scopeId }: { scopeId: string }) {
    return this.hidden || !hasActionHintLayoutBox(this)
      ? []
      : (this.info?.keyboardNavigationContexts({ scopeId }) ?? []);
  }

  scrollSurfaceScope({
    scopeId,
    clipRoots = [],
  }: {
    scopeId: string;
    clipRoots?: Element[];
  }): ScrollSurfaceScope {
    const preview = this.preview;
    if (this.hidden || !hasActionHintLayoutBox(this) || !preview) {
      return emptyScrollSurfaceScope();
    }
    return preview.scrollSurfaceScope({
      scopeId: `${scopeId}:content`,
      label: this.snapshot.result.note?.name || "Note",
      clipRoots: [this, ...clipRoots],
    });
  }

  private intent(event: Event) {
    const control = event.currentTarget as HTMLElement;
    this.dispatchEvent(
      new CustomEvent<NoteDocumentIntent>(NOTE_DOCUMENT_INTENT_EVENT, {
        bubbles: true,
        detail: {
          type: control.dataset.action as NoteDocumentIntent["type"],
          side: this.snapshot.side,
        },
      }),
    );
  }

  private get info() {
    return this.querySelector<CaffoldNotesInfo>("caffold-notes-info");
  }

  private get preview() {
    return this.querySelector<CaffoldMarkdownPreview>(
      "caffold-markdown-preview",
    );
  }
}

await Promise.all(
  ["split", "close"].map((action) =>
    compactIconButton.register(
      "caffold-note-document",
      `> .notes-workspace-detail-pane > .notes-workspace-detail-header > .note-document-actions > .note-document-${action}`,
    ),
  ),
);
customElements.define("caffold-note-document", CaffoldNoteDocument);
