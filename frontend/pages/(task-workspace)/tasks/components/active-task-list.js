import { getTasks, taskListStreamUrl } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { PENDING_CODEX_TASK_OPERATIONS } from "../../codex-status.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
  taskStatusView,
  taskThreadStatusType,
} from "../runtime-state.js";
import {
  taskThreadId,
  taskWorktreeLabel,
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
    this.closeStream();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.sections = [];
    this.unsectioned = [];
    this.taskListLoading = false;
    this.taskListLoaded = false;
    this.taskListError = null;
    this.taskListRequestId = 0;
    this.pendingTopPlacements = new Map();
    this.initialRequestSettled = false;
    this.selectedThreadId = "";
    this.revisionByThread = new Map();
    this.active = false;
    this.codexTaskOperations = PENDING_CODEX_TASK_OPERATIONS;
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.render();
    this.taskListStream = new TaskStreamLifecycle({
      createUrl: () => taskListStreamUrl(),
      eventTypes: [
        "task-removed",
        "task-updated",
        "task-placed-at-top",
        "task-list-refresh",
        "task-sync",
      ],
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
    if (this.codexOperationsBlocked) {
      return null;
    }
    return await this.loadTasks({ force });
  }

  get codexOperationsBlocked() {
    return this.codexTaskOperations?.blocked !== false;
  }

  setCodexTaskOperations(presentation) {
    this.ensureState();
    if (this.codexTaskOperations?.key === presentation.key) {
      return;
    }
    const becameBlocked =
      this.codexTaskOperations?.blocked === false && presentation.blocked;
    this.codexTaskOperations = presentation;
    if (becameBlocked) {
      this.taskListRequestId += 1;
      this.taskListLoading = false;
      this.closeStream();
    }
    this.render();
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
      const task = this.allTasks().find(
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
    const listKey = this.replaceTaskInPlace(nextTask);
    if (!listKey) {
      return;
    }
    const row = this.querySelector(
      `li[data-thread-id="${CSS.escape(threadId)}"]`,
    );
    if (!row) {
      this.render();
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = this.renderTaskRow(nextTask, listKey).trim();
    const nextRow = template.content.firstElementChild;
    if (!nextRow || !patchTaskListRow(row, nextRow)) {
      this.render();
      return;
    }
    this.syncSelection();
    this.publishState();
  }

  acceptTask(task, placement) {
    this.ensureState();
    if (!task || !taskThreadId(task)) {
      return;
    }
    this.placeCanonicalTaskAtTop(task, placement);
  }

  placeCanonicalTaskAtTop(task, placement) {
    this.ensureState();
    const threadId = taskThreadId(task);
    const normalizedPlacement = normalizeActiveTopPlacement(placement);
    if (!threadId || !normalizedPlacement) {
      return false;
    }
    const nextTask = threadId === this.selectedThreadId
      ? { ...task, unseen: false }
      : task;
    if (!this.taskListLoaded) {
      this.pendingTopPlacements.set(threadId, {
        task: nextTask,
        placement: normalizedPlacement,
      });
      return true;
    }
    this.applyCanonicalTopPlacement(nextTask, normalizedPlacement);
    this.render();
    return true;
  }

  applyCanonicalTopPlacement(task, placement) {
    const threadId = taskThreadId(task);
    const targetId = placement.section.id;
    const existingTarget = this.sections.find(
      (section) =>
        section.id === targetId &&
        section.tasks.some((candidate) => taskThreadId(candidate) === threadId),
    );
    if (existingTarget) {
      existingTarget.name = placement.section.name;
      existingTarget.repository = placement.section.repository;
      existingTarget.tasks = existingTarget.tasks.map((candidate) =>
        taskThreadId(candidate) === threadId ? task : candidate
      );
      this.unsectioned = this.unsectioned.filter(
        (candidate) => taskThreadId(candidate) !== threadId,
      );
      return;
    }

    const remainingSections = this.sections
      .map((section) => ({
        ...section,
        tasks: section.tasks.filter(
          (candidate) => taskThreadId(candidate) !== threadId,
        ),
      }))
      .filter((section) => section.id === targetId || section.tasks.length);
    const target = remainingSections.find((section) => section.id === targetId) ?? {
      ...placement.section,
      tasks: [],
    };
    target.name = placement.section.name;
    target.repository = placement.section.repository;
    const beforeIndex = placement.beforeThreadId
      ? target.tasks.findIndex(
          (candidate) => taskThreadId(candidate) === placement.beforeThreadId,
        )
      : target.tasks.length;
    target.tasks.splice(beforeIndex < 0 ? 0 : beforeIndex, 0, task);
    this.sections = [
      target,
      ...remainingSections.filter((section) => section.id !== targetId),
    ];
    this.unsectioned = this.unsectioned.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
  }

  removeTask(threadId) {
    if (!threadId || !this.taskListLoaded) {
      return;
    }
    const previousCount = this.allTasks().length;
    this.sections = this.sections
      .map((section) => ({
        ...section,
        tasks: section.tasks.filter(
          (candidate) => taskThreadId(candidate) !== threadId,
        ),
      }))
      .filter((section) => section.tasks.length);
    this.unsectioned = this.unsectioned.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
    if (this.allTasks().length === previousCount) {
      return;
    }
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
    if (this.codexOperationsBlocked) {
      return;
    }
    const threadId = `${action.dataset.threadId ?? ""}`;
    if (action.dataset.taskAction === "open-task") {
      this.dispatchIntent("select-task", { threadId });
    } else if (action.dataset.taskAction === "open-task-recovery") {
      const recovery = this.recoveryFor(threadId);
      if (recovery) {
        this.dispatchIntent("select-task-recovery", { threadId, recovery });
      }
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
    if (this.codexOperationsBlocked) {
      return null;
    }
    if (this.taskListLoaded && !force) {
      return {
        sections: this.sections,
        unsectioned: this.unsectioned,
      };
    }

    const requestId = ++this.taskListRequestId;
    this.taskListLoading = true;
    this.taskListError = null;
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
      this.sections = normalizeActiveSections(response.sections);
      this.unsectioned = normalizeTaskList(response.unsectioned);
      this.taskListLoading = false;
      this.taskListLoaded = true;
      for (const { task, placement } of this.pendingTopPlacements.values()) {
        this.applyCanonicalTopPlacement(task, placement);
      }
      this.pendingTopPlacements.clear();
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
      this.sections = [];
      this.unsectioned = [];
      this.taskListLoaded = false;
      const initialSettled = this.markInitialRequestSettled();
      this.render();
      this.dispatchInitialSettled(initialSettled);
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
    if (this.codexOperationsBlocked || !this.active || !this.isConnected) {
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
    if (type === "task-list-refresh") {
      void this.loadTasks({ force: true });
      return;
    }
    if (type === "task-placed-at-top") {
      const update = parseJson(event.data);
      if (update?.task && update?.placement) {
        this.placeCanonicalTaskAtTop(update.task, update.placement);
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
      // A task-sync error belongs to one Task detail. The canonical list
      // remains valid until its own request or transport fails.
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

  allTasks() {
    return [
      ...this.sections.flatMap((section) => section.tasks),
      ...this.unsectioned,
    ];
  }

  taskFor(threadId) {
    return this.allTasks().find(
      (task) => taskThreadId(task) === threadId,
    ) ?? null;
  }

  recoveryFor(threadId) {
    return this.unsectioned.find(
      (task) => taskThreadId(task) === threadId && task?.recovery,
    ) ?? null;
  }

  replaceTaskInPlace(task) {
    const threadId = taskThreadId(task);
    for (const section of this.sections) {
      const index = section.tasks.findIndex(
        (candidate) => taskThreadId(candidate) === threadId,
      );
      if (index < 0) {
        continue;
      }
      section.tasks = section.tasks.map((candidate, candidateIndex) =>
        candidateIndex === index ? task : candidate,
      );
      return section.id;
    }
    const recoveryIndex = this.unsectioned.findIndex(
      (candidate) => taskThreadId(candidate) === threadId,
    );
    if (recoveryIndex < 0) {
      return "";
    }
    this.unsectioned = this.unsectioned.map((candidate, candidateIndex) =>
      candidateIndex === recoveryIndex ? task : candidate,
    );
    return "unsectioned";
  }

  listState() {
    this.ensureState();
    return {
      count: this.allTasks().length,
      loaded: this.taskListLoaded,
      loading: !this.codexOperationsBlocked &&
        (this.taskListLoading || !this.initialRequestSettled),
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
    const loading = !this.codexOperationsBlocked &&
      (this.taskListLoading || !this.initialRequestSettled);
    const taskCount = this.allTasks().length;
    let content;
    if (this.codexOperationsBlocked && !taskCount) {
      content = `<p class="task-section-message">${escapeHtml(this.codexTaskOperations.message)}</p>`;
    } else if (loading && !taskCount) {
      content = `<p class="task-section-message">Loading...</p>`;
    } else if (this.taskListError && !taskCount) {
      content = `
        <div class="task-section-message" role="alert">
          <p>${escapeHtml(this.taskListError.message)}</p>
          <button type="button" class="task-secondary-button" data-task-action="retry-task-list" ${this.codexOperationsBlocked ? "disabled" : ""}>Retry</button>
        </div>
      `;
    } else if (!taskCount) {
      content = `<p class="task-section-message">No Caffold tasks yet.</p>`;
    } else {
      const sections = [
        ...this.sections,
        ...(this.unsectioned.length
          ? [{
              id: "unsectioned",
              name: "Tasks awaiting Section recovery",
              label: "Recovery",
              repository: false,
              recovery: true,
              tasks: this.unsectioned,
            }]
          : []),
      ];
      content = `<ol class="task-repository-groups" data-task-section="managed">
        ${sections.map((section) => this.renderSection(section)).join("")}
      </ol>`;
    }
    this.innerHTML = content;
    initializeRunningSpinners(this);
    this.syncSelection();
    this.publishState();
  }

  renderSection(section) {
    const icon = section.recovery
      ? "CircleAlert"
      : section.repository
        ? "FolderGit2"
        : "Folder";
    const iconLabel = section.recovery
      ? "Section recovery"
      : section.repository
        ? "Git repository"
        : "Directory";
    const label = section.label ?? sectionLabel(section.name);
    return `
      <li class="task-repository-group" data-task-repository-key="${escapeHtml(section.id)}"${section.recovery ? ' data-task-recovery="true"' : ""}>
        <div class="task-repository-header" title="${escapeHtml(section.name)}">
          ${renderInlineIcon(icon, iconLabel, "task-repository-icon")}
          <span class="task-repository-label">${escapeHtml(label)}</span>
          <span class="task-repository-count">${section.tasks.length}</span>
        </div>
        <ol class="task-list">
          ${section.tasks.map((task) => this.renderTaskRow(task, section.id)).join("")}
        </ol>
      </li>
    `;
  }

  renderTaskRow(task, sectionId) {
    const threadId = taskThreadId(task);
    const transportState = this.streamState;
    const selected = threadId === this.selectedThreadId ? ` aria-current="true"` : "";
    const status =
      taskStatusView(task, transportState)?.status ?? taskThreadStatusType(task);
    const busy = status === "running" ? ` aria-busy="true"` : "";
    const unseen = Boolean(
      threadId && task?.unseen && threadId !== this.selectedThreadId,
    );
    const recoveryCopy = task?.recovery && task?.conversationAvailable === false
      ? recoveryReasonCopy(task.recovery.reason)
      : "";
    const meta = recoveryCopy
      ? `<span class="task-row-recovery-status" title="${escapeHtml(recoveryCopy)}">
          ${renderInlineIcon("TriangleAlert", recoveryCopy, "task-row-recovery-icon")}
        </span>`
      : unseen
      ? renderUnseenTaskRowMeta(task)
      : renderTaskRowMeta(task, transportState);
    const worktree = task?.worktree?.linked
      ? `<span class="task-row-worktree" title="${escapeHtml(taskWorktreeLabel(task))}">
          ${renderInlineIcon("GitBranch", "Linked worktree", "task-row-worktree-icon")}
        </span>`
      : "";
    const action = recoveryCopy ? "open-task-recovery" : "open-task";
    const title = this.codexOperationsBlocked
      ? this.codexTaskOperations.title
      : recoveryCopy ? `${task.title} — ${recoveryCopy}` : task.title;
    return `
      <li data-thread-id="${escapeHtml(threadId)}" data-task-list-key="${escapeHtml(sectionId)}">
        <button type="button" class="task-row" data-task-action="${action}" data-thread-id="${escapeHtml(threadId)}" data-task-status="${escapeHtml(status)}"${task?.recovery ? ` data-task-recovery-reason="${escapeHtml(task.recovery.reason ?? "")}"` : ""} title="${escapeHtml(title)}"${selected}${busy}${this.codexOperationsBlocked ? " disabled" : ""}>
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

}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeActiveSections(sections) {
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections
    .filter((section) => section && typeof section === "object")
    .map((section) => ({
      id: `${section.id ?? ""}`,
      name: `${section.name ?? ""}`,
      repository: Boolean(section.repository),
      tasks: normalizeTaskList(section.tasks),
    }))
    .filter((section) => section.id && section.tasks.length);
}

function normalizeTaskList(tasks) {
  return Array.isArray(tasks) ? tasks.filter(Boolean) : [];
}

function recoveryReasonCopy(reason) {
  return {
    codexArchived: "Archived in Codex",
    threadMissing: "Thread unavailable",
    temporarilyUnavailable: "Temporarily unavailable",
    sectionPlacementPending: "Section placement pending",
  }[reason] ?? "Recovery required";
}

function normalizeActiveTopPlacement(placement) {
  const section = placement?.section;
  const id = `${section?.id ?? ""}`;
  const name = `${section?.name ?? ""}`;
  if (!id || !section || typeof section !== "object") {
    return null;
  }
  const beforeThreadId = `${placement?.beforeThreadId ?? ""}`;
  return {
    section: {
      id,
      name,
      repository: Boolean(section.repository),
    },
    beforeThreadId: beforeThreadId || null,
  };
}

function sectionLabel(name) {
  return `${name ?? ""}`.split("/").filter(Boolean).at(-1) ?? "Directory";
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

if (!customElements.get("caffold-active-task-list")) {
  customElements.define("caffold-active-task-list", CaffoldActiveTaskList);
}
