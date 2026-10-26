import { html, LitElement, nothing } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import {
  type ActiveTask,
  type ActiveTaskRecovery,
  type ActiveTaskTopPlacement,
  archiveRecoveryTask,
  recheckRecoveryTask,
  removeRecoveryTask,
  restoreRecoveryTask,
  restoreTask,
  type Task,
  type TaskAbsence,
  taskAbsence,
  taskAlreadyActive,
} from "#app/api.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "../components/task-absence.ts";
import type {
  CaffoldTaskAbsence,
  TaskAbsenceIntent,
} from "../components/task-absence.ts";
import { taskThreadId } from "../task-list-model.ts";

const REMOVAL_WARNING =
  "The Codex Thread could not be found. Caffold will remove its membership and managed Task resources. This cannot be undone.";
const BODY = ":scope > .task-recovery-view > .task-recovery-body";
const PENDING_LABELS: Record<string, string> = {
  restore: "Restoring Task…",
  archive: "Moving Task to Archived…",
  remove: "Removing Task from Caffold…",
  recheck: "Checking Task state…",
};

type RecoveryAction =
  | "restore"
  | "restore-archived"
  | "archive"
  | "remove"
  | "recheck";

// What the recovery screen tells the Tasks screen: the Task was checked
// again, or it is resolved and has a new place.
export type TaskRecoveryIntent =
  | { type: "rechecked"; recovery: ActiveTaskRecovery }
  | {
      type: "resolved";
      resolution: "restored";
      task: ActiveTask;
      activeTopPlacement: ActiveTaskTopPlacement;
    }
  | { type: "resolved"; resolution: "archived"; task: Task }
  | { type: "resolved"; resolution: "removed"; threadId: string };

/**
 * A listed Task Caffold cannot open as it is: why, and what can be done with
 * it, each action answered by the server.
 *
 * The Tasks screen opens it for a Task and reads its Action Hints and scroll
 * surface right after, so it draws at once.
 */
