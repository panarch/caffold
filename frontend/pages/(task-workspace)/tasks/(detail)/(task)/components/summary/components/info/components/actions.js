import {
  isTaskTransportStale,
  taskThreadStatusType,
} from "../../../../../../../runtime-state.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../../../../../action-hints.js";
import { taskThreadId } from "../../../../../../../task-list-model.js";

/** The approval mode Caffold answers under, which is the one Jev judges for. */
const REVIEWED_PERMISSION_MODE = "caffold:ask-jev-first";

class CaffoldTaskDetailInfoActions extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
    }
    if (!this.actionButton("fork")) {
      this.render();
    } else {
      this.patch();
    }
  }

  disconnectedCallback() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = normalizedSnapshot();
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    this.snapshot = normalizedSnapshot(snapshot);
    if (!this.actionButton("fork")) {
      this.render();
      return;
    }
    this.patch();
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-task-info-action]");
    if (!action || action.matches(":disabled")) {
      return;
    }
    const type = `${action.dataset.taskInfoAction ?? ""}`;
    if (!["archive", "fork", "permission-instructions"].includes(type)) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-info-action-intent", {
        bubbles: true,
        composed: true,
        detail: { type },
      }),
    );
  }

  render() {
    this.innerHTML = `
      <div
        class="task-detail-task-action task-detail-permission-instructions-action"
        data-task-info-permission-instructions
        hidden
      >
        <p>This Task keeps what your own prompts say it may and may not do, for Jev to read when it answers a permission request here.</p>
        <button
          type="button"
          class="task-secondary-button"
          data-task-info-action="permission-instructions"
        >What your prompts settled</button>
      </div>
      <div class="task-detail-task-action task-detail-fork-action">
        <p>Create a new Task at the project root with this conversation's history. Files and worktrees are not copied.</p>
        <p class="task-detail-fork-availability" hidden></p>
        <button
          type="button"
          class="task-secondary-button"
          data-task-info-action="fork"
          disabled
        >Fork task</button>
        <p class="task-detail-action-error task-detail-fork-error" role="alert" hidden></p>
      </div>
      <div class="task-detail-task-action task-detail-archive-action">
        <p>Archive removes this task from the active list. If Caffold prepared its worktree, the worktree is removed and its branch is kept.</p>
        <button
          type="button"
          class="task-secondary-button"
          data-task-info-action="archive"
          disabled
        >Archive task</button>
        <p class="task-detail-action-error task-detail-archive-error" role="alert" hidden></p>
      </div>
    `;
    this.patch();
  }

  patch() {
    if (!this.snapshot.task) {
      return;
    }
    this.patchFork();
    this.patchArchive();
    this.patchPermissionInstructions();
  }

  patchPermissionInstructions() {
    const action = this.querySelector("[data-task-info-permission-instructions]");
    if (action) {
      action.hidden = !this.keepsPermissionInstructions();
    }
  }

  // The record is kept and read only under the reviewed mode, so the action
  // that opens it is offered under that mode and no other.
  keepsPermissionInstructions() {
    return this.snapshot.permissionMode === REVIEWED_PERMISSION_MODE;
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    const threadId = taskThreadId(this.snapshot.task);
    if (!scopeId || !threadId) {
      return emptyActionHintScope();
    }
    const actionIds = {
      fork: ACTION_HINT_ACTION.TASK_FORK,
      archive: ACTION_HINT_ACTION.TASK_ARCHIVE,
      "permission-instructions": ACTION_HINT_ACTION.BUTTON_ACTIVATE,
    };
    const offered = (type) =>
      type !== "permission-instructions" || this.keepsPermissionInstructions();
    const targets = Object.keys(actionIds).flatMap((type) => {
      const control = this.actionButton(type);
      if (!control || control.disabled || !offered(type)) {
        return [];
      }
      const actionId = actionIds[type];
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:${threadId}:${type}`,
        actionId,
        label: control.textContent?.trim() || `${type} task`,
        control,
        clipRoots: [...clipRoots],
        badgeAtEnd: true,
        isActionable: () =>
          this.isConnected &&
          taskThreadId(this.snapshot.task) === threadId &&
          this.actionButton(type) === control &&
          control.dataset.taskInfoAction === type &&
          !control.disabled &&
          offered(type),
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  patchArchive() {
    const task = this.snapshot.task;
    const button = this.actionButton("archive");
    const error = this.querySelector(".task-detail-archive-error");
    if (!task || !button || !error) {
      return;
    }

    const loading = this.snapshot.archiveState.loading;
    button.disabled =
      loading ||
      this.snapshot.forkState.loading ||
      this.snapshot.archiveBlockedByActive;
    setText(button, loading ? "Archiving..." : "Archive task");

    const message = actionErrorMessage(this.snapshot.archiveState.error);
    setText(error, message);
    error.hidden = !message;
  }

  patchFork() {
    const task = this.snapshot.task;
    const button = this.actionButton("fork");
    const availability = this.querySelector(".task-detail-fork-availability");
    const error = this.querySelector(".task-detail-fork-error");
    if (!task || !button || !availability || !error) {
      return;
    }

    const loading = this.snapshot.forkState.loading;
    const disabledReason = forkDisabledReason(this.snapshot);
    button.disabled = loading || Boolean(disabledReason);
    setText(button, loading ? "Forking..." : "Fork task");
    if (loading) {
      button.removeAttribute("title");
    } else if (disabledReason) {
      setAttribute(button, "title", disabledReason);
    } else {
      button.removeAttribute("title");
    }
    setText(availability, loading ? "" : disabledReason);
    availability.hidden = loading || !disabledReason;

    const message = actionErrorMessage(this.snapshot.forkState.error);
    setText(error, message);
    error.hidden = !message;
  }

  actionButton(type) {
    return this.querySelector(`[data-task-info-action="${type}"]`);
  }
}

if (!customElements.get("caffold-task-detail-info-actions")) {
  customElements.define(
    "caffold-task-detail-info-actions",
    CaffoldTaskDetailInfoActions,
  );
}

function normalizedSnapshot(snapshot = {}) {
  return {
    task: snapshot.task ?? null,
    canonicalTaskAvailable: Boolean(snapshot.canonicalTaskAvailable),
    archiveBlockedByActive: Boolean(snapshot.archiveBlockedByActive),
    transportState: snapshot.transportState ?? "idle",
    provider: `${snapshot.provider ?? ""}`,
    permissionMode: `${snapshot.permissionMode ?? ""}`,
    archiveState: {
      loading: Boolean(snapshot.archiveState?.loading),
      error: snapshot.archiveState?.error ?? null,
    },
    forkState: {
      loading: Boolean(snapshot.forkState?.loading),
      error: snapshot.forkState?.error ?? null,
    },
  };
}

function actionErrorMessage(error) {
  return error ? `${error.message ?? error}` : "";
}

function forkDisabledReason(snapshot) {
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

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function setText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
