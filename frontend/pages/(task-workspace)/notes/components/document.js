import { compactIconButton } from "#app/component-styles.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";
import "#components/markdown-preview.js";
import {
  buttonActionHintTarget, emptyActionHintScope, hasActionHintLayoutBox, mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import "./info.js";

export const NOTE_DOCUMENT_INTENT_EVENT = "caffold:note-document-intent";
let documentInstanceId = 0;

// A retained document view. Notes Workspace owns reads and selection; this
// owns the header, preview, Info, focus and scroll across placement changes.
class CaffoldNoteDocument extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.boundIconsReady ??= () => this.renderIcons();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.info()?.deactivate();
  }

  ensureRendered() {
    if (this.rendered) return;
    this.rendered = true;
    this.renderedMarkdown = null;
    const titleId = `notes-document-title-${++documentInstanceId}`;
    this.innerHTML = `
      <div class="notes-workspace-detail-pane" role="region" aria-labelledby="${titleId}" tabindex="-1">
        <header class="notes-workspace-detail-header" hidden>
          <button type="button" class="note-document-back" data-action="back" title="Back to notes" aria-label="Back to notes"></button>
          <h1 id="${titleId}"><span class="note-document-title-text"></span><button type="button" class="note-document-title-picker" data-action="choose"><span></span><span data-title-chevron></span></button></h1>
          <div class="note-document-actions">
            <button type="button" class="note-document-split" data-action="split" title="View side by side" aria-label="View side by side"></button>
            <button type="button" class="note-document-close" data-action="close" title="Close side by side" aria-label="Close side by side"></button>
            <caffold-notes-info></caffold-notes-info>
          </div>
        </header>
        <p class="notes-workspace-location" hidden></p>
        <div class="notes-workspace-status" hidden><p class="notes-workspace-message"></p><button type="button" data-action="retry" hidden>Retry</button></div>
        <caffold-markdown-preview hidden></caffold-markdown-preview>
      </div>`;
    this.addEventListener("click", (event) => {
      const control = event.target.closest("button[data-action]");
      if (!control || !this.contains(control)) return;
      this.dispatchEvent(new CustomEvent(NOTE_DOCUMENT_INTENT_EVENT, {
        bubbles: true, detail: { type: control.dataset.action, side: this.dataset.noteSide },
      }));
    });
    this.renderIcons();
    void warmIcons();
  }

  setSnapshot({ noteId, result, side, split, paired, readable, emptyTree = false }) {
    this.ensureRendered();
    if (noteId !== this.noteId) this.renderedMarkdown = null;
    this.noteId = noteId;
    this.dataset.noteSide = side;
    this.dataset.split = `${split}`;
    this.dataset.paired = `${paired}`;
    const { state, note, message } = result;
    const title = state === "missing" ? "Note not found" : note?.name || "";
    this.noteName = note?.name || "Note";
    this.querySelector(".notes-workspace-detail-header").hidden = !noteId;
    const heading = this.querySelector("h1");
    heading.title = title;
    heading.querySelector(".note-document-title-text").textContent = title;
    const choose = heading.querySelector("button");
    choose.querySelector("span").textContent = paired ? title : "";
    choose.setAttribute("aria-label", `${title || "Note"}, choose another note`);
    this.querySelector('[data-action="split"]').hidden = split || !readable;
    this.querySelector('[data-action="close"]').hidden = !paired || side !== "secondary";
    this.info().setNote(noteId ? note : null);
    const location = this.querySelector(".notes-workspace-location");
    location.textContent = (note?.location ?? []).map((directory) => directory.name).join(" / ");
    location.hidden = !location.textContent;
    const statusMessage = !noteId ? (emptyTree ? "" : "Choose a note to read it.")
      : state === "loading" ? "Loading note…"
      : state === "missing" ? "This note no longer exists."
      : state === "failed" ? message
      : note?.content === "" ? "This note is empty." : "";
    const status = this.querySelector(".notes-workspace-status");
    status.hidden = !statusMessage;
    status.dataset.state = state === "failed" ? "failed" : "info";
    status.querySelector("p").textContent = statusMessage;
    this.querySelector('[data-action="retry"]').hidden = state !== "failed";
    const preview = this.preview();
    preview.hidden = !noteId || !note || note.content === "";
    if (preview.hidden) return;
    const previous = this.renderedMarkdown;
    if (previous?.noteId === note.id && previous.content === note.content) return;
    preview.setMarkdown(note.content, previous?.noteId === note.id
      ? { preserveScroll: true } : { scroll: { top: 0, left: 0 } });
    this.renderedMarkdown = { noteId: note.id, content: note.content };
  }

  renderIcons() {
    this.querySelector('[data-action="back"]').innerHTML = renderInlineIcon("ArrowLeft", "Back to notes", "note-document-icon");
    this.querySelector('[data-action="split"]').innerHTML = renderInlineIcon("Columns2", "View side by side", "note-document-icon");
    this.querySelector('[data-action="close"]').innerHTML = renderInlineIcon("X", "Close side by side", "note-document-icon");
    this.querySelector("[data-title-chevron]").innerHTML = renderInlineIcon("ChevronDown", "", "note-document-icon");
  }

  focusTitle({ preferSplit = false } = {}) {
    const split = this.querySelector('[data-action="split"]');
    if (preferSplit && hasActionHintLayoutBox(split)) { split.focus(); return; }
    const choose = this.querySelector('[data-action="choose"]');
    if (hasActionHintLayoutBox(choose)) choose.focus();
    else this.querySelector(".notes-workspace-detail-pane").focus();
  }

  place(parent, before = null) {
    const target = before?.parentElement === parent ? before : null;
    if (this.parentElement === parent) return;
    const scroll = this.preview().getScrollState();
    if (parent.moveBefore && this.isConnected) parent.moveBefore(this, target);
    else parent.insertBefore(this, target);
    this.preview().scrollTop = scroll.top;
    this.preview().scrollLeft = scroll.left;
  }

  actionHintScope({ scopeId, clipRoots = [] }) {
    if (this.hidden || !hasActionHintLayoutBox(this)) return emptyActionHintScope();
    const controls = [...this.querySelectorAll("button[data-action]")].filter(hasActionHintLayoutBox);
    const buttons = {
      blocked: false,
      targets: controls.map((control) => buttonActionHintTarget({
        invalidationOwner: this, id: `${scopeId}:${control.dataset.action}`,
        actionId: control.dataset.action === "back" ? ACTION_HINT_ACTION.PARENT : ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") || control.textContent,
        control, clipRoots: [this, ...clipRoots],
        isActionable: () => this.isConnected && !this.hidden && !control.hidden && hasActionHintLayoutBox(control),
      })), mutationRoots: [this], scrollRoots: [],
    };
    return mergeActionHintScopes(buttons, this.info().actionHintScope({ scopeId, clipRoots: [this, ...clipRoots] }),
      this.preview().actionHintScope({ scopeId: `${scopeId}:content`, linkActionId: ACTION_HINT_ACTION.LINK_OPEN, clipRoots: [this, ...clipRoots] }));
  }

  keyboardNavigationContexts({ scopeId }) {
    return this.hidden || !hasActionHintLayoutBox(this) ? [] : this.info().keyboardNavigationContexts({ scopeId });
  }

  scrollSurfaceScope({ scopeId, clipRoots = [] }) {
    return this.hidden || !hasActionHintLayoutBox(this) ? emptyScrollSurfaceScope() : this.preview().scrollSurfaceScope({
      scopeId: `${scopeId}:content`, label: this.noteName, clipRoots: [this, ...clipRoots],
    });
  }

  info() { return this.querySelector("caffold-notes-info"); }
  preview() { return this.querySelector("caffold-markdown-preview"); }
}

await Promise.all(["split", "close"].map((action) => compactIconButton.register("caffold-note-document", `> .notes-workspace-detail-pane > .notes-workspace-detail-header > .note-document-actions > .note-document-${action}`)));
customElements.define("caffold-note-document", CaffoldNoteDocument);
