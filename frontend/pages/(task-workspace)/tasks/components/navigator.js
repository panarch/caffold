import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import "../../components/workspace-brand.js";
import {
  taskStoreOperationsPresentation,
} from "../../codex-status.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "../../../../action-hints.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";
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
    this.addEventListener("keydown", this.boundKeydown);
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
    this.closeReorderPopover();
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("keydown", this.boundKeydown);
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
    this.taskOperations = taskStoreOperationsPresentation(null);
    this.lastPublishedListState = "";
    this.liveUpdates = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundKeydown = (event) => this.handleKeydown(event);
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

  actionHintScope() {
    this.ensureChildren();
    const scrollRoot = this.querySelector(":scope > .task-list-scroll");
    const primaryHeader = this.querySelector(
      ":scope > .task-list-primary-header",
    );
    const newTask = primaryHeader?.querySelector(
      ":scope .task-list-new-task[data-task-action='open-new']",
    );
    const targets = [];
    const reorderTarget = this.actionHintReorderTarget();
    if (reorderTarget) {
      targets.push(reorderTarget);
    }
    if (this.reorderMode === "none" && newTask) {
      targets.push({
        id: "task-create:global",
        actionId: "task.create",
        label: "Create a new task",
        invalidationOwner: this,
        controlKind: "button",
        control: newTask,
        anchor: newTask,
        clipRoots: [this],
        isActionable: () =>
          this.querySelector(
            ":scope > .task-list-primary-header .task-list-new-task[data-task-action='open-new']",
          ) === newTask &&
          !this.taskOperations.blocked &&
          !newTask.disabled,
        activate: () => newTask.click(),
      });
    }
    if (scrollRoot) {
      targets.push(...this.activeTaskList.actionHintTargets({
        clipRoots: [this, scrollRoot],
      }));
    }
    const ownScope = {
      blocked: false,
      targets,
      mutationRoots: [primaryHeader, this.activeTaskList].filter(Boolean),
      scrollRoots: [scrollRoot].filter(Boolean),
    };
    const archived = this.archivedTaskList;
    return mergeActionHintScopes(
      ownScope,
      this.reorderMode === "none" &&
          scrollRoot &&
          archived &&
          hasActionHintLayoutBox(archived)
        ? archived.actionHintScope({
            scopeId: "task-list:archived",
            clipRoots: [this, scrollRoot],
          })
        : null,
    );
  }

  actionHintReorderTarget() {
    const control = this.reorderButton;
    const popover = this.reorderPopover();
    if (!control || !popover) {
      return null;
    }
    const mode = this.reorderMode;
    const active = mode !== "none";
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: active
        ? `task-list:reorder:finish:${mode}`
        : "task-list:reorder:open",
      actionId: active
        ? ACTION_HINT_ACTION.REORDER_FINISH
        : ACTION_HINT_ACTION.REORDER_OPEN,
      label: control.getAttribute("aria-label") ||
        (active ? `Finish reordering ${mode}` : "Choose what to reorder"),
      control,
      clipRoots: [this],
      isActionable: () =>
        this.isConnected &&
        this.active &&
        !this.hidden &&
        this.reorderMode === mode &&
        this.reorderButton === control &&
        this.reorderPopover() === popover &&
        control.getAttribute("popovertarget") === popover.id &&
        !control.disabled &&
        (active || !popover.matches(":popover-open")),
    });
  }

  keyboardNavigationContexts() {
    this.ensureChildren();
    const popover = this.reorderPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = "task-list:reorder";
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: this.reorderActionHintScope({ contextId, popover }),
      },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "Reorder options",
          popover,
          isCurrent: () =>
            this.isConnected &&
            this.active &&
            !this.hidden &&
            this.reorderMode === "none" &&
            this.reorderPopover() === popover,
        }),
      },
    })];
  }

  reorderActionHintScope({ contextId, popover }) {
    if (!popover) {
      return emptyActionHintScope();
    }
    const targets = [...popover.querySelectorAll(
      ":scope > button[data-task-action='select-reorder-mode']",
    )].flatMap((control) => {
      const mode = `${control.dataset.reorderMode ?? ""}`;
      if (!["tasks", "sections"].includes(mode) || control.disabled) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${contextId}:${mode}`,
        actionId: ACTION_HINT_ACTION.REORDER_SELECT,
        label: control.textContent?.trim() || `Reorder ${mode}`,
        control,
        clipRoots: [popover],
        isActionable: () =>
          this.isConnected &&
          this.active &&
          !this.hidden &&
          this.reorderMode === "none" &&
          this.reorderPopover() === popover &&
          popover.matches(":popover-open") &&
          popover.contains(control) &&
          control.dataset.taskAction === "select-reorder-mode" &&
          control.dataset.reorderMode === mode &&
          !control.disabled,
      })];
    });
    return {
      blocked: this.reorderMode !== "none",
      targets,
      mutationRoots: [popover],
      scrollRoots: [popover],
    };
  }

  scrollSurfaceScope() {
    this.ensureChildren();
    const scrollport = this.querySelector(":scope > .task-list-scroll");
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: this.reorderMode !== "none",
      surfaces: [{
        id: "task-list",
        label: "Task list",
        scrollport,
        clipRoots: [this, scrollport],
        isEligible: () =>
          this.isConnected &&
          this.active &&
          !this.hidden &&
          this.reorderMode === "none" &&
          this.querySelector(":scope > .task-list-scroll") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this, this.activeTaskList, this.archivedTaskList].filter(
        Boolean,
      ),
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  setLiveUpdates(liveUpdates) {
    this.ensureChildren();
    this.liveUpdates = liveUpdates ?? null;
    this.activeTaskList.setLiveUpdates(this.liveUpdates);
  }

  get streamState() {
    return this.activeTaskList?.streamState ?? TASK_TRANSPORT_STATE.IDLE;
  }

  async activate({ force = false } = {}) {
    this.ensureState();
    this.render();
    this.active = true;
    const tasksRequest = this.activeTaskList.activate({ force });
    const archivedRequest = this.taskOperations.blocked
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
    this.closeReorderPopover();
    this.setReorderMode("none", options);
  }

  closeReorderPopover() {
    const popover = this.reorderPopover();
    if (!popover?.matches?.(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // A parent transition may already have detached the retained shell.
    }
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureChildren();
    // The store's own gate is the only one the whole navigator shares.
    // Codex being unready locks nothing here: rows open for reading, and a
    // new Task can always be started with the other agent.
    const presentation = taskStoreOperationsPresentation(snapshot);
    if (this.taskOperations.key === presentation.key) {
      return;
    }
    this.taskOperations = presentation;
    this.activeTaskList.setTaskOperations(presentation);
    this.archivedTaskList.setTaskOperations(presentation);
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
    if (this.taskOperations.blocked) {
      return;
    }
    if (action.dataset.taskAction === "open-new") {
      this.exitReorderMode({ restoreFocus: false });
      this.dispatchIntent("new-task");
    }
  }

  handleKeydown(event) {
    if (
      this.reorderMode === "none" ||
      event.defaultPrevented ||
      event.key !== "Escape" ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.exitReorderMode();
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
      selectedRecovery: active.selectedRecovery ?? null,
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
    this.activeTaskList.setTaskOperations(this.taskOperations);
    this.activeTaskList.setLiveUpdates(this.liveUpdates);
    this.activeTaskList.setReorderMode(this.reorderMode);
    this.archivedTaskList.setTaskOperations(this.taskOperations);
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
      newTaskButton.title = this.taskOperations.blocked
        ? this.taskOperations.title
        : "New Task";
      newTaskButton.disabled = this.taskOperations.blocked;
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
    const blocked = this.taskOperations.blocked;
    const title = blocked ? this.taskOperations.title : "New Task";
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
            <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
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

  reorderPopover() {
    return this.querySelector(
      `:scope > .task-list-primary-header #${this.reorderPopoverId}`,
    );
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
