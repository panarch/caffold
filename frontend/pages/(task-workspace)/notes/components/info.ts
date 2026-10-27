import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { Note, NoteTask } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  KeyboardContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { formatModified } from "#components/dom.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "./info/components/copy-markdown.js";
import type { CaffoldNotesInfoCopyMarkdown } from "./info/components/copy-markdown.js";
import "./info/components/copy-path.js";
import type { CaffoldNotesInfoCopyPath } from "./info/components/copy-path.js";

let notesInfoInstanceId = 0;

// The details button at the end of the Note header. Its popover shows when the
// open Note changed and was created and the Tasks that wrote it, and copies the
// Note's path or its Markdown.
export class CaffoldNotesInfo extends LitElement {
  static properties = {
    note: { attribute: false },
    shownNote: { state: true },
  };

  // The Note shown in the header, or null while none is.
  declare note: Note | null;
  // While no Note is shown, the hidden popover keeps the last one.
  declare private shownNote: Note | null;
  private readonly popoverId = `notes-info-${++notesInfoInstanceId}`;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly infoPopover = new DrawnRef<HTMLDivElement>(this);
  private readonly copyPath = new DrawnRef<CaffoldNotesInfoCopyPath>(this);
  private readonly copyMarkdown = new DrawnRef<CaffoldNotesInfoCopyMarkdown>(
    this,
  );

  constructor() {
    super();
    this.note = null;
    this.shownNote = null;
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
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

  // The popover closes when a different Note takes its place and stays open
  // while the same Note is read again.
  willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("note")) {
      return;
    }
    if (this.note?.id !== changed.get("note")?.id) {
      this.deactivate();
    }
    this.shownNote = this.note ?? this.shownNote;
    if (this.hidden !== !this.note) {
      this.hidden = !this.note;
    }
  }

  render() {
    const note = this.shownNote;
    const changedByAnotherTask =
      note !== null && note.updatedBy.threadId !== note.createdBy.threadId;
    const shown = Boolean(this.note);
    return html`
      <button
        ${this.hints.button({
          id: `${note?.id}:details:open`,
          label: "Note details",
          action: ACTION_HINT_ACTION.NOTE_DETAILS_OPEN,
          when: shown,
        })}
        type="button"
        class="notes-info-button"
        popovertarget=${this.popoverId}
        aria-label="Note details"
        title="Note details"
      >${inlineIcon("Info", "Note details", "notes-info-icon")}</button>
      <div
        ${drawn(this.infoPopover)}
        ${this.keyboard.popover({
          id: `${note?.id}:details`,
          label: "Note details",
          sessionBound: true,
          when: shown,
        })}
        id=${this.popoverId}
        class="notes-info-popover"
        popover="auto"
        aria-label="Note details"
      >
        <dl>
          <div>
            <dt>Updated</dt>
            <dd data-notes-info-field="updated">${
              note ? timeValue(note.updatedAtMs) : nothing
            }</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd data-notes-info-field="created">${
              note ? timeValue(note.createdAtMs) : nothing
            }</dd>
          </div>
          <div>
            <dt>Created in</dt>
            <dd data-notes-info-field="created-by">${
              note ? this.taskValue("created-by", note.createdBy) : nothing
            }</dd>
          </div>
          <div data-notes-info-changed-by ?hidden=${!changedByAnotherTask}>
            <dt>Changed in</dt>
            <dd data-notes-info-field="changed-by">${
              changedByAnotherTask
                ? this.taskValue("changed-by", note.updatedBy)
                : nothing
            }</dd>
          </div>
        </dl>
        <div class="notes-info-actions">
          <caffold-notes-info-copy-path
            ${drawn(this.copyPath)}
            .note=${note}
          ></caffold-notes-info-copy-path>
          <caffold-notes-info-copy-markdown
            ${drawn(this.copyMarkdown)}
            .note=${note}
          ></caffold-notes-info-copy-markdown>
        </div>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  deactivate() {
    const popover = this.infoPopover.value;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The popover may already have left the document with its Note.
    }
  }

  actionHintScope({ scopeId = "notes", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  keyboardNavigationContexts({ scopeId = "notes" }: { scopeId?: string } = {}) {
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) =>
        mergeActionHintScopes(
          this.hints.scope(pull),
          this.copyPath.value?.actionHintScope(pull),
          this.copyMarkdown.value?.actionHintScope(pull),
        ),
    });
  }

  // Only an active Task has a page to open.
  private taskValue(field: string, task: NoteTask) {
    if (task.state === "deleted") {
      return "a deleted task";
    }
    if (task.state === "archived") {
      return `${task.displayName} (archived)`;
    }
    return html`<a
      ${this.hints.link({
        id: `task-link:${field}`,
        label: task.displayName,
        action: ACTION_HINT_ACTION.LINK_OPEN,
      })}
      href=${`/tasks/${encodeURIComponent(task.threadId)}`}
    >${task.displayName}</a>`;
  }

  private handleDismiss(event: Event) {
    if (event.target === this.infoPopover.value) {
      this.deactivate();
    }
  }
}

await compactIconButton.register("caffold-notes-info", "> .notes-info-button");

customElements.define("caffold-notes-info", CaffoldNotesInfo);

function timeValue(ms: number) {
  return html`<time datetime=${new Date(ms).toISOString()}>${formatModified(
    ms,
  )}</time>`;
}
