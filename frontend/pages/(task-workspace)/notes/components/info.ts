import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { Note, NoteTask } from "#app/api.ts";
import { compactIconButton } from "#app/component-styles.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { formatModified } from "#components/dom.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "./info/components/copy-markdown.ts";
import type { CaffoldNotesInfoCopyMarkdown } from "./info/components/copy-markdown.ts";
import "./info/components/copy-path.ts";
import type { CaffoldNotesInfoCopyPath } from "./info/components/copy-path.ts";

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
    return html`
      <button
        type="button"
        class="notes-info-button"
        popovertarget=${this.popoverId}
        aria-label="Note details"
        title="Note details"
      >${inlineIcon("Info", "Note details", "notes-info-icon")}</button>
      <div
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
              note ? taskValue(note.createdBy) : nothing
            }</dd>
          </div>
          <div data-notes-info-changed-by ?hidden=${!changedByAnotherTask}>
            <dt>Changed in</dt>
            <dd data-notes-info-field="changed-by">${
              changedByAnotherTask ? taskValue(note.updatedBy) : nothing
            }</dd>
          </div>
        </dl>
        <div class="notes-info-actions">
          <caffold-notes-info-copy-path
            .note=${note}
          ></caffold-notes-info-copy-path>
          <caffold-notes-info-copy-markdown
            .note=${note}
          ></caffold-notes-info-copy-markdown>
        </div>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  deactivate() {
    const popover = this.infoPopover;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The popover may already have left the document with its Note.
    }
  }

  actionHintScope({
    scopeId = "notes",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const noteId = this.note?.id;
    const control = this.infoButton;
    const popover = this.infoPopover;
    if (!noteId || this.hidden || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${noteId}:details:open`,
          actionId: ACTION_HINT_ACTION.NOTE_DETAILS_OPEN,
          label: "Note details",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.note?.id === noteId &&
            !popover.matches(":popover-open"),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({ scopeId = "notes" }: { scopeId?: string } = {}) {
    const noteId = this.note?.id;
    const popover = this.infoPopover;
    const presentation =
      popover?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!noteId || this.hidden || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:${noteId}:details`;
    const isCurrent = () => this.isConnected && this.note?.id === noteId;
    const links = [
      ...popover.querySelectorAll<HTMLAnchorElement>(":scope > dl a[href]"),
    ];
    const actions = popover.querySelector(":scope > .notes-info-actions");
    const copyPath = actions?.querySelector<CaffoldNotesInfoCopyPath>(
      ":scope > caffold-notes-info-copy-path",
    );
    const copyMarkdown = actions?.querySelector<CaffoldNotesInfoCopyMarkdown>(
      ":scope > caffold-notes-info-copy-markdown",
    );
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: mergeActionHintScopes(
            {
              blocked: false,
              targets: links.map((link, index) =>
                linkActionHintTarget({
                  invalidationOwner: this,
                  id: `${contextId}:task-link:${index}`,
                  actionId: ACTION_HINT_ACTION.LINK_OPEN,
                  label: (link.textContent ?? "").trim(),
                  control: link,
                  clipRoots: [popover],
                  isActionable: () => isCurrent() && link.isConnected,
                }),
              ),
              mutationRoots: [popover],
              scrollRoots: [popover],
            },
            copyPath?.actionHintScope({
              scopeId: contextId,
              clipRoots: [popover],
              isCurrent,
            }),
            copyMarkdown?.actionHintScope({
              scopeId: contextId,
              clipRoots: [popover],
              isCurrent,
            }),
          ),
          sessionBound: true,
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "Note details",
            popover,
            isCurrent,
          }),
        },
      }),
    ];
  }

  private handleDismiss(event: Event) {
    if (event.target === this.infoPopover) {
      this.deactivate();
    }
  }

  private get infoButton() {
    return this.querySelector<HTMLButtonElement>(":scope > .notes-info-button");
  }

  private get infoPopover() {
    return this.querySelector<HTMLElement>(":scope > .notes-info-popover");
  }
}

await compactIconButton.register("caffold-notes-info", "> .notes-info-button");

customElements.define("caffold-notes-info", CaffoldNotesInfo);

function timeValue(ms: number) {
  return html`<time datetime=${new Date(ms).toISOString()}>${formatModified(
    ms,
  )}</time>`;
}

// Only an active Task has a page to open.
function taskValue(task: NoteTask) {
  if (task.state === "deleted") {
    return "a deleted task";
  }
  if (task.state === "archived") {
    return `${task.displayName} (archived)`;
  }
  return html`<a href=${`/tasks/${encodeURIComponent(task.threadId)}`}>${
    task.displayName
  }</a>`;
}
