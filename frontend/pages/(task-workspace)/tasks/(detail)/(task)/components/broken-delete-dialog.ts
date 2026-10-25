import { html, LitElement } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { deleteTask, getTask, type TaskResponseError } from "#app/api.js";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";

// The Task a broken worktree keeps from opening, as its Task screen holds it.
export interface BrokenTaskContext {
  threadId: string;
  title?: string | null;
  error: TaskResponseError | null;
}

// What the dialog tells the Task screen: the Task is gone, or the delete
// failed and the Task's diagnosis is now this.
export type BrokenTaskDeleteIntent =
  | { type: "task-deleted"; threadId: string }
  | { type: "broken-delete-error"; error: unknown };

type Phase = "idle" | "confirming" | "deleting";
type PhaseEvent =
  | "open"
  | "cancel"
  | "confirm"
  | "success"
  | "failure"
  | "refused"
  | "reset";

// One authority owns the UI phase. Diagnosis and request identity are data,
// independent of the native dialog's open attribute and transport state.
const EDGES: Readonly<Record<Phase, Partial<Record<PhaseEvent, Phase>>>> = {
  idle: { open: "confirming", reset: "idle" },
  confirming: { cancel: "idle", confirm: "deleting", reset: "idle" },
  deleting: {
    success: "idle",
    failure: "confirming",
    refused: "idle",
    reset: "idle",
  },
};

/**
 * Asks before deleting a Task whose worktree Caffold cannot check, and
 * deletes it with the worktree its diagnosis named.
 */
