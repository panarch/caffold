import { deleteTask, getTask } from "../../../../../../api.js";
import { ACTION_HINT_ACTION, buttonActionHintTarget, emptyActionHintScope } from "../../../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../../../keyboard-navigation.js";
import "../../../../../../keyboard-navigation/components/presentation.js";

// One authority owns the UI phase. Diagnosis and request identity are data,
// independent of the native dialog's open attribute and transport state.
const EDGES = Object.freeze({
  idle: { open: "confirming", reset: "idle" },
  confirming: { cancel: "idle", confirm: "deleting", reset: "idle" },
  deleting: { success: "idle", failure: "confirming", refused: "idle", reset: "idle" },
});

class CaffoldBrokenTaskDeleteDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.phase = "idle";
    this.generation = 0;
    this.render();
    this.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (event.submitter?.value === "delete") void this.confirm();
      else this.cancel();
    });
    this.dialog().addEventListener("cancel", (event) => {
      if (this.phase === "deleting") event.preventDefault();
    });
    this.dialog().addEventListener("close", () => {
      if (!this.dialog().open) this.cancel();
    });
  }

  disconnectedCallback() { this.reset(); }
  dialog() { return this.querySelector(":scope > dialog"); }

  setContext(context) {
    const eligible = context?.error?.allowedActions?.includes("deleteTask") && context?.error?.worktreeId;
    const next = eligible ? context : null;
    if (this.context?.threadId !== next?.threadId || this.context?.error?.worktreeId !== next?.error?.worktreeId) this.reset();
    this.context = next;
    if (this.phase === "confirming" && next) {
      this.target = { ...next };
      this.presentTarget();
    }
  }

  openTask() {
    if (!this.context || !this.transition("open")) return false;
    this.target = { ...this.context, error: this.context.error };
    this.presentTarget();
    this.showError(null);
    this.dialog().showModal();
    return true;
  }

  presentTarget() {
    this.querySelector("[data-broken-delete-task]").textContent = this.target.title || this.target.threadId;
    this.querySelector("[data-broken-delete-path]").textContent = this.target.error.worktreePath;
    this.querySelector("[data-broken-delete-title]").textContent = this.target.error.worktreeMissing
      ? "Delete task with missing worktree?" : "Delete task and remaining worktree files?";
    this.querySelector("[data-broken-delete-description]").textContent = this.target.error.worktreeMissing
      ? "The worktree folder is missing. This permanently deletes this conversation and Caffold-owned task data. This cannot be undone."
      : "Caffold cannot check for uncommitted changes in this worktree. This permanently deletes the remaining worktree files, this conversation, and Caffold-owned task data. This cannot be undone.";
  }

  cancel() {
    if (!this.transition("cancel")) return;
    this.target = null;
    if (this.dialog().open) this.dialog().close();
  }

  reset() {
    this.generation = (this.generation ?? 0) + 1;
    this.transition("reset");
    this.target = null;
    if (this.dialog()?.open) this.dialog().close();
  }

  async confirm() {
    const target = this.target;
    if (!target || !this.transition("confirm")) return;
    const generation = ++this.generation;
    this.showError(null);
    const current = () => this.isConnected && this.generation === generation && this.target === target;
    try {
      await deleteTask(target.threadId, {
        confirmBrokenWorktreeDeletion: true,
        expectedWorktreeId: target.error.worktreeId,
      });
      if (!current()) return;
      this.transition("success");
      this.dialog().close();
      this.intent({ type: "task-deleted", threadId: target.threadId });
    } catch (error) {
      if (!current()) return;
      // Ask the owning source again after a partial failure. A failed request
      // does not prove that the original confirmation remains eligible.
      let diagnostic = null;
      try { await getTask(target.threadId); }
      catch (latest) { diagnostic = latest; }
      if (!current()) return;
      const eligible = diagnostic?.allowedActions?.includes("deleteTask") && diagnostic.worktreeId === target.error.worktreeId;
      if (eligible) {
        this.transition("failure");
        this.showError(error);
        this.intent({ type: "broken-delete-error", error: diagnostic });
      } else {
        this.transition("refused");
        this.dialog().close();
        this.intent({ type: "broken-delete-error", error: diagnostic ?? error });
      }
    }
  }

  transition(event) {
    const next = EDGES[this.phase ?? "idle"]?.[event];
    if (!next) return false;
    this.phase = next;
    const pending = next === "deleting";
    this.dialog()?.setAttribute("closedby", pending ? "none" : "any");
    for (const button of this.querySelectorAll("form button")) button.disabled = pending;
    const confirm = this.querySelector('button[value="delete"]');
    if (confirm) confirm.textContent = pending ? "Deleting…" : "Delete task";
    return true;
  }

  showError(error) {
    const message = this.querySelector("[data-broken-delete-error]");
    message.textContent = error?.message ?? "";
    message.hidden = !error;
  }

  intent(detail) {
    this.dispatchEvent(new CustomEvent("caffold:task-detail-intent", { bubbles: true, composed: true, detail }));
  }

  actionHintScope() {
    const dialog = this.dialog();
    if (!dialog) return emptyActionHintScope();
    const generation = this.generation;
    return {
      blocked: false,
      targets: [...dialog.querySelectorAll("form button")].map((control) => buttonActionHintTarget({
        invalidationOwner: this,
        id: `broken-task-delete:${this.target?.threadId}:${control.value}`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.textContent,
        control,
        clipRoots: [dialog],
        isActionable: () => this.isConnected && dialog.open && this.generation === generation && this.phase === "confirming" && !control.disabled,
      })),
      mutationRoots: [this], scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(":scope > caffold-keyboard-navigation-presentation");
    const hintDialog = presentation?.actionHintDialog?.();
    return dialog && hintDialog ? [keyboardNavigationContext({
      id: `broken-task-delete:${this.target?.threadId ?? ""}`, kind: "modal", root: dialog,
      actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
    })] : [];
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="broken-task-delete-title" aria-describedby="broken-task-delete-description">
        <form method="dialog" class="broken-delete-card">
          <h2 id="broken-task-delete-title" data-broken-delete-title></h2>
          <p class="broken-delete-task" data-broken-delete-task></p>
          <p class="broken-delete-path" data-broken-delete-path></p>
          <p id="broken-task-delete-description" data-broken-delete-description></p>
          <p>Local Git branches will be kept.</p>
          <p class="broken-delete-error" data-broken-delete-error role="alert" hidden></p>
          <footer class="broken-delete-actions">
            <button type="submit" class="broken-delete-button" value="cancel" autofocus>Cancel</button>
            <button type="submit" class="broken-delete-button broken-delete-confirm" value="delete">Delete task</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>`;
  }
}

if (!customElements.get("caffold-broken-task-delete-dialog")) {
  customElements.define("caffold-broken-task-delete-dialog", CaffoldBrokenTaskDeleteDialog);
}
