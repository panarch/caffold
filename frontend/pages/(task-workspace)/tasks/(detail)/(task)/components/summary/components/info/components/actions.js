import {
  isTaskTransportStale,
  taskThreadStatusType,
} from "../../../../../../../runtime-state.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../../../action-hints.js";
import { taskThreadId } from "../../../../../../../task-list-model.js";

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
    if (!["archive", "fork"].includes(type)) {
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
        <p>Archive removes this task from the active list. Its worktree and files are retained.</p>
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
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    const threadId = taskThreadId(this.snapshot.task);
    if (!scopeId || !threadId) {
      return emptyActionHintScope();
    }
    const targets = ["fork", "archive"].flatMap((type) => {
      const control = this.actionButton(type);
      if (!control || control.disabled) {
        return [];
      }
      const actionId = type === "fork"
        ? ACTION_HINT_ACTION.TASK_FORK
        : ACTION_HINT_ACTION.TASK_ARCHIVE;
      return [buttonActionHintTarget({
        id: `${scopeId}:${threadId}:${type}`,
        actionId,
        label: control.textContent?.trim() || `${type} task`,
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          taskThreadId(this.snapshot.task) === threadId &&
          this.actionButton(type) === control &&
          control.dataset.taskInfoAction === type &&
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
      isTaskTransportStale(this.snapshot.transportState) ||
      taskThreadStatusType(task) === "active";
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
    transportState: snapshot.transportState ?? "idle",
    provider: `${snapshot.provider ?? ""}`,
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
