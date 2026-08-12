import {
  deleteTask,
  getArchivedTasks,
  restoreTask,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
} from "../runtime-state.js";
import {
  groupTasksByRepository,
  mergeTaskListPage,
  sortTasksByRecency,
  taskRepositoryKey,
  taskThreadId,
  taskWorktreeLabel,
  upsertTask,
} from "../task-list-model.js";
import { formatRelativeAge } from "../task-format.js";
import { renderTaskStatusChip } from "./task-status.js";

export const ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT =
  "caffold:archived-task-list-initial-settled";
export const ARCHIVED_TASK_RESTORED_EVENT =
  "caffold:archived-task-restored";
export const ARCHIVED_TASK_LIST_STATE_EVENT =
  "caffold:archived-task-list-state";

class CaffoldArchivedTaskList extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.archivedTaskRequestId += 1;
    this.archivedTaskLoading = false;
    this.archivedTaskLoadingMore = false;
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.archivedTasks = [];
    this.archivedTaskLoading = false;
    this.archivedTaskLoadingMore = false;
    this.archivedTaskLoaded = false;
    this.archivedTaskError = null;
    this.archivedTaskLoadMoreError = null;
    this.archivedTaskNextCursor = null;
    this.archivedTaskRequestId = 0;
    this.initialRequestSettled = false;
    this.revealed = false;
    this.transportState = TASK_TRANSPORT_STATE.IDLE;
    this.restoringThreadIds = new Set();
    this.restoreErrors = new Map();
    this.deletingThreadIds = new Set();
    this.deleteErrors = new Map();
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.render();
    warmIcons();
  }

  async activate({ force = false } = {}) {
    this.ensureState();
    return await this.loadArchived({ force });
  }

  setRevealed(revealed) {
    this.ensureState();
    const nextRevealed = Boolean(revealed);
    if (this.revealed === nextRevealed) {
      return;
    }
    this.revealed = nextRevealed;
    this.render();
  }

  setTransportState(state) {
    this.ensureState();
    const previousState = this.transportState;
    this.transportState = state ?? TASK_TRANSPORT_STATE.IDLE;
    if (taskTransportRenderKey(previousState) !== taskTransportRenderKey(this.transportState)) {
      this.render();
    }
  }

  acceptTask(task) {
    this.ensureState();
    if (!task || !taskThreadId(task)) {
      return;
    }
    this.archivedTasks = upsertTask(this.archivedTasks, task);
    this.archivedTaskLoaded = true;
    this.archivedTaskError = null;
    this.render();
  }

  removeTask(threadId) {
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

  async restoreThread(threadId) {
    this.ensureState();
    if (
      !threadId ||
      this.restoringThreadIds.has(threadId) ||
      this.deletingThreadIds.has(threadId) ||
      isTaskTransportStale(this.transportState)
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
      this.render();
      this.dispatchEvent(
        new CustomEvent(ARCHIVED_TASK_RESTORED_EVENT, {
          bubbles: true,
          detail: { task },
        }),
      );
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
      isTaskTransportStale(this.transportState)
    ) {
      return null;
    }
    this.deletingThreadIds.add(threadId);
    this.deleteErrors.delete(threadId);
    this.render();
    try {
      const response = await deleteTask(threadId);
      this.removeTask(threadId);
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

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-task-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const threadId = `${action.dataset.threadId ?? ""}`;
    if (action.dataset.taskAction === "load-more-archived-tasks") {
      void this.loadMoreArchived();
    } else if (action.dataset.taskAction === "retry-archived-task-list") {
      void this.loadArchived({ force: true });
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
      const initialSettled = this.markInitialRequestSettled();
      this.render();
      this.dispatchInitialSettled(initialSettled);
      return response;
    } catch (error) {
      if (requestId !== this.archivedTaskRequestId) {
        return null;
      }
      this.archivedTaskLoading = false;
      this.archivedTaskError = error;
      this.archivedTasks = [];
      this.archivedTaskLoaded = false;
      const initialSettled = this.markInitialRequestSettled();
      this.render();
      this.dispatchInitialSettled(initialSettled);
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

  markInitialRequestSettled() {
    if (this.initialRequestSettled) {
      return false;
    }
    this.initialRequestSettled = true;
    return true;
  }

  dispatchInitialSettled(changed) {
    if (!changed) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT, {
        bubbles: true,
      }),
    );
  }

  listState() {
    this.ensureState();
    return {
      count: this.archivedTasks.length,
      loaded: this.archivedTaskLoaded,
      loading: this.archivedTaskLoading || !this.initialRequestSettled,
      error: this.archivedTaskError?.message ?? "",
    };
  }

  publishState() {
    this.dispatchEvent(
      new CustomEvent(ARCHIVED_TASK_LIST_STATE_EVENT, {
        bubbles: true,
        detail: this.listState(),
      }),
    );
  }

  render() {
    this.ensureState();
    if (!this.revealed) {
      this.hidden = true;
      this.classList.remove("task-list-section");
      delete this.dataset.taskSection;
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
      this.replaceChildren();
      this.publishState();
      return;
    }

    this.hidden = false;
    this.classList.add("task-list-section");
    this.dataset.taskSection = "archived";
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Archived Caffold Tasks");
    const tasks = sortTasksByRecency(this.archivedTasks);
    let content;
    if (this.archivedTaskLoading && !tasks.length) {
      content = `<p class="task-section-message">Loading...</p>`;
    } else if (this.archivedTaskError && !tasks.length) {
      content = `
        <div class="task-section-message" role="alert">
          <p>${escapeHtml(this.archivedTaskError.message)}</p>
          <button type="button" class="task-secondary-button" data-task-action="retry-archived-task-list">Retry</button>
        </div>
      `;
    } else if (!tasks.length) {
      content = `<p class="task-section-message">No archived Caffold tasks.</p>`;
    } else {
      const groups = groupTasksByRepository(tasks);
      content = `<ol class="task-repository-groups" data-task-section="archived">
        ${groups.map((group) => this.renderRepositoryGroup(group)).join("")}
      </ol>`;
    }
    this.innerHTML = `
      <header class="task-list-section-header">
        <h2>Archived</h2>
        <span class="task-list-section-count">${tasks.length}</span>
      </header>
      ${content}
      ${this.renderArchivedPagination()}
    `;
    this.publishState();
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

  renderRepositoryGroup(group) {
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
          ${group.tasks.map((task) => this.renderArchivedTaskRow(task, group.key)).join("")}
        </ol>
      </li>
    `;
  }

  renderArchivedTaskRow(task, repositoryKey = taskRepositoryKey(task)) {
    const threadId = taskThreadId(task);
    const restoring = this.restoringThreadIds.has(threadId);
    const deleting = this.deletingThreadIds.has(threadId);
    const mutating = restoring || deleting;
    const transportBlocked = isTaskTransportStale(this.transportState);
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
      ? renderTaskRowMeta(task)
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
}

function taskTransportRenderKey(state) {
  return isTaskTransportStale(state) ? state : "available";
}

function renderTaskRowMeta(task) {
  const status = renderTaskStatusChip(task, "task-row-meta", { label: false });
  if (status) {
    return status;
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

if (!customElements.get("caffold-archived-task-list")) {
  customElements.define("caffold-archived-task-list", CaffoldArchivedTaskList);
}
