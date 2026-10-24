import { html, LitElement } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { taskThreadId } from "../task-list-model.js";

export const TASK_ARCHIVED_DELETE_CONFIRMED_EVENT =
  "caffold:task-archived-delete-confirmed";

class CaffoldTaskArchivedDeleteDialog extends LitElement {
  static properties = {
    taskTitle: { state: true },
  };

  declare private taskTitle: string;
  private pendingThreadId: string | null = null;

  constructor() {
    super();
    this.taskTitle = "";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    return html`
      <dialog
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
              type="submit"
              class="task-delete-dialog-button"
              value="cancel"
              autofocus
            >
              Cancel
            </button>
            <button
              type="submit"
              class="task-delete-dialog-button task-delete-confirm"
              value="delete"
            >
              Delete permanently
            </button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  openTask(task: { title?: string | null } | null | undefined) {
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.pendingThreadId = threadId;
    this.taskTitle = task?.title ?? threadId;
    this.performUpdate();
    const dialog = this.dialog;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.returnValue = "";
    dialog.showModal();
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const hintDialog = dialog
      ?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      )
      ?.actionHintDialog?.();
    if (!dialog || !hintDialog) {
      return [];
    }
    const threadId = `${this.pendingThreadId ?? ""}`;
    return [
      keyboardNavigationContext({
        id: threadId
          ? `archived-task-delete:${encodeURIComponent(threadId)}`
          : "archived-task-delete",
        kind: "modal",
        root: dialog,
        actionHints: {
          dialog: hintDialog,
          scope: this.actionHintScope(),
        },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const threadId = `${this.pendingThreadId ?? ""}`;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const targets = ["cancel", "delete"].flatMap((value) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `button[value="${value}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `archived-task-delete:${encodeURIComponent(threadId)}:${value}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || value,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            `${this.pendingThreadId ?? ""}` === threadId &&
            Boolean(threadId) &&
            dialog.querySelector(`button[value="${value}"]`) === control &&
            !control.disabled,
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }

  private handleClose() {
    const dialog = this.dialog;
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
