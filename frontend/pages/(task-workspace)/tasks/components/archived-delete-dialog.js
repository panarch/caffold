import { taskThreadId } from "../task-list-model.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";

export const TASK_ARCHIVED_DELETE_CONFIRMED_EVENT =
  "caffold:task-archived-delete-confirmed";

class CaffoldTaskArchivedDeleteDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    if (!dialog || !hintDialog) {
      return [];
    }
    const threadId = `${this.pendingThreadId ?? ""}`;
    return [keyboardNavigationContext({
      id: threadId
        ? `archived-task-delete:${encodeURIComponent(threadId)}`
        : "archived-task-delete",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    const threadId = `${this.pendingThreadId ?? ""}`;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const targets = ["cancel", "delete"].flatMap((value) => {
      const control = dialog.querySelector(`button[value="${value}"]`);
      if (!control) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `archived-task-delete:${encodeURIComponent(threadId)}:${value}`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.textContent?.trim() || value,
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          `${this.pendingThreadId ?? ""}` === threadId &&
          Boolean(threadId) &&
          dialog.querySelector(`button[value="${value}"]`) === control &&
          !control.disabled,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  openTask(task) {
    const threadId = taskThreadId(task);
    if (!threadId) {
      return false;
    }

    const dialog = this.dialog();
    this.pendingThreadId = threadId;
    dialog.returnValue = "";
    this.querySelector("[data-task-delete-title]").textContent =
      task?.title ?? threadId;
    if (!dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  handleClose() {
    if (this.dialog().open) {
      return;
    }
    const threadId = this.pendingThreadId;
    const confirmed = this.dialog().returnValue === "delete";
    this.pendingThreadId = null;
    this.querySelector("[data-task-delete-title]").textContent = "";
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

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-delete-dialog-title" aria-describedby="task-delete-dialog-description">
        <form method="dialog" class="task-delete-dialog-card">
          <h2 id="task-delete-dialog-title">Permanently delete archived task?</h2>
          <p class="task-delete-dialog-task" data-task-delete-title></p>
          <p id="task-delete-dialog-description">
            This deletes the Codex conversation and Caffold-owned task data.<br>
            It cannot be restored.
          </p>
          <p class="task-delete-dialog-preserved">Your local Git branch will be kept.</p>
          <footer class="task-delete-dialog-actions">
            <button type="submit" class="task-delete-dialog-button" value="cancel" autofocus>Cancel</button>
            <button type="submit" class="task-delete-dialog-button task-delete-confirm" value="delete">Delete permanently</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

if (!customElements.get("caffold-task-archived-delete-dialog")) {
  customElements.define(
    "caffold-task-archived-delete-dialog",
    CaffoldTaskArchivedDeleteDialog,
  );
}