export class CaffoldBrokenTaskDeleteDialog extends LitElement {
  private phase: Phase = "idle";
  private generation = 0;
  private context: BrokenTaskContext | null = null;
  private target: BrokenTaskContext | null = null;
  private failure: Error | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.reset();
  }

  setContext(context: BrokenTaskContext | null) {
    const error = context?.error;
    const next =
      error?.allowedActions?.includes("deleteTask") && error.worktreeId
        ? context
        : null;
    if (
      this.context?.threadId !== next?.threadId ||
      this.context?.error?.worktreeId !== next?.error?.worktreeId
    ) {
      this.reset();
    }
    this.context = next;
    if (this.phase === "confirming" && next) {
      this.target = { ...next };
      this.draw();
    }
  }

  openTask() {
    if (!this.context || !this.transition("open")) {
      return false;
    }
    this.target = { ...this.context };
    this.failure = null;
    this.draw();
    this.dialog.showModal();
    return true;
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const generation = this.generation;
    return {
      blocked: false,
      targets: [
        ...dialog.querySelectorAll<HTMLButtonElement>("form button"),
      ].map((control) =>
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `broken-task-delete:${this.target?.threadId}:${control.value}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            dialog.open &&
            this.generation === generation &&
            this.phase === "confirming" &&
            !control.disabled,
        }),
      ),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const hintDialog = dialog
      ?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      )
      ?.actionHintDialog();
    return dialog && hintDialog
      ? [
          keyboardNavigationContext({
            id: `broken-task-delete:${this.target?.threadId ?? ""}`,
            kind: "modal",
            root: dialog,
            actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
          }),
        ]
      : [];
  }

  render() {
    const target = this.target;
    const missing = Boolean(target?.error?.worktreeMissing);
    const deleting = this.phase === "deleting";
    const title = !target
      ? ""
      : missing
        ? "Delete task with missing worktree?"
        : "Delete task and remaining worktree files?";
    const description = !target
      ? ""
      : missing
        ? "The worktree folder is missing. This permanently deletes this conversation and Caffold-owned task data. This cannot be undone."
        : "Caffold cannot check for uncommitted changes in this worktree. This permanently deletes the remaining worktree files, this conversation, and Caffold-owned task data. This cannot be undone.";
    return html`<dialog
      closedby=${deleting ? "none" : "any"}
      aria-labelledby="broken-task-delete-title"
      aria-describedby="broken-task-delete-description"
      @cancel=${this.handleCancel}
      @close=${this.handleClose}
    >
      <form
        method="dialog"
        class="broken-delete-card"
        @submit=${this.handleSubmit}
      >
        <h2 id="broken-task-delete-title" data-broken-delete-title
          >${title}</h2
        >
        <p class="broken-delete-task" data-broken-delete-task
          >${target ? target.title || target.threadId : ""}</p
        >
        <p class="broken-delete-path" data-broken-delete-path
          >${target?.error?.worktreePath ?? ""}</p
        >
        <p
          id="broken-task-delete-description"
          data-broken-delete-description
        >${description}</p>
        <p>Local Git branches will be kept.</p>
        <p
          class="broken-delete-error"
          data-broken-delete-error
          role="alert"
          ?hidden=${!this.failure}
        >${this.failure?.message ?? ""}</p>
        <footer class="broken-delete-actions">
          <button
            type="submit"
            class="broken-delete-button"
            value="cancel"
            autofocus
            ?disabled=${deleting}
          >Cancel</button>
          <button
            type="submit"
            class="broken-delete-button broken-delete-confirm"
            value="delete"
            ?disabled=${deleting}
          >${deleting ? "Deleting…" : "Delete task"}</button>
        </footer>
      </form>
      <caffold-keyboard-navigation-presentation
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private transition(event: PhaseEvent) {
    const next = EDGES[this.phase][event];
    if (!next) {
      return false;
    }
    this.phase = next;
    this.draw();
    return true;
  }

  private cancel() {
    if (!this.transition("cancel")) {
      return;
    }
    this.target = null;
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  // Ends the dialog and any delete in flight, for an owner that leaves the
  // Task.
  reset() {
    this.generation += 1;
    this.transition("reset");
    this.target = null;
    if (this.dialog?.open) {
      this.dialog.close();
    }
  }

  private async confirm() {
    const target = this.target;
    const worktreeId = target?.error?.worktreeId;
    if (!target || !worktreeId || !this.transition("confirm")) {
      return;
    }
    const generation = ++this.generation;
    this.failure = null;
    this.draw();
    const current = () =>
      this.isConnected &&
      this.generation === generation &&
      this.target === target;
    try {
      await deleteTask(target.threadId, {
        confirmBrokenWorktreeDeletion: true,
        expectedWorktreeId: worktreeId,
      });
      if (!current()) {
        return;
      }
      this.transition("success");
      this.dialog.close();
      this.intent({ type: "task-deleted", threadId: target.threadId });
    } catch (error) {
      if (!current()) {
        return;
      }
      // Ask the owning source again after a partial failure. A failed request
      // does not prove that the original confirmation remains eligible.
      let diagnostic: TaskResponseError | null = null;
      try {
        await getTask(target.threadId);
      } catch (latest) {
        diagnostic = latest as TaskResponseError;
      }
      if (!current()) {
        return;
      }
      const eligible =
        diagnostic?.allowedActions?.includes("deleteTask") &&
        diagnostic.worktreeId === worktreeId;
      if (eligible) {
        this.transition("failure");
        this.failure = error instanceof Error ? error : new Error(`${error}`);
        this.draw();
        this.intent({ type: "broken-delete-error", error: diagnostic });
      } else {
        this.transition("refused");
        this.dialog.close();
        this.intent({
          type: "broken-delete-error",
          error: diagnostic ?? error,
        });
      }
    }
  }

  private handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if ((event.submitter as HTMLButtonElement | null)?.value === "delete") {
      void this.confirm();
    } else {
      this.cancel();
    }
  }

  private handleCancel(event: Event) {
    if (this.phase === "deleting") {
      event.preventDefault();
    }
  }

  private handleClose() {
    if (!this.dialog.open) {
      this.cancel();
    }
  }

  private intent(detail: BrokenTaskDeleteIntent) {
    this.dispatchEvent(
      new CustomEvent<BrokenTaskDeleteIntent>("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private get dialog() {
    return this.querySelector(":scope > dialog") as HTMLDialogElement;
  }
}

customElements.define(
  "caffold-broken-task-delete-dialog",
  CaffoldBrokenTaskDeleteDialog,
);
