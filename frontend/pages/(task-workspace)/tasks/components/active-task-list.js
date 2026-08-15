import { getTasks, reorderTask, taskListStreamUrl } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { PENDING_CODEX_TASK_OPERATIONS } from "../../codex-status.js";
import {
  TASK_TRANSPORT_STATE,
  isTaskTransportStale,
  taskThreadStatusType,
} from "../runtime-state.js";
import {
  taskThreadId,
} from "../task-list-model.js";
import { TaskStreamLifecycle } from "../stream.js";
import {
  ACTIVE_TASK_ROW_INTENT_EVENT,
} from "./active-task-list/components/row.js";

export const ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT =
  "caffold:active-task-list-initial-settled";
export const ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT =
  "caffold:active-task-list-archive-sync";
export const ACTIVE_TASK_LIST_STATE_EVENT = "caffold:active-task-list-state";

class CaffoldActiveTaskList extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.classList.add("task-list-section");
    this.dataset.taskSection = "managed";
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Caffold Tasks");
    this.addEventListener("click", this.boundClick);
    this.addEventListener(ACTIVE_TASK_ROW_INTENT_EVENT, this.boundRowIntent);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener(ACTIVE_TASK_ROW_INTENT_EVENT, this.boundRowIntent);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.taskListRequestId += 1;
    this.taskListLoadPromise = null;
    this.taskListLoading = false;
    this.cancelDrag();
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
    this.taskListLoadPromise = null;
    this.taskListRefreshPending = false;
    this.pendingTopPlacements = new Map();
    this.pendingRuntimeSnapshot = null;
    this.initialRequestSettled = false;
    this.selectedThreadId = "";
    this.selectedSectionId = "";
    this.revisionByThread = new Map();
    this.active = false;
    this.codexTaskOperations = PENDING_CODEX_TASK_OPERATIONS;
    this.reorderMode = false;
    this.pendingMove = null;
    this.reorderError = null;
    this.dragState = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundRowIntent = (event) => this.handleRowIntent(event);
    this.boundIconsReady = () => this.render();
    this.taskListStream = new TaskStreamLifecycle({
      createUrl: () => taskListStreamUrl(),
      eventTypes: [
        "task-removed",
        "task-updated",
        "task-placed-at-top",
        "task-list-refresh",
        "task-list-snapshot",
        "task-sync",
      ],
      onEvent: (type, event) => this.handleStreamEvent(type, event),
      onReconcile: (_contextKey, isCurrent, metadata) =>
        this.reconcileTaskList(isCurrent, metadata),
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
      this.closeStream();
    }
    this.render();
  }

  setSelectedThreadId(threadId) {
    this.setSelectedSubject(
      threadId ? { kind: "task", id: `${threadId}` } : null,
    );
  }

  setSelectedSubject(subject) {
    this.ensureState();
    const nextThreadId = subject?.kind === "task" ? `${subject.id ?? ""}` : "";
    const nextSectionId = subject?.kind === "section" ? `${subject.id ?? ""}` : "";
    if (
      this.selectedThreadId === nextThreadId &&
      this.selectedSectionId === nextSectionId
    ) {
      return;
    }
    this.selectedThreadId = nextThreadId;
    this.selectedSectionId = nextSectionId;
    this.syncRows();
    this.syncSectionSelection();
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
    const row = this.rowFor(threadId);
    if (!row) {
      this.render();
      return;
    }
    this.syncRow(row, nextTask, listKey);
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
    const context = this.sectionContext(threadId);
    const restoreHandleFocus = this.reorderMode &&
      this.rowComponentFor(threadId)?.contains(document.activeElement);
    if (this.dragState?.threadId === threadId) {
      this.cancelDrag();
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
    if (restoreHandleFocus) {
      const section = this.sections.find(
        (candidate) => candidate.id === context?.section.id,
      );
      const nextTask = section?.tasks[Math.min(
        context.index,
        section.tasks.length - 1,
      )];
      if (nextTask) {
        queueMicrotask(() =>
          this.rowComponentFor(taskThreadId(nextTask))?.focusHandle()
        );
      } else {
        this.dispatchEvent(
          new CustomEvent("caffold:active-task-list-focus-reorder-toggle", {
            bubbles: true,
          }),
        );
      }
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
    if (action.dataset.taskAction === "select-section") {
      if (!this.reorderMode) {
        this.dispatchIntent("select-section", {
          sectionId: action.dataset.sectionId,
        });
      }
      return;
    }
    if (action.dataset.taskAction === "retry-task-list") {
      void this.loadTasks({ force: true });
      return;
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

  setReorderMode(active) {
    this.ensureState();
    const next = Boolean(active);
    if (this.reorderMode === next) {
      return;
    }
    this.reorderMode = next;
    if (!next) {
      this.cancelDrag();
      this.reorderError = null;
    }
    this.renderAlerts();
    this.syncRows();
  }

  handleRowIntent(event) {
    if (!(event.target instanceof Element) || !this.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    const { type, threadId, direction, clientY } = event.detail ?? {};
    if (type === "select-task") {
      if (!this.reorderMode) {
        this.dispatchIntent("select-task", { threadId });
      }
      return;
    }
    if (type === "select-task-recovery") {
      if (!this.reorderMode) {
        const recovery = this.recoveryFor(threadId);
        if (recovery) {
          this.dispatchIntent("select-task-recovery", { threadId, recovery });
        }
      }
      return;
    }
    if (!this.reorderMode || this.pendingMove) {
      return;
    }
    if (type === "move") {
      this.moveByKeyboard(threadId, direction);
    } else if (type === "drag-start") {
      this.startDrag(threadId, clientY);
    } else if (type === "drag-move") {
      this.moveDrag(threadId, clientY);
    } else if (type === "drag-end") {
      this.endDrag(threadId);
    } else if (type === "drag-cancel") {
      this.cancelDrag();
    }
  }

  moveByKeyboard(threadId, direction) {
    const context = this.sectionContext(threadId);
    if (!context || !["up", "down"].includes(direction)) {
      return;
    }
    const { section, index } = context;
    if (direction === "up" && index === 0) {
      this.announce(`${context.task.title} is already first in ${sectionLabel(section.name)}.`);
      return;
    }
    if (direction === "down" && index === section.tasks.length - 1) {
      this.announce(`${context.task.title} is already last in ${sectionLabel(section.name)}.`);
      return;
    }
    const beforeThreadId = direction === "up"
      ? taskThreadId(section.tasks[index - 1])
      : taskThreadId(section.tasks[index + 2]) || null;
    void this.requestMove({ threadId, beforeThreadId });
  }

  startDrag(threadId) {
    const context = this.sectionContext(threadId);
    const row = this.rowFor(threadId);
    if (!context || !row) {
      return;
    }
    this.dragState = {
      threadId,
      sectionId: context.section.id,
      originalBeforeThreadId:
        taskThreadId(context.section.tasks[context.index + 1]) || null,
      beforeThreadId:
        taskThreadId(context.section.tasks[context.index + 1]) || null,
    };
  }

  moveDrag(threadId, clientY) {
    const drag = this.dragState;
    if (!drag || drag.threadId !== threadId || !Number.isFinite(clientY)) {
      return;
    }
    const source = this.rowFor(threadId);
    const list = source?.parentElement;
    if (!source || !list?.matches(".task-list")) {
      this.cancelDrag();
      return;
    }
    const candidates = [...list.children].filter((row) => row !== source);
    const before = candidates.find(
      (row) => clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2,
    ) ?? null;
    drag.beforeThreadId = before?.dataset.threadId || null;
    this.clearDragTarget(drag);
    if (before) {
      this.rowComponentFor(before.dataset.threadId)?.setAttribute(
        "data-task-drop-before",
        "",
      );
    } else {
      const last = candidates.at(-1) ?? source;
      this.rowComponentFor(last.dataset.threadId)?.setAttribute(
        "data-task-drop-after",
        "",
      );
    }
    this.autoScrollDrag(clientY);
  }

  endDrag(threadId) {
    const drag = this.dragState;
    if (!drag || drag.threadId !== threadId) {
      return;
    }
    this.dragState = null;
    this.clearDragTarget(drag);
    if (drag.beforeThreadId === drag.originalBeforeThreadId) {
      return;
    }
    void this.requestMove({
      threadId: drag.threadId,
      beforeThreadId: drag.beforeThreadId,
    });
  }

  cancelDrag() {
    const drag = this.dragState;
    this.dragState = null;
    if (!drag) {
      return;
    }
    this.clearDragTarget(drag);
  }

  clearDragTarget(drag) {
    if (!drag) {
      return;
    }
    const group = this.querySelector(
      `.task-repository-group[data-task-repository-key="${CSS.escape(drag.sectionId)}"]`,
    );
    for (const component of group?.querySelectorAll(
      "caffold-active-task-row[data-task-drop-before], caffold-active-task-row[data-task-drop-after]",
    ) ?? []) {
      component.removeAttribute("data-task-drop-before");
      component.removeAttribute("data-task-drop-after");
    }
  }

  autoScrollDrag(clientY) {
    const scroller = this.closest(".task-list-scroll");
    if (!scroller) {
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const edge = Math.min(48, bounds.height / 4);
    if (clientY < bounds.top + edge) {
      scroller.scrollBy({ top: -12 });
    } else if (clientY > bounds.bottom - edge) {
      scroller.scrollBy({ top: 12 });
    }
  }

  async requestMove({ threadId, beforeThreadId }) {
    if (!this.reorderMode || this.pendingMove) {
      return false;
    }
    const original = this.sectionContext(threadId);
    if (!original) {
      return false;
    }
    const originalOrder = original.section.tasks.map(taskThreadId);
    const changed = this.applyMoveToState(threadId, beforeThreadId);
    if (!changed) {
      return false;
    }
    const move = {
      threadId,
      beforeThreadId: beforeThreadId || null,
      sectionId: original.section.id,
      originalOrder,
      originalBeforeThreadId: originalOrder[original.index + 1] || null,
      optimistic: true,
    };
    this.pendingMove = move;
    this.reorderError = null;
    this.renderAlerts();
    this.syncRows();
    this.moveTaskRow(move.sectionId, threadId, move.beforeThreadId);

    try {
      await reorderTask(threadId, move.beforeThreadId);
      move.optimistic = false;
      await this.loadTasks({ force: true, requireFresh: true });
      if (this.reorderMode) {
        this.announceMoveResult(threadId);
      }
      return true;
    } catch {
      move.optimistic = false;
      this.restoreSectionOrder(
        move.sectionId,
        originalOrder,
        move.threadId,
        move.originalBeforeThreadId,
      );
      this.reorderError = this.reorderMode
        ? {
            taskTitle: original.task.title,
          }
        : null;
      this.render();
      await this.loadTasks({ force: true, requireFresh: true });
      return false;
    } finally {
      if (this.pendingMove === move) {
        this.pendingMove = null;
      }
      this.renderAlerts();
      this.syncRows();
      if (this.reorderMode) {
        queueMicrotask(() => this.rowComponentFor(threadId)?.focusHandle());
      }
    }
  }

  applyMoveToState(threadId, beforeThreadId) {
    const context = this.sectionContext(threadId);
    if (!context) {
      return false;
    }
    const tasks = [...context.section.tasks];
    const [task] = tasks.splice(context.index, 1);
    const destination = beforeThreadId
      ? tasks.findIndex((candidate) => taskThreadId(candidate) === beforeThreadId)
      : tasks.length;
    if (destination < 0) {
      return false;
    }
    tasks.splice(destination, 0, task);
    if (tasks.map(taskThreadId).join("\u0000") === context.section.tasks.map(taskThreadId).join("\u0000")) {
      return false;
    }
    context.section.tasks = tasks;
    return true;
  }

  restoreSectionOrder(
    sectionId,
    threadIds,
    movedThreadId,
    beforeThreadId,
  ) {
    const section = this.sections.find((candidate) => candidate.id === sectionId);
    if (!section) {
      return;
    }
    const positions = new Map(threadIds.map((threadId, index) => [threadId, index]));
    section.tasks = [...section.tasks].sort((left, right) => {
      const leftIndex = positions.get(taskThreadId(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = positions.get(taskThreadId(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
    this.moveTaskRow(sectionId, movedThreadId, beforeThreadId);
  }

  sectionContext(threadId) {
    for (const section of this.sections) {
      const index = section.tasks.findIndex(
        (task) => taskThreadId(task) === threadId,
      );
      if (index >= 0) {
        return { section, index, task: section.tasks[index] };
      }
    }
    return null;
  }

  announceMoveResult(threadId) {
    const context = this.sectionContext(threadId);
    if (!context) {
      return;
    }
    this.announce(
      `${context.task.title} moved to position ${context.index + 1} of ${context.section.tasks.length} in ${sectionLabel(context.section.name)}.`,
    );
  }

  announce(message) {
    const region = this.querySelector(":scope > .task-reorder-announcement");
    if (!region) {
      return;
    }
    region.textContent = "";
    queueMicrotask(() => {
      if (region.isConnected) {
        region.textContent = message;
      }
    });
  }

  async loadTasks({
    force = false,
    requireFresh = false,
    isCurrent = () => true,
  } = {}) {
    if (this.taskListLoaded && !force) {
      return {
        sections: this.sections,
        unsectioned: this.unsectioned,
      };
    }
    if (this.taskListLoadPromise) {
      if (force && requireFresh) {
        this.taskListRefreshPending = true;
      }
      return await this.taskListLoadPromise;
    }

    const request = this.performLoadTasks({ isCurrent });
    this.taskListLoadPromise = request;
    try {
      return await request;
    } finally {
      if (this.taskListLoadPromise === request) {
        this.taskListLoadPromise = null;
      }
      if (this.taskListRefreshPending && this.isConnected) {
        this.taskListRefreshPending = false;
        void this.loadTasks({ force: true });
      }
    }
  }

  async performLoadTasks({ isCurrent }) {
    const requestId = ++this.taskListRequestId;
    this.taskListLoading = true;
    this.taskListError = null;
    if (this.allTasks().length) {
      this.publishState();
    } else {
      this.render();
    }

    try {
      const response = await getTasks();
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      if (!isCurrent()) {
        this.taskListLoading = false;
        return null;
      }
      const runtimeByThread = new Map(
        this.allTasks().map((task) => [taskThreadId(task), task]),
      );
      this.sections = normalizeActiveSections(
        response.sections,
        runtimeByThread,
      );
      this.unsectioned = normalizeTaskList(response.unsectioned).map((task) =>
        mergeTaskRuntime(task, runtimeByThread.get(taskThreadId(task))),
      );
      if (this.pendingMove?.optimistic) {
        this.applyMoveToState(
          this.pendingMove.threadId,
          this.pendingMove.beforeThreadId,
        );
      }
      this.taskListLoading = false;
      this.taskListLoaded = true;
      for (const { task, placement } of this.pendingTopPlacements.values()) {
        this.applyCanonicalTopPlacement(task, placement);
      }
      this.pendingTopPlacements.clear();
      if (this.pendingRuntimeSnapshot) {
        this.applyRuntimeSnapshot(this.pendingRuntimeSnapshot);
        this.pendingRuntimeSnapshot = null;
      }
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

  suspendStream() {
    this.taskListStream.suspend();
  }

  async recoverForeground() {
    if (!this.active || !this.isConnected) {
      return { ok: true, skipped: true };
    }
    if (this.codexOperationsBlocked) {
      const response = await this.loadTasks({ force: true });
      if (!response) {
        throw this.taskListError ?? new Error("Caffold Task ledger unavailable.");
      }
      return { ok: true, transportSkipped: true };
    }
    const outcome = await this.taskListStream.recover("task-list");
    if (!outcome.ok && !outcome.stale) {
      throw outcome.error ?? new Error("Task list recovery failed.");
    }
    return outcome;
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
    if (type === "task-list-snapshot") {
      const snapshot = parseJson(event.data);
      if (Array.isArray(snapshot?.tasks)) {
        this.applyRuntimeSnapshot(snapshot.tasks);
      }
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

  applyRuntimeSnapshot(tasks) {
    if (!this.taskListLoaded) {
      this.pendingRuntimeSnapshot = tasks;
      return;
    }
    for (const task of normalizeTaskList(tasks)) {
      this.upsertCanonicalTask(task);
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

  async reconcileTaskList(isCurrent, { recovery = false } = {}) {
    if (recovery && isCurrent()) {
      this.revisionByThread.clear();
    }
    const response = await this.loadTasks({ force: true, isCurrent });
    if (!isCurrent()) {
      return null;
    }
    if (!response) {
      throw this.taskListError ?? new Error("Caffold Task ledger unavailable.");
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
    this.taskListStream.retry({ reconcile: false });
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

  sectionFor(sectionId) {
    const section = this.sections.find(
      (candidate) => candidate.id === `${sectionId ?? ""}`,
    );
    return section
      ? {
          id: section.id,
          name: section.name,
          repository: section.repository,
        }
      : null;
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
      loading: this.taskListLoading || !this.initialRequestSettled,
      error: this.taskListError?.message ?? "",
      selectedSection: this.sectionFor(this.selectedSectionId),
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
    this.ensureDom();
    this.renderAlerts();
    const loading = this.taskListLoading || !this.initialRequestSettled;
    const taskCount = this.allTasks().length;
    const content = this.querySelector(":scope > .task-list-content");
    if (loading && !taskCount) {
      this.showLoading(content);
    } else if (this.taskListError && !taskCount) {
      this.showLoadError(content, this.taskListError.message);
    } else if (!taskCount) {
      this.showEmpty(content);
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
      this.reconcileSections(content, sections);
    }
    this.publishState();
  }

  showLoading(content) {
    if (
      content.childElementCount === 1 &&
      content.firstElementChild?.matches(
        ".task-section-message.task-section-loading",
      )
    ) {
      return;
    }
    const message = document.createElement("p");
    message.className = "task-section-message task-section-loading";
    message.textContent = "Loading...";
    content.replaceChildren(message);
  }

  showLoadError(content, message) {
    let panel = content.firstElementChild;
    if (
      content.childElementCount !== 1 ||
      !panel?.matches(
        ".task-section-message.task-section-load-error",
      )
    ) {
      panel = document.createElement("div");
      panel.className = "task-section-message task-section-load-error";
      panel.setAttribute("role", "alert");
      const copy = document.createElement("p");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "task-secondary-button";
      retry.dataset.taskAction = "retry-task-list";
      retry.textContent = "Retry";
      panel.append(copy, retry);
      content.replaceChildren(panel);
    }
    const copy = panel.querySelector(":scope > p");
    if (copy.textContent !== message) {
      copy.textContent = message;
    }
  }

  showEmpty(content) {
    if (
      content.childElementCount === 1 &&
      content.firstElementChild?.matches(
        ".task-section-message.task-section-empty",
      )
    ) {
      return;
    }
    const message = document.createElement("p");
    message.className = "task-section-message task-section-empty";
    message.textContent = "No Caffold tasks yet.";
    content.replaceChildren(message);
  }

  ensureDom() {
    if (
      this.querySelector(":scope > .task-list-alerts") &&
      this.querySelector(":scope > .task-list-content") &&
      this.querySelector(":scope > .task-reorder-announcement")
    ) {
      return;
    }
    this.innerHTML = `
      <div class="task-list-alerts"></div>
      <div class="task-list-content"></div>
      <p class="sr-only task-reorder-announcement" aria-live="polite" aria-atomic="true"></p>
    `;
  }

  renderAlerts() {
    const alerts = this.querySelector(":scope > .task-list-alerts");
    if (!alerts) {
      return;
    }
    alerts.innerHTML = `
      ${this.reorderMode && this.reorderError ? `
        <div class="task-reorder-error" role="alert">
          <span aria-hidden="true">Move wasn't saved. Move it again to retry.</span>
          <span class="sr-only">Could not move ${escapeHtml(this.reorderError.taskTitle)}. The saved order was restored. Move it again to retry.</span>
        </div>
      ` : ""}
    `;
  }

  reconcileSections(content, sections) {
    let groups = content.querySelector(":scope > .task-repository-groups");
    if (!groups) {
      content.replaceChildren();
      groups = document.createElement("ol");
      groups.className = "task-repository-groups";
      groups.dataset.taskSection = "managed";
      content.append(groups);
    }
    const existingGroups = new Map(
      [...groups.querySelectorAll(":scope > .task-repository-group")]
        .map((group) => [group.dataset.taskRepositoryKey, group]),
    );
    const existingRows = new Map(
      [...groups.querySelectorAll("li[data-thread-id]")]
        .map((row) => [row.dataset.threadId, row]),
    );
    const projectedThreadIds = new Set(
      sections.flatMap((section) => section.tasks.map(taskThreadId)),
    );
    for (const [threadId, row] of existingRows) {
      if (!projectedThreadIds.has(threadId)) {
        row.remove();
        existingRows.delete(threadId);
      }
    }
    const projectedSectionIds = new Set(sections.map((section) => section.id));
    const nextProjectedGroup = (start) => {
      let group = start;
      while (
        group &&
        !projectedSectionIds.has(group.dataset.taskRepositoryKey)
      ) {
        group = group.nextElementSibling;
      }
      return group;
    };
    let nextGroup = nextProjectedGroup(groups.firstElementChild);
    for (const section of sections) {
      let group = existingGroups.get(section.id);
      if (!group) {
        group = document.createElement("li");
        group.className = "task-repository-group";
        group.innerHTML = `<ol class="task-list"></ol>`;
      }
      group.dataset.taskRepositoryKey = section.id;
      group.toggleAttribute("data-task-recovery", Boolean(section.recovery));
      this.syncSectionHeader(group, section);
      const list = group.querySelector(":scope > .task-list");
      const sectionThreadIds = new Set(section.tasks.map(taskThreadId));
      const nextSectionRow = (start) => {
        let row = start;
        while (row && !sectionThreadIds.has(row.dataset.threadId)) {
          row = row.nextElementSibling;
        }
        return row;
      };
      let nextRow = nextSectionRow(list.firstElementChild);
      for (const task of section.tasks) {
        const threadId = taskThreadId(task);
        let row = existingRows.get(threadId);
        if (!row) {
          row = document.createElement("li");
        }
        row.dataset.threadId = threadId;
        row.dataset.taskListKey = section.id;
        this.syncRow(row, task, section.id);
        if (row === nextRow) {
          nextRow = nextSectionRow(nextRow.nextElementSibling);
        } else {
          this.moveListItemBefore(list, row, nextRow);
        }
      }
      if (group === nextGroup) {
        nextGroup = nextProjectedGroup(nextGroup.nextElementSibling);
      } else {
        this.moveListItemBefore(groups, group, nextGroup);
      }
      existingGroups.delete(section.id);
    }
    for (const group of existingGroups.values()) {
      group.remove();
    }
  }

  syncSectionHeader(group, section) {
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
    const expectedTag = section.recovery ? "DIV" : "BUTTON";
    let header = group.querySelector(":scope > .task-repository-header");
    if (header?.tagName !== expectedTag) {
      const next = document.createElement(expectedTag.toLowerCase());
      next.className = "task-repository-header";
      if (next instanceof HTMLButtonElement) {
        next.type = "button";
        next.dataset.taskAction = "select-section";
      }
      group.insertBefore(next, group.querySelector(":scope > .task-list"));
      header?.remove();
      header = next;
    }
    if (!section.recovery) {
      header.dataset.sectionId = section.id;
      header.setAttribute(
        "aria-current",
        this.selectedSectionId === section.id ? "page" : "false",
      );
    }
    if (header.title !== section.name) {
      header.title = section.name;
    }
    let labelElement = header.querySelector(
      ":scope > .task-repository-label",
    );
    let countElement = header.querySelector(
      ":scope > .task-repository-count",
    );
    if (!labelElement || !countElement) {
      header.replaceChildren();
      labelElement = document.createElement("span");
      labelElement.className = "task-repository-label";
      countElement = document.createElement("span");
      countElement.className = "task-repository-count";
      header.append(labelElement, countElement);
    }
    if (labelElement.textContent !== label) {
      labelElement.textContent = label;
    }
    const count = `${section.tasks.length}`;
    if (countElement.textContent !== count) {
      countElement.textContent = count;
    }

    const iconMarkup = renderInlineIcon(
      icon,
      iconLabel,
      "task-repository-icon",
    );
    const iconChanged = header.dataset.taskRepositoryIcon !== icon;
    const iconBecameAvailable =
      iconMarkup.includes("task-repository-icon") &&
      !header.querySelector(":scope > .task-repository-icon");
    if (iconChanged || iconBecameAvailable) {
      while (header.firstChild && header.firstChild !== labelElement) {
        header.firstChild.remove();
      }
      const template = document.createElement("template");
      template.innerHTML = iconMarkup;
      header.insertBefore(template.content, labelElement);
      header.dataset.taskRepositoryIcon = icon;
    }
  }

  syncRow(row, task, sectionId) {
    let component = row.querySelector(":scope > caffold-active-task-row");
    if (!component) {
      component = document.createElement("caffold-active-task-row");
      row.replaceChildren(component);
    }
    component.setSnapshot({
      task,
      selectedThreadId: this.selectedThreadId,
      transportState: this.streamState,
      codexTaskOperations: this.codexTaskOperations,
      reorderMode: this.reorderMode,
      reorderable: sectionId !== "unsectioned" && !task?.recovery,
      pending: Boolean(this.pendingMove),
    });
  }

  syncRows() {
    for (const section of this.sections) {
      for (const task of section.tasks) {
        const row = this.rowFor(taskThreadId(task));
        if (row) {
          this.syncRow(row, task, section.id);
        }
      }
    }
    for (const task of this.unsectioned) {
      const row = this.rowFor(taskThreadId(task));
      if (row) {
        this.syncRow(row, task, "unsectioned");
      }
    }
  }

  syncSectionSelection() {
    for (const header of this.querySelectorAll(
      ":scope > .task-list-content .task-repository-header[data-section-id]",
    )) {
      header.setAttribute(
        "aria-current",
        header.dataset.sectionId === this.selectedSectionId ? "page" : "false",
      );
    }
  }

  rowFor(threadId) {
    if (!threadId) {
      return null;
    }
    return this.querySelector(`li[data-thread-id="${CSS.escape(threadId)}"]`);
  }

  rowComponentFor(threadId) {
    return this.rowFor(threadId)?.querySelector(
      ":scope > caffold-active-task-row",
    ) ?? null;
  }

  moveTaskRow(sectionId, threadId, beforeThreadId) {
    const list = this.querySelector(
      `.task-repository-group[data-task-repository-key="${CSS.escape(sectionId)}"] > .task-list`,
    );
    const row = this.rowFor(threadId);
    const before = beforeThreadId ? this.rowFor(beforeThreadId) : null;
    if (
      !list ||
      row?.parentElement !== list ||
      (beforeThreadId && before?.parentElement !== list) ||
      row.nextElementSibling === before ||
      (!before && row === list.lastElementChild)
    ) {
      return;
    }
    this.moveListItemBefore(list, row, before);
  }

  moveListItemBefore(parent, item, before) {
    if (
      typeof parent.moveBefore === "function" &&
      parent.isConnected &&
      item.isConnected
    ) {
      parent.moveBefore(item, before);
    } else {
      parent.insertBefore(item, before);
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

const TASK_RUNTIME_FIELDS = Object.freeze([
  "conversationAvailable",
  "preview",
  "threadStatus",
  "latestTurnStatus",
  "activeTurn",
  "cwd",
  "cwdPath",
  "relativeCwd",
  "worktree",
  "createdMs",
  "updatedMs",
  "lastEventSummary",
]);

function normalizeActiveSections(sections, runtimeByThread = new Map()) {
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections
    .filter((section) => section && typeof section === "object")
    .map((section) => ({
      id: `${section.id ?? ""}`,
      name: `${section.name ?? ""}`,
      repository: Boolean(section.repository),
      tasks: normalizeTaskList(section.tasks).map((task) =>
        mergeTaskRuntime(task, runtimeByThread.get(taskThreadId(task))),
      ),
    }))
    .filter((section) => section.id && section.tasks.length);
}

function mergeTaskRuntime(cached, runtime) {
  if (
    !runtime ||
    cached?.recovery ||
    taskThreadStatusType(cached) !== "notLoaded"
  ) {
    return cached;
  }
  const merged = { ...cached };
  for (const field of TASK_RUNTIME_FIELDS) {
    if (Object.hasOwn(runtime, field)) {
      merged[field] = runtime[field];
    }
  }
  return merged;
}

function normalizeTaskList(tasks) {
  return Array.isArray(tasks) ? tasks.filter(Boolean) : [];
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

if (!customElements.get("caffold-active-task-list")) {
  customElements.define("caffold-active-task-list", CaffoldActiveTaskList);
}
