import { getTasks, taskListStreamUrl } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
  taskStatusView,
  taskThreadStatusType,
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
import { TaskStreamLifecycle } from "../stream.js";
import {
  patchTaskStatusChip,
  renderTaskStatusChip,
} from "./task-status.js";

export const ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT =
  "caffold:active-task-list-initial-settled";
export const ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT =
  "caffold:active-task-list-archive-sync";
export const ACTIVE_TASK_LIST_STATE_EVENT = "caffold:active-task-list-state";

const TASK_RUNNING_SPINNER_DURATION_MS = 800;
const UNSEEN_ATTENTION_PHASE_COUNT = 8;
const UNSEEN_ATTENTION_PHASE_INTERVAL_MS = 300;

class CaffoldActiveTaskList extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.classList.add("task-list-section");
    this.dataset.taskSection = "managed";
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Caffold Tasks");
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.taskListRequestId += 1;
    this.taskListLoading = false;
    this.taskListLoadingMore = false;
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
    this.initialRequestSettled = false;
    this.selectedThreadId = "";
    this.revisionByThread = new Map();
    this.active = false;
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
    return await this.loadTasks({ force });
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
      const task = this.tasks.find(
        (candidate) => taskThreadId(candidate) === nextThreadId,
      );
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
    const index = this.tasks.findIndex(
      (candidate) => taskThreadId(candidate) === threadId,
    );
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
    this.publishState();
  }

  acceptTask(task) {
    this.ensureState();
    if (!task || !taskThreadId(task)) {
      return;
    }
    this.tasks = upsertTask(this.tasks, task);
    this.taskListLoaded = true;
    this.taskListError = null;
    this.render();
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
    } else if (action.dataset.taskAction === "load-more-tasks") {
      void this.loadMoreTasks();
    } else if (action.dataset.taskAction === "retry-task-list") {
      void this.loadTasks({ force: true });
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
      const initialSettled = this.markInitialRequestSettled();
      this.render();
      this.dispatchInitialSettled(initialSettled);
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
      const initialSettled = this.markInitialRequestSettled();
      this.render();
      this.dispatchInitialSettled(initialSettled);
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
      new CustomEvent(ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT, {
        bubbles: true,
      }),
    );
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
          this.dispatchArchiveSync("refresh", message.threadId);
        } else if (message.reason === "deleted") {
          this.dispatchArchiveSync("remove", message.threadId);
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
      this.upsertCanonicalTask(task);
      this.dispatchArchiveSync("remove", threadId);
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

  dispatchArchiveSync(action, threadId) {
    this.dispatchEvent(
      new CustomEvent(ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT, {
        bubbles: true,
        detail: { action, threadId },
      }),
    );
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

  retryStream() {
    this.taskListStream.retry();
  }

  isTransportAvailable() {
    return !isTaskTransportStale(this.streamState);
  }

  listState() {
    this.ensureState();
    return {
      count: this.tasks.length,
      loaded: this.taskListLoaded,
      loading: this.taskListLoading || !this.initialRequestSettled,
      error: this.taskListError?.message ?? "",
    };
  }

  publishState() {
    this.dispatchEvent(
      new CustomEvent(ACTIVE_TASK_LIST_STATE_EVENT, {
        bubbles: true,
        detail: this.listState(),
      }),
    );
  }

  render() {
    this.ensureState();
    const loading = this.taskListLoading || !this.initialRequestSettled;
    const tasks = sortTasksByRecency(this.tasks);
    let content;
    if (loading && !tasks.length) {
      content = `<p class="task-section-message">Loading...</p>`;
    } else if (this.taskListError && !tasks.length) {
      content = `
        <div class="task-section-message" role="alert">
          <p>${escapeHtml(this.taskListError.message)}</p>
          <button type="button" class="task-secondary-button" data-task-action="retry-task-list">Retry</button>
        </div>
      `;
    } else if (!tasks.length) {
      content = `<p class="task-section-message">No Caffold tasks yet.</p>`;
    } else {
      const groups = groupTasksByRepository(tasks);
      content = `<ol class="task-repository-groups" data-task-section="managed">
        ${groups.map((group) => this.renderRepositoryGroup(group)).join("")}
      </ol>`;
    }
    this.innerHTML = `${content}${this.renderTaskPagination()}`;
    initializeRunningSpinners(this);
    this.syncSelection();
    this.publishState();
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
          ${group.tasks.map((task) => this.renderTaskRow(task, group.key)).join("")}
        </ol>
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
    const unseen = Boolean(
      threadId && task?.unseen && threadId !== this.selectedThreadId,
    );
    const meta = unseen
      ? renderUnseenTaskRowMeta(task)
      : renderTaskRowMeta(task, transportState);
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
    const groupList = this.querySelector(":scope > .task-repository-groups");
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

function renderUnseenTaskRowMeta(task) {
  const attentionDelayMs = unseenAttentionDelayMs(taskThreadId(task));
  return `
    <span class="task-row-meta task-unseen-complete" title="Completed - not viewed" aria-label="Completed - not viewed" style="--task-unseen-attention-delay: ${attentionDelayMs}ms"></span>
  `;
}

function renderTaskRowMeta(task, transportState) {
  const status = renderTaskStatusChip(task, "task-row-meta", {
    label: false,
    transportState,
  });
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

if (!customElements.get("caffold-active-task-list")) {
  customElements.define("caffold-active-task-list", CaffoldActiveTaskList);
}
