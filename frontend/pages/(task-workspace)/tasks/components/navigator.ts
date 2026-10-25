import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintTarget,
  buttonActionHintTarget,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { ActiveTask, ActiveTaskTopPlacement, Task } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import {
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  scrollBackToTop,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "../../components/workspace-brand.ts";
import type { WorkspaceLiveUpdates } from "../../live-updates.js";
import {
  type TaskStoreStatusSnapshot,
  taskStoreOperationsPresentation,
} from "../../task-store-status.js";
import type { TaskTransportState } from "../runtime-state.js";
import { type ListedTask, taskThreadId } from "../task-list-model.js";
import "./active-task-list.ts";
import type {
  ActiveTaskListState,
  ArchiveSyncDetail,
  CaffoldActiveTaskList,
  ReorderMode,
  SectionSummary,
} from "./active-task-list.ts";
import "./archived-task-list.ts";
import type {
  ArchivedTaskRestoredDetail,
  CaffoldArchivedTaskList,
} from "./archived-task-list.ts";

const ICON = "task-action-icon";

let taskNavigatorInstanceId = 0;

// What the navigator asks of its owner beside what its lists ask.
export type TaskNavigatorIntent =
  | { type: "open-task-switcher" }
  | { type: "new-task" };

// Both lists together, as `caffold:task-navigator-list-state` says them.
export interface TaskNavigatorListState {
  count: number;
  activeCount: number;
  activeError: string;
  archivedCount: number;
  loaded: boolean;
  loading: boolean;
  error: string;
  selectedSection: SectionSummary | null;
  selectedRecovery: ActiveTaskListState["selectedRecovery"];
}

/**
 * The Tasks tab's navigation pane: the workspace header with Switch task,
 * Reorder, and New Task, and below it the Active list and the Archived list.
 *
 * The workspace and the Tasks layout reach both lists through it. It reveals
 * the Archived list once both have first answered, and hands the Archived list
 * what the Active list learns: the transport, and Tasks archived or restored.
 */
export class CaffoldTaskNavigator extends LitElement {
  private active = false;
  private reorderMode: ReorderMode = "none";
  private taskOperations = taskStoreOperationsPresentation(null);
  private lastPublishedListState = "";
  private readonly reorderPopoverId =
    `task-list-reorder-${++taskNavigatorInstanceId}`;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.addEventListener("keydown", (event) =>
      this.exitReorderOnEscape(event),
    );
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.draw();
    if (this.active) {
      void this.activate({ force: true });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.closeReorderPopover();
  }

  get streamState(): TaskTransportState {
    return this.activeTaskList.streamState;
  }

  async activate({ force = false } = {}) {
    this.active = true;
    const activeList = this.activeTaskList;
    // Task list events need the Active rows loaded, not the Archived ones.
    const tasksRequest = activeList.activate({ force }).then((tasks) => {
      if (
        this.active &&
        this.isConnected &&
        document.visibilityState === "visible"
      ) {
        activeList.connectStream();
      }
      return tasks;
    });
    const archivedRequest = this.taskOperations.blocked
      ? Promise.resolve(null)
      : this.archivedTaskList.activate({ force });
    const [tasks, archived] = await Promise.all([
      tasksRequest,
      archivedRequest,
    ]);
    return { tasks, archived };
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null) {
    this.activeTaskList.setLiveUpdates(liveUpdates);
  }

  // The store's own gate is the only one the whole navigator shares. Codex
  // being unready locks nothing here: rows open for reading, and a new Task
  // can always be started with the other agent.
  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    const presentation = taskStoreOperationsPresentation(snapshot);
    if (this.taskOperations.key === presentation.key) {
      return;
    }
    this.taskOperations = presentation;
    this.activeTaskList.setTaskOperations(presentation);
    this.archivedTaskList.setTaskOperations(presentation);
    this.draw();
  }

  setSelectedSubject(subject: { kind: "task" | "section"; id: string } | null) {
    this.activeTaskList.setSelectedSubject(subject);
  }

  upsertCanonicalTask(task: ListedTask) {
    this.activeTaskList.upsertCanonicalTask(task);
  }

  placeCanonicalTaskAtTop(task: ListedTask, placement: ActiveTaskTopPlacement) {
    this.activeTaskList.placeCanonicalTaskAtTop(task, placement);
  }

  acceptArchivedTask(task: Task) {
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.activeTaskList.removeTask(threadId);
    this.archivedTaskList.acceptTask(task);
  }

  acceptRestoredTask(task: ActiveTask, placement: ActiveTaskTopPlacement) {
    const threadId = taskThreadId(task);
    if (!threadId) {
      return;
    }
    this.archivedTaskList.removeTask(threadId);
    this.activeTaskList.placeCanonicalTaskAtTop(task, placement);
  }

  restoreThread(threadId: string) {
    return this.archivedTaskList.restoreThread(threadId);
  }

  deleteThread(threadId: string) {
    return this.archivedTaskList.deleteThread(threadId);
  }

  removeTask(threadId: string) {
    this.activeTaskList.removeTask(threadId);
  }

  taskFor(threadId: string) {
    return this.activeTaskList.taskFor(threadId);
  }

  activeTaskSnapshot() {
    const activeList = this.activeTaskList;
    return {
      rows: activeList.tasksWithSections(),
      loaded: activeList.listState().loaded,
    };
  }

  sectionFor(sectionId: string) {
    return this.activeTaskList.sectionFor(sectionId);
  }

  sectionForDirectory(path: string) {
    return this.activeTaskList.sectionForDirectory(path);
  }

  sectionForTask(threadId: string) {
    return this.activeTaskList.sectionForTask(threadId);
  }

  recoveryFor(threadId: string) {
    return this.activeTaskList.recoveryFor(threadId);
  }

  isTransportAvailable() {
    return this.activeTaskList.isTransportAvailable();
  }

  suspendForeground() {
    this.activeTaskList.suspendStream();
  }

  recoverForeground() {
    return this.activeTaskList.recoverForeground();
  }

  setReorderMode(mode: ReorderMode, { restoreFocus = true } = {}) {
    if (this.reorderMode === mode) {
      return;
    }
    const activeList = this.activeTaskList;
    const handleHadFocus = activeList.containsReorderFocus(
      document.activeElement,
    );
    const previous = this.reorderMode;
    this.reorderMode = mode;
    activeList.setReorderMode(mode, {
      revealTasks: previous === "sections" && mode === "none" && restoreFocus,
    });
    this.draw();
    if (mode === "none" && restoreFocus && handleHadFocus) {
      queueMicrotask(() => this.reorderButton?.focus());
    }
  }

  exitReorderMode(options: { restoreFocus?: boolean } = {}) {
    this.closeReorderPopover();
    this.setReorderMode("none", options);
  }

  scrollToTop() {
    scrollBackToTop(this.scrollRoot);
  }

  listState(): TaskNavigatorListState {
    const active = this.activeTaskList.listState();
    const archived = this.archivedTaskList.listState();
    return {
      count: active.count + archived.count,
      activeCount: active.count,
      activeError: active.error,
      archivedCount: archived.count,
      loaded: active.loaded && archived.loaded,
      loading: active.loading || archived.loading,
      error: active.error || archived.error,
      selectedSection: active.selectedSection,
      selectedRecovery: active.selectedRecovery,
    };
  }

  actionHintScope(): ActionHintScope {
    const scrollRoot = this.scrollRoot;
    const activeList = this.activeTaskList;
    const archived = this.archivedTaskList;
    const reordering = this.reorderMode !== "none";
    const targets: ActionHintTarget[] = [];
    const switcher = reordering ? null : this.switcherTarget();
    if (switcher) {
      targets.push(switcher);
    }
    const reorder = this.reorderTarget();
    if (reorder) {
      targets.push(reorder);
    }
    const newTask = this.newTaskButton;
    if (!reordering && newTask) {
      targets.push({
        id: "task-create:global",
        actionId: "task.create",
        label: "Create a new task",
        invalidationOwner: this,
        controlKind: "button",
        control: newTask,
        anchor: newTask,
        clipRoots: [this],
        badgeAtEnd: false,
        isActionable: () =>
          this.newTaskButton === newTask &&
          !this.taskOperations.blocked &&
          !newTask.disabled,
        activate: () => newTask.click(),
      });
    }
    targets.push(
      ...activeList.actionHintTargets({ clipRoots: [this, scrollRoot] }),
    );
    return mergeActionHintScopes(
      {
        blocked: false,
        targets,
        mutationRoots: [this.primaryHeader, activeList],
        scrollRoots: [scrollRoot],
      },
      !reordering && hasActionHintLayoutBox(archived)
        ? archived.actionHintScope({
            scopeId: "task-list:archived",
            clipRoots: [this, scrollRoot],
          })
        : null,
    );
  }

  keyboardNavigationContexts() {
    const popover = this.reorderPopover;
    const presentation =
      popover.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog || !hud || !selector) {
      return [];
    }
    const contextId = "task-list:reorder";
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: this.reorderActionHintScope(contextId, popover),
          sessionBound: true,
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "Reorder options",
            popover,
            isCurrent: () =>
              this.isCurrent() &&
              this.reorderMode === "none" &&
              this.reorderPopover === popover,
          }),
        },
      }),
    ];
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    const scrollport = this.scrollRoot;
    return {
      blocked: this.reorderMode !== "none",
      surfaces: [
        {
          id: "task-list",
          label: "Task list",
          scrollport,
          clipRoots: [this, scrollport],
          isEligible: () =>
            this.isCurrent() &&
            this.reorderMode === "none" &&
            this.scrollRoot === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this, this.activeTaskList, this.archivedTaskList],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    const blocked = this.taskOperations.blocked;
    const reordering = this.reorderMode !== "none";
    const finish = `Finish reordering ${
      this.reorderMode === "sections" ? "Sections" : "Tasks"
    }`;
    const popoverId = this.reorderPopoverId;
    const switchIcon = inlineIcon("History", "Switch task", ICON);
    const reorderIcon = inlineIcon("ArrowDownUp", "Reorder tasks", ICON);
    const newTaskIcon = inlineIcon("Plus", "New task", ICON);
    return html`
      <header class="task-list-section-header task-list-primary-header">
        <caffold-workspace-brand></caffold-workspace-brand>
        <span class="task-list-primary-actions">
          <button
            type="button"
            class="task-list-header-action task-list-switcher"
            data-task-action="open-task-switcher"
            aria-label="Switch task"
            title="Switch task"
            @click=${this.openSwitcher}
          >${switchIcon}</button>
          <button
            type="button"
            class="task-list-header-action task-list-reorder"
            data-task-action="toggle-reorder"
            aria-label=${reordering ? finish : "Choose what to reorder"}
            aria-pressed=${reordering}
            title=${reordering ? finish : "Reorder"}
            popovertarget=${popoverId}
            @click=${this.toggleReorder}
          >${reorderIcon}</button>
          <div
            id=${popoverId}
            class="task-list-reorder-popover"
            popover="auto"
            role="group"
            aria-label="Reorder options"
          >
            <button
              type="button"
              data-task-action="select-reorder-mode"
              data-reorder-mode="tasks"
              popovertarget=${popoverId}
              popovertargetaction="hide"
              @click=${() => this.setReorderMode("tasks")}
            >Reorder Tasks</button>
            <button
              type="button"
              data-task-action="select-reorder-mode"
              data-reorder-mode="sections"
              popovertarget=${popoverId}
              popovertargetaction="hide"
              @click=${() => this.setReorderMode("sections")}
            >Reorder Sections</button>
            <caffold-keyboard-navigation-presentation
            ></caffold-keyboard-navigation-presentation>
          </div>
          <button
            type="button"
            class="task-list-header-action task-list-new-task"
            data-task-action="open-new"
            aria-label="New Task"
            title=${blocked ? this.taskOperations.title : "New Task"}
            ?disabled=${blocked}
            @click=${this.openNewTask}
          >${newTaskIcon}</button>
        </span>
      </header>
      <div class="task-list-scroll">
        <caffold-active-task-list
          @caffold:active-task-list-state=${this.activeListChanged}
          @caffold:active-task-list-initial-settled=${this.listSettled}
          @caffold:active-task-list-archive-sync=${this.syncArchived}
          @caffold:task-navigator-transport-change=${this.transportChanged}
          @caffold:active-task-list-focus-reorder-toggle=${this.focusReorder}
        ></caffold-active-task-list>
        <caffold-archived-task-list
          hidden
          @caffold:archived-task-list-state=${this.archivedListChanged}
          @caffold:archived-task-list-initial-settled=${this.listSettled}
          @caffold:archived-task-restored=${this.taskRestored}
        ></caffold-archived-task-list>
      </div>
    `;
  }

  updated() {
    if (this.dataset.reorderMode !== this.reorderMode) {
      this.dataset.reorderMode = this.reorderMode;
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private switcherTarget() {
    const control = this.switcherButton;
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: "task-list:switcher:open",
      actionId: ACTION_HINT_ACTION.TASK_SWITCHER_OPEN,
      label: control.getAttribute("aria-label") || "Switch task",
      control,
      clipRoots: [this],
      isActionable: () =>
        this.isCurrent() &&
        this.reorderMode === "none" &&
        this.switcherButton === control &&
        !control.disabled,
    });
  }

  private reorderTarget() {
    const control = this.reorderButton;
    const popover = this.reorderPopover;
    const mode = this.reorderMode;
    const reordering = mode !== "none";
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: reordering
        ? `task-list:reorder:finish:${mode}`
        : "task-list:reorder:open",
      actionId: reordering
        ? ACTION_HINT_ACTION.REORDER_FINISH
        : ACTION_HINT_ACTION.REORDER_OPEN,
      label:
        control.getAttribute("aria-label") ||
        (reordering ? `Finish reordering ${mode}` : "Choose what to reorder"),
      control,
      clipRoots: [this],
      isActionable: () =>
        this.isCurrent() &&
        this.reorderMode === mode &&
        this.reorderButton === control &&
        this.reorderPopover === popover &&
        control.getAttribute("popovertarget") === popover.id &&
        !control.disabled &&
        (reordering || !popover.matches(":popover-open")),
    });
  }

  private reorderActionHintScope(
    contextId: string,
    popover: HTMLElement,
  ): ActionHintScope {
    const targets = [
      ...popover.querySelectorAll<HTMLButtonElement>(
        ":scope > button[data-task-action='select-reorder-mode']",
      ),
    ].flatMap((control) => {
      const mode = control.dataset.reorderMode ?? "";
      if (control.disabled) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${contextId}:${mode}`,
          actionId: ACTION_HINT_ACTION.REORDER_SELECT,
          label: control.textContent?.trim() || `Reorder ${mode}`,
          control,
          clipRoots: [popover],
          badgeAtEnd: true,
          isActionable: () =>
            this.isCurrent() &&
            this.reorderMode === "none" &&
            this.reorderPopover === popover &&
            popover.matches(":popover-open") &&
            popover.contains(control) &&
            control.dataset.reorderMode === mode &&
            !control.disabled,
        }),
      ];
    });
    return {
      blocked: this.reorderMode !== "none",
      targets,
      mutationRoots: [popover],
      scrollRoots: [popover],
    };
  }

  private isCurrent() {
    return this.isConnected && this.active && !this.hidden;
  }

  // While reordering, the toggle finishes it instead of opening its choices.
  private toggleReorder(event: Event) {
    event.stopPropagation();
    if (this.reorderMode !== "none") {
      event.preventDefault();
      this.setReorderMode("none");
    }
  }

  private openSwitcher(event: Event) {
    event.stopPropagation();
    this.dispatchIntent({ type: "open-task-switcher" });
  }

  private openNewTask(event: Event) {
    event.stopPropagation();
    if (this.taskOperations.blocked) {
      return;
    }
    this.exitReorderMode({ restoreFocus: false });
    this.dispatchIntent({ type: "new-task" });
  }

  private exitReorderOnEscape(event: KeyboardEvent) {
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

  private handleDismiss(event: Event) {
    if (event.target === this.reorderPopover) {
      this.closeReorderPopover();
    }
  }

  private closeReorderPopover() {
    const popover = this.reorderPopover;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // A parent transition may already have detached the retained shell.
    }
  }

  // The workspace hears the Active list's state at the navigator, so it goes
  // on from here.
  private activeListChanged() {
    this.publishListState();
  }

  private archivedListChanged(event: Event) {
    event.stopPropagation();
    this.publishListState();
  }

  // The Archived list shows once both lists have first answered.
  private listSettled(event: Event) {
    event.stopPropagation();
    this.archivedTaskList.setRevealed(
      this.activeTaskList.initialRequestSettled &&
        this.archivedTaskList.initialRequestSettled,
    );
    this.publishListState();
  }

  private syncArchived(event: CustomEvent<ArchiveSyncDetail>) {
    event.stopPropagation();
    const { action, threadId } = event.detail;
    if (action === "refresh") {
      void this.archivedTaskList.loadArchived({ force: true });
    } else {
      this.archivedTaskList.removeTask(threadId);
    }
  }

  private taskRestored(event: CustomEvent<ArchivedTaskRestoredDetail>) {
    event.stopPropagation();
    this.activeTaskList.acceptTask(
      event.detail.task,
      event.detail.activeTopPlacement,
    );
  }

  private transportChanged(event: CustomEvent<{ state: TaskTransportState }>) {
    this.archivedTaskList.setTransportState(event.detail.state);
  }

  private focusReorder(event: Event) {
    event.stopPropagation();
    this.reorderButton.focus();
  }

  private publishListState() {
    const detail = this.listState();
    const signature = JSON.stringify(detail);
    if (signature === this.lastPublishedListState) {
      return;
    }
    this.lastPublishedListState = signature;
    this.dispatchEvent(
      new CustomEvent<TaskNavigatorListState>(
        "caffold:task-navigator-list-state",
        { bubbles: true, composed: true, detail },
      ),
    );
  }

  private dispatchIntent(detail: TaskNavigatorIntent) {
    this.dispatchEvent(
      new CustomEvent<TaskNavigatorIntent>("caffold:task-navigator-intent", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  // The lists are drawn the first time one is needed, which can be before the
  // navigator is in the document.
  private get activeTaskList() {
    this.performUpdate();
    return this.querySelector(
      ":scope > .task-list-scroll > caffold-active-task-list",
    ) as CaffoldActiveTaskList;
  }

  private get archivedTaskList() {
    this.performUpdate();
    return this.querySelector(
      ":scope > .task-list-scroll > caffold-archived-task-list",
    ) as CaffoldArchivedTaskList;
  }

  private get scrollRoot() {
    this.performUpdate();
    return this.querySelector(":scope > .task-list-scroll") as HTMLElement;
  }

  private get primaryHeader() {
    this.performUpdate();
    return this.querySelector(
      ":scope > .task-list-primary-header",
    ) as HTMLElement;
  }

  private get switcherButton() {
    return this.primaryHeader.querySelector(
      ":scope > .task-list-primary-actions > .task-list-switcher",
    ) as HTMLButtonElement;
  }

  private get reorderButton() {
    return this.primaryHeader.querySelector(
      ":scope > .task-list-primary-actions > .task-list-reorder",
    ) as HTMLButtonElement;
  }

  private get reorderPopover() {
    return this.primaryHeader.querySelector(
      ":scope > .task-list-primary-actions > .task-list-reorder-popover",
    ) as HTMLElement;
  }

  private get newTaskButton() {
    return this.primaryHeader.querySelector(
      ":scope > .task-list-primary-actions > .task-list-new-task",
    ) as HTMLButtonElement;
  }
}

await compactIconButton.register(
  "caffold-task-navigator",
  "> .task-list-primary-header > .task-list-primary-actions > .task-list-header-action",
);

customElements.define("caffold-task-navigator", CaffoldTaskNavigator);
