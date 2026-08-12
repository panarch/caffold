import {
  deleteTask,
  getArchivedTasks,
  getTasks,
  restoreTask,
  taskListStreamUrl,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import "../../components/workspace-brand.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
  taskStatusView,
  taskThreadStatusType,
} from "../runtime-state.js";
import { formatRelativeAge } from "../task-format.js";
import {
  groupTasksByRepository,
  mergeTaskListPage,
  sortTasksByRecency,
  taskRepositoryKey,
  taskThreadId,
  taskWorktreeLabel,
  upsertTask,
} from "../task-list-model.js";
import { TaskStreamLifecycle } from "../stream.js";
import {
  patchTaskStatusChip,
  renderTaskStatusChip,
} from "./task-status.js";
import "./task-transport-overlay.js";

const UNSEEN_ATTENTION_PHASE_COUNT = 8;
const UNSEEN_ATTENTION_PHASE_INTERVAL_MS = 300;
const TASK_RUNNING_SPINNER_DURATION_MS = 800;

class CaffoldTaskNavigator extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
    if (this.active) {
      void this.activate({ force: true });
    }
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.taskListRequestId += 1;
    this.archivedTaskRequestId += 1;
    this.taskListLoading = false;
    this.taskListLoadingMore = false;
    this.archivedTaskLoading = false;
    this.archivedTaskLoadingMore = false;
    this.closeStream();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.tasks = [];
    this.taskListLoading = false;
    this.taskListLoadingMore = false;
    this.taskListLoaded = false;
    this.taskListError = null;
    this.taskListLoadMoreError = null;
    this.taskListNextCursor = null;
    this.taskListRequestId = 0;
    this.archivedTasks = [];
    this.archivedTaskLoading = false;
    this.archivedTaskLoadingMore = false;
    this.archivedTaskLoaded = false;
    this.archivedTaskError = null;
    this.archivedTaskLoadMoreError = null;
    this.archivedTaskNextCursor = null;
    this.archivedTaskRequestId = 0;
    this.restoringThreadIds = new Set();
    this.restoreErrors = new Map();
    this.deletingThreadIds = new Set();
    this.deleteErrors = new Map();
    this.selectedThreadId = "";
    this.revisionByThread = new Map();
    this.active = false;
    this.lastPublishedListState = "";
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.render();
    this.taskListStream = new TaskStreamLifecycle({
      createUrl: () => taskListStreamUrl(),
      eventTypes: ["task-removed", "task-updated", "task-sync"],
      onEvent: (type, event) => this.handleStreamEvent(type, event),
      onReconcile: (_contextKey, isCurrent) =>
        this.reconcileTaskList(isCurrent),
      onStateChange: (state, previousState) =>
        this.handleStreamStateChange(state, previousState),
    });
    warmIcons();
  }

  async activate({ force = false } = {}) {
    this.ensureState();
    this.active = true;
    const [tasks, archived] = await Promise.all([
      this.loadTasks({ force }),
      this.loadArchived({ force }),
    ]);
    if (
      this.active &&
      this.isConnected &&
      document.visibilityState === "visible"
    ) {
      this.connectStream();
    }
    return { tasks, archived };
  }

  setSelectedThreadId(threadId) {
    this.ensureState();
    const nextThreadId = `${threadId ?? ""}`;
    if (this.selectedThreadId === nextThreadId) {
      return;
    }
    this.selectedThreadId = nextThreadId;
    this.syncSelection();
    if (nextThreadId) {
      const task = this.tasks.find((candidate) => taskThreadId(candidate) === nextThreadId);
      if (task?.unseen) {
        this.upsertCanonicalTask({ ...task, unseen: false });
      }
    }
  }

  upsertCanonicalTask(task) {
    this.ensureState();
    if (!task || !this.taskListLoaded) {
      return;
    }
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    const nextTask =
      threadId === this.selectedThreadId ? { ...task, unseen: false } : task;
    const index = this.tasks.findIndex((candidate) => taskThreadId(candidate) === threadId);
    if (index < 0) {
      this.tasks = [...this.tasks, nextTask];
      this.render();
      return;
    }

    const previous = this.tasks[index];
    this.tasks = this.tasks.map((candidate, candidateIndex) =>
      candidateIndex === index ? nextTask : candidate,
    );
    const previousListKey = taskRepositoryKey(previous);
    const nextListKey = taskRepositoryKey(nextTask);
    const row = this.querySelector(
      `li[data-thread-id="${CSS.escape(threadId)}"]`,
    );
    if (!row || previousListKey !== nextListKey) {
      this.render();
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = this.renderTaskRow(nextTask, nextListKey).trim();
    const nextRow = template.content.firstElementChild;
    if (!nextRow || !patchTaskListRow(row, nextRow)) {
      this.render();
      return;
    }
    this.syncSelection();
    this.reorderTaskListDom();
  }

  acceptArchivedTask(task) {
    this.ensureState();
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.tasks = this.tasks.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
    this.archivedTasks = upsertTask(this.archivedTasks, task);
    this.archivedTaskLoaded = true;
    this.revisionByThread.delete(threadId);
    this.render();
  }

  async restoreThread(threadId) {
    this.ensureState();
    if (
      !threadId ||
      this.restoringThreadIds.has(threadId) ||
      this.deletingThreadIds.has(threadId) ||
      isTaskTransportStale(this.streamState)
    ) {
      return null;
    }
    this.restoringThreadIds.add(threadId);
    this.restoreErrors.delete(threadId);
    this.archivedTaskError = null;
    this.render();
    try {
      const task = await restoreTask(threadId);
      this.archivedTasks = this.archivedTasks.filter(
        (candidate) => taskThreadId(candidate) !== threadId,
      );
      this.tasks = upsertTask(this.tasks, task);
      this.taskListLoaded = true;
      this.render();
      return task;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(`${error}`);
      this.archivedTaskError = normalized;
      this.restoreErrors.set(threadId, normalized);
      this.render();
      return null;
    } finally {
      this.restoringThreadIds.delete(threadId);
      this.render();
    }
  }

  async deleteThread(threadId) {
    this.ensureState();
    if (
      !threadId ||
      this.deletingThreadIds.has(threadId) ||
      this.restoringThreadIds.has(threadId) ||
      isTaskTransportStale(this.streamState)
    ) {
      return null;
    }
    this.deletingThreadIds.add(threadId);
    this.deleteErrors.delete(threadId);
    this.render();
    try {
      const response = await deleteTask(threadId);
      this.removeArchivedTask(threadId);
      return response;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(`${error}`);
      this.deleteErrors.set(threadId, normalized);
      this.render();
      return null;
    } finally {
      this.deletingThreadIds.delete(threadId);
      this.render();
    }
  }

  isTransportAvailable() {
    this.ensureState();
    return !isTaskTransportStale(this.streamState);
  }

  retryStream() {
    this.ensureState();
    this.taskListStream.retry();
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-task-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const threadId = `${action.dataset.threadId ?? ""}`;
    if (action.dataset.taskAction === "open-task") {
      this.dispatchIntent("select-task", { threadId });
    } else if (action.dataset.taskAction === "open-new") {
      this.dispatchIntent("new-task");
    } else if (action.dataset.taskAction === "load-more-tasks") {
      void this.loadMoreTasks();
    } else if (action.dataset.taskAction === "load-more-archived-tasks") {
      void this.loadMoreArchived();
    } else if (action.dataset.taskAction === "retry-archived-task-list") {
      void this.loadArchived({ force: true });
    } else if (action.dataset.taskAction === "retry-task-list") {
      void this.loadTasks({ force: true });
    } else if (action.dataset.taskAction === "restore-archived-task") {
      void this.restoreThread(threadId);
    } else if (action.dataset.taskAction === "delete-archived-task") {
      const task = this.archivedTasks.find(
        (candidate) => taskThreadId(candidate) === threadId,
      );
      if (task) {
        this.dispatchIntent("delete-archived-task", { task });
      }
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

  async loadTasks({ force = false, isCurrent = () => true } = {}) {
    if (this.taskListLoaded && !force) {
      return { tasks: this.tasks, nextCursor: this.taskListNextCursor };
    }

    const requestId = ++this.taskListRequestId;
    this.taskListLoading = true;
    this.taskListLoadingMore = false;
    this.taskListError = null;
    this.taskListLoadMoreError = null;
    this.render();

    try {
      const response = await getTasks();
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      if (!isCurrent()) {
        this.taskListLoading = false;
        return null;
      }
      this.tasks = response.tasks ?? [];
      this.taskListNextCursor = response.nextCursor ?? null;
      this.taskListLoading = false;
      this.taskListLoaded = true;
      this.render();
      return response;
    } catch (error) {
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      if (!isCurrent()) {
        this.taskListLoading = false;
        return null;
      }
      this.taskListLoading = false;
      this.taskListError = error;
      this.tasks = [];
      this.taskListLoaded = false;
      this.render();
      return null;
    }
  }

  async loadMoreTasks() {
    const cursor = this.taskListNextCursor;
    if (!cursor || this.taskListLoading || this.taskListLoadingMore) {
      return null;
    }

    const requestId = ++this.taskListRequestId;
    this.taskListLoadingMore = true;
    this.taskListLoadMoreError = null;
    this.render();
    try {
      const response = await getTasks(cursor);
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      this.tasks = mergeTaskListPage(this.tasks, response.tasks ?? []);
      this.taskListNextCursor = response.nextCursor ?? null;
      this.taskListLoadingMore = false;
      this.render();
      return response;
    } catch (error) {
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      this.taskListLoadingMore = false;
      this.taskListLoadMoreError = error;
      this.render();
      return null;
    }
  }

  async loadArchived({ force = false } = {}) {
    if (this.archivedTaskLoaded && !force) {
      return {
        tasks: this.archivedTasks,
        nextCursor: this.archivedTaskNextCursor,
      };
    }
    const requestId = ++this.archivedTaskRequestId;
    this.archivedTaskLoading = true;
    this.archivedTaskLoadingMore = false;
    this.archivedTaskError = null;
    this.archivedTaskLoadMoreError = null;
    this.render();
    try {
      const response = await getArchivedTasks();
      if (requestId !== this.archivedTaskRequestId) {
        return null;
      }
      this.archivedTasks = response.tasks ?? [];
      this.archivedTaskNextCursor = response.nextCursor ?? null;
      this.archivedTaskLoading = false;
      this.archivedTaskLoaded = true;
      this.render();
      return response;
    } catch (error) {
      if (requestId !== this.archivedTaskRequestId) {
        return null;
      }
      this.archivedTaskLoading = false;
      this.archivedTaskError = error;
      this.archivedTasks = [];
      this.archivedTaskLoaded = false;
      this.render();
      return null;
    }
  }

  async loadMoreArchived() {
    const cursor = this.archivedTaskNextCursor;
    if (!cursor || this.archivedTaskLoading || this.archivedTaskLoadingMore) {
      return null;
    }
    const requestId = ++this.archivedTaskRequestId;
    this.archivedTaskLoadingMore = true;
    this.archivedTaskLoadMoreError = null;
    this.render();
    try {
      const response = await getArchivedTasks(cursor);
      if (requestId !== this.archivedTaskRequestId) {
        return null;
      }
      this.archivedTasks = mergeTaskListPage(
        this.archivedTasks,
        response.tasks ?? [],
      );
      this.archivedTaskNextCursor = response.nextCursor ?? null;
      this.archivedTaskLoadingMore = false;
      this.render();
      return response;
    } catch (error) {
      if (requestId !== this.archivedTaskRequestId) {
        return null;
      }
      this.archivedTaskLoadingMore = false;
      this.archivedTaskLoadMoreError = error;
      this.render();
      return null;
    }
  }

  connectStream() {
    if (!this.active || !this.isConnected) {
      return;
    }
    this.taskListStream.activate("task-list");
  }

  handleStreamEvent(type, event) {
    if (type === "task-removed") {
      const message = parseJson(event.data);
      if (message?.threadId) {
        this.removeTask(message.threadId);
        if (message.reason === "archived") {
          void this.loadArchived({ force: true });
        } else if (message.reason === "deleted") {
          this.removeArchivedTask(message.threadId);
        }
      }
      return;
    }
    if (type === "task-updated") {
      const task = parseJson(event.data);
      const threadId = taskThreadId(task);
      if (!threadId) {
        return;
      }
      const archivedLength = this.archivedTasks.length;
      this.archivedTasks = this.archivedTasks.filter(
        (candidate) => taskThreadId(candidate) !== threadId,
      );
      this.upsertCanonicalTask(task);
      if (
        this.archivedTasks.length !== archivedLength
      ) {
        this.render();
      }
      return;
    }

    const message = parseJson(event.data);
    const detail = message?.detail;
    if (message?.error) {
      this.tasks = [];
      this.taskListLoaded = false;
      this.taskListError = new Error(message.error);
      this.render();
      return;
    }
    if (
      detail?.task &&
      message?.threadId === taskThreadId(detail.task) &&
      this.acceptRevision(message.threadId, message.revision)
    ) {
      this.upsertCanonicalTask(detail.task);
    }
  }

  async reconcileTaskList(isCurrent) {
    this.revisionByThread.clear();
    const response = await this.loadTasks({ force: true, isCurrent });
    if (!isCurrent()) {
      return null;
    }
    if (!response) {
      throw this.taskListError ?? new Error("Canonical task list unavailable.");
    }
    return response;
  }

  acceptRevision(threadId, revision) {
    const value = Number(revision);
    if (!threadId || !Number.isFinite(value) || value <= 0) {
      return true;
    }
    const current = this.revisionByThread.get(threadId) ?? 0;
    if (value < current) {
      return false;
    }
    this.revisionByThread.set(threadId, value);
    return true;
  }

  closeStream() {
    this.taskListStream.deactivate();
  }

  handleStreamStateChange(state, previousState) {
    if (taskTransportRenderKey(previousState) !== taskTransportRenderKey(state)) {
      this.render();
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-navigator-transport-change", {
        bubbles: true,
        composed: true,
        detail: {
          available: !isTaskTransportStale(state),
          state,
        },
      }),
    );
  }

  get streamState() {
    return this.taskListStream?.state ?? TASK_TRANSPORT_STATE.IDLE;
  }

  setStreamState(state) {
    this.taskListStream.setState(state);
  }

  removeTask(threadId) {
    if (!threadId || !this.taskListLoaded) {
      return;
    }
    const tasks = this.tasks.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
    if (tasks.length === this.tasks.length) {
      return;
    }
    this.tasks = tasks;
    this.revisionByThread.delete(threadId);
    this.render();
  }

  removeArchivedTask(threadId) {
    if (!threadId) {
      return;
    }
    const archivedTasks = this.archivedTasks.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
    if (archivedTasks.length === this.archivedTasks.length) {
      return;
    }
    this.archivedTasks = archivedTasks;
    this.restoreErrors.delete(threadId);
    this.deleteErrors.delete(threadId);
    this.render();
  }

  render() {
    this.ensureState();
    const scrollTop = this.querySelector(".task-list-scroll")?.scrollTop ?? 0;
    this.innerHTML = `
      ${this.renderPrimaryHeader()}
      ${this.renderAvailability()}
      <div class="task-list-scroll">
        ${this.renderSection("Caffold Tasks", this.tasks, "managed")}
        ${this.renderSection("Archived", this.archivedTasks, "archived")}
      </div>
    `;
    initializeRunningSpinners(this);
    const scroller = this.querySelector(".task-list-scroll");
    if (scroller) {
      scroller.scrollTop = scrollTop;
    }
    this.syncSelection();
    this.publishListState();
  }

  renderPrimaryHeader() {
    return `
      <header class="task-list-section-header task-list-primary-header">
        <caffold-workspace-brand></caffold-workspace-brand>
        <button
          type="button"
          class="task-list-new-task"
          data-task-action="open-new"
          aria-label="New Task"
          title="New Task"
        >${renderInlineIcon("Plus", "New task", "task-action-icon")}</button>
      </header>
    `;
  }

  renderAvailability() {
    if (!isTaskTransportStale(this.streamState)) {
      return "";
    }
    return `
      <caffold-task-transport-overlay
        class="task-list-availability"
        state="${escapeHtml(this.streamState)}"
        message="${
          this.streamState === TASK_TRANSPORT_STATE.RECONNECTING
            ? "Reconnecting to Caffold server..."
            : "Caffold server unavailable."
        }"
        data-task-list-availability="${escapeHtml(this.streamState)}"
      ></caffold-task-transport-overlay>
    `;
  }

  listState() {
    this.ensureState();
    return {
      count: this.tasks.length + this.archivedTasks.length,
      activeCount: this.tasks.length,
      archivedCount: this.archivedTasks.length,
      loaded: this.taskListLoaded && this.archivedTaskLoaded,
      loading: this.taskListLoading || this.archivedTaskLoading,
      error:
        this.taskListError?.message ?? this.archivedTaskError?.message ?? "",
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

  renderSection(title, entries, kind) {
    const archived = kind === "archived";
    const loading = archived
      ? this.archivedTaskLoading
      : this.taskListLoading;
    const error = archived
      ? this.archivedTaskError
      : this.taskListError;
    const tasks = sortTasksByRecency(entries);
    const pagination = archived
      ? this.renderArchivedPagination()
      : this.renderTaskPagination();
    const header = archived
      ? `<header class="task-list-section-header">
          <h2>${escapeHtml(title)}</h2>
          <span class="task-list-section-count">${tasks.length}</span>
        </header>`
      : "";
    const sectionLabel = archived
      ? ""
      : ' aria-label="Caffold Tasks"';
    let content;

    if (loading && !tasks.length) {
      content = `<p class="task-section-message">Loading...</p>`;
    } else if (error && !tasks.length) {
      content = `
        <div class="task-section-message" role="alert">
          <p>${escapeHtml(error.message)}</p>
          <button type="button" class="task-secondary-button" data-task-action="${archived ? "retry-archived-task-list" : "retry-task-list"}">Retry</button>
        </div>
      `;
    } else if (!tasks.length) {
      content = archived
        ? `<p class="task-section-message">No archived Caffold tasks.</p>`
        : `<p class="task-section-message">No Caffold tasks yet.</p>`;
    } else {
      const groups = groupTasksByRepository(tasks);
      content = `<ol class="task-repository-groups" data-task-section="${escapeHtml(kind)}">
        ${groups.map((group) => this.renderRepositoryGroup(group, kind)).join("")}
      </ol>`;
    }

    return `
      <section class="task-list-section" data-task-section="${escapeHtml(kind)}"${sectionLabel}>
        ${header}
        ${content}
        ${pagination}
      </section>
    `;
  }

  renderTaskPagination() {
    if (!this.taskListNextCursor && !this.taskListLoadingMore && !this.taskListLoadMoreError) {
      return "";
    }
    const label = this.taskListLoadingMore
      ? "Loading more tasks..."
      : this.taskListLoadMoreError
        ? "Retry loading more tasks"
        : "Load more tasks";
    return `
      <div class="task-list-pagination">
        ${this.taskListLoadMoreError ? `<p class="task-list-pagination-error">${escapeHtml(this.taskListLoadMoreError.message)}</p>` : ""}
        <button type="button" class="task-secondary-button" data-task-action="load-more-tasks" ${this.taskListLoadingMore ? "disabled" : ""}>${label}</button>
      </div>
    `;
  }

  renderArchivedPagination() {
    if (
      !this.archivedTaskNextCursor &&
      !this.archivedTaskLoadingMore &&
      !this.archivedTaskLoadMoreError
    ) {
      return "";
    }
    const label = this.archivedTaskLoadingMore
      ? "Loading more archived tasks..."
      : this.archivedTaskLoadMoreError
        ? "Retry loading more archived tasks"
        : "Load more archived tasks";
    return `
      <div class="task-list-pagination">
        ${this.archivedTaskLoadMoreError ? `<p class="task-list-pagination-error">${escapeHtml(this.archivedTaskLoadMoreError.message)}</p>` : ""}
        <button type="button" class="task-secondary-button" data-task-action="load-more-archived-tasks" ${this.archivedTaskLoadingMore ? "disabled" : ""}>${label}</button>
      </div>
    `;
  }

  renderRepositoryGroup(group, kind) {
    const icon = group.repository ? "FolderGit2" : "Folder";
    const iconLabel = group.repository ? "Git repository" : "Directory";
    return `
      <li class="task-repository-group" data-task-repository-key="${escapeHtml(group.key)}">
        <div class="task-repository-header" title="${escapeHtml(group.rootPath)}">
          ${renderInlineIcon(icon, iconLabel, "task-repository-icon")}
          <span class="task-repository-label">${escapeHtml(group.label)}</span>
          <span class="task-repository-count">${group.tasks.length}</span>
        </div>
        <ol class="task-list">
          ${group.tasks.map((task) => kind === "archived" ? this.renderArchivedTaskRow(task, group.key) : this.renderTaskRow(task, group.key)).join("")}
        </ol>
      </li>
    `;
  }

  renderArchivedTaskRow(task, repositoryKey = taskRepositoryKey(task)) {
    const threadId = taskThreadId(task);
    const restoring = this.restoringThreadIds.has(threadId);
    const deleting = this.deletingThreadIds.has(threadId);
    const mutating = restoring || deleting;
    const transportBlocked = isTaskTransportStale(this.streamState);
    const restoreError = this.restoreErrors.get(threadId);
    const deleteError = this.deleteErrors.get(threadId);
    const conversationAvailable = task?.conversationAvailable !== false;
    const availabilityClass = conversationAvailable
      ? ""
      : " is-conversation-unavailable";
    const restoreLabel = restoring
      ? `Restoring ${task.title}`
      : restoreError
        ? `Retry restoring ${task.title}`
        : `Restore ${task.title}`;
    const restoreTitle = restoring
      ? "Restoring task"
      : restoreError?.message ?? "Restore task; its worktree was retained";
    const restoreIcon = restoring ? "LoaderCircle" : "ArchiveRestore";
    const deleteLabel = deleting
      ? `Deleting ${task.title}`
      : deleteError
        ? `Retry deleting ${task.title}`
        : `Delete ${task.title}`;
    const deleteTitle = deleting
      ? "Deleting task"
      : deleteError?.message ?? "Permanently delete task";
    const deleteIcon = deleting ? "LoaderCircle" : "Trash2";
    const worktree = task?.worktree?.linked
      ? `<span class="task-row-worktree" title="${escapeHtml(taskWorktreeLabel(task))}">
          ${renderInlineIcon("GitBranch", "Linked worktree retained", "task-row-worktree-icon")}
        </span>`
      : "";
    const meta = conversationAvailable
      ? renderTaskRowMeta(task, false)
      : `<span class="task-conversation-unavailable">Conversation unavailable</span>`;
    const restoreButton = conversationAvailable
      ? `<button type="button" class="task-archived-action-button${restoring ? " is-loading" : ""}" data-task-action="restore-archived-task" data-thread-id="${escapeHtml(threadId)}" aria-label="${escapeHtml(restoreLabel)}" title="${escapeHtml(restoreTitle)}" ${mutating || transportBlocked ? "disabled" : ""}>${renderInlineIcon(restoreIcon, restoreLabel, "task-archived-action-icon")}</button>`
      : "";
    return `
      <li class="task-archived-row${availabilityClass}" data-thread-id="${escapeHtml(threadId)}" data-task-list-key="${escapeHtml(repositoryKey)}">
        <div class="task-archived-copy" title="${escapeHtml(task.title)}">
          <span class="task-row-title">${escapeHtml(task.title)}</span>
          <span class="task-row-indicators">${worktree}${meta}</span>
        </div>
        <div class="task-archived-actions">
          ${restoreButton}
          <button type="button" class="task-archived-action-button task-delete-button${deleting ? " is-loading" : ""}" data-task-action="delete-archived-task" data-thread-id="${escapeHtml(threadId)}" aria-label="${escapeHtml(deleteLabel)}" title="${escapeHtml(deleteTitle)}" ${mutating || transportBlocked ? "disabled" : ""}>${renderInlineIcon(deleteIcon, deleteLabel, "task-archived-action-icon")}</button>
        </div>
        ${restoreError || deleteError ? `<p class="task-archived-action-error" role="alert">${escapeHtml((deleteError ?? restoreError).message)}</p>` : ""}
      </li>
    `;
  }

  renderTaskRow(task, repositoryKey = taskRepositoryKey(task)) {
    const threadId = taskThreadId(task);
    const transportState = this.streamState;
    const selected = threadId === this.selectedThreadId ? ` aria-current="true"` : "";
    const status =
      taskStatusView(task, transportState)?.status ?? taskThreadStatusType(task);
    const busy = status === "running" ? ` aria-busy="true"` : "";
    const meta = renderTaskRowMeta(
      task,
      Boolean(threadId && task?.unseen && threadId !== this.selectedThreadId),
      transportState,
    );
    const worktree = task?.worktree?.linked
      ? `<span class="task-row-worktree" title="${escapeHtml(taskWorktreeLabel(task))}">
          ${renderInlineIcon("GitBranch", "Linked worktree", "task-row-worktree-icon")}
        </span>`
      : "";
    return `
      <li data-thread-id="${escapeHtml(threadId)}" data-task-list-key="${escapeHtml(repositoryKey)}">
        <button type="button" class="task-row" data-task-action="open-task" data-thread-id="${escapeHtml(threadId)}" data-task-status="${escapeHtml(status)}" title="${escapeHtml(task.title)}"${selected}${busy}>
          <span class="task-row-title">${escapeHtml(task.title)}</span>
          <span class="task-row-indicators">${worktree}${meta}</span>
        </button>
      </li>
    `;
  }

  syncSelection() {
    for (const row of this.querySelectorAll(".task-row[data-thread-id]")) {
      if (row.dataset.threadId === this.selectedThreadId) {
        if (row.getAttribute("aria-current") !== "true") {
          row.setAttribute("aria-current", "true");
        }
      } else if (row.hasAttribute("aria-current")) {
        row.removeAttribute("aria-current");
      }
    }
  }

  reorderTaskListDom() {
    const groups = groupTasksByRepository(sortTasksByRecency(this.tasks));
    const groupList = this.querySelector(
      '.task-list-section[data-task-section="managed"] .task-repository-groups',
    );
    if (!groupList) {
      return;
    }
    const groupElements = [];
    for (const group of groups) {
      const groupElement = groupList.querySelector(
        `:scope > [data-task-repository-key="${CSS.escape(group.key)}"]`,
      );
      if (!groupElement) {
        continue;
      }
      groupElements.push(groupElement);
      const taskList = groupElement.querySelector(":scope > .task-list");
      if (taskList) {
        const rows = group.tasks
          .map((task) =>
            taskList.querySelector(
              `:scope > [data-thread-id="${CSS.escape(taskThreadId(task))}"]`,
            ),
          )
          .filter(Boolean);
        reorderChildElements(taskList, rows);
      }
    }
    reorderChildElements(groupList, groupElements);
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function taskTransportRenderKey(state) {
  return isTaskTransportStale(state) ? state : "available";
}

function renderTaskRowMeta(
  task,
  unseen = false,
  transportState = TASK_TRANSPORT_STATE.READY,
) {
  if (taskStatusView(task, transportState)) {
    return renderTaskStatusChip(task, "task-row-meta", {
      label: false,
      transportState,
    });
  }
  if (unseen) {
    const attentionDelayMs = unseenAttentionDelayMs(taskThreadId(task));
    return `
      <span class="task-row-meta task-unseen-complete" title="Completed - not viewed" aria-label="Completed - not viewed" style="--task-unseen-attention-delay: ${attentionDelayMs}ms"></span>
    `;
  }

  const ms = task.lastCompletedMs ?? task.recencyMs ?? task.updatedMs;
  const date = new Date(Number(ms));
  const dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
  return `
    <time class="task-row-meta task-row-time" datetime="${escapeHtml(dateTime)}">
      ${escapeHtml(formatRelativeAge(ms))}
    </time>
  `;
}

function unseenAttentionDelayMs(threadId) {
  let checksum = 0;
  for (const [index, character] of [...threadId].entries()) {
    checksum += character.codePointAt(0) * (index + 1);
  }
  const phase = checksum % UNSEEN_ATTENTION_PHASE_COUNT;
  return 0 - phase * UNSEEN_ATTENTION_PHASE_INTERVAL_MS;
}

function patchTaskListRow(row, nextRow) {
  const currentButton = row.querySelector(":scope > .task-row");
  const nextButton = nextRow.querySelector(":scope > .task-row");
  const currentTitle = currentButton?.querySelector(":scope > .task-row-title");
  const nextTitle = nextButton?.querySelector(":scope > .task-row-title");
  const currentIndicators = currentButton?.querySelector(
    ":scope > .task-row-indicators",
  );
  const nextIndicators = nextButton?.querySelector(
    ":scope > .task-row-indicators",
  );
  if (
    !currentButton ||
    !nextButton ||
    !currentTitle ||
    !nextTitle ||
    !currentIndicators ||
    !nextIndicators
  ) {
    return false;
  }
  syncElementAttributes(row, nextRow, [
    "class",
    "data-thread-id",
    "data-task-list-key",
  ]);
  syncElementAttributes(currentButton, nextButton, [
    "type",
    "class",
    "data-task-action",
    "data-thread-id",
    "data-task-status",
    "title",
    "aria-current",
    "aria-busy",
  ]);
  syncElementAttributes(currentTitle, nextTitle, ["class"]);
  if (currentTitle.textContent !== nextTitle.textContent) {
    currentTitle.textContent = nextTitle.textContent;
  }
  syncElementAttributes(currentIndicators, nextIndicators, ["class"]);
  patchTaskRowIndicator(currentIndicators, nextIndicators, ".task-row-worktree");
  patchTaskRowIndicator(currentIndicators, nextIndicators, ".task-row-meta");
  return true;
}

function patchTaskRowIndicator(currentIndicators, nextIndicators, selector) {
  const current = currentIndicators.querySelector(`:scope > ${selector}`);
  const next = nextIndicators.querySelector(`:scope > ${selector}`);
  if (current && next && patchMatchingTaskRowIndicator(current, next)) {
    initializeRunningSpinners(current);
    return;
  }
  if (current && next) {
    current.replaceWith(next);
    initializeRunningSpinners(next);
    return;
  }
  if (current) {
    current.remove();
    return;
  }
  if (!next) {
    return;
  }
  const before = selector === ".task-row-worktree"
    ? currentIndicators.querySelector(":scope > .task-row-meta")
    : null;
  currentIndicators.insertBefore(next, before);
  initializeRunningSpinners(next);
}

function patchMatchingTaskRowIndicator(current, next) {
  if (current.matches(".task-status-chip") && next.matches(".task-status-chip")) {
    patchTaskStatusChip(current, next);
    return true;
  }
  if (
    current.matches(".task-row-worktree") &&
    next.matches(".task-row-worktree")
  ) {
    syncElementAttributes(current, next, ["class", "title"]);
    return true;
  }
  if (
    current.matches(".task-unseen-complete") &&
    next.matches(".task-unseen-complete")
  ) {
    syncElementAttributes(current, next, [
      "class",
      "title",
      "aria-label",
      "style",
    ]);
    return true;
  }
  if (current.matches(".task-row-time") && next.matches(".task-row-time")) {
    syncElementAttributes(current, next, ["class", "datetime"]);
    if (current.textContent !== next.textContent) {
      current.textContent = next.textContent;
    }
    return true;
  }
  return false;
}

function initializeRunningSpinners(root) {
  const spinners = root.matches?.(".task-status-spinner")
    ? [root]
    : root.querySelectorAll(".task-status-spinner");
  for (const spinner of spinners) {
    if (!spinner.closest('.task-row[data-task-status="running"]')) {
      spinner.style.removeProperty("animation-delay");
      continue;
    }
    if (spinner.style.animationDelay) {
      continue;
    }
    const delayMs =
      0 - (Math.random() * (TASK_RUNNING_SPINNER_DURATION_MS - 1) + 1);
    spinner.style.animationDelay = `${delayMs}ms`;
  }
}

function syncElementAttributes(element, nextElement, names) {
  for (const name of names) {
    if (nextElement.hasAttribute(name)) {
      const value = nextElement.getAttribute(name);
      if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
      }
    } else if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }
}

function reorderChildElements(parent, elements) {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (parent.children[index] !== element) {
      parent.insertBefore(element, parent.children[index] ?? null);
    }
  }
}

if (!customElements.get("caffold-task-navigator")) {
  customElements.define("caffold-task-navigator", CaffoldTaskNavigator);
}