export class CaffoldTaskRecovery extends LitElement {
  private recovery: ActiveTaskRecovery | null = null;
  // Why the Task is no longer one to recover here: archived elsewhere, or
  // not found at all, as an action's answer said.
  private absence: TaskAbsence | null = null;
  private pendingAction: RecoveryAction | "" = "";
  private actionError: Error | null = null;
  private confirmingRemoval = false;
  private readonly iconsReady = () => this.requestUpdate();

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
  }

  prepare(recovery: ActiveTaskRecovery | null | undefined) {
    this.recovery = recovery ?? null;
    this.absence = null;
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
    this.draw();
  }

  updateRecovery(recovery: ActiveTaskRecovery | null | undefined) {
    const previous = this.recovery;
    this.recovery = recovery ?? null;
    if (sameRecoveryPresentation(previous, this.recovery)) {
      return;
    }
    this.absence = null;
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
    this.draw();
  }

  deactivate() {
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
  }

  actionHintScope({
    scopeId = "task-recovery",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const notice = this.absenceNotice();
    if (notice) {
      return notice.actionHintScope({
        scopeId: `${scopeId}:${taskThreadId(this.recovery)}:absence`,
        clipRoots: [this, ...clipRoots],
      });
    }
    const scrollport = this.querySelector(BODY);
    const threadId = taskThreadId(this.recovery);
    if (this.hidden || !scrollport || !threadId) {
      return emptyActionHintScope();
    }
    const targets = [
      ...this.querySelectorAll<HTMLButtonElement>(
        "button[data-task-recovery-action]",
      ),
    ].flatMap((control) => {
      const action = `${control.dataset.taskRecoveryAction ?? ""}`;
      if (!action || control.disabled || !hasActionHintLayoutBox(control)) {
        return [];
      }
      const selector = `button[data-task-recovery-action="${action}"]`;
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${threadId}:${action}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label:
            control.getAttribute("aria-label") ||
            control.textContent?.trim() ||
            action,
          control,
          clipRoots: [this, scrollport, ...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            taskThreadId(this.recovery) === threadId &&
            this.querySelector(selector) === control &&
            !control.disabled &&
            hasActionHintLayoutBox(control),
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "task-recovery",
    label = "Task recovery",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    this.performUpdate();
    const scrollport = this.querySelector(BODY);
    const threadId = taskThreadId(this.recovery);
    if (this.hidden || !scrollport || !threadId) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:${threadId}:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            taskThreadId(this.recovery) === threadId &&
            this.querySelector(BODY) === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    const recovery = this.recovery;
    if (recovery && this.absence) {
      return html`<caffold-task-absence
        @caffold:task-absence-intent=${this.absenceIntent}
      ></caffold-task-absence>`;
    }
    if (!recovery) {
      return html`
        <section class="task-recovery-view" aria-label="Task recovery">
          <header class="task-recovery-header">
            <h2>Task recovery</h2>
          </header>
          <div class="task-recovery-body">
            <p class="task-recovery-loading"><caffold-loading-text
              >Checking recovery state…</caffold-loading-text
            ></p>
          </div>
        </section>
      `;
    }
    const copy = recoveryCopy(
      recovery.recovery?.reason ?? "temporarilyUnavailable",
    );
    const actions = new Set<string>(recovery.recovery?.actions ?? ["recheck"]);
    const busy = Boolean(this.pendingAction);
    const pendingLabel = PENDING_LABELS[this.pendingAction] ?? "";
    const controls = this.confirmingRemoval
      ? html`<div class="task-recovery-removal-confirmation" role="alert">
          <strong>Remove this Task from Caffold?</strong>
          <p>${REMOVAL_WARNING}</p>
          <div class="task-recovery-confirmation-actions">
            <button
              type="button"
              class="task-secondary-button"
              data-task-recovery-action="cancel-remove"
              ?disabled=${busy}
              @click=${this.takeAction}
            >Cancel</button>
            <button
              type="button"
              class="task-secondary-button task-recovery-remove-button"
              data-task-recovery-action="confirm-remove"
              ?disabled=${busy}
              @click=${this.takeAction}
            >Remove Task</button>
          </div>
        </div>`
      : html`<div class="task-recovery-action-row">
          <div class="task-recovery-resolution-actions">
            ${
              actions.has("restoreToActive")
                ? html`<button
                    type="button"
                    class="task-secondary-button"
                    data-task-recovery-action="restore"
                    ?disabled=${busy}
                    @click=${this.takeAction}
                  >
                    ${actionIcon(
                      "restore",
                      "ArchiveRestore",
                      "Restore to Active",
                    )}
                    <span>Restore to Active</span>
                  </button>`
                : nothing
            }
            ${
              actions.has("moveToArchived")
                ? html`<button
                    type="button"
                    class="task-secondary-button"
                    data-task-recovery-action="archive"
                    ?disabled=${busy}
                    @click=${this.takeAction}
                  >
                    ${actionIcon("archive", "Archive", "Move to Archived")}
                    <span>Move to Archived</span>
                  </button>`
                : nothing
            }
            ${
              actions.has("removeFromCaffold")
                ? html`<button
                    type="button"
                    class="task-secondary-button task-recovery-remove-button"
                    data-task-recovery-action="remove"
                    ?disabled=${busy}
                    @click=${this.takeAction}
                  >
                    ${actionIcon("remove", "Trash2", "Remove from Caffold")}
                    <span>Remove from Caffold</span>
                  </button>`
                : nothing
            }
          </div>
          ${
            actions.has("recheck")
              ? html`<button
                  type="button"
                  class="task-recovery-recheck-button"
                  data-task-recovery-action="recheck"
                  ?disabled=${busy}
                  @click=${this.takeAction}
                >
                  ${actionIcon("recheck", "RefreshCw", "Recheck Task")}
                  <span>Recheck</span>
                </button>`
              : nothing
          }
        </div>`;
    return html`
      <section
        class="task-recovery-view"
        aria-labelledby="task-recovery-task-title"
      >
        <header class="task-recovery-header">
          <h2 id="task-recovery-task-title">${
            recovery.title ?? "Unavailable Task"
          }</h2>
        </header>
        <div class="task-recovery-body">
          <div class="task-recovery-content">
            <div class="task-recovery-heading">
              <span
                class="task-recovery-icon-slot"
                data-task-recovery-icon="warning"
              >${inlineIcon(
                "TriangleAlert",
                "Task recovery",
                "task-recovery-icon",
              )}</span>
              <h3>${copy.title}</h3>
            </div>
            <div class="task-recovery-description">${copy.messages.map(
              (message) => html`<p>${message}</p>`,
            )}</div>
            ${controls}
            <div class="task-recovery-feedback" aria-live="polite">
              ${
                pendingLabel
                  ? html`<p class="task-recovery-progress" role="status">${
                      pendingLabel
                    }</p>`
                  : nothing
              }
              ${
                this.actionError
                  ? html`<p class="task-recovery-error" role="alert">${
                      this.actionError.message
                    }</p>`
                  : nothing
              }
            </div>
            <div class="task-recovery-thread">
              <span>Thread</span>
              <code>${taskThreadId(recovery)}</code>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  private takeAction(event: Event) {
    if (this.pendingAction) {
      return;
    }
    const type = (event.currentTarget as HTMLButtonElement).dataset
      .taskRecoveryAction;
    if (type === "recheck") {
      void this.recheck();
    } else if (type === "restore") {
      void this.restore();
    } else if (type === "archive") {
      void this.archive();
    } else if (type === "remove") {
      this.confirmingRemoval = true;
      this.actionError = null;
      this.draw();
    } else if (type === "cancel-remove") {
      this.confirmingRemoval = false;
      this.draw();
    } else if (type === "confirm-remove") {
      void this.removeTask();
    }
  }

  private absenceIntent(event: CustomEvent<TaskAbsenceIntent>) {
    event.stopPropagation();
    if (event.detail?.type === "restore") {
      void this.restoreArchived();
    }
  }

  private dispatchIntent(intent: TaskRecoveryIntent) {
    this.dispatchEvent(
      new CustomEvent<TaskRecoveryIntent>("caffold:task-recovery-intent", {
        bubbles: true,
        composed: true,
        detail: intent,
      }),
    );
  }

  private async restore() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("restore", async () => {
      const response = await restoreRecoveryTask(threadId);
      if (!response?.task || !response?.activeTopPlacement) {
        throw new Error("Recovered Task response is incomplete.");
      }
      this.dispatchIntent({
        type: "resolved",
        resolution: "restored",
        task: response.task,
        activeTopPlacement: response.activeTopPlacement,
      });
    });
  }

  // Restore from the notice of a Task archived elsewhere. One restored
  // elsewhere meanwhile is back to the recovery it needed.
  private async restoreArchived() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId || this.pendingAction) {
      return;
    }
    await this.runAction("restore-archived", async () => {
      const response = await restoreTask(threadId);
      if (!response?.task || !response?.activeTopPlacement) {
        throw new Error("Restored Task response is incomplete.");
      }
      this.dispatchIntent({
        type: "resolved",
        resolution: "restored",
        task: response.task,
        activeTopPlacement: response.activeTopPlacement,
      });
    });
  }

  private async recheck() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("recheck", async () => {
      const recovery = await recheckRecoveryTask(threadId);
      if (!recovery?.recovery) {
        throw new Error("Rechecked Task response is missing recovery state.");
      }
      this.dispatchIntent({ type: "rechecked", recovery });
    });
  }

  private async archive() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("archive", async () => {
      const task = await archiveRecoveryTask(threadId);
      if (!task) {
        throw new Error("Archived Task response is missing its Task.");
      }
      this.dispatchIntent({ type: "resolved", resolution: "archived", task });
    });
  }

  private async removeTask() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("remove", async () => {
      await removeRecoveryTask(threadId);
      this.dispatchIntent({
        type: "resolved",
        resolution: "removed",
        threadId,
      });
    });
  }

  private async runAction(
    action: RecoveryAction,
    callback: () => Promise<void>,
  ) {
    this.pendingAction = action;
    this.actionError = null;
    this.draw();
    try {
      await callback();
    } catch (error) {
      const absence = taskAbsence(error);
      if (absence) {
        this.absence = absence;
      } else if (action === "restore-archived" && taskAlreadyActive(error)) {
        this.absence = null;
      } else {
        this.actionError =
          error instanceof Error ? error : new Error(`${error}`);
      }
    } finally {
      this.pendingAction = "";
      this.draw();
    }
  }

  // The notice of an absent Task is told what to show once it is drawn.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    const absence = this.absence;
    if (absence) {
      this.absenceNotice()?.setSnapshot({
        absence,
        title: this.recovery?.title,
        restoring: this.pendingAction === "restore-archived",
        error: this.actionError,
      });
    }
  }

  private absenceNotice() {
    return this.querySelector<CaffoldTaskAbsence>(
      ":scope > caffold-task-absence",
    );
  }
}

customElements.define("caffold-task-recovery", CaffoldTaskRecovery);

function actionIcon(key: string, name: string, label: string) {
  return html`<span
    class="task-recovery-action-icon-slot"
    data-task-recovery-icon=${key}
  >${inlineIcon(name, label, "task-action-icon")}</span>`;
}

function sameRecoveryPresentation(
  left: ActiveTaskRecovery | null,
  right: ActiveTaskRecovery | null,
) {
  const leftActions = left?.recovery?.actions ?? [];
  const rightActions = right?.recovery?.actions ?? [];
  return (
    taskThreadId(left) === taskThreadId(right) &&
    left?.title === right?.title &&
    left?.recovery?.reason === right?.recovery?.reason &&
    leftActions.length === rightActions.length &&
    leftActions.every((action, index) => action === rightActions[index])
  );
}

function recoveryCopy(reason: string) {
  return (
    {
      codexArchived: {
        title: "Archived in Codex",
        messages: [
          "This Task is still Active in Caffold.",
          "Restore it, or move it to Archived here as well.",
        ],
      },
      threadMissing: {
        title: "Thread unavailable",
        messages: [
          "Caffold still has this Task.",
          "Its Codex Thread could not be found.",
        ],
      },
      sectionPlacementPending: {
        title: "Section placement is pending",
        messages: [
          "This Task remains available.",
          "Caffold will retry its Section placement.",
        ],
      },
      temporarilyUnavailable: {
        title: "Recovery temporarily unavailable",
        messages: [
          "Caffold could not confirm this Task's current Codex state.",
          "Recheck when Codex is available.",
        ],
      },
    }[reason] ?? {
      title: "Recovery required",
      messages: [
        "This Task remains visible.",
        "Caffold will keep trying to reconcile its Codex state.",
      ],
    }
  );
}
