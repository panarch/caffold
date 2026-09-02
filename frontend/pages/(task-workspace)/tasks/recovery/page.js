import {
  archiveRecoveryTask,
  recheckRecoveryTask,
  removeRecoveryTask,
  restoreRecoveryTask,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { taskThreadId } from "../task-list-model.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";

class CaffoldTaskRecovery extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.recovery = null;
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.render();
    warmIcons();
  }

  prepare(recovery) {
    this.ensureState();
    this.recovery = recovery ?? null;
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
    this.render();
  }

  updateRecovery(recovery) {
    this.ensureState();
    this.recovery = recovery ?? null;
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
    this.render();
  }

  deactivate() {
    this.pendingAction = "";
    this.actionError = null;
    this.confirmingRemoval = false;
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-task-recovery-action]")
      : null;
    if (!action || !this.contains(action) || this.pendingAction) {
      return;
    }
    const type = action.dataset.taskRecoveryAction;
    if (type === "recheck") {
      void this.recheck();
    } else if (type === "restore") {
      void this.restore();
    } else if (type === "archive") {
      void this.archive();
    } else if (type === "remove") {
      this.confirmingRemoval = true;
      this.actionError = null;
      this.render();
    } else if (type === "cancel-remove") {
      this.confirmingRemoval = false;
      this.render();
    } else if (type === "confirm-remove") {
      void this.remove();
    }
  }

  dispatchIntent(type, detail = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-recovery-intent", {
        bubbles: true,
        composed: true,
        detail: { type, ...detail },
      }),
    );
  }

  async restore() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("restore", async () => {
      const response = await restoreRecoveryTask(threadId);
      if (!response?.task || !response?.activeTopPlacement) {
        throw new Error("Recovered Task response is incomplete.");
      }
      this.dispatchIntent("resolved", {
        resolution: "restored",
        task: response.task,
        activeTopPlacement: response.activeTopPlacement,
      });
    });
  }

  async recheck() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("recheck", async () => {
      const recovery = await recheckRecoveryTask(threadId);
      if (!recovery?.recovery) {
        throw new Error("Rechecked Task response is missing recovery state.");
      }
      this.dispatchIntent("rechecked", { recovery });
    });
  }

  async archive() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("archive", async () => {
      const task = await archiveRecoveryTask(threadId);
      if (!task) {
        throw new Error("Archived Task response is missing its Task.");
      }
      this.dispatchIntent("resolved", { resolution: "archived", task });
    });
  }

  async remove() {
    const threadId = taskThreadId(this.recovery);
    if (!threadId) {
      return;
    }
    await this.runAction("remove", async () => {
      await removeRecoveryTask(threadId);
      this.dispatchIntent("resolved", { resolution: "removed", threadId });
    });
  }

  async runAction(action, callback) {
    this.pendingAction = action;
    this.actionError = null;
    this.render();
    try {
      await callback();
    } catch (error) {
      this.actionError = error instanceof Error ? error : new Error(`${error}`);
    } finally {
      this.pendingAction = "";
      this.render();
    }
  }

  actionHintScope({
    scopeId = "task-recovery",
    clipRoots = [],
  } = {}) {
    this.ensureState();
    const scrollport = this.querySelector(
      ":scope > .task-recovery-view > .task-recovery-body",
    );
    const threadId = taskThreadId(this.recovery);
    if (this.hidden || !scrollport || !threadId) {
      return emptyActionHintScope();
    }
    const targets = Array.from(this.querySelectorAll(
      "button[data-task-recovery-action]",
    )).flatMap((control) => {
      const action = `${control.dataset.taskRecoveryAction ?? ""}`;
      if (!action || control.disabled || !hasActionHintLayoutBox(control)) {
        return [];
      }
      const selector =
        `button[data-task-recovery-action="${action}"]`;
      return [buttonActionHintTarget({
        id: `${scopeId}:${threadId}:${action}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          action,
        control,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          taskThreadId(this.recovery) === threadId &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          hasActionHintLayoutBox(control),
      })];
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
  } = {}) {
    this.ensureState();
    const scrollport = this.querySelector(
      ":scope > .task-recovery-view > .task-recovery-body",
    );
    const threadId = taskThreadId(this.recovery);
    if (this.hidden || !scrollport || !threadId) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:${threadId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          taskThreadId(this.recovery) === threadId &&
          this.querySelector(
            ":scope > .task-recovery-view > .task-recovery-body",
          ) === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    this.ensureState();
    const recovery = this.recovery;
    if (!recovery) {
      this.innerHTML = `
        <section class="task-recovery-view" aria-label="Task recovery">
          <header class="task-recovery-header">
            <h2>Task recovery</h2>
          </header>
          <div class="task-recovery-body">
            <p class="task-recovery-loading" role="status">Checking recovery state…</p>
          </div>
        </section>
      `;
      return;
    }
    const reason = recovery?.recovery?.reason ?? "temporarilyUnavailable";
    const copy = recoveryCopy(reason);
    const actions = new Set(recovery?.recovery?.actions ?? ["recheck"]);
    const busy = Boolean(this.pendingAction);
    const pendingLabel = {
      restore: "Restoring Task…",
      archive: "Moving Task to Archived…",
      remove: "Removing Task from Caffold…",
      recheck: "Checking Task state…",
    }[this.pendingAction] ?? "";
    this.innerHTML = `
      <section class="task-recovery-view" aria-labelledby="task-recovery-task-title">
        <header class="task-recovery-header">
          <h2 id="task-recovery-task-title">${escapeHtml(recovery.title ?? "Unavailable Task")}</h2>
        </header>
        <div class="task-recovery-body">
          <div class="task-recovery-content">
            <div class="task-recovery-heading">
              <span class="task-recovery-icon-slot">
                ${renderInlineIcon("TriangleAlert", "Task recovery", "task-recovery-icon")}
              </span>
              <h3>${escapeHtml(copy.title)}</h3>
            </div>
            <div class="task-recovery-description">
              ${copy.messages.map((message) => `<p>${escapeHtml(message)}</p>`).join("")}
            </div>
            ${this.confirmingRemoval ? this.renderRemovalConfirmation(busy) : this.renderActions(actions, busy)}
            <div class="task-recovery-feedback" aria-live="polite">
              ${pendingLabel ? `<p class="task-recovery-progress" role="status">${escapeHtml(pendingLabel)}</p>` : ""}
              ${this.actionError ? `<p class="task-recovery-error" role="alert">${escapeHtml(this.actionError.message)}</p>` : ""}
            </div>
            <div class="task-recovery-thread">
              <span>Thread</span>
              <code>${escapeHtml(taskThreadId(recovery))}</code>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  renderActions(actions, busy) {
    return `
      <div class="task-recovery-action-row">
        <div class="task-recovery-resolution-actions">
          ${actions.has("restoreToActive") ? `<button type="button" class="task-secondary-button" data-task-recovery-action="restore" ${busy ? "disabled" : ""}>${renderInlineIcon("ArchiveRestore", "Restore to Active", "task-action-icon")}<span>Restore to Active</span></button>` : ""}
          ${actions.has("moveToArchived") ? `<button type="button" class="task-secondary-button" data-task-recovery-action="archive" ${busy ? "disabled" : ""}>${renderInlineIcon("Archive", "Move to Archived", "task-action-icon")}<span>Move to Archived</span></button>` : ""}
          ${actions.has("removeFromCaffold") ? `<button type="button" class="task-secondary-button task-recovery-remove-button" data-task-recovery-action="remove" ${busy ? "disabled" : ""}>${renderInlineIcon("Trash2", "Remove from Caffold", "task-action-icon")}<span>Remove from Caffold</span></button>` : ""}
        </div>
        ${actions.has("recheck") ? `<button type="button" class="task-recovery-recheck-button" data-task-recovery-action="recheck" ${busy ? "disabled" : ""}>${renderInlineIcon("RefreshCw", "Recheck Task", "task-action-icon")}<span>Recheck</span></button>` : ""}
      </div>
    `;
  }

  renderRemovalConfirmation(busy) {
    return `
      <div class="task-recovery-removal-confirmation" role="alert">
        <strong>Remove this Task from Caffold?</strong>
        <p>The Codex Thread could not be found. Caffold will remove its membership and managed Task resources. This cannot be undone.</p>
        <div class="task-recovery-confirmation-actions">
          <button type="button" class="task-secondary-button" data-task-recovery-action="cancel-remove" ${busy ? "disabled" : ""}>Cancel</button>
          <button type="button" class="task-secondary-button task-recovery-remove-button" data-task-recovery-action="confirm-remove" ${busy ? "disabled" : ""}>Remove Task</button>
        </div>
      </div>
    `;
  }
}

function recoveryCopy(reason) {
  return {
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
  };
}

if (!customElements.get("caffold-task-recovery")) {
  customElements.define("caffold-task-recovery", CaffoldTaskRecovery);
}
