import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  isTaskTransportStale,
  type TaskTransportState,
  taskThreadStatusType,
} from "#tasks/runtime-state.js";
import { type ListedTask, taskThreadId } from "#tasks/task-list-model.js";

/** The approval mode Caffold answers under, which is the one Jev judges for. */
const REVIEWED_PERMISSION_MODE = "caffold:ask-jev-first";
const PERMISSION_INSTRUCTIONS_ABOUT =
  "This Task keeps what your own prompts say it may and may not do, for Jev to read when it answers a permission request here.";
const FORK_ABOUT =
  "Create a new Task at the project root with this conversation's history. Files and worktrees are not copied.";
const ARCHIVE_ABOUT =
  "Archive removes this task from the active list. If Caffold prepared its worktree, the worktree is removed and its branch is kept. Its open terminal is closed.";

// A request the Task screen runs for the Task: whether it runs, and why the
// last one failed.
export interface TaskActionState {
  loading: boolean;
  error: Error | null;
}

// What the actions show: the Task, whether its details have been read, its
// live connection, its agent and approval mode, and its Archive and Fork
// requests. Archive waits while the agent is working on the Task.
export interface TaskInfoActionsSnapshot {
  task: ListedTask | null;
  canonicalTaskAvailable: boolean;
  archiveBlockedByActive: boolean;
  transportState: TaskTransportState;
  provider: string;
  permissionMode: string;
  archiveState: TaskActionState;
  forkState: TaskActionState;
}

type TaskInfoAction = "archive" | "fork" | "permission-instructions";

export interface TaskInfoActionIntent {
  type: TaskInfoAction;
}

/**
 * What can be done with the Task from its details popover: read what its
 * prompts settled, fork it, and archive it, each with why it cannot be done
 * now.
 */
@customElement("caffold-task-detail-info-actions")
export class CaffoldTaskDetailInfoActions extends LitElement {
  @property({ attribute: false })
  accessor snapshot: TaskInfoActionsSnapshot | null = null;

  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot?.task) {
      return nothing;
    }
    const forking = snapshot.forkState.loading;
    const forkUnavailable = forkDisabledReason(snapshot);
    const forkError = actionErrorMessage(snapshot.forkState.error);
    const archiving = snapshot.archiveState.loading;
    const archiveError = actionErrorMessage(snapshot.archiveState.error);
    const threadId = taskThreadId(snapshot.task);
    return html`
      <div
        class="task-detail-task-action
          task-detail-permission-instructions-action"
        data-task-info-permission-instructions
        ?hidden=${!this.keepsPermissionInstructions()}
      >
        <p>${PERMISSION_INSTRUCTIONS_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:permission-instructions`,
            label: "What your prompts settled",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: this.keepsPermissionInstructions(),
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action="permission-instructions"
          @click=${this.requestAction}
        >What your prompts settled</button>
      </div>
      <div class="task-detail-task-action task-detail-fork-action">
        <p>${FORK_ABOUT}</p>
        <p
          class="task-detail-fork-availability"
          ?hidden=${forking || !forkUnavailable}
        >${forking ? "" : forkUnavailable}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:fork`,
            label: "Fork task",
            action: ACTION_HINT_ACTION.TASK_FORK,
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action="fork"
          title=${forking || !forkUnavailable ? nothing : forkUnavailable}
          ?disabled=${forking || Boolean(forkUnavailable)}
          @click=${this.requestAction}
        >${forking ? "Forking..." : "Fork task"}</button>
        <p
          class="task-detail-action-error task-detail-fork-error"
          role="alert"
          ?hidden=${!forkError}
        >${forkError}</p>
      </div>
      <div class="task-detail-task-action task-detail-archive-action">
        <p>${ARCHIVE_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:archive`,
            label: "Archive task",
            action: ACTION_HINT_ACTION.TASK_ARCHIVE,
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action="archive"
          ?disabled=${
            archiving ||
            snapshot.forkState.loading ||
            snapshot.archiveBlockedByActive
          }
          @click=${this.requestAction}
        >${archiving ? "Archiving..." : "Archive task"}</button>
        <p
          class="task-detail-action-error task-detail-archive-error"
          role="alert"
          ?hidden=${!archiveError}
        >${archiveError}</p>
      </div>
    `;
  }

  // The record is kept and read only under the reviewed mode, so the action
  // that opens it is offered under that mode and no other.
  private keepsPermissionInstructions() {
    return this.snapshot?.permissionMode === REVIEWED_PERMISSION_MODE;
  }

  private requestAction(event: Event) {
    const type = (event.currentTarget as HTMLButtonElement).dataset
      .taskInfoAction as TaskInfoAction;
    this.dispatchEvent(
      new CustomEvent<TaskInfoActionIntent>(
        "caffold:task-detail-info-action-intent",
        {
          bubbles: true,
          composed: true,
          detail: { type },
        },
      ),
    );
  }
}

function actionErrorMessage(error: Error | null) {
  return error ? `${error.message ?? error}` : "";
}

function forkDisabledReason(snapshot: TaskInfoActionsSnapshot) {
  if (!snapshot.canonicalTaskAvailable) {
    return "Fork is unavailable until Task details load.";
  }
  if (snapshot.provider !== "codex") {
    return "Fork is currently available only for Codex Tasks.";
  }
  if (isTaskTransportStale(snapshot.transportState)) {
    return "Fork is unavailable while the Task connection is interrupted.";
  }
  if (snapshot.archiveState.loading) {
    return "Another Task action is in progress.";
  }
  if (taskThreadStatusType(snapshot.task) !== "idle") {
    return "Fork is available when the Codex Task is idle.";
  }
  return "";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-info-actions": CaffoldTaskDetailInfoActions;
  }
}
