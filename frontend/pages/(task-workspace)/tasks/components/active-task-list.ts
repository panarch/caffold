import { html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type ActiveTask,
  type ActiveTaskComposerSettings,
  type ActiveTaskRecovery,
  type ActiveTaskSection,
  type ActiveTaskTopPlacement,
  getTasks,
  reorderSection,
  reorderTask,
} from "#app/api.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { focusedElement } from "#app/shadow-roots.js";
import type { WorkspaceLiveUpdates } from "../../live-updates.js";
import {
  type TaskOperationsPresentation,
  taskStoreOperationsPresentation,
} from "../../task-store-status.js";
import {
  isTaskTransportStale,
  type TaskTransportState,
  taskThreadStatusType,
} from "../runtime-state.js";
import { TaskStreamLifecycle, type TaskStreamRecovery } from "../stream.js";
import { sectionLabel } from "../task-format.js";
import { type ListedTask, taskThreadId } from "../task-list-model.js";
import type { ActiveTaskListIntent } from "../task-navigator-intent-event.js";
import { TASK_NAVIGATOR_INTENT_EVENT } from "../task-navigator-intent-event.js";
import {
  CaffoldActiveTaskSection,
  type ListedSection,
  type ReorderMode,
  type SectionIntent,
  type SectionSnapshot,
} from "./active-task-list/components/section.js";
import { moveListItemBefore } from "./active-task-list/move-list-item.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import styles from "./active-task-list.css.js";

export interface TaskNavigatorTransportChangeDetail {
  available: boolean;
  state: TaskTransportState;
}

export type { ReorderMode } from "./active-task-list/components/section.js";

// The Section component in each group the list made.
const groupSections = new WeakMap<HTMLLIElement, CaffoldActiveTaskSection>();

export const ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT =
  "caffold:active-task-list-initial-settled";
export const ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT =
  "caffold:active-task-list-archive-sync";
export const ACTIVE_TASK_LIST_STATE_EVENT = "caffold:active-task-list-state";

// What New Task in a Section starts from: what its Tasks last ran under.
export interface SectionComposerSettings {
  model: string;
  effort: string;
  fastMode: boolean;
  permissionMode: string;
}

// A Section as the list's callers read it.
export interface SectionSummary {
  id: string;
  name: string;
  repository: boolean;
  directory?: ActiveTaskSection["directory"];
  composerSettings: SectionComposerSettings | null;
}

// What the list says about itself with `ACTIVE_TASK_LIST_STATE_EVENT`.
export interface ActiveTaskListState {
  count: number;
  loaded: boolean;
  loading: boolean;
  error: string;
  selectedSection: SectionSummary | null;
  selectedRecovery: {
    threadId: string;
    title: string;
    reason: string;
    actions: string[];
  } | null;
}

// The Archived list changed with this list: a Task left for it, or left both.
export interface ArchiveSyncDetail {
  action: "refresh" | "remove";
  threadId: string;
}

// A Task beside the Section it sits in, for surfaces that show no headers.
export interface TaskWithSection {
  task: ListedTask;
  sectionName: string;
}

export type ForegroundRecovery =
  | TaskStreamRecovery
  | { ok: true; skipped: true }
  | { ok: true; transportSkipped: true };

// A Section as the list holds it.
interface HeldSection extends ListedSection {
  composerSettings: SectionComposerSettings | null;
}

interface HeldTaskList {
  sections: HeldSection[];
  unsectioned: ListedTask[];
}

// Where a Task newly at the top of the list goes.
interface TopPlacement {
  section: { id: string; name: string; repository: boolean };
  beforeSectionId: string | null;
  beforeThreadId: string | null;
}

// A move being saved. Until the server confirms it, a reload lays it over
// what the server answers.
type PendingMove =
  | {
      kind: "task";
      optimistic: boolean;
      threadId: string;
      beforeThreadId: string | null;
    }
  | {
      kind: "section";
      optimistic: boolean;
      sectionId: string;
      beforeSectionId: string | null;
    };

interface TaskDrag {
  threadId: string;
  sectionId: string;
  originalBeforeThreadId: string | null;
  beforeThreadId: string | null;
}

interface SectionDrag {
  sectionId: string;
  originalBeforeSectionId: string | null;
  beforeSectionId: string | null;
}

/**
 * The Active list: the person's Sections in the order they arranged, each with
 * its Tasks, and after them the Tasks awaiting recovery.
 *
 * It loads the list, keeps it current from the workspace's Task list stream,
 * and saves the person's reordering. Its template is the frame: the reorder
 * error, the loading, failed, and empty states, and the spoken result of a
 * move. The Sections are kept outside the template and moved with
 * `moveBefore()`, so a Section, its rows, and a gesture in progress survive
 * any reordering.
 */
@customElement("caffold-active-task-list")
export class CaffoldActiveTaskList extends CaffoldElement {
  static override styles = [
    scopedStyle(secondaryButton, ".task-secondary-button"),
    styles,
  ];

