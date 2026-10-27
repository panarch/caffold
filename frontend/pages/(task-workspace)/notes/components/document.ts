import { html, LitElement, type PropertyValues } from "lit";
import { hasActionHintLayoutBox } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { Note } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "#components/markdown-preview.js";
import type { CaffoldMarkdownPreview } from "#components/markdown-preview.js";
import "./info.js";
import type { CaffoldNotesInfo } from "./info.js";

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
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly pane = new DrawnRef<HTMLDivElement>(this);
  private readonly choose = new DrawnRef<HTMLButtonElement>(this);
  private readonly split = new DrawnRef<HTMLButtonElement>(this);
  private readonly info = new DrawnRef<CaffoldNotesInfo>(this);
  private readonly preview = new DrawnRef<CaffoldMarkdownPreview>(this);

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
        ${drawn(this.pane)}
        class="notes-workspace-detail-pane"
        role="region"
        aria-labelledby=${this.titleId}
        tabindex="-1"
      >
        <header class="notes-workspace-detail-header" ?hidden=${!noteId}>
          <button
            ${this.hints.button({
              id: "back",
              label: "Back to notes",
              action: ACTION_HINT_ACTION.PARENT,
            })}
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
            ${drawn(this.choose)}
            ${this.hints.button({
              id: "choose",
              label: `${title || "Note"}, choose another note`,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
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
              ${drawn(this.split)}
              ${this.hints.button({
                id: "split",
                label: "View side by side",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              class="note-document-split"
              data-action="split"
              title="View side by side"
              aria-label="View side by side"
              ?hidden=${split || !readable}
              @click=${this.intent}
            >${splitIcon}</button>
            <button
              ${this.hints.button({
                id: "close",
                label: "Close side by side",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              class="note-document-close"
              data-action="close"
              title="Close side by side"
              aria-label="Close side by side"
              ?hidden=${!paired || side !== "secondary"}
              @click=${this.intent}
            >${closeIcon}</button>
            <caffold-notes-info
              ${drawn(this.info)}
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
          ${this.hints.button({
            id: "retry",
            label: "Retry",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          data-action="retry"
          ?hidden=${state !== "failed"}
          @click=${this.intent}
        >Retry</button></div>
        <caffold-markdown-preview
          ${drawn(this.preview)}
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
    const preview = this.preview.value;
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
    const split = this.split.value;
    if (preferSplit && hasActionHintLayoutBox(split)) {
      split?.focus();
      return;
    }
    const choose = this.choose.value;
    if (hasActionHintLayoutBox(choose)) {
      choose?.focus();
    } else {
      this.pane.value?.focus();
    }
  }

  // Moves this document into another pane and keeps where it was read.
  place(parent: Element, before: Element | null = null) {
    const target = before?.parentElement === parent ? before : null;
    if (this.parentElement === parent) {
      return;
    }
    const preview = this.preview.value;
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
    this.info.value?.deactivate();
  }

  actionHintScope(pull: ActionHintPull) {
    const own = this.hints.scope(pull);
    const clipRoots = [this, ...(pull.clipRoots ?? [])];
    return mergeActionHintScopes(
      own,
      this.info.value?.actionHintScope({ ...pull, clipRoots }),
      this.preview.value?.actionHintScope({
        scopeId: `${pull.scopeId}:content`,
        actions: { link: ACTION_HINT_ACTION.LINK_OPEN },
        clipRoots,
      }),
    );
  }

  keyboardNavigationContexts({ scopeId }: { scopeId: string }) {
    return this.info.value?.keyboardNavigationContexts({ scopeId }) ?? [];
  }

  scrollSurfaceScope(pull: ScrollSurfacePull) {
    const own = this.surfaces.scope(pull);
    return mergeScrollSurfaceScopes(
      own,
      this.preview.value?.scrollSurfaceScope({
        scopeId: `${pull.scopeId}:content`,
        label: this.snapshot.result.note?.name || "Note",
        clipRoots: [this, ...(pull.clipRoots ?? [])],
      }),
    );
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
