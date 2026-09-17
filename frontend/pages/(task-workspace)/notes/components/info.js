import { formatModified } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../../../../action-hints.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";

let notesInfoInstanceId = 0;

// The details button at the end of the Note header. Its popover shows when the
// open Note changed and was created and the Tasks that wrote it.
class CaffoldNotesInfo extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  disconnectedCallback() {
    this.deactivate();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    notesInfoInstanceId += 1;
    const popoverId = `notes-info-${notesInfoInstanceId}`;
    this.note = null;
    this.renderedKey = "";
    this.listenersAttached = false;
    this.boundDismiss = (event) => this.handleDismiss(event);
    this.boundIconsReady = () => this.renderIcon();
    this.hidden = true;
    this.innerHTML = `
      <button
        type="button"
        class="notes-info-button"
        popovertarget="${popoverId}"
        aria-label="Note details"
        title="Note details"
      >${renderInlineIcon("Info", "Note details", "notes-info-icon")}</button>
      <div
        id="${popoverId}"
        class="notes-info-popover"
        popover="auto"
        aria-label="Note details"
      >
        <dl>
          <div>
            <dt>Updated</dt>
            <dd data-notes-info-field="updated"></dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd data-notes-info-field="created"></dd>
          </div>
          <div>
            <dt>Created in</dt>
            <dd data-notes-info-field="created-by"></dd>
          </div>
          <div data-notes-info-changed-by>
            <dt>Changed in</dt>
            <dd data-notes-info-field="changed-by"></dd>
          </div>
        </dl>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </div>
    `;
    warmIcons();
  }

  // The Note shown in the header, or null while none is. The popover closes
  // when a different Note takes its place and stays open while the same Note
  // is read again.
  setNote(note) {
    this.ensureRendered();
    if (note?.id !== this.note?.id) {
      this.deactivate();
    }
    this.note = note ?? null;
    this.hidden = !this.note;
    if (this.note) {
      this.renderFields();
    }
  }

  renderFields() {
    const { updatedAtMs, createdAtMs, createdBy, updatedBy } = this.note;
    const key = JSON.stringify([updatedAtMs, createdAtMs, createdBy, updatedBy]);
    if (key === this.renderedKey) {
      return;
    }
    this.renderedKey = key;
    this.field("updated").replaceChildren(timeValue(updatedAtMs));
    this.field("created").replaceChildren(timeValue(createdAtMs));
    this.field("created-by").replaceChildren(taskValue(createdBy));
    const changedByAnotherTask = updatedBy.threadId !== createdBy.threadId;
    this.querySelector("[data-notes-info-changed-by]").hidden = !changedByAnotherTask;
    this.field("changed-by").replaceChildren(
      ...(changedByAnotherTask ? [taskValue(updatedBy)] : []),
    );
  }

  handleDismiss(event) {
    if (event.target === this.infoPopover()) {
      this.deactivate();
    }
  }

  deactivate() {
    const popover = this.infoPopover();
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The popover may already have left the document with its Note.
    }
  }

  actionHintScope({ scopeId = "notes", clipRoots = [] } = {}) {
    this.ensureRendered();
    const noteId = this.note?.id;
    const control = this.infoButton();
    const popover = this.infoPopover();
    if (!noteId || this.hidden) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
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
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({ scopeId = "notes" } = {}) {
    this.ensureRendered();
    const noteId = this.note?.id;
    const popover = this.infoPopover();
    const presentation = popover.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!noteId || this.hidden || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:${noteId}:details`;
    const isCurrent = () => this.isConnected && this.note?.id === noteId;
    const links = [...popover.querySelectorAll(":scope > dl a[href]")];
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: mergeActionHintScopes({
          blocked: false,
          targets: links.map((link, index) => linkActionHintTarget({
            invalidationOwner: this,
            id: `${contextId}:task-link:${index}`,
            actionId: ACTION_HINT_ACTION.LINK_OPEN,
            label: link.textContent.trim(),
            control: link,
            clipRoots: [popover],
            isActionable: () => isCurrent() && link.isConnected,
          })),
          mutationRoots: [popover],
          scrollRoots: [popover],
        }),
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
    })];
  }

  renderIcon() {
    const button = this.infoButton();
    if (button && !button.querySelector(":scope > .notes-info-icon")) {
      button.innerHTML = renderInlineIcon("Info", "Note details", "notes-info-icon");
    }
  }

  field(name) {
    return this.querySelector(`[data-notes-info-field="${name}"]`);
  }

  infoButton() {
    return this.querySelector(":scope > .notes-info-button");
  }

  infoPopover() {
    return this.querySelector(":scope > .notes-info-popover");
  }
}

customElements.define("caffold-notes-info", CaffoldNotesInfo);

function timeValue(ms) {
  const time = document.createElement("time");
  time.dateTime = new Date(ms).toISOString();
  time.textContent = formatModified(ms);
  return time;
}

// Only an active Task has a page to open.
function taskValue(task) {
  if (task.state === "deleted") {
    return document.createTextNode("a deleted task");
  }
  if (task.state === "archived") {
    return document.createTextNode(`${task.displayName} (archived)`);
  }
  const link = document.createElement("a");
  link.href = `/tasks/${encodeURIComponent(task.threadId)}`;
  link.textContent = task.displayName;
  return link;
}
