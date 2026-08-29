import {
  getTasks,
  reorderSection,
  reorderTask,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { taskStoreOperationsPresentation } from "../../codex-status.js";
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
  ACTIVE_TASK_SECTION_INTENT_EVENT,
  activeTaskSectionLabel,
} from "./active-task-list/components/section.js";

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
    this.addEventListener(
      ACTIVE_TASK_SECTION_INTENT_EVENT,
      this.boundSectionIntent,
    );
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener(
      ACTIVE_TASK_SECTION_INTENT_EVENT,
      this.boundSectionIntent,
    );
    this.taskListRequestId += 1;
    this.taskListLoadPromise = null;
    this.taskListLoading = false;
    this.cancelDrag();
    this.cancelSectionDrag();
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
    this.taskOperations = taskStoreOperationsPresentation(null);
    this.reorderMode = "none";
    this.pendingMove = null;
    this.reorderError = null;
    this.dragState = null;
    this.sectionDragState = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundSectionIntent = (event) => this.handleSectionIntent(event);
    this.taskListStream = new TaskStreamLifecycle({
      subscribe: (_contextKey, listener) => {
        if (!this.liveUpdates) {
          throw new Error("Workspace live updates are unavailable.");
        }
        return this.liveUpdates.subscribeTaskList(listener);
      },
      onEvent: (type, event) => this.handleStreamEvent(type, event),
      onReconcile: (_contextKey, isCurrent, metadata) =>
        this.reconcileTaskList(isCurrent, metadata),
      onStateChange: (state, previousState) =>
        this.handleStreamStateChange(state, previousState),
    });
  }

  async activate({ force = false } = {}) {
    this.ensureState();
    this.active = true;
    return await this.loadTasks({ force });
  }

  setLiveUpdates(liveUpdates) {
    this.ensureState();
    this.liveUpdates = liveUpdates ?? null;
  }

  get taskOperationsBlocked() {
    return this.taskOperations?.blocked !== false;
  }

  setTaskOperations(presentation) {
    this.ensureState();
    if (this.taskOperations?.key === presentation.key) {
      return;
    }
    const becameBlocked =
      this.taskOperations?.blocked === false && presentation.blocked;
    this.taskOperations = presentation;
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
    this.syncSections();
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
    const currentTask = this.taskFor(threadId);
    const canonicalTask = currentTask?.recovery && !task?.recovery
      ? currentTask
      : task;
    const nextTask =
      threadId === this.selectedThreadId
        ? { ...canonicalTask, unseen: false }
        : canonicalTask;
    const listKey = this.replaceTaskInPlace(nextTask);
    if (!listKey) {
      return;
    }
    const section = this.sectionComponentFor(listKey);
    if (!section?.updateTask(nextTask)) {
      this.render();
      return;
    }
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
    const withoutTarget = remainingSections.filter(
      (section) => section.id !== targetId,
    );
    const destination = placement.beforeSectionId
      ? withoutTarget.findIndex(
          (section) => section.id === placement.beforeSectionId,
        )
      : withoutTarget.length;
    withoutTarget.splice(destination < 0 ? 0 : destination, 0, target);
    this.sections = withoutTarget;
    this.unsectioned = this.unsectioned.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
  }

  removeTask(threadId) {
    if (!threadId || !this.taskListLoaded) {
      return;
    }
    const context = this.sectionContext(threadId);
    const restoreHandleFocus = this.reorderMode === "tasks" &&
      this.sectionComponentFor(context?.section.id)?.containsTaskHandleFocus(
        threadId,
        document.activeElement,
      );
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
          this.sectionComponentFor(section.id)?.focusTaskHandle(
            taskThreadId(nextTask),
          )
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
    if (action.dataset.taskAction === "retry-task-list") {
      void this.loadTasks({ force: true });
    }
  }

  handleSectionIntent(event) {
    if (!(event.target instanceof Element) || !this.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    const detail = event.detail ?? {};
    if (detail.subject === "task") {
      this.handleTaskIntent(detail);
      return;
    }
    const { type, sectionId, direction, clientY } = detail;
    if (type === "select-section") {
      if (this.reorderMode === "none") {
        this.dispatchIntent("select-section", { sectionId });
      }
      return;
    }
    if (this.reorderMode !== "sections" || this.pendingMove) {
      return;
    }
    if (type === "move") {
      this.moveSectionByKeyboard(sectionId, direction);
    } else if (type === "drag-start") {
      this.startSectionDrag(sectionId);
      this.moveSectionDrag(clientY);
    } else if (type === "drag-move") {
      this.moveSectionDrag(clientY);
    } else if (type === "drag-end") {
      this.endSectionDrag();
    } else if (type === "drag-cancel") {
      this.cancelSectionDrag();
    }
  }

  moveSectionByKeyboard(sectionId, direction) {
    const context = this.sectionContextById(sectionId);
    if (!context || !["up", "down"].includes(direction)) {
      return;
    }
    if (direction === "up" && context.index === 0) {
      this.announce(
        `${activeTaskSectionLabel(context.section.name)} is already first.`,
      );
      return;
    }
    if (direction === "down" && context.index === this.sections.length - 1) {
      this.announce(
        `${activeTaskSectionLabel(context.section.name)} is already last.`,
      );
      return;
    }
    const beforeSectionId = direction === "up"
      ? this.sections[context.index - 1].id
      : this.sections[context.index + 2]?.id ?? null;
    void this.requestSectionMove({ sectionId, beforeSectionId });
  }

  startSectionDrag(sectionId) {
    const context = this.sectionContextById(sectionId);
    if (!context) {
      return;
    }
    this.sectionDragState = {
      sectionId,
      originalBeforeSectionId: this.sections[context.index + 1]?.id ?? null,
      beforeSectionId: this.sections[context.index + 1]?.id ?? null,
    };
  }

  moveSectionDrag(clientY) {
    const drag = this.sectionDragState;
    if (!drag || !Number.isFinite(clientY)) {
      return;
    }
    const source = this.groupFor(drag.sectionId);
    const groups = source?.parentElement;
    if (!source || !groups?.matches(".task-repository-groups")) {
      this.cancelSectionDrag();
      return;
    }
    const candidates = [...groups.children].filter(
      (group) => group !== source && !group.hasAttribute("data-task-recovery"),
    );
    const before = candidates.find((group) => {
      const bounds = group.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2;
    }) ?? null;
    drag.beforeSectionId = before?.dataset.taskRepositoryKey ?? null;
    this.clearSectionDragTarget();
    if (before) {
      this.sectionComponentFor(
        before.dataset.taskRepositoryKey,
      )?.setDropPosition("before");
    } else {
      this.sectionComponentFor(
        (candidates.at(-1) ?? source).dataset.taskRepositoryKey,
      )?.setDropPosition("after");
    }
    this.autoScrollDrag(clientY);
  }

  endSectionDrag() {
    const drag = this.sectionDragState;
    this.sectionDragState = null;
    this.clearSectionDragTarget();
    if (!drag || drag.beforeSectionId === drag.originalBeforeSectionId) {
      return;
    }
    void this.requestSectionMove(drag);
  }

  cancelSectionDrag() {
    const drag = this.sectionDragState;
    this.sectionDragState = null;
    this.clearSectionDragTarget();
    this.sectionComponentFor(drag?.sectionId)?.cancelPointerGesture({
      announce: false,
    });
  }

  clearSectionDragTarget() {
    for (const section of this.querySelectorAll(
      "caffold-active-task-section[data-section-drop-before], caffold-active-task-section[data-section-drop-after]",
    )) {
      section.setDropPosition();
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

  setReorderMode(mode, { revealTasks = false } = {}) {
    this.ensureState();
    const next = normalizeReorderMode(mode);
    if (this.reorderMode === next) {
      return;
    }
    const anchor = this.captureScrollAnchor();
    this.reorderMode = next;
    this.dataset.reorderMode = next;
    if (next === "sections") {
      this.removeAttribute("data-task-reveal");
    } else if (revealTasks) {
      this.setAttribute("data-task-reveal", "");
    } else {
      this.removeAttribute("data-task-reveal");
    }
    this.cancelDrag();
    this.cancelSectionDrag();
    if (next === "none") {
      this.reorderError = null;
    }
    this.render();
    this.restoreScrollAnchor(anchor);
  }

  containsReorderFocus(element) {
    return [...this.querySelectorAll("caffold-active-task-section")]
      .some((section) => section.containsReorderFocus(element));
  }

  handleTaskIntent({ type, threadId, direction, clientY } = {}) {
    if (type === "select-task") {
      if (this.reorderMode === "none") {
        this.dispatchIntent("select-task", { threadId });
      }
      return;
    }
    if (type === "select-task-recovery") {
      if (this.reorderMode === "none") {
        const recovery = this.recoveryFor(threadId);
        if (recovery) {
          this.dispatchIntent("select-task-recovery", { threadId, recovery });
        }
      }
      return;
    }
    if (this.reorderMode !== "tasks" || this.pendingMove) {
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
      this.announce(
        `${context.task.title} is already first in ${activeTaskSectionLabel(section.name)}.`,
      );
      return;
    }
    if (direction === "down" && index === section.tasks.length - 1) {
      this.announce(
        `${context.task.title} is already last in ${activeTaskSectionLabel(section.name)}.`,
      );
      return;
    }
    const beforeThreadId = direction === "up"
      ? taskThreadId(section.tasks[index - 1])
      : taskThreadId(section.tasks[index + 2]) || null;
    void this.requestMove({ threadId, beforeThreadId });
  }

  startDrag(threadId) {
    const context = this.sectionContext(threadId);
    if (
      !context ||
      !this.sectionComponentFor(context.section.id)?.hasTaskRow(threadId)
    ) {
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
    const beforeThreadId = this.sectionComponentFor(drag.sectionId)
      ?.updateTaskDropTarget(threadId, clientY);
    if (beforeThreadId === undefined) {
      this.cancelDrag();
      return;
    }
    drag.beforeThreadId = beforeThreadId;
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
    this.sectionComponentFor(drag.sectionId)?.clearTaskDropTarget();
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
    if (this.reorderMode !== "tasks" || this.pendingMove) {
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
      kind: "task",
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
    this.syncSections();
    this.moveTaskRow(move.sectionId, threadId, move.beforeThreadId);

    try {
      await reorderTask(threadId, move.beforeThreadId);
      move.optimistic = false;
      await this.loadTasks({ force: true, requireFresh: true });
      if (this.reorderMode === "tasks") {
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
      this.reorderError = this.reorderMode === "tasks"
        ? {
            subjectTitle: original.task.title,
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
      this.syncSections();
      if (this.reorderMode === "tasks") {
        queueMicrotask(() =>
          this.sectionComponentFor(move.sectionId)?.focusTaskHandle(threadId)
        );
      }
    }
  }

  async requestSectionMove({ sectionId, beforeSectionId }) {
    if (this.reorderMode !== "sections" || this.pendingMove) {
      return false;
    }
    const original = this.sectionContextById(sectionId);
    if (!original) {
      return false;
    }
    const originalOrder = this.sections.map((section) => section.id);
    if (!this.applySectionMoveToState(sectionId, beforeSectionId)) {
      return false;
    }
    const move = {
      kind: "section",
      sectionId,
      beforeSectionId: beforeSectionId || null,
      originalOrder,
      originalBeforeSectionId: originalOrder[original.index + 1] || null,
      optimistic: true,
    };
    this.pendingMove = move;
    this.reorderError = null;
    this.renderAlerts();
    this.syncSections();
    this.moveSectionGroup(sectionId, move.beforeSectionId);

    try {
      await reorderSection(sectionId, move.beforeSectionId);
      move.optimistic = false;
      await this.loadTasks({ force: true, requireFresh: true });
      if (this.reorderMode === "sections") {
        this.announceSectionMoveResult(sectionId);
      }
      return true;
    } catch {
      move.optimistic = false;
      this.restoreSectionOrderByIds(
        originalOrder,
        move.sectionId,
        move.originalBeforeSectionId,
      );
      this.reorderError = this.reorderMode === "sections"
        ? { subjectTitle: activeTaskSectionLabel(original.section.name) }
        : null;
      this.render();
      await this.loadTasks({ force: true, requireFresh: true });
      return false;
    } finally {
      if (this.pendingMove === move) {
        this.pendingMove = null;
      }
      this.renderAlerts();
      this.syncSections();
      if (this.reorderMode === "sections") {
        queueMicrotask(() =>
          this.sectionComponentFor(sectionId)?.focusHandle()
        );
      }
    }
  }

  applySectionMoveToState(sectionId, beforeSectionId) {
    const context = this.sectionContextById(sectionId);
    if (!context) {
      return false;
    }
    const sections = [...this.sections];
    const [section] = sections.splice(context.index, 1);
    const destination = beforeSectionId
      ? sections.findIndex((candidate) => candidate.id === beforeSectionId)
      : sections.length;
    if (destination < 0) {
      return false;
    }
    sections.splice(destination, 0, section);
    if (
      sections.map((candidate) => candidate.id).join("\u0000") ===
      this.sections.map((candidate) => candidate.id).join("\u0000")
    ) {
      return false;
    }
    this.sections = sections;
    return true;
  }

  restoreSectionOrderByIds(sectionIds, movedSectionId, beforeSectionId) {
    const positions = new Map(sectionIds.map((sectionId, index) => [sectionId, index]));
    this.sections = [...this.sections].sort(
      (left, right) =>
        (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
    this.moveSectionGroup(movedSectionId, beforeSectionId);
  }

  sectionContextById(sectionId) {
    const index = this.sections.findIndex((section) => section.id === sectionId);
    return index >= 0 ? { section: this.sections[index], index } : null;
  }

  announceSectionMoveResult(sectionId) {
    const context = this.sectionContextById(sectionId);
    if (!context) {
      return;
    }
    this.announce(
      `Section ${activeTaskSectionLabel(context.section.name)} moved to position ${context.index + 1} of ${this.sections.length}.`,
    );
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
      `${context.task.title} moved to position ${context.index + 1} of ${context.section.tasks.length} in ${activeTaskSectionLabel(context.section.name)}.`,
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
        if (this.pendingMove.kind === "section") {
          this.applySectionMoveToState(
            this.pendingMove.sectionId,
            this.pendingMove.beforeSectionId,
          );
        } else {
          this.applyMoveToState(
            this.pendingMove.threadId,
            this.pendingMove.beforeThreadId,
          );
        }
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
    if (this.taskOperationsBlocked || !this.active || !this.isConnected) {
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
    if (this.taskOperationsBlocked) {
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
    if (type === "section-composer-settings") {
      const update = parseJson(event.data);
      this.updateSectionComposerSettings(
        update?.sectionId,
        update?.composerSettings,
      );
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
    const task = message?.task;
    if (
      task &&
      message?.threadId === taskThreadId(task) &&
      this.acceptRevision(message.threadId, message.revision)
    ) {
      this.upsertCanonicalTask(task);
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

  updateSectionComposerSettings(sectionId, composerSettings) {
    if (!this.taskListLoaded) {
      return false;
    }
    const section = this.sections.find(
      (candidate) => candidate.id === `${sectionId ?? ""}`,
    );
    const normalized = normalizeComposerSettings(composerSettings);
    if (!section || !normalized) {
      return false;
    }
    if (JSON.stringify(section.composerSettings) === JSON.stringify(normalized)) {
      return false;
    }
    section.composerSettings = normalized;
    this.publishState();
    return true;
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
    this.liveUpdates?.retry();
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
          composerSettings: section.composerSettings
            ? { ...section.composerSettings }
            : null,
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
    const selectedRecovery = this.recoveryFor(this.selectedThreadId);
    return {
      count: this.allTasks().length,
      loaded: this.taskListLoaded,
      loading: this.taskListLoading || !this.initialRequestSettled,
      error: this.taskListError?.message ?? "",
      selectedSection: this.sectionFor(this.selectedSectionId),
      selectedRecovery: selectedRecovery
        ? {
            threadId: taskThreadId(selectedRecovery),
            title: selectedRecovery.title,
            reason: selectedRecovery.recovery.reason,
            actions: selectedRecovery.recovery.actions,
          }
        : null,
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
      this.reconcileSections(content, this.projectedSections());
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
      ${this.reorderMode !== "none" && this.reorderError ? `
        <div class="task-reorder-error" role="alert">
          <span aria-hidden="true">Move wasn't saved. Move it again to retry.</span>
          <span class="sr-only">Could not move ${escapeHtml(this.reorderError.subjectTitle)}. The saved order was restored. Move it again to retry.</span>
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
    const tasksBySection = new Map(
      sections.map((section) => [
        section.id,
        new Set(section.tasks.map(taskThreadId)),
      ]),
    );
    const projectedThreadIds = new Set(
      sections.flatMap((section) => section.tasks.map(taskThreadId)),
    );
    const availableRows = new Map();
    for (const group of existingGroups.values()) {
      const component = group.querySelector(
        ":scope > caffold-active-task-section",
      );
      const localThreadIds = tasksBySection.get(
        group.dataset.taskRepositoryKey,
      ) ?? new Set();
      for (const [threadId, row] of component?.transferableRows(
        localThreadIds,
        projectedThreadIds,
      ) ?? []) {
        availableRows.set(threadId, row);
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
      }
      group.dataset.taskRepositoryKey = section.id;
      group.toggleAttribute("data-task-recovery", Boolean(section.recovery));
      if (group === nextGroup) {
        nextGroup = nextProjectedGroup(nextGroup.nextElementSibling);
      } else {
        this.moveListItemBefore(groups, group, nextGroup);
      }
      this.syncSectionElement(group, section, {
        availableRows,
        prune: false,
      });
      existingGroups.delete(section.id);
    }
    for (const group of existingGroups.values()) {
      group.remove();
    }
    for (const component of groups.querySelectorAll(
      ":scope > .task-repository-group > caffold-active-task-section",
    )) {
      component.pruneRows();
    }
  }

  syncSectionElement(group, section, options) {
    let component = group.querySelector(
      ":scope > caffold-active-task-section",
    );
    if (!component) {
      component = document.createElement("caffold-active-task-section");
      group.replaceChildren(component);
    }
    component.setSnapshot({
      section,
      selectedSectionId: this.selectedSectionId,
      selectedThreadId: this.selectedThreadId,
      transportState: this.streamState,
      taskOperations: this.taskOperations,
      reorderMode: this.reorderMode,
      pending: Boolean(this.pendingMove),
    }, options);
  }

  projectedSections() {
    return [
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
  }

  syncSections() {
    for (const section of this.projectedSections()) {
      this.syncSection(section.id);
    }
  }

  syncSection(sectionId) {
    const section = this.projectedSections().find(
      (candidate) => candidate.id === sectionId,
    );
    const group = this.groupFor(sectionId);
    if (section && group) {
      this.syncSectionElement(group, section);
    }
  }

  groupFor(sectionId) {
    if (!sectionId) {
      return null;
    }
    return this.querySelector(
      `.task-repository-group[data-task-repository-key="${CSS.escape(sectionId)}"]`,
    );
  }

  sectionComponentFor(sectionId) {
    return this.groupFor(sectionId)?.querySelector(
      ":scope > caffold-active-task-section",
    ) ?? null;
  }

  moveSectionGroup(sectionId, beforeSectionId) {
    const group = this.groupFor(sectionId);
    const parent = group?.parentElement;
    const before = beforeSectionId ? this.groupFor(beforeSectionId) : null;
    const recovery = parent?.querySelector(
      ":scope > .task-repository-group[data-task-recovery]",
    ) ?? null;
    const destination = before ?? recovery;
    if (
      !parent?.matches(".task-repository-groups") ||
      !group ||
      (beforeSectionId && before?.parentElement !== parent) ||
      group.nextElementSibling === destination ||
      (!destination && group === parent.lastElementChild)
    ) {
      return;
    }
    this.moveListItemBefore(parent, group, destination);
  }

  captureScrollAnchor() {
    const scroller = this.closest(".task-list-scroll");
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const groups = [...this.querySelectorAll(
      ":scope > .task-list-content .task-repository-group:not([data-task-recovery])",
    )];
    const group = groups.find(
      (candidate) => candidate.getBoundingClientRect().bottom > scrollerTop,
    ) ?? groups[0];
    return group
      ? {
          sectionId: group.dataset.taskRepositoryKey,
          offset: group.getBoundingClientRect().top - scrollerTop,
        }
      : null;
  }

  restoreScrollAnchor(anchor) {
    if (!anchor) {
      return;
    }
    requestAnimationFrame(() => {
      const scroller = this.closest(".task-list-scroll");
      const group = this.groupFor(anchor.sectionId);
      if (!scroller || !group) {
        return;
      }
      const nextOffset = group.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      scroller.scrollTop += nextOffset - anchor.offset;
    });
  }

  moveTaskRow(sectionId, threadId, beforeThreadId) {
    this.sectionComponentFor(sectionId)?.moveTaskRow(
      threadId,
      beforeThreadId,
    );
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
      composerSettings: normalizeComposerSettings(section.composerSettings),
      tasks: normalizeTaskList(section.tasks).map((task) =>
        mergeTaskRuntime(task, runtimeByThread.get(taskThreadId(task))),
      ),
    }))
    .filter((section) => section.id && section.tasks.length);
}

function normalizeComposerSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return {
    model: `${settings.model ?? ""}`,
    effort: `${settings.effort ?? ""}`,
    fastMode: Boolean(settings.fastMode),
  };
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
  const beforeSectionId = `${placement?.beforeSectionId ?? ""}`;
  return {
    section: {
      id,
      name,
      repository: Boolean(section.repository),
    },
    beforeSectionId: beforeSectionId || null,
    beforeThreadId: beforeThreadId || null,
  };
}

function normalizeReorderMode(mode) {
  if (mode === true) {
    return "tasks";
  }
  return ["tasks", "sections"].includes(mode) ? mode : "none";
}

function taskTransportRenderKey(state) {
  return isTaskTransportStale(state) ? state : "available";
}

if (!customElements.get("caffold-active-task-list")) {
  customElements.define("caffold-active-task-list", CaffoldActiveTaskList);
}