  private sections: HeldSection[] = [];
  private unsectioned: ListedTask[] = [];
  private taskListLoading = false;
  private taskListLoaded = false;
  private taskListError: Error | null = null;
  private taskListRequestId = 0;
  private taskListLoadPromise: Promise<HeldTaskList | null> | null = null;
  private taskListRefreshPending = false;
  private readonly pendingTopPlacements = new Map<
    string,
    { task: ListedTask; placement: TopPlacement }
  >();
  private pendingRuntimeSnapshot: ActiveTask[] | null = null;
  private settled = false;
  private selectedThreadId = "";
  private selectedSectionId = "";
  private readonly revisionByThread = new Map<string, number>();
  private readonly hints = new ActionHints(this);
  private readonly groups = new DrawnRef<HTMLOListElement>(this);
  private readonly announcement = new DrawnRef<HTMLParagraphElement>(this);
  private active = false;
  private taskOperations = taskStoreOperationsPresentation(null);
  private reorderMode: ReorderMode = "none";
  private revealTasks = false;
  private pendingMove: PendingMove | null = null;
  private reorderError: { subjectTitle: string } | null = null;
  private dragState: TaskDrag | null = null;
  private sectionDragState: SectionDrag | null = null;
  private liveUpdates: WorkspaceLiveUpdates | null = null;
  private readonly taskListStream = new TaskStreamLifecycle({
    subscribe: (_contextKey, listener) => {
      if (!this.liveUpdates) {
        throw new Error("Workspace live updates are unavailable.");
      }
      return this.liveUpdates.subscribeTaskList(listener);
    },
    onEvent: (type, event) => this.handleStreamEvent(type, event),
    onReconcile: (_contextKey, isCurrent, metadata) =>
      this.reconcileTaskList(isCurrent, metadata),
    onStateChange: (state) => this.announceTransport(state),
  });

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add("task-list-section");
    this.dataset.taskSection = "managed";
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Caffold Tasks");
    this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.taskListRequestId += 1;
    this.taskListLoadPromise = null;
    this.taskListLoading = false;
    this.cancelDrag();
    this.cancelSectionDrag();
    this.closeStream();
  }

  // Whether the first load has answered, one way or the other.
  get initialRequestSettled() {
    return this.settled;
  }

  get streamState(): TaskTransportState {
    return this.taskListStream.state;
  }

  async activate({ force = false } = {}) {
    this.active = true;
    return await this.loadTasks({ force });
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null) {
    this.liveUpdates = liveUpdates;
  }

  setTaskOperations(presentation: TaskOperationsPresentation) {
    if (this.taskOperations.key === presentation.key) {
      return;
    }
    const becameBlocked = !this.taskOperations.blocked && presentation.blocked;
    this.taskOperations = presentation;
    if (becameBlocked) {
      this.closeStream();
    }
    this.draw();
  }

  setSelectedSubject(subject: { kind: "task" | "section"; id: string } | null) {
    const threadId = subject?.kind === "task" ? subject.id : "";
    const sectionId = subject?.kind === "section" ? subject.id : "";
    if (
      this.selectedThreadId === threadId &&
      this.selectedSectionId === sectionId
    ) {
      return;
    }
    this.selectedThreadId = threadId;
    this.selectedSectionId = sectionId;
    this.syncSections();
    this.revealSelectedTask(threadId);
    const task = threadId ? this.taskFor(threadId) : null;
    if (task?.unseen) {
      this.upsertCanonicalTask({ ...task, unseen: false });
    }
  }

  // A Task chosen from a surface that does not follow this list's order can
  // be marked here but nowhere on screen. Only that case moves the list: a
  // row with any part of it showing stays exactly where the reader left it.
  private revealSelectedTask(threadId: string) {
    if (!threadId) {
      return;
    }
    requestAnimationFrame(() => {
      if (!this.isConnected || this.selectedThreadId !== threadId) {
        return;
      }
      const sectionId = this.sectionContext(threadId)?.section.id ?? "";
      const row = this.sectionComponentFor(sectionId)?.rowFor(threadId);
      const scroller = this.closest(".task-list-scroll");
      if (!row || !scroller) {
        return;
      }
      const view = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.bottom > view.top && box.top < view.bottom) {
        return;
      }
      row.scrollIntoView({ block: "nearest" });
    });
  }

  // A Task changed where it stands. A Task the person must recover keeps that
  // entry until the server says otherwise.
  upsertCanonicalTask(task: ListedTask) {
    const threadId = taskThreadId(task);
    if (!this.taskListLoaded || !threadId) {
      return;
    }
    const current = this.taskFor(threadId);
    const canonical =
      current && "recovery" in current && !("recovery" in task)
        ? current
        : task;
    const next =
      threadId === this.selectedThreadId
        ? { ...canonical, unseen: false }
        : canonical;
    const listKey = this.replaceTaskInPlace(next);
    if (!listKey) {
      return;
    }
    if (!this.sectionComponentFor(listKey)?.updateTask(next)) {
      this.draw();
      return;
    }
    this.publishState();
  }

  acceptTask(task: ListedTask, placement: ActiveTaskTopPlacement) {
    if (taskThreadId(task)) {
      this.placeCanonicalTaskAtTop(task, placement);
    }
  }

  placeCanonicalTaskAtTop(
    task: ListedTask,
    placement: ActiveTaskTopPlacement | null | undefined,
  ) {
    const threadId = taskThreadId(task);
    const place = topPlacement(placement);
    if (!threadId || !place) {
      return false;
    }
    const next =
      threadId === this.selectedThreadId ? { ...task, unseen: false } : task;
    if (!this.taskListLoaded) {
      this.pendingTopPlacements.set(threadId, { task: next, placement: place });
      return true;
    }
    this.applyCanonicalTopPlacement(next, place);
    this.draw();
    return true;
  }

  removeTask(threadId: string) {
    if (!threadId || !this.taskListLoaded) {
      return;
    }
    const context = this.sectionContext(threadId);
    const restoreHandleFocus =
      this.reorderMode === "tasks" &&
      Boolean(
        this.sectionComponentFor(
          context?.section.id ?? "",
        )?.containsTaskHandleFocus(threadId, focusedElement()),
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
    this.draw();
    if (!restoreHandleFocus || !context) {
      return;
    }
    // Focus goes to the handle that took the removed row's place, or back to
    // the reorder toggle once the Section is gone.
    const section = this.sections.find(
      (candidate) => candidate.id === context.section.id,
    );
    const nextTask =
      section?.tasks[Math.min(context.index, section.tasks.length - 1)];
    if (section && nextTask) {
      queueMicrotask(() =>
        this.sectionComponentFor(section.id)?.focusTaskHandle(
          taskThreadId(nextTask),
        ),
      );
    } else {
      this.dispatchEvent(
        new CustomEvent("caffold:active-task-list-focus-reorder-toggle", {
          bubbles: true,
        }),
      );
    }
  }

  setReorderMode(mode: ReorderMode, { revealTasks = false } = {}) {
    if (this.reorderMode === mode) {
      return;
    }
    const anchor = this.captureScrollAnchor();
    this.reorderMode = mode;
    this.dataset.reorderMode = mode;
    this.revealTasks = mode !== "sections" && revealTasks;
    this.cancelDrag();
    this.cancelSectionDrag();
    if (mode === "none") {
      this.reorderError = null;
    }
    this.draw();
    this.restoreScrollAnchor(anchor);
  }

  containsReorderFocus(element: Element | null) {
    return this.sectionComponents().some((section) =>
      section.containsReorderFocus(element),
    );
  }

  // Callers that join a load in flight share its answer; each judges for
  // itself whether it still wants it.
  async loadTasks({ force = false, requireFresh = false } = {}) {
    if (this.taskListLoaded && !force) {
      return this.heldTaskList();
    }
    if (this.taskListLoadPromise) {
      if (force && requireFresh) {
        this.taskListRefreshPending = true;
      }
      return await this.taskListLoadPromise;
    }
    const request = this.performLoadTasks();
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

  connectStream() {
    if (this.taskOperations.blocked || !this.active || !this.isConnected) {
      return;
    }
    this.taskListStream.activate("task-list");
  }

  suspendStream() {
    this.taskListStream.suspend();
  }

  closeStream() {
    this.taskListStream.deactivate();
  }

  retryStream() {
    this.liveUpdates?.retry();
    this.taskListStream.retry({ reconcile: false });
  }

  isTransportAvailable() {
    return !isTaskTransportStale(this.streamState);
  }

  async recoverForeground(): Promise<ForegroundRecovery> {
    if (!this.active || !this.isConnected) {
      return { ok: true, skipped: true };
    }
    if (this.taskOperations.blocked) {
      const response = await this.loadTasks({ force: true });
      if (!response) {
        throw (
          this.taskListError ?? new Error("Caffold Task ledger unavailable.")
        );
      }
      return { ok: true, transportSkipped: true };
    }
    const outcome = await this.taskListStream.recover("task-list");
    if (!outcome.ok && !outcome.stale) {
      throw outcome.error ?? new Error("Task list recovery failed.");
    }
    return outcome;
  }

  // Every listed Task beside its Section. A flat list loses the grouping the
  // navigator shows, so the Section travels with its Task.
  tasksWithSections(): TaskWithSection[] {
    return [
      ...this.sections.flatMap((section) =>
        section.tasks.map((task) => ({
          task,
          sectionName: sectionLabel(section.name),
        })),
      ),
      ...this.unsectioned.map((task) => ({ task, sectionName: "" })),
    ];
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      ...this.sectionComponents().map((section) =>
        section.actionHintScope(pull),
      ),
    );
  }

  taskFor(threadId: string) {
    return (
      this.allTasks().find((task) => taskThreadId(task) === threadId) ?? null
    );
  }

  sectionFor(sectionId: string): SectionSummary | null {
    const section = this.sections.find(
      (candidate) => candidate.id === sectionId,
    );
    return section
      ? {
          id: section.id,
          name: section.name,
          repository: section.repository,
          ...(section.directory ? { directory: section.directory } : {}),
          composerSettings: section.composerSettings
            ? { ...section.composerSettings }
            : null,
        }
      : null;
  }

  // The Section of a directory, by the logical path a Task `cwd` uses.
  sectionForDirectory(path: string) {
    const section = this.sections.find((candidate) => candidate.name === path);
    return section ? this.sectionFor(section.id) : null;
  }

  sectionForTask(threadId: string) {
    return this.sectionFor(this.sectionContext(threadId)?.section.id ?? "");
  }

  recoveryFor(threadId: string) {
    return (
      this.unsectioned
        .filter(needsRecovery)
        .find((task) => taskThreadId(task) === threadId) ?? null
    );
  }

  listState(): ActiveTaskListState {
    const recovery = this.recoveryFor(this.selectedThreadId);
    return {
      count: this.allTasks().length,
      loaded: this.taskListLoaded,
      loading: this.taskListLoading || !this.settled,
      error: this.taskListError?.message ?? "",
      selectedSection: this.sectionFor(this.selectedSectionId),
      selectedRecovery: recovery
        ? {
            threadId: taskThreadId(recovery),
            title: recovery.title,
            reason: recovery.recovery.reason,
            actions: recovery.recovery.actions,
          }
        : null,
    };
  }

  override render() {
    const empty = this.allTasks().length === 0;
    const error = this.taskListError;
    let content: TemplateResult;
    if (empty && (this.taskListLoading || !this.settled)) {
      content = html`<p class="task-section-message task-section-loading"
        ><caffold-loading-text>Loading...</caffold-loading-text></p
      >`;
    } else if (empty && error) {
      content = html`<div
        class="task-section-message task-section-load-error"
        role="alert"
      >
        <p>${error.message}</p>
        <button
          type="button"
          class="task-secondary-button"
          data-task-action="retry-task-list"
          @click=${this.retryLoad}
        >Retry</button>
      </div>`;
    } else if (empty) {
      content = html`<p class="task-section-message task-section-empty"
        >No Caffold tasks yet.</p
      >`;
    } else {
      content = html`<ol
        ${drawn(this.groups)}
        class="task-repository-groups"
        data-task-section="managed"
        @caffold:active-task-section-intent=${this.handleSectionIntent}
      ></ol>`;
    }
    const failed = this.reorderMode !== "none" ? this.reorderError : null;
    const alert = failed
      ? html`<div class="task-reorder-error" role="alert">
          <span aria-hidden="true"
            >Move wasn't saved. Move it again to retry.</span
          >
          <span class="sr-only"
            >Could not move ${failed.subjectTitle}. The saved order was
            restored. Move it again to retry.</span
          >
        </div>`
      : nothing;
    return html`
      <div class="task-list-alerts">${alert}</div>
      <div class="task-list-content">${content}</div>
      <p
        ${drawn(this.announcement)}
        class="sr-only task-reorder-announcement"
        aria-live="polite"
        aria-atomic="true"
      ></p>
    `;
  }

  // The frame draws, then the Sections are put in their order and handed
  // what they show.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    const groups = this.groupList;
    if (groups) {
      this.reconcileSections(groups);
    }
    this.publishState();
  }

  private reconcileSections(groups: HTMLOListElement) {
    const sections = this.projectedSections();
    const existingGroups = new Map(
      this.groupItems().map((group) => [
        group.dataset.taskRepositoryKey ?? "",
        group,
      ]),
    );
    const tasksBySection = new Map(
      sections.map((section) => [
        section.id,
        new Set(section.tasks.map(taskThreadId)),
      ]),
    );
    const listedThreadIds = new Set(
      sections.flatMap((section) => section.tasks.map(taskThreadId)),
    );
    // A Task that moved to another Section takes its row element along.
    const availableRows = new Map<string, HTMLLIElement>();
    for (const [sectionId, group] of existingGroups) {
      const rows = this.sectionIn(group)?.transferableRows(
        tasksBySection.get(sectionId) ?? new Set(),
        listedThreadIds,
      );
      for (const [threadId, row] of rows ?? []) {
        availableRows.set(threadId, row);
      }
    }
    const listedSectionIds = new Set(sections.map((section) => section.id));
    const nextListedGroup = (start: Element | null) => {
      let group = start;
      while (
        group &&
        !listedSectionIds.has(
          group.getAttribute("data-task-repository-key") ?? "",
        )
      ) {
        group = group.nextElementSibling;
      }
      return group;
    };
    let nextGroup = nextListedGroup(groups.firstElementChild);
    for (const section of sections) {
      let group = existingGroups.get(section.id);
      if (!group) {
        group = document.createElement("li");
        group.className = "task-repository-group";
      }
      group.dataset.taskRepositoryKey = section.id;
      group.toggleAttribute("data-task-recovery", Boolean(section.recovery));
      if (group === nextGroup) {
        nextGroup = nextListedGroup(nextGroup.nextElementSibling);
      } else {
        moveListItemBefore(groups, group, nextGroup);
      }
      this.syncSectionElement(group, section, { availableRows, prune: false });
      existingGroups.delete(section.id);
    }
    for (const group of existingGroups.values()) {
      group.remove();
    }
    for (const section of this.sectionComponents()) {
      section.pruneRows();
    }
  }

  private syncSectionElement(
    group: HTMLLIElement,
    section: ListedSection,
    options?: { availableRows?: Map<string, HTMLLIElement>; prune?: boolean },
  ) {
    let component = this.sectionIn(group);
    if (!component) {
      component = new CaffoldActiveTaskSection();
      groupSections.set(group, component);
      group.replaceChildren(component);
    }
    component.setSnapshot(this.sectionSnapshot(section), options);
  }

  private sectionSnapshot(section: ListedSection): SectionSnapshot {
    return {
      section,
      selectedSectionId: this.selectedSectionId,
      selectedThreadId: this.selectedThreadId,
      taskOperations: this.taskOperations,
      reorderMode: this.reorderMode,
      revealTasks: this.revealTasks,
      pending: Boolean(this.pendingMove),
    };
  }

  // Hands each Section what it shows without changing what the list holds.
  private syncSections() {
    for (const section of this.projectedSections()) {
      const group = this.groupFor(section.id);
      if (group) {
        this.syncSectionElement(group, section);
      }
    }
  }

  private projectedSections(): ListedSection[] {
    return [
      ...this.sections,
      ...(this.unsectioned.length
        ? [
            {
              id: "unsectioned",
              name: "Tasks awaiting Section recovery",
              label: "Recovery",
              repository: false,
              recovery: true,
              tasks: this.unsectioned,
            },
          ]
        : []),
    ];
  }

  private handleSectionIntent(event: CustomEvent<SectionIntent>) {
    if (
      !(event.target instanceof Element) ||
      !this.renderRoot.contains(event.target)
    ) {
      return;
    }
    event.stopPropagation();
    const intent = event.detail;
    if (intent.subject === "task") {
      this.handleTaskIntent(intent);
      return;
    }
    if (intent.type === "select-section") {
      if (this.reorderMode === "none") {
        this.dispatchIntent({
          type: "select-section",
          sectionId: intent.sectionId,
        });
      }
      return;
    }
    if (this.reorderMode !== "sections" || this.pendingMove) {
      return;
    }
    if (intent.type === "move") {
      this.moveSectionByKeyboard(intent.sectionId, intent.direction);
    } else if (intent.type === "drag-start") {
      this.startSectionDrag(intent.sectionId);
      this.moveSectionDrag(intent.clientY);
    } else if (intent.type === "drag-move") {
      this.moveSectionDrag(intent.clientY);
    } else if (intent.type === "drag-end") {
      this.endSectionDrag();
    } else {
      this.cancelSectionDrag();
    }
  }

  private handleTaskIntent(
    intent: Extract<SectionIntent, { subject: "task" }>,
  ) {
    if (intent.type === "select-task") {
      if (this.reorderMode === "none") {
        this.dispatchIntent({ type: "select-task", threadId: intent.threadId });
      }
      return;
    }
    if (intent.type === "select-task-recovery") {
      const recovery = this.recoveryFor(intent.threadId);
      if (this.reorderMode === "none" && recovery) {
        this.dispatchIntent({
          type: "select-task-recovery",
          threadId: intent.threadId,
          recovery,
        });
      }
      return;
    }
    if (this.reorderMode !== "tasks" || this.pendingMove) {
      return;
    }
    if (intent.type === "move") {
      this.moveByKeyboard(intent.threadId, intent.direction);
    } else if (intent.type === "drag-start") {
      this.startDrag(intent.threadId);
    } else if (intent.type === "drag-move") {
      this.moveDrag(intent.threadId, intent.clientY);
    } else if (intent.type === "drag-end") {
      this.endDrag(intent.threadId);
    } else {
      this.cancelDrag();
    }
  }

  private moveSectionByKeyboard(sectionId: string, direction: "up" | "down") {
    const context = this.sectionContextById(sectionId);
    if (!context) {
      return;
    }
    const label = sectionLabel(context.section.name);
    if (direction === "up" && context.index === 0) {
      this.announce(`${label} is already first.`);
      return;
    }
    if (direction === "down" && context.index === this.sections.length - 1) {
      this.announce(`${label} is already last.`);
      return;
    }
    const beforeSectionId =
      direction === "up"
        ? this.sections[context.index - 1].id
        : (this.sections[context.index + 2]?.id ?? null);
    void this.requestSectionMove(sectionId, beforeSectionId);
  }

  private startSectionDrag(sectionId: string) {
    const context = this.sectionContextById(sectionId);
    if (!context) {
      return;
    }
    const nextId = this.sections[context.index + 1]?.id ?? null;
    this.sectionDragState = {
      sectionId,
      originalBeforeSectionId: nextId,
      beforeSectionId: nextId,
    };
  }

  private moveSectionDrag(clientY: number) {
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
    const candidates = this.groupItems().filter(
      (group) => group !== source && !group.hasAttribute("data-task-recovery"),
    );
    const before =
      candidates.find((group) => {
        const bounds = group.getBoundingClientRect();
        return clientY < bounds.top + bounds.height / 2;
      }) ?? null;
    drag.beforeSectionId = before?.dataset.taskRepositoryKey ?? null;
    this.clearSectionDragTarget();
    const target = before ?? candidates.at(-1) ?? source;
    this.sectionIn(target)?.setDropPosition(before ? "before" : "after");
    this.autoScrollDrag(clientY);
  }

  private endSectionDrag() {
    const drag = this.sectionDragState;
    this.sectionDragState = null;
    this.clearSectionDragTarget();
    if (drag && drag.beforeSectionId !== drag.originalBeforeSectionId) {
      void this.requestSectionMove(drag.sectionId, drag.beforeSectionId);
    }
  }

  private cancelSectionDrag() {
    const drag = this.sectionDragState;
    this.sectionDragState = null;
    this.clearSectionDragTarget();
    this.sectionComponentFor(drag?.sectionId ?? "")?.cancelPointerGesture({
      announce: false,
    });
  }

  private clearSectionDragTarget() {
    for (const section of this.sectionComponents()) {
      section.setDropPosition();
    }
  }

  private moveByKeyboard(threadId: string, direction: "up" | "down") {
    const context = this.sectionContext(threadId);
    if (!context) {
      return;
    }
    const { section, index } = context;
    const where = sectionLabel(section.name);
    if (direction === "up" && index === 0) {
      this.announce(`${context.task.title} is already first in ${where}.`);
      return;
    }
    if (direction === "down" && index === section.tasks.length - 1) {
      this.announce(`${context.task.title} is already last in ${where}.`);
      return;
    }
    const beforeThreadId =
      direction === "up"
        ? taskThreadId(section.tasks[index - 1])
        : taskThreadId(section.tasks[index + 2]) || null;
    void this.requestMove(threadId, beforeThreadId);
  }

  private startDrag(threadId: string) {
    const context = this.sectionContext(threadId);
    if (
      !context ||
      !this.sectionComponentFor(context.section.id)?.hasTaskRow(threadId)
    ) {
      return;
    }
    const nextId =
      taskThreadId(context.section.tasks[context.index + 1]) || null;
    this.dragState = {
      threadId,
      sectionId: context.section.id,
      originalBeforeThreadId: nextId,
      beforeThreadId: nextId,
    };
  }

  private moveDrag(threadId: string, clientY: number) {
    const drag = this.dragState;
    if (drag?.threadId !== threadId || !Number.isFinite(clientY)) {
      return;
    }
    const beforeThreadId = this.sectionComponentFor(
      drag.sectionId,
    )?.updateTaskDropTarget(threadId, clientY);
    if (beforeThreadId === undefined) {
      this.cancelDrag();
      return;
    }
    drag.beforeThreadId = beforeThreadId;
    this.autoScrollDrag(clientY);
  }

  private endDrag(threadId: string) {
    const drag = this.dragState;
    if (drag?.threadId !== threadId) {
      return;
    }
    this.dragState = null;
    this.sectionComponentFor(drag.sectionId)?.clearTaskDropTarget();
    if (drag.beforeThreadId !== drag.originalBeforeThreadId) {
      void this.requestMove(drag.threadId, drag.beforeThreadId);
    }
  }

  private cancelDrag() {
    const drag = this.dragState;
    this.dragState = null;
    if (drag) {
      this.sectionComponentFor(drag.sectionId)?.clearTaskDropTarget();
    }
  }

  // A drag near the list's top or bottom edge scrolls the list toward it.
  private autoScrollDrag(clientY: number) {
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

  // The move shows at once and is saved; a refused move puts the saved order
  // back and says so.
  private async requestMove(threadId: string, beforeThreadId: string | null) {
    if (this.reorderMode !== "tasks" || this.pendingMove) {
      return false;
    }
    const original = this.sectionContext(threadId);
    if (!original) {
      return false;
    }
    const originalOrder = original.section.tasks.map(taskThreadId);
    if (!this.applyMoveToState(threadId, beforeThreadId)) {
      return false;
    }
    const move: PendingMove = {
      kind: "task",
      optimistic: true,
      threadId,
      beforeThreadId,
    };
    this.pendingMove = move;
    this.reorderError = null;
    this.draw();
    try {
      await reorderTask(threadId, beforeThreadId);
      move.optimistic = false;
      await this.loadTasks({ force: true, requireFresh: true });
      if (this.reorderMode === "tasks") {
        this.announceMoveResult(threadId);
      }
      return true;
    } catch {
      move.optimistic = false;
      const positions = new Map(originalOrder.map((id, index) => [id, index]));
      const section = this.sections.find(
        (candidate) => candidate.id === original.section.id,
      );
      if (section) {
        section.tasks = [...section.tasks].sort(
          (left, right) =>
            (positions.get(taskThreadId(left)) ?? Number.MAX_SAFE_INTEGER) -
            (positions.get(taskThreadId(right)) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      this.reorderError =
        this.reorderMode === "tasks"
          ? { subjectTitle: original.task.title }
          : null;
      this.draw();
      await this.loadTasks({ force: true, requireFresh: true });
      return false;
    } finally {
      if (this.pendingMove === move) {
        this.pendingMove = null;
      }
      this.draw();
      if (this.reorderMode === "tasks") {
        queueMicrotask(() =>
          this.sectionComponentFor(original.section.id)?.focusTaskHandle(
            threadId,
          ),
        );
      }
    }
  }

  private async requestSectionMove(
    sectionId: string,
    beforeSectionId: string | null,
  ) {
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
    const move: PendingMove = {
      kind: "section",
      optimistic: true,
      sectionId,
      beforeSectionId,
    };
    this.pendingMove = move;
    this.reorderError = null;
    this.draw();
    try {
      await reorderSection(sectionId, beforeSectionId);
      move.optimistic = false;
      await this.loadTasks({ force: true, requireFresh: true });
      if (this.reorderMode === "sections") {
        this.announceSectionMoveResult(sectionId);
      }
      return true;
    } catch {
      move.optimistic = false;
      const positions = new Map(originalOrder.map((id, index) => [id, index]));
      this.sections = [...this.sections].sort(
        (left, right) =>
          (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
      this.reorderError =
        this.reorderMode === "sections"
          ? { subjectTitle: sectionLabel(original.section.name) }
          : null;
      this.draw();
      await this.loadTasks({ force: true, requireFresh: true });
      return false;
    } finally {
      if (this.pendingMove === move) {
        this.pendingMove = null;
      }
      this.draw();
      if (this.reorderMode === "sections") {
        queueMicrotask(() =>
          this.sectionComponentFor(sectionId)?.focusHandle(),
        );
      }
    }
  }

  private applySectionMoveToState(
    sectionId: string,
    beforeSectionId: string | null,
  ) {
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
      sameOrder(
        sections.map(({ id }) => id),
        this.sections.map(({ id }) => id),
      )
    ) {
      return false;
    }
    this.sections = sections;
    return true;
  }

  private applyMoveToState(threadId: string, beforeThreadId: string | null) {
    const context = this.sectionContext(threadId);
    if (!context) {
      return false;
    }
    const tasks = [...context.section.tasks];
    const [task] = tasks.splice(context.index, 1);
    const destination = beforeThreadId
      ? tasks.findIndex(
          (candidate) => taskThreadId(candidate) === beforeThreadId,
        )
      : tasks.length;
    if (destination < 0) {
      return false;
    }
    tasks.splice(destination, 0, task);
    if (
      sameOrder(
        tasks.map(taskThreadId),
        context.section.tasks.map(taskThreadId),
      )
    ) {
      return false;
    }
    context.section.tasks = tasks;
    return true;
  }

  private sectionContextById(sectionId: string) {
    const index = this.sections.findIndex(
      (section) => section.id === sectionId,
    );
    return index >= 0 ? { section: this.sections[index], index } : null;
  }

  private sectionContext(threadId: string) {
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

  private announceMoveResult(threadId: string) {
    const context = this.sectionContext(threadId);
    if (context) {
      this.announce(
        `${context.task.title} moved to position ${context.index + 1} of ${context.section.tasks.length} in ${sectionLabel(context.section.name)}.`,
      );
    }
  }

  private announceSectionMoveResult(sectionId: string) {
    const context = this.sectionContextById(sectionId);
    if (context) {
      this.announce(
        `Section ${sectionLabel(context.section.name)} moved to position ${context.index + 1} of ${this.sections.length}.`,
      );
    }
  }

  // Cleared first, so the same words said twice are spoken twice.
  private announce(message: string) {
    const region = this.announcement.value;
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

  private async performLoadTasks() {
    const requestId = ++this.taskListRequestId;
    this.taskListLoading = true;
    this.taskListError = null;
    if (this.allTasks().length) {
      this.publishState();
    } else {
      this.draw();
    }
    try {
      const response = await getTasks();
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      const runtimeByThread = new Map(
        this.allTasks().map((task) => [taskThreadId(task), task]),
      );
      this.sections = heldSections(listed(response.sections), runtimeByThread);
      this.unsectioned = listed(response.unsectioned).map((task) =>
        withRuntime(task, runtimeByThread.get(taskThreadId(task))),
      );
      const move = this.pendingMove;
      if (move?.optimistic) {
        if (move.kind === "section") {
          this.applySectionMoveToState(move.sectionId, move.beforeSectionId);
        } else {
          this.applyMoveToState(move.threadId, move.beforeThreadId);
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
      const firstAnswer = this.markSettled();
      this.draw();
      this.announceSettled(firstAnswer);
      return this.heldTaskList();
    } catch (error) {
      if (requestId !== this.taskListRequestId) {
        return null;
      }
      this.taskListLoading = false;
      this.taskListError =
        error instanceof Error ? error : new Error(String(error));
      const firstAnswer = this.markSettled();
      this.draw();
      this.announceSettled(firstAnswer);
      return null;
    }
  }

  private heldTaskList(): HeldTaskList {
    return { sections: this.sections, unsectioned: this.unsectioned };
  }

  private markSettled() {
    if (this.settled) {
      return false;
    }
    this.settled = true;
    return true;
  }

  private announceSettled(firstAnswer: boolean) {
    if (firstAnswer) {
      this.dispatchEvent(
        new CustomEvent(ACTIVE_TASK_LIST_INITIAL_SETTLED_EVENT, {
          bubbles: true,
        }),
      );
    }
  }

  private applyCanonicalTopPlacement(
    task: ListedTask,
    placement: TopPlacement,
  ) {
    const threadId = taskThreadId(task);
    const targetId = placement.section.id;
    const remaining = this.sections
      .map((section) => ({
        ...section,
        tasks: section.tasks.filter(
          (candidate) => taskThreadId(candidate) !== threadId,
        ),
      }))
      .filter((section) => section.id === targetId || section.tasks.length);
    const target: HeldSection = remaining.find(
      (section) => section.id === targetId,
    ) ?? { ...placement.section, composerSettings: null, tasks: [] };
    target.name = placement.section.name;
    target.repository = placement.section.repository;
    const beforeIndex = placement.beforeThreadId
      ? target.tasks.findIndex(
          (candidate) => taskThreadId(candidate) === placement.beforeThreadId,
        )
      : target.tasks.length;
    target.tasks.splice(Math.max(beforeIndex, 0), 0, task);
    const others = remaining.filter((section) => section.id !== targetId);
    const destination = placement.beforeSectionId
      ? others.findIndex((section) => section.id === placement.beforeSectionId)
      : others.length;
    others.splice(Math.max(destination, 0), 0, target);
    this.sections = others;
    this.unsectioned = this.unsectioned.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
  }

  private handleStreamEvent(type: string, { data }: { data: string }) {
    if (type === "task-removed") {
      const message = parseJson<{ threadId: string; reason: string }>(data);
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
      const snapshot = parseJson<{ tasks: ActiveTask[] }>(data);
      if (Array.isArray(snapshot?.tasks)) {
        this.applyRuntimeSnapshot(snapshot.tasks);
      }
      return;
    }
    if (type === "task-placed-at-top") {
      const update = parseJson<{
        task: ActiveTask;
        placement: ActiveTaskTopPlacement;
      }>(data);
      if (update?.task && update.placement) {
        this.placeCanonicalTaskAtTop(update.task, update.placement);
      }
      return;
    }
    if (type === "section-composer-settings") {
      const update = parseJson<{
        sectionId: string;
        composerSettings: ActiveTaskComposerSettings;
      }>(data);
      if (update) {
        this.updateSectionComposerSettings(
          update.sectionId,
          update.composerSettings,
        );
      }
      return;
    }
    if (type === "task-updated") {
      const task = parseJson<ActiveTask>(data);
      const threadId = taskThreadId(task);
      if (task && threadId) {
        this.upsertCanonicalTask(task);
        this.dispatchArchiveSync("remove", threadId);
      }
      return;
    }
    const message = parseJson<{
      threadId: string;
      revision: number;
      task: ActiveTask | null;
    }>(data);
    const task = message?.task;
    if (
      task &&
      message.threadId === taskThreadId(task) &&
      this.acceptRevision(message.threadId, message.revision)
    ) {
      this.upsertCanonicalTask(task);
    }
  }

  private applyRuntimeSnapshot(tasks: ActiveTask[]) {
    if (!this.taskListLoaded) {
      this.pendingRuntimeSnapshot = tasks;
      return;
    }
    for (const task of tasks) {
      this.upsertCanonicalTask(task);
    }
  }

  private updateSectionComposerSettings(
    sectionId: string,
    settings: ActiveTaskComposerSettings,
  ) {
    const section = this.sections.find(
      (candidate) => candidate.id === sectionId,
    );
    const next = composerSettings(settings);
    if (
      !this.taskListLoaded ||
      !section ||
      !next ||
      JSON.stringify(section.composerSettings) === JSON.stringify(next)
    ) {
      return;
    }
    section.composerSettings = next;
    this.publishState();
  }

  private dispatchArchiveSync(
    action: ArchiveSyncDetail["action"],
    threadId: string,
  ) {
    this.dispatchEvent(
      new CustomEvent<ArchiveSyncDetail>(ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT, {
        bubbles: true,
        detail: { action, threadId },
      }),
    );
  }

  private async reconcileTaskList(
    isCurrent: () => boolean,
    { recovery = false } = {},
  ) {
    if (recovery && isCurrent()) {
      this.revisionByThread.clear();
    }
    const response = await this.loadTasks({ force: true });
    if (!isCurrent()) {
      return null;
    }
    if (!response) {
      throw this.taskListError ?? new Error("Caffold Task ledger unavailable.");
    }
    return response;
  }

  // A Task's revision only moves forward; an older publication is dropped.
  private acceptRevision(threadId: string, revision: number) {
    const value = Number(revision);
    if (!threadId || !Number.isFinite(value) || value <= 0) {
      return true;
    }
    if (value < (this.revisionByThread.get(threadId) ?? 0)) {
      return false;
    }
    this.revisionByThread.set(threadId, value);
    return true;
  }

  private announceTransport(state: TaskTransportState) {
    this.dispatchEvent(
      new CustomEvent<TaskNavigatorTransportChangeDetail>(
        "caffold:task-navigator-transport-change",
        {
          bubbles: true,
          composed: true,
          detail: { available: !isTaskTransportStale(state), state },
        },
      ),
    );
  }

  private retryLoad(event: Event) {
    event.stopPropagation();
    void this.loadTasks({ force: true });
  }

  private dispatchIntent(detail: ActiveTaskListIntent) {
    this.dispatchEvent(
      new CustomEvent<ActiveTaskListIntent>(TASK_NAVIGATOR_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private publishState() {
    this.dispatchEvent(
      new CustomEvent<ActiveTaskListState>(ACTIVE_TASK_LIST_STATE_EVENT, {
        bubbles: true,
        composed: true,
        detail: this.listState(),
      }),
    );
  }

  private allTasks() {
    return [
      ...this.sections.flatMap((section) => section.tasks),
      ...this.unsectioned,
    ];
  }

  // Puts a changed Task where its old entry was, and answers the Section it
  // is in: a Section id, "unsectioned", or "" when it is not listed.
  private replaceTaskInPlace(task: ListedTask) {
    const threadId = taskThreadId(task);
    const replace = (tasks: ListedTask[]) => {
      const index = tasks.findIndex(
        (candidate) => taskThreadId(candidate) === threadId,
      );
      return index < 0
        ? null
        : tasks.map((candidate, at) => (at === index ? task : candidate));
    };
    for (const section of this.sections) {
      const tasks = replace(section.tasks);
      if (tasks) {
        section.tasks = tasks;
        return section.id;
      }
    }
    const unsectioned = replace(this.unsectioned);
    if (!unsectioned) {
      return "";
    }
    this.unsectioned = unsectioned;
    return "unsectioned";
  }

  // Which Section heads the visible part of the list, and where.
  private captureScrollAnchor() {
    const scroller = this.closest(".task-list-scroll");
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const groups = this.groupItems().filter(
      (group) => !group.hasAttribute("data-task-recovery"),
    );
    const group =
      groups.find(
        (candidate) => candidate.getBoundingClientRect().bottom > scrollerTop,
      ) ?? groups[0];
    return group
      ? {
          sectionId: group.dataset.taskRepositoryKey ?? "",
          offset: group.getBoundingClientRect().top - scrollerTop,
        }
      : null;
  }

  private restoreScrollAnchor(
    anchor: { sectionId: string; offset: number } | null,
  ) {
    if (!anchor) {
      return;
    }
    requestAnimationFrame(() => {
      const scroller = this.closest(".task-list-scroll");
      const group = this.groupFor(anchor.sectionId);
      if (!scroller || !group) {
        return;
      }
      const offset =
        group.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      scroller.scrollTop += offset - anchor.offset;
    });
  }

  private groupFor(sectionId: string) {
    if (!sectionId) {
      return null;
    }
    return (
      this.groupItems().find(
        (group) => group.dataset.taskRepositoryKey === sectionId,
      ) ?? null
    );
  }

  // The Section groups this list holds, in their order.
  private groupItems() {
    return [...(this.groupList?.children ?? [])] as HTMLLIElement[];
  }

  private sectionIn(group: HTMLLIElement) {
    return groupSections.get(group) ?? null;
  }

  private sectionComponentFor(sectionId: string) {
    const group = this.groupFor(sectionId);
    return group ? this.sectionIn(group) : null;
  }

  private sectionComponents() {
    return this.groupItems().flatMap((group) => {
      const section = this.sectionIn(group);
      return section ? [section] : [];
    });
  }

  private get groupList() {
    return this.groups.value;
  }
}

function needsRecovery(task: ListedTask): task is ActiveTaskRecovery {
  return "recovery" in task;
}

// The stream carries the server's own JSON, read as the shape it sends.
function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function heldSections(
  sections: ActiveTaskSection[],
  runtimeByThread: Map<string, ListedTask>,
): HeldSection[] {
  return sections
    .map((section) => ({
      id: section.id,
      name: section.name,
      repository: section.repository,
      directory: section.directory,
      composerSettings: composerSettings(section.composerSettings),
      tasks: listed(section.tasks).map((task) =>
        withRuntime(task, runtimeByThread.get(taskThreadId(task))),
      ),
    }))
    .filter((section) => section.id && section.tasks.length);
}

// A list the answer left out reads as empty.
function listed<T>(items: T[] | undefined) {
  return Array.isArray(items) ? items.filter(Boolean) : [];
}

function composerSettings(
  settings: ActiveTaskComposerSettings | null,
): SectionComposerSettings | null {
  return settings
    ? {
        model: settings.model ?? "",
        effort: settings.effort ?? "",
        fastMode: settings.fastMode,
        permissionMode: settings.permissionMode ?? "",
      }
    : null;
}

// A Task the agent has not been asked about yet keeps the status and the
// background work the stream last reported for it.
function withRuntime<T extends ListedTask>(
  cached: T,
  runtime: ListedTask | undefined,
): T {
  if (
    !runtime ||
    "recovery" in cached ||
    taskThreadStatusType(cached) !== "notLoaded"
  ) {
    return cached;
  }
  return {
    ...cached,
    threadStatus: runtime.threadStatus,
    backgroundWork: runtime.backgroundWork,
    recencyMs: runtime.recencyMs,
    updatedMs: runtime.updatedMs,
  };
}

function topPlacement(
  placement: ActiveTaskTopPlacement | null | undefined,
): TopPlacement | null {
  const section = placement?.section;
  if (!placement || !section?.id) {
    return null;
  }
  return {
    section: {
      id: section.id,
      name: section.name ?? "",
      repository: Boolean(section.repository),
    },
    beforeSectionId: placement.beforeSectionId || null,
    beforeThreadId: placement.beforeThreadId || null,
  };
}

function sameOrder(left: string[], right: string[]) {
  return left.join("\u0000") === right.join("\u0000");
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-active-task-list": CaffoldActiveTaskList;
  }

  interface HTMLElementEventMap {
    [ACTIVE_TASK_LIST_ARCHIVE_SYNC_EVENT]: CustomEvent<ArchiveSyncDetail>;
    [ACTIVE_TASK_LIST_STATE_EVENT]: CustomEvent<ActiveTaskListState>;
    "caffold:task-navigator-transport-change": CustomEvent<TaskNavigatorTransportChangeDetail>;
  }
}
