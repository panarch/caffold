import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { TaskResponseError } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import {
  isTaskTransportStale,
  type TaskTransportState,
  taskThreadStatusType,
} from "#tasks/runtime-state.js";
import { type ListedTask, taskThreadId } from "#tasks/task-list-model.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./actions.css.js";

/** The approval mode Caffold answers under, which is the one Jev judges for. */
const REVIEWED_PERMISSION_MODE = "caffold:ask-jev-first";
const PERMISSION_INSTRUCTIONS_ABOUT =
  "This Task keeps what your own prompts say it may and may not do, for Jev to read when it answers a permission request here.";
const PIN_ABOUT =
  "Pinned Tasks stay at the top of the Task list and the Task Switcher.";
const UNPIN_ABOUT =
  "This Task is pinned. Unpinning returns it to the top of its Section.";
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
// live connection, its agent and approval mode, whether it is pinned (null
// while the list has not placed it in a Section), and its Archive, Fork, and
// pin requests. Archive waits while the agent is working on the Task.
export interface TaskInfoActionsSnapshot {
  task: ListedTask | null;
  canonicalTaskAvailable: boolean;
  archiveBlockedByActive: boolean;
  transportState: TaskTransportState;
  provider: string;
  permissionMode: string;
  archiveState: TaskActionState;
  forkState: TaskActionState;
  pinned: boolean | null;
  pinState: TaskActionState;
}

type TaskInfoAction =
  | "archive"
  | "force-archive"
  | "fork"
  | "pin"
  | "unpin"
  | "permission-instructions";

export interface TaskInfoActionIntent {
  type: TaskInfoAction;
}

/**
 * What can be done with the Task from its details popover: read what its
 * prompts settled, pin or unpin it, fork it, and archive it, each with why it
 * cannot be done now.
 */
@customElement("caffold-task-detail-info-actions")
export class CaffoldTaskDetailInfoActions extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: TaskInfoActionsSnapshot | null = null;

  static override styles = [
    scopedStyle(busySpin, ".task-detail-action-icon.is-busy"),
    scopedStyle(secondaryButton, ".task-secondary-button"),
    styles,
  ];

  private readonly hints = new ActionHints(this);
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
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
    const createdTaskId = (snapshot.forkState.error as TaskResponseError | null)
      ?.createdTaskId;
    const pinned = snapshot.pinned;
    const pinning = snapshot.pinState.loading;
    const pinError = actionErrorMessage(snapshot.pinState.error);
    const pinLabel = pinned ? "Unpin task" : "Pin task";
    const pinIcon = pinned ? "PinOff" : "Pin";
    const archiving = snapshot.archiveState.loading;
    const archiveError = actionErrorMessage(snapshot.archiveState.error);
    const archiveFailure = snapshot.archiveState
      .error as TaskResponseError | null;
    const canForceArchive = Boolean(
      archiveFailure?.allowedActions?.includes("forceArchive") &&
        archiveFailure.worktreeId,
    );
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
        >${actionContent("ShieldCheck", "What your prompts settled")}</button>
      </div>
      <div
        class="task-detail-task-action task-detail-pin-action"
        ?hidden=${pinned === null}
      >
        <p>${pinned ? UNPIN_ABOUT : PIN_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:pin`,
            label: pinLabel,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: pinned !== null,
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action=${pinned ? "unpin" : "pin"}
          ?disabled=${pinning}
          @click=${this.requestAction}
        >${actionContent(
          pinIcon,
          pinning ? (pinned ? "Unpinning..." : "Pinning...") : pinLabel,
          pinning,
        )}</button>
        <p
          class="task-detail-action-error task-detail-pin-error"
          role="alert"
          ?hidden=${!pinError}
        >${pinError}</p>
      </div>
      <div class="task-detail-task-action task-detail-fork-action">
        <p>${FORK_ABOUT}</p>
        <p
          class="task-detail-fork-availability"
          ?hidden=${forking || Boolean(createdTaskId) || !forkUnavailable}
        >${forking ? "" : forkUnavailable}</p>
        ${
          createdTaskId
            ? nothing
            : html`<button
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
              >${actionContent("Split", forking ? "Forking..." : "Fork task", forking)}</button>`
        }
        <p
          class="task-detail-action-error task-detail-fork-error"
          role="alert"
          ?hidden=${!forkError}
        >${forkError}</p>
        ${
          createdTaskId
            ? html`<a
                ${this.hints.link({
                  id: `${threadId}:open-fork`,
                  label: "Open forked task",
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
                class="task-secondary-button"
                href=${`/tasks/${encodeURIComponent(createdTaskId)}`}
              >${actionContent("ArrowRight", "Open forked task")}</a>`
            : nothing
        }
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
        >${actionContent(
          "Archive",
          archiving ? "Archiving..." : "Archive task",
          archiving,
        )}</button>
        <p
          class="task-detail-action-error task-detail-archive-error"
          role="alert"
          ?hidden=${!archiveError}
        >${archiveError}</p>
        ${
          canForceArchive
            ? html`
                <button
                  ${this.hints.button({
                    id: `${threadId}:force-archive`,
                    label: "Discard changes and archive",
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                    badgeAtEnd: true,
                  })}
                  type="button"
                  class="task-secondary-button"
                  data-task-info-action="force-archive"
                  ?disabled=${
                    archiving ||
                    snapshot.forkState.loading ||
                    snapshot.archiveBlockedByActive
                  }
                  @click=${this.requestAction}
                >${actionContent("ArchiveX", "Discard changes and archive")}</button>
              `
            : nothing
        }
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

// An action's icon before its label. While the action runs, the busy icon
// turns in the icon's place.
function actionContent(icon: string, label: string, busy = false) {
  return html`<span
      class=${busy ? "task-detail-action-icon is-busy" : "task-detail-action-icon"}
      aria-hidden="true"
    >${inlineIcon(busy ? "LoaderCircle" : icon, "", "task-detail-action-svg")}</span>
    <span>${label}</span>`;
}

function actionErrorMessage(error: Error | null) {
  return error ? `${error.message ?? error}` : "";
}

function forkDisabledReason(snapshot: TaskInfoActionsSnapshot) {
  if (!snapshot.canonicalTaskAvailable) {
    return "Fork is unavailable until Task details load.";
  }
  if (!["codex", "claude", "grok"].includes(snapshot.provider ?? "")) {
    return "Fork is available for Codex, Claude and Grok Tasks.";
  }
  if (isTaskTransportStale(snapshot.transportState)) {
    return "Fork is unavailable while the Task connection is interrupted.";
  }
  if (snapshot.archiveState.loading) {
    return "Another Task action is in progress.";
  }
  if (taskThreadStatusType(snapshot.task) !== "idle") {
    return "Fork is available when the Task is idle.";
  }
  return "";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-info-actions": CaffoldTaskDetailInfoActions;
  }

  interface HTMLElementEventMap {
    "caffold:task-detail-info-action-intent": CustomEvent<TaskInfoActionIntent>;
  }
}
