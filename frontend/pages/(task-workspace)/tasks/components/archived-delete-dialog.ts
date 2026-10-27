import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { taskThreadId } from "../task-list-model.js";

export const TASK_ARCHIVED_DELETE_CONFIRMED_EVENT =
  "caffold:task-archived-delete-confirmed";

export class CaffoldTaskArchivedDeleteDialog extends LitElement {
  static properties = {
    taskTitle: { state: true },
    pendingThreadId: { state: true },
  };

  declare private taskTitle: string;
  declare private pendingThreadId: string | null;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  constructor() {
    super();
    this.taskTitle = "";
    this.pendingThreadId = null;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({
          id: `archived-task-delete:${encodeURIComponent(
            this.pendingThreadId ?? "",
          )}`,
        })}
        closedby="any"
        aria-labelledby="task-delete-dialog-title"
        aria-describedby="task-delete-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="task-delete-dialog-card">
          <h2 id="task-delete-dialog-title">
            Permanently delete archived task?
          </h2>
          <p class="task-delete-dialog-task">${this.taskTitle}</p>
          <p id="task-delete-dialog-description">
            This deletes the Codex conversation and Caffold-owned task data.<br>
            It cannot be restored.
          </p>
          <p class="task-delete-dialog-preserved">
            Your local Git branch will be kept.
          </p>
          <footer class="task-delete-dialog-actions">
            <button
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="task-delete-dialog-button"
              value="cancel"
              autofocus
            >
              Cancel
            </button>
            <button
              ${this.hints.button({
                id: "delete",
                label: "Delete permanently",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="task-delete-dialog-button task-delete-confirm"
              value="delete"
            >
              Delete permanently
            </button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  openTask(
    task:
      | { threadId?: string | null; id?: string | null; title?: string | null }
      | null
      | undefined,
  ) {
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.pendingThreadId = threadId;
    this.taskTitle = task?.title ?? threadId;
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.returnValue = "";
    dialog.showModal();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  private handleClose() {
    const dialog = this.dialog.value;
    // A close event that arrives after the dialog was opened again belongs
    // to the earlier Task.
    if (!dialog || dialog.open) {
      return;
    }
    const threadId = this.pendingThreadId;
    const confirmed = dialog.returnValue === "delete";
    this.pendingThreadId = null;
    this.taskTitle = "";
    if (!confirmed || !threadId) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(TASK_ARCHIVED_DELETE_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
        detail: { threadId },
      }),
    );
  }
}

customElements.define(
  "caffold-task-archived-delete-dialog",
  CaffoldTaskArchivedDeleteDialog,
);
