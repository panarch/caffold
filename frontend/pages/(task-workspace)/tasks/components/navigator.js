import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import "../../components/workspace-brand.js";
import {
  codexTaskOperationsPresentation,
} from "../../codex-status.js";
import {
  TASK_TRANSPORT_STATE,
} from "../runtime-state.js";
import { taskThreadId } from "../task-list-model.js";
import {
  ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT,
  ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT,
  ACTIVE_TASK_LIST_STATE_EVENT,
} from "./active-task-list.js";
import {
  ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT,
  ARCHIVED_TASK_RESTORED_EVENT,
  ARCHIVED_TASK_LIST_STATE_EVENT,
} from "./archived-task-list.js";

let taskNavigatorInstanceId = 0;

class CaffoldTaskNavigator extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.addEventListener(
      ACTIVE_TASK_LIST_STATE_EVENT,
      this.boundSectionStateChange,
    );
    this.addEventListener(
      ARCHIVED_TASK_LIST_STATE_EVENT,
      this.boundSectionStateChange,
    );
    this.addEventListener(
      ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT,
      this.boundInitialSettled,
    );
    this.addEventListener(
      ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT,
      this.boundInitialSettled,
    );
    this.addEventListener(
      ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT,
      this.boundArchiveSync,
    );
    this.addEventListener(
      ARCHIVED_TASK_RESTORED_EVENT,
      this.boundTaskRestored,
    );
    this.addEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTransportChange,
    );
    this.addEventListener(
      "caffold:active-task-list-focus-reorder-toggle",
      this.boundFocusReorderToggle,
    );
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
    if (this.active) {
      void this.activate({ force: true });
    }
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener(
      ACTIVE_TASK_LIST_STATE_EVENT,
      this.boundSectionStateChange,
    );
    this.removeEventListener(
      ARCHIVED_TASK_LIST_STATE_EVENT,
      this.boundSectionStateChange,
    );
    this.removeEventListener(
      ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT,
      this.boundInitialSettled,
    );
    this.removeEventListener(
      ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT,
      this.boundInitialSettled,
    );
    this.removeEventListener(
      ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT,
      this.boundArchiveSync,
    );
    this.removeEventListener(
      ARCHIVED_TASK_RESTORED_EVENT,
      this.boundTaskRestored,
    );
    this.removeEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTransportChange,
    );
    this.removeEventListener(
      "caffold:active-task-list-focus-reorder-toggle",
      this.boundFocusReorderToggle,
    );
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.closeStream();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.active = false;
    this.reorderMode = "none";
    taskNavigatorInstanceId += 1;
    this.reorderPopoverId = `task-list-reorder-${taskNavigatorInstanceId}`;
    this.codexTaskOperations = codexTaskOperationsPresentation(null);
    this.lastPublishedListState = "";
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.syncPrimaryHeader();
    this.boundSectionStateChange = (event) =>
      this.handleSectionStateChange(event);
    this.boundInitialSettled = (event) => this.handleInitialSettled(event);
    this.boundArchiveSync = (event) => this.handleArchiveSync(event);
    this.boundTaskRestored = (event) => this.handleTaskRestored(event);
    this.boundTransportChange = (event) => this.handleTransportChange(event);
    this.boundFocusReorderToggle = (event) => {
      event.stopPropagation();
      this.reorderButton?.focus();
    };
    warmIcons();
  }

  get activeTaskList() {
    return this.querySelector(
      ":scope > .task-list-scroll > caffold-active-task-list",
    );
  }

  get archivedTaskList() {
    return this.querySelector(
      ":scope > .task-list-scroll > caffold-archived-task-list",
    );
  }

  get reorderButton() {
    return this.querySelector(
      ":scope > .task-list-primary-header .task-list-reorder",
    );
  }

  get taskListStream() {
    return this.activeTaskList?.taskListStream ?? null;
  }

  get streamState() {
    return this.activeTaskList?.streamState ?? TASK_TRANSPORT_STATE.IDLE;
  }

  async activate({ force = false } = {}) {
    this.ensureState();
    this.render();
    this.active = true;
    const tasksRequest = this.activeTaskList.activate({ force });
    const archivedRequest = this.codexTaskOperations.blocked
      ? Promise.resolve(null)
      : this.archivedTaskList.activate({ force });
    const [tasks, archived] = await Promise.all([
      tasksRequest,
      archivedRequest,
    ]);
    if (
      this.active &&
      this.isConnected &&
      document.visibilityState === "visible"
    ) {
      this.activeTaskList.connectStream();
    }
    return { tasks, archived };
  }

  setSelectedThreadId(threadId) {
    this.setSelectedSubject(
      threadId ? { kind: "task", id: `${threadId}` } : null,
    );
  }

  setSelectedSubject(subject) {
    this.ensureChildren();
    this.activeTaskList.setSelectedSubject(subject);
  }

  upsertCanonicalTask(task) {
    this.ensureChildren();
    this.activeTaskList.upsertCanonicalTask(task);
  }

  placeCanonicalTaskAtTop(task, placement) {
    this.ensureChildren();
    this.activeTaskList.placeCanonicalTaskAtTop(task, placement);
  }

  acceptArchivedTask(task) {
    this.ensureChildren();
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.activeTaskList.removeTask(threadId);
    this.archivedTaskList.acceptTask(task);
  }

  restoreThread(threadId) {
    this.ensureChildren();
    return this.archivedTaskList.restoreThread(threadId);
  }

  deleteThread(threadId) {
    this.ensureChildren();
    return this.archivedTaskList.deleteThread(threadId);
  }

  loadTasks(options = {}) {
    this.ensureChildren();
    return this.activeTaskList.loadTasks(options);
  }

  loadArchived(options = {}) {
    this.ensureChildren();
    return this.archivedTaskList.loadArchived(options);
  }

  removeTask(threadId) {
    this.ensureChildren();
    this.activeTaskList.removeTask(threadId);
  }

  taskFor(threadId) {
    this.ensureChildren();
    return this.activeTaskList.taskFor(threadId);
  }

  sectionFor(sectionId) {
    this.ensureChildren();
    return this.activeTaskList.sectionFor(sectionId);
  }

  recoveryFor(threadId) {
    this.ensureChildren();
    return this.activeTaskList.recoveryFor(threadId);
  }

  removeArchivedTask(threadId) {
    this.ensureChildren();
    this.archivedTaskList.removeTask(threadId);
  }

  isTransportAvailable() {
    this.ensureChildren();
    return this.activeTaskList.isTransportAvailable();
  }

  retryStream() {
    this.ensureChildren();
    this.activeTaskList.retryStream();
  }

  setStreamState(state) {
    this.ensureChildren();
    this.activeTaskList.setStreamState(state);
  }

  closeStream() {
    this.activeTaskList?.closeStream();
  }

  suspendForeground() {
    this.activeTaskList?.suspendStream();
  }

  recoverForeground() {
    this.ensureChildren();
    return this.activeTaskList.recoverForeground();
  }

  setReorderMode(mode, { restoreFocus = true } = {}) {
    this.ensureChildren();
    const next = normalizeReorderMode(mode);
    if (this.reorderMode === next) {
      return;
    }
    const handleHadFocus = this.activeTaskList?.containsReorderFocus(
      document.activeElement,
    );
    const previous = this.reorderMode;
    this.reorderMode = next;
    this.dataset.reorderMode = next;
    this.activeTaskList.setReorderMode(next, {
      revealTasks: previous === "sections" && next === "none" && restoreFocus,
    });
    this.syncPrimaryHeader();
    if (next === "none" && restoreFocus && handleHadFocus) {
      queueMicrotask(() => this.reorderButton?.focus());
    }
  }

  exitReorderMode(options = {}) {
    this.setReorderMode("none", options);
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureChildren();
    const presentation = codexTaskOperationsPresentation(snapshot);
    if (this.codexTaskOperations.key === presentation.key) {
      return;
    }
    this.codexTaskOperations = presentation;
    this.activeTaskList.setCodexTaskOperations(presentation);
    this.archivedTaskList.setCodexTaskOperations(presentation);
    this.render();
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-task-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    if (action.dataset.taskAction === "toggle-reorder") {
      if (this.reorderMode !== "none") {
        event.preventDefault();
        this.setReorderMode("none");
      }
      return;
    }
    if (action.dataset.taskAction === "select-reorder-mode") {
      this.setReorderMode(action.dataset.reorderMode);
      return;
    }
    if (this.codexTaskOperations.blocked) {
      return;
    }
    if (action.dataset.taskAction === "open-new") {
      this.exitReorderMode({ restoreFocus: false });
      this.dispatchIntent("new-task");
    }
  }

  dispatchIntent(type, detail = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-navigator-intent", {
        bubbles: true,
        composed: true,
        detail: { type, ...detail },
      }),
    );
  }

  handleSectionStateChange(event) {
    if (
      event.target !== this.activeTaskList &&
      event.target !== this.archivedTaskList
    ) {
      return;
    }
    event.stopPropagation();
    this.publishListState();
  }

  handleInitialSettled(event) {
    event.stopPropagation();
    this.syncInitialPresentation();
    this.publishListState();
  }

  handleArchiveSync(event) {
    event.stopPropagation();
    const { action, threadId } = event.detail ?? {};
    if (action === "refresh") {
      void this.archivedTaskList.loadArchived({ force: true });
    } else if (action === "remove") {
      this.archivedTaskList.removeTask(threadId);
    }
  }

  handleTaskRestored(event) {
    event.stopPropagation();
    if (event.detail?.task) {
      this.activeTaskList.acceptTask(
        event.detail.task,
        event.detail.activeTopPlacement,
      );
    }
  }

  handleTransportChange(event) {
    if (event.target !== this.activeTaskList) {
      return;
    }
    this.archivedTaskList.setTransportState(event.detail?.state);
  }

  syncInitialPresentation() {
    const active = this.activeTaskList;
    const archived = this.archivedTaskList;
    if (!active || !archived) {
      return;
    }
    archived.setRevealed(
      active.initialRequestSettled && archived.initialRequestSettled,
    );
  }

  listState() {
    this.ensureChildren();
    const active = taskListState(this.activeTaskList);
    const archived = taskListState(this.archivedTaskList);
    return {
      count: active.count + archived.count,
      activeCount: active.count,
      activeError: active.error,
      archivedCount: archived.count,
      loaded: active.loaded && archived.loaded,
      loading: active.loading || archived.loading,
      error: active.error || archived.error,
      selectedSection: active.selectedSection ?? null,
    };
  }

  publishListState() {
    const detail = this.listState();
    const signature = JSON.stringify(detail);
    if (signature === this.lastPublishedListState) {
      return;
    }
    this.lastPublishedListState = signature;
    this.dispatchEvent(
      new CustomEvent("caffold:task-navigator-list-state", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  render() {
    this.ensureChildren();
    this.syncPrimaryHeader();
    this.syncInitialPresentation();
  }

  ensureChildren() {
    this.ensureState();
    this.ensureDom();
  }

  ensureDom() {
    if (
      this.querySelector(":scope > .task-list-primary-header") &&
      this.querySelector(":scope > .task-list-scroll")
    ) {
      return;
    }
    this.innerHTML = `
      ${this.renderPrimaryHeader()}
      <div class="task-list-scroll">
        <caffold-active-task-list></caffold-active-task-list>
        <caffold-archived-task-list hidden></caffold-archived-task-list>
      </div>
    `;
    this.activeTaskList.setCodexTaskOperations(this.codexTaskOperations);
    this.activeTaskList.setReorderMode(this.reorderMode);
    this.archivedTaskList.setCodexTaskOperations(this.codexTaskOperations);
  }

  syncPrimaryHeader() {
    const newTaskButton = this.querySelector(
      ":scope > .task-list-primary-header .task-list-new-task",
    );
    if (newTaskButton) {
      syncHeaderActionIcon(
        newTaskButton,
        "Plus",
        "New task",
      );
      newTaskButton.title = this.codexTaskOperations.blocked
        ? this.codexTaskOperations.title
        : "New Task";
      newTaskButton.disabled = this.codexTaskOperations.blocked;
    }
    const reorderButton = this.reorderButton;
    if (reorderButton) {
      const active = this.reorderMode !== "none";
      const modeLabel = this.reorderMode === "sections" ? "Sections" : "Tasks";
      syncHeaderActionIcon(
        reorderButton,
        "ArrowDownUp",
        "Reorder tasks",
      );
      reorderButton.setAttribute("aria-pressed", `${active}`);
      reorderButton.setAttribute("aria-label", active
        ? `Finish reordering ${modeLabel}`
        : "Choose what to reorder");
      reorderButton.title = active
        ? `Finish reordering ${modeLabel}`
        : "Reorder";
      reorderButton.setAttribute("popovertarget", this.reorderPopoverId);
    }
  }

  renderPrimaryHeader() {
    const blocked = this.codexTaskOperations.blocked;
    const title = blocked ? this.codexTaskOperations.title : "New Task";
    return `
      <header class="task-list-section-header task-list-primary-header">
        <caffold-workspace-brand></caffold-workspace-brand>
        <span class="task-list-primary-actions">
          <button
            type="button"
            class="task-list-header-action task-list-reorder"
            data-task-action="toggle-reorder"
            aria-label="Choose what to reorder"
            aria-pressed="${this.reorderMode !== "none"}"
            title="Reorder"
            popovertarget="${this.reorderPopoverId}"
          >${renderInlineIcon("ArrowDownUp", "Reorder tasks", "task-action-icon")}</button>
          <div
            id="${this.reorderPopoverId}"
            class="task-list-reorder-popover"
            popover="auto"
            role="group"
            aria-label="Reorder options"
          >
            <button
              type="button"
              data-task-action="select-reorder-mode"
              data-reorder-mode="tasks"
              popovertarget="${this.reorderPopoverId}"
              popovertargetaction="hide"
            >Reorder Tasks</button>
            <button
              type="button"
              data-task-action="select-reorder-mode"
              data-reorder-mode="sections"
              popovertarget="${this.reorderPopoverId}"
              popovertargetaction="hide"
            >Reorder Sections</button>
          </div>
          <button
            type="button"
            class="task-list-header-action task-list-new-task"
            data-task-action="open-new"
            aria-label="New Task"
            title="${title}"
            ${blocked ? "disabled" : ""}
          >${renderInlineIcon("Plus", "New task", "task-action-icon")}</button>
        </span>
      </header>
    `;
  }

}

function normalizeReorderMode(mode) {
  if (mode === true) {
    return "tasks";
  }
  return ["tasks", "sections"].includes(mode) ? mode : "none";
}

function syncHeaderActionIcon(button, name, label) {
  if (button.querySelector(":scope > .task-action-icon")) {
    return;
  }
  const markup = renderInlineIcon(name, label, "task-action-icon");
  if (button.innerHTML !== markup) {
    button.innerHTML = markup;
  }
}

function taskListState(list) {
  if (typeof list?.listState === "function") {
    return list.listState();
  }
  return {
    count: 0,
    loaded: false,
    loading: true,
    error: "",
  };
}

if (!customElements.get("caffold-task-navigator")) {
  customElements.define("caffold-task-navigator", CaffoldTaskNavigator);
}
