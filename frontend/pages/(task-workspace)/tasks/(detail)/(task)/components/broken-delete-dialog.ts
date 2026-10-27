import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { deleteTask, getTask, type TaskResponseError } from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type { BrokenTaskDeleteIntent } from "../../task-detail-intent-event.js";
import { TASK_DETAIL_INTENT_EVENT } from "../../task-detail-intent-event.js";

// The Task a broken worktree keeps from opening, as its Task screen holds it.
export interface BrokenTaskContext {
  threadId: string;
  title?: string | null;
  error: TaskResponseError | null;
}

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
@customElement("caffold-broken-task-delete-dialog")
export class CaffoldBrokenTaskDeleteDialog extends LitElement {
  @state()
  private accessor phase: Phase = "idle";
  @state()
  private accessor target: BrokenTaskContext | null = null;
  @state()
  private accessor failure: Error | null = null;

  private generation = 0;
  private context: BrokenTaskContext | null = null;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
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
    }
  }

  openTask() {
    if (!this.context || !this.transition("open")) {
      return false;
    }
    this.target = { ...this.context };
    this.failure = null;
    this.dialog.value?.showModal();
    return true;
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  override render() {
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
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: `broken-task-delete:${target?.threadId ?? ""}`,
      })}
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
            ${this.hints.button({
              id: "cancel",
              label: "Cancel",
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="submit"
            class="broken-delete-button"
            value="cancel"
            autofocus
            ?disabled=${deleting}
          >Cancel</button>
          <button
            ${this.hints.button({
              id: "delete",
              label: "Delete task",
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="submit"
            class="broken-delete-button broken-delete-confirm"
            value="delete"
            ?disabled=${deleting}
          >${deleting ? "Deleting…" : "Delete task"}</button>
        </footer>
      </form>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private transition(event: PhaseEvent) {
    const next = EDGES[this.phase][event];
    if (!next) {
      return false;
    }
    this.phase = next;
    return true;
  }

  private cancel() {
    if (!this.transition("cancel")) {
      return;
    }
    this.target = null;
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  // Ends the dialog and any delete in flight, for an owner that leaves the
  // Task.
  reset() {
    this.generation += 1;
    this.transition("reset");
    this.target = null;
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
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
      this.dialog.value?.close();
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
        this.intent({ type: "broken-delete-error", error: diagnostic });
      } else {
        this.transition("refused");
        this.dialog.value?.close();
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
    if (!this.dialog.value?.open) {
      this.cancel();
    }
  }

  private intent(detail: BrokenTaskDeleteIntent) {
    this.dispatchEvent(
      new CustomEvent<BrokenTaskDeleteIntent>(TASK_DETAIL_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-broken-task-delete-dialog": CaffoldBrokenTaskDeleteDialog;
  }
}
