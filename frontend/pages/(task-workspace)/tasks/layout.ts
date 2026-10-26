import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.ts";
import {
  type ActiveTask,
  type ActiveTaskRecovery,
  type ActiveTaskTopPlacement,
  type CreatedTask,
  createTask,
  type Task,
} from "#app/api.ts";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.ts";
import { routeDomain, routeTarget } from "#app/navigation-routes.ts";
import {
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import type { WorkspaceLiveUpdates } from "../live-updates.ts";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  type TaskStoreStatusSnapshot,
  taskStoreBlocksTaskOperations,
} from "../task-store-status.ts";
import "./(detail)/layout.ts";
import type { CaffoldDetailLayout } from "./(detail)/layout.ts";
import { TERMINAL_PAGE_FOCUS_RELEASE_EVENT } from "./(detail)/terminal/page.ts";
import type { ComposerSubmission } from "./components/composer.ts";
import {
  type CaffoldTaskImagePreviewDialog,
  TASK_IMAGE_PREVIEW_EVENT,
  type TaskImagePreviewRequest,
} from "./components/image-preview-dialog.ts";
import type {
  CaffoldTaskNavigator,
  TaskNavigatorListState,
} from "./components/navigator.ts";
import type { TaskStartIntent } from "./components/task-create.ts";
import "./components/task-store-recovery.ts";
import type { CaffoldTaskStoreRecovery } from "./components/task-store-recovery.ts";
import "./new/page.ts";
import type { CaffoldTaskNew } from "./new/page.ts";
import "./recovery/page.ts";
import type {
  CaffoldTaskRecovery,
  TaskRecoveryIntent,
} from "./recovery/page.ts";
import { TASK_TRANSPORT_STATE } from "./runtime-state.ts";
import { taskDetailThreadId } from "./task-list-model.ts";

type TasksView = "home" | "new" | "detail" | "recovery";

// A Tasks route as this screen reads it; the screen it opens reads the rest.
interface TasksRoute {
  kind: string;
  threadId?: string;
  sectionId?: string;
  sectionSurface?: string;
  recovery?: boolean;
  new?: boolean;
  cwd?: string;
  [field: string]: unknown;
}

interface RouteOptions {
  preserveLoadedTask?: boolean;
  recovery?: ActiveTaskRecovery | null;
  defaultCwdPath?: string;
}

// What the Task list asks of the Tasks screen.
type NavigatorIntent =
  | { type: "select-task" | "select-task-recovery"; threadId: string }
  | { type: "select-section"; sectionId: string }
  | { type: "new-task" | "open-task-switcher" };

// What a Task's or Section's Detail tells the Tasks screen.
type DetailIntent =
  | { type: "task-archived"; task?: Task }
  | { type: "task-deleted"; threadId?: string }
  | {
      type: "task-restored";
      task?: ActiveTask;
      activeTopPlacement: ActiveTaskTopPlacement;
    }
  | { type: "review-route" | "domain-route"; route?: TasksRoute };

// A Task made elsewhere under Tasks, which this screen opens; `adopted` is
// set once its Detail holds it.
interface TaskCreatedHandoff {
  created: CreatedTask;
  submission: Partial<ComposerSubmission> | null;
  adopted: boolean;
}

// The Task being created, by the submission that asked for it.
interface PendingTaskCreation {
  submissionId: string;
  completion: Promise<CreatedTask> | null;
}

// Which transports a foreground return is still checking.
interface ForegroundProgress {
  validatingTransports(stages: { detail: boolean; list: boolean }): void;
}

/**
 * The Tasks tab beside the Task list: New Task, a Task's or Section's
 * Detail, a Task's recovery, or the Task store's own recovery while it
 * blocks Tasks, with the image preview over them.
 *
 * The workspace routes here and reads it right after, so it draws at once.
 * It owns a Task being created until that Task's Detail holds it.
 */
export class CaffoldTasksPage extends LitElement {
  selectedThreadId = "";
  private view: TasksView = "home";
  private detailView = "conversation";
  private detailPresentation = "reading";
  private taskListState = "loading";
  private selectedSectionId = "";
  private adoptedThreadId = "";
  private currentRoute: TasksRoute = { kind: "tasks" };
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot =
    INITIAL_TASK_STORE_STATUS_SNAPSHOT;
  private lastPublishedTransportTargets = "";
  private pendingTaskCreation: PendingTaskCreation | null = null;
  private liveUpdates: WorkspaceLiveUpdates | null = null;
  private connectedTaskNavigator: CaffoldTaskNavigator | null = null;
  private readonly detailPane = new DrawnRef<HTMLDivElement>(this);
  private readonly taskStoreRecovery = new DrawnRef<CaffoldTaskStoreRecovery>(
    this,
  );
  private readonly taskNew = new DrawnRef<CaffoldTaskNew>(this);
  private readonly detail = new DrawnRef<CaffoldDetailLayout>(this);
  private readonly taskRecovery = new DrawnRef<CaffoldTaskRecovery>(this);
  private readonly imagePreviewDialog =
    new DrawnRef<CaffoldTaskImagePreviewDialog>(this);
  private readonly navigatorIntent = (event: Event) => {
    event.stopPropagation();
    const intent = (event as CustomEvent<NavigatorIntent>).detail;
    if (intent?.type === "select-task") {
      this.requestRoute({ kind: "tasks", threadId: intent.threadId });
    } else if (intent?.type === "select-task-recovery") {
      this.requestRoute({
        kind: "tasks",
        threadId: intent.threadId,
        recovery: true,
      });
    } else if (intent?.type === "select-section") {
      this.requestRoute({
        kind: "tasks",
        sectionId: intent.sectionId,
        sectionSurface: "new",
      });
    } else if (intent?.type === "new-task") {
      this.requestNewTaskRoute();
    }
  };
  private readonly navigatorListState = (event: Event) => {
    event.stopPropagation();
    this.syncTaskListState(
      (event as CustomEvent<TaskNavigatorListState>).detail,
    );
    this.publishTransportState();
  };
  private readonly navigatorTransportChange = (event: Event) => {
    event.stopPropagation();
    const available = Boolean(
      (event as CustomEvent<{ available?: boolean }>).detail?.available,
    );
    this.taskNew.value?.setTransportAvailable(available);
    this.taskDetail()?.setTransportAvailable(available);
    this.publishTransportState();
  };

  constructor() {
    super();
    // Task Create starts a Task from New Task and from a Section alike.
    this.addEventListener("caffold:task-create-intent", (event) => {
      const intent = (event as CustomEvent<{ type: string }>).detail;
      if (intent?.type !== "start") {
        return;
      }
      event.stopPropagation();
      const start = intent as TaskStartIntent;
      const completion = this.startTaskCreation(
        start.request,
        start.submission,
      );
      start.accepted = Boolean(completion);
      start.completion = completion;
    });
    this.addEventListener("caffold:task-created", (event) => {
      event.stopPropagation();
      const handoff = (event as CustomEvent<TaskCreatedHandoff>).detail;
      handoff.adopted = this.adoptCreatedTask(
        handoff?.created,
        handoff?.submission,
      );
    });
    // A terminal that ended under the keyboard hands focus to the pane that
    // Escape leaves an editor for.
    this.addEventListener(TERMINAL_PAGE_FOCUS_RELEASE_EVENT, (event) => {
      event.stopPropagation();
      this.detailPane.value?.focus({
        preventScroll: true,
      });
    });
    this.addEventListener(TASK_IMAGE_PREVIEW_EVENT, (event) => {
      event.stopPropagation();
      this.imagePreviewDialog.value?.openImage(
        (event as CustomEvent<TaskImagePreviewRequest>).detail,
      );
    });
  }

  createRenderRoot() {
    return this;
  }

  // The first drawing also tells the workspace what Tasks shows.
  connectedCallback() {
    super.connectedCallback();
    if (!this.hasUpdated) {
      this.draw();
    }
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null | undefined) {
    this.performUpdate();
    this.liveUpdates = liveUpdates ?? null;
    this.taskDetail()?.setLiveUpdates(this.liveUpdates);
  }

  connectTaskNavigator(navigator: CaffoldTaskNavigator | null | undefined) {
    this.performUpdate();
    if (this.connectedTaskNavigator === navigator) {
      return;
    }
    const previous = this.connectedTaskNavigator;
    previous?.removeEventListener(
      "caffold:task-navigator-intent",
      this.navigatorIntent,
    );
    previous?.removeEventListener(
      "caffold:task-navigator-list-state",
      this.navigatorListState,
    );
    previous?.removeEventListener(
      "caffold:task-navigator-transport-change",
      this.navigatorTransportChange,
    );
    this.connectedTaskNavigator = navigator ?? null;
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-intent",
      this.navigatorIntent,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-list-state",
      this.navigatorListState,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-transport-change",
      this.navigatorTransportChange,
    );
    this.syncTaskListState(this.connectedTaskNavigator?.listState());
    this.taskNew.value?.setTransportAvailable(
      Boolean(this.connectedTaskNavigator?.isTransportAvailable()),
    );
    this.connectedTaskNavigator?.setSelectedSubject(this.selectedSubject());
    this.syncSelectedManagedTask();
    this.publishTransportState();
  }

  deactivate() {
    this.taskNavigator()?.exitReorderMode({ restoreFocus: false });
    this.imagePreviewDialog.value?.dismiss();
    if (this.view === "detail") {
      this.taskDetail()?.deactivate({ retainComposerDom: true });
    } else if (this.view === "recovery") {
      this.taskRecovery.value?.deactivate();
    } else {
      this.taskNew.value?.deactivate();
    }
  }

  suspendForeground() {
    this.taskNavigator()?.suspendForeground();
    this.taskDetail()?.suspendForeground();
  }

  /** Enters or leaves the open Task's or Section's terminal. */
  toggleTerminal() {
    return (
      this.view === "detail" && Boolean(this.taskDetail()?.toggleTerminal())
    );
  }

  ownsTerminalInput(element: Element | null | undefined) {
    return (
      this.view === "detail" &&
      Boolean(this.taskDetail()?.ownsTerminalInput(element))
    );
  }

  ownsEditingEscape(element: Element | null) {
    return (
      (this.view === "home" || this.view === "new") &&
      Boolean(this.taskNew.value?.ownsEditingEscape(element))
    );
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.performUpdate();
    this.taskNew.value?.setServerPaths(server);
    this.taskDetail()?.setServerPaths(server);
  }

  async recoverForeground({
    initialActivation = false,
    isCurrent = () => true,
    progress,
  }: {
    initialActivation?: boolean;
    isCurrent?: () => boolean;
    progress?: ForegroundProgress;
  } = {}) {
    if (initialActivation || !isCurrent()) {
      return { retry: false };
    }
    const recoveries = new Map<string, unknown>();
    const listRecovery = this.taskNavigator()?.recoverForeground();
    if (listRecovery) {
      recoveries.set("list", listRecovery);
    }
    if (!this.taskStoreOperationsBlocked() && this.view === "detail") {
      const detailRecovery = this.taskDetail()?.recoverForeground();
      if (detailRecovery) {
        recoveries.set("detail", detailRecovery);
      }
    }
    reportForegroundValidationStage(progress, recoveries.keys());
    const results = await Promise.allSettled(
      [...recoveries].map(([target, recovery]) =>
        Promise.resolve(recovery).then((result) => {
          recoveries.delete(target);
          if (isCurrent()) {
            reportForegroundValidationStage(progress, recoveries.keys());
          }
          return result;
        }),
      ),
    );
    if (!isCurrent()) {
      return { stale: true, retry: false };
    }
    const failure = results.find((result) => result.status === "rejected");
    return {
      retry: Boolean(failure),
      error: failure?.reason ?? null,
    };
  }

  prepareRoute(route: TasksRoute, options: RouteOptions = {}) {
    this.performUpdate();
    this.taskNavigator()?.exitReorderMode({ restoreFocus: false });
    this.currentRoute = { ...route };
    const target = routeTarget(route);
    const domain = routeDomain(route);
    const nextView: TasksView =
      target === "recovery"
        ? "recovery"
        : route?.threadId || route?.sectionId
          ? "detail"
          : target === "new"
            ? "new"
            : "home";
    const nextDetailView = route?.sectionId
      ? (route.sectionSurface ?? "new")
      : domain ||
        (target === "terminal"
          ? "terminal"
          : target === "review" || target === "review-file"
            ? "review"
            : "conversation");
    const nextThreadId = `${route?.threadId ?? ""}`;
    const nextSectionId = `${route?.sectionId ?? ""}`;
    if (
      nextView !== this.view ||
      nextThreadId !== this.selectedThreadId ||
      nextSectionId !== this.selectedSectionId
    ) {
      this.imagePreviewDialog.value?.dismiss();
    }
    const preserveAdopted =
      nextThreadId &&
      this.adoptedThreadId === nextThreadId &&
      taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId;
    const preserveLoadedTask =
      Boolean(options.preserveLoadedTask) ||
      Boolean(preserveAdopted) ||
      (this.selectedThreadId === nextThreadId &&
        taskDetailThreadId(this.taskDetail()?.currentDetail()) ===
          nextThreadId);

    this.view = nextView;
    this.detailView = nextDetailView;
    this.detailPresentation = taskRoutePresentation(route);
    this.selectedThreadId = nextThreadId;
    this.selectedSectionId = nextSectionId;
    this.taskNavigator()?.setSelectedSubject(this.selectedSubject());
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    }
    if (nextView !== "recovery") {
      this.taskRecovery.value?.deactivate();
    }
    if (nextView === "detail") {
      this.taskNew.value?.deactivate();
      if (nextThreadId) {
        this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask, route });
      } else {
        const section = this.taskNavigator()?.sectionFor(nextSectionId);
        if (section) {
          this.taskDetail()?.prepareSection(section, route);
        }
      }
    } else if (nextView === "recovery") {
      this.taskNew.value?.deactivate();
      this.taskRecovery.value?.prepare(options.recovery ?? null);
    }
    this.syncSelectedManagedTask();
    this.draw();
    return { preserveLoadedTask };
  }

  async openRoute(route: TasksRoute, options: RouteOptions = {}) {
    const prepared = this.prepareRoute(route, options);
    const navigatorRequest = this.taskNavigator()?.activate();
    const target = routeTarget(route);
    if (target === "new") {
      this.taskNew.value?.prepare({
        cwd: route.cwd ?? "",
        defaultCwdPath: options.defaultCwdPath ?? "",
      });
      this.taskNew.value?.open();
      this.draw();
      return null;
    }
    if (target === "recovery" && route?.threadId) {
      this.taskNew.value?.deactivate();
      this.taskDetail()?.deactivate();
      await this.taskNavigator()?.activate({ force: true });
      const recovery = this.taskNavigator()?.recoveryFor(route.threadId);
      if (!recovery) {
        const task = this.taskNavigator()?.taskFor(route.threadId);
        this.requestRoute(
          task
            ? { kind: "tasks", threadId: route.threadId }
            : { kind: "tasks" },
          { correction: true },
        );
        return null;
      }
      this.taskRecovery.value?.updateRecovery(recovery);
      this.draw();
      return recovery;
    }
    if (route?.sectionId) {
      this.taskNew.value?.deactivate();
      await navigatorRequest;
      const section = this.taskNavigator()?.sectionFor(route.sectionId);
      if (!section) {
        this.requestRoute({ kind: "tasks" }, { correction: true });
        return null;
      }
      return await this.taskDetail()?.openSection(section, route);
    }
    if (route?.threadId) {
      this.taskNew.value?.deactivate();
      const recovery = this.taskNavigator()?.recoveryFor(route.threadId);
      if (recovery) {
        this.requestRoute({
          kind: "tasks",
          threadId: route.threadId,
          recovery: true,
        });
        return null;
      }
      const result = await this.taskDetail()?.open(route.threadId, {
        preserveLoadedTask: prepared.preserveLoadedTask,
        route,
      });
      if (this.adoptedThreadId === route.threadId) {
        this.adoptedThreadId = "";
      }
      return result;
    }
    this.taskNew.value?.prepare({
      defaultCwdPath: options.defaultCwdPath ?? "",
    });
    this.taskNew.value?.open();
    this.draw();
    return await this.taskNavigator()?.activate({ force: true });
  }

  startTaskCreation(
    request: TaskStartIntent["request"] | null | undefined,
    submission: Partial<ComposerSubmission> | null | undefined,
  ) {
    // Task and Section routes may replace the originating create component
    // while POST /tasks is pending. This page remains mounted across those
    // routes, so it owns the request until Task Detail accepts the submission.
    const submissionId = `${submission?.submissionId ?? ""}`.trim();
    if (
      this.pendingTaskCreation ||
      !submissionId ||
      !request ||
      typeof request !== "object"
    ) {
      return null;
    }
    const pending: PendingTaskCreation = { submissionId, completion: null };
    this.pendingTaskCreation = pending;
    pending.completion = this.createAndAdoptTask(
      pending,
      { ...request },
      { ...submission },
    );
    return pending.completion;
  }

  setTaskStoreStatusSnapshot(
    snapshot: TaskStoreStatusSnapshot | null | undefined,
  ) {
    this.performUpdate();
    const wasTakenOver = this.taskStoreRecoveryVisible();
    this.taskStoreStatusSnapshot =
      snapshot ?? INITIAL_TASK_STORE_STATUS_SNAPSHOT;
    this.taskNew.value?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
    this.taskDetail()?.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
    this.taskNavigator()?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
    this.taskStoreRecovery.value?.setSnapshot(this.taskStoreStatusSnapshot);
    if (this.taskStoreRecoveryVisible()) {
      this.taskDetail()?.deactivate();
    } else if (
      wasTakenOver &&
      this.view === "detail" &&
      this.selectedThreadId
    ) {
      // The takeover deactivated the open Task; its clearing has to bring
      // the Task back, or the pane it uncovers is blank.
      this.syncSelectedManagedTask();
      void this.taskDetail()?.open(this.selectedThreadId, {
        preserveLoadedTask: true,
        route: this.currentRoute,
      });
    }
    this.draw();
  }

  taskStoreOperationsBlocked() {
    return taskStoreBlocksTaskOperations(this.taskStoreStatusSnapshot);
  }

  taskStoreRecoveryVisible() {
    return this.taskStoreOperationsBlocked();
  }

  taskNavigator() {
    return this.connectedTaskNavigator;
  }

  sidePane() {
    this.performUpdate();
    if (this.taskStoreRecoveryVisible() || this.view !== "detail") {
      return null;
    }
    const detail = this.taskDetail();
    return detail && !detail.hidden ? detail.sidePane() : null;
  }

  actionHintScope(): ActionHintScope {
    this.performUpdate();
    const navigator = this.taskNavigator();
    const activeOwners = !hasActionHintLayoutBox(this)
      ? []
      : this.activeDirectSurfaceOwners().filter(hasActionHintLayoutBox);
    return mergeActionHintScopes(
      navigator && hasActionHintLayoutBox(navigator)
        ? navigator.actionHintScope()
        : null,
      ...activeOwners.map((owner) => owner.actionHintScope()),
    );
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    this.performUpdate();
    const navigator = this.taskNavigator();
    const activeOwners = hasScrollLayoutBox(this)
      ? this.activeDirectSurfaceOwners().filter(hasScrollLayoutBox)
      : [];
    return mergeScrollSurfaceScopes(
      navigator && hasScrollLayoutBox(navigator)
        ? navigator.scrollSurfaceScope()
        : null,
      ...activeOwners.map((owner) => owner.scrollSurfaceScope()),
    );
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    const navigator = this.taskNavigator();
    const detail = this.taskDetail();
    const activeSurface = !hasScrollLayoutBox(this)
      ? []
      : this.view === "home" || this.view === "new"
        ? (this.taskNew.value?.keyboardNavigationContexts() ?? [])
        : this.view === "detail" && detail && hasScrollLayoutBox(detail)
          ? detail.keyboardNavigationContexts()
          : [];
    return mergeKeyboardNavigationContexts(
      navigator && hasScrollLayoutBox(navigator)
        ? navigator.keyboardNavigationContexts()
        : [],
      this.imagePreviewDialog.value?.keyboardNavigationContexts() ?? [],
      activeSurface,
    );
  }

  focusActionHintDestination() {
    this.detailPane.value?.focus({
      preventScroll: true,
    });
  }

  // Where Escape takes focus from a field being edited in Tasks.
  editingEscapeTarget() {
    return this.detailPane.value ?? null;
  }

  taskDetail() {
    return this.detail.value ?? null;
  }

  protected updated() {
    const takeover = this.taskStoreRecoveryVisible();
    const attributes = {
      tasksView: this.view,
      taskListState: this.taskListState,
      taskDetailView: this.view === "detail" ? this.detailView : "conversation",
      taskDetailPresentation: this.detailPresentation,
    };
    for (const [name, value] of Object.entries(attributes)) {
      if (this.dataset[name] !== value) {
        this.dataset[name] = value;
      }
    }
    // The corner controls stand on the Detail header, which the terminal can
    // give up.
    const headerHidden =
      !takeover &&
      this.view === "detail" &&
      Boolean(this.taskDetail()?.headerHidden);
    if (this.hasAttribute("data-task-detail-header-hidden") !== headerHidden) {
      this.toggleAttribute("data-task-detail-header-hidden", headerHidden);
    }
    // New Task and Detail also show and hide themselves as they open and
    // close.
    this.taskNew.value?.toggleAttribute(
      "hidden",
      takeover || (this.view !== "new" && this.view !== "home"),
    );
    this.taskDetail()?.toggleAttribute(
      "hidden",
      takeover || this.view !== "detail",
    );
  }

  render() {
    // Only the store may take the Task surface over — it gates every agent.
    const takeover = this.taskStoreRecoveryVisible();
    return html`
      <section class="tasks-surface" aria-label="Tasks">
        <div
          ${drawn(this.detailPane)}
          class="tasks-detail-pane"
          role="region"
          aria-label="Task content"
          tabindex="-1"
        >
          <caffold-task-store-recovery
            ${drawn(this.taskStoreRecovery)}
            ?hidden=${!takeover}
          ></caffold-task-store-recovery>
          <caffold-task-new
            ${drawn(this.taskNew)}
            hidden
            @caffold:task-new-route-intent=${this.newTaskRouteIntent}
          ></caffold-task-new>
          <caffold-detail-layout
            ${drawn(this.detail)}
            hidden
            @caffold:task-detail-intent=${this.detailIntent}
            @caffold:task-detail-transport-change=${this.detailTransportChange}
            @caffold:detail-header-change=${this.detailHeaderChange}
          ></caffold-detail-layout>
          <caffold-task-recovery
            ${drawn(this.taskRecovery)}
            ?hidden=${takeover || this.view !== "recovery"}
            @caffold:task-recovery-intent=${this.recoveryIntent}
          ></caffold-task-recovery>
        </div>
      </section>
      <caffold-task-image-preview-dialog
        ${drawn(this.imagePreviewDialog)}
      ></caffold-task-image-preview-dialog>
    `;
  }

  private newTaskRouteIntent(event: CustomEvent<{ route?: TasksRoute }>) {
    event.stopPropagation();
    if (event.detail?.route) {
      this.requestRoute(event.detail.route);
    }
  }

  private detailIntent(event: CustomEvent<DetailIntent>) {
    event.stopPropagation();
    const intent = event.detail;
    if (intent?.type === "task-archived" && intent.task) {
      this.taskNavigator()?.acceptArchivedTask(intent.task);
      this.syncSelectedManagedTask();
      this.requestRoute({ kind: "tasks" }, { correction: true });
    } else if (intent?.type === "task-deleted" && intent.threadId) {
      this.taskNavigator()?.removeTask(intent.threadId);
      this.syncSelectedManagedTask();
      this.requestRoute({ kind: "tasks" }, { correction: true });
    } else if (intent?.type === "task-restored" && intent.task) {
      this.taskNavigator()?.acceptRestoredTask(
        intent.task,
        intent.activeTopPlacement,
      );
      this.syncSelectedManagedTask();
    } else if (
      (intent?.type === "review-route" || intent?.type === "domain-route") &&
      intent.route
    ) {
      this.requestRoute(intent.route);
    }
  }

  private detailTransportChange(event: Event) {
    if (event.target !== this.taskDetail()) {
      return;
    }
    event.stopPropagation();
    this.publishTransportState();
  }

  private detailHeaderChange(event: Event) {
    if (event.target !== this.taskDetail()) {
      return;
    }
    event.stopPropagation();
    this.draw();
  }

  private recoveryIntent(event: CustomEvent<TaskRecoveryIntent>) {
    event.stopPropagation();
    const intent = event.detail;
    if (intent?.type === "rechecked") {
      this.applyRecheckedRecovery(intent.recovery);
    } else if (intent?.type === "resolved") {
      this.resolveRecovery(intent);
    }
  }

  private adoptCreatedTask(
    created: CreatedTask | null | undefined,
    submission: Partial<ComposerSubmission> | null | undefined,
  ) {
    const detail = created?.detail;
    const threadId = taskDetailThreadId(detail);
    if (!created || !threadId || !detail?.task) {
      return false;
    }
    this.adoptedThreadId = threadId;
    this.selectedThreadId = threadId;
    const adopted = this.taskDetail()?.adoptCreatedDetail(detail, submission);
    if (!adopted) {
      return false;
    }
    this.taskNavigator()?.placeCanonicalTaskAtTop(
      created.activeTask,
      created.activeTopPlacement,
    );
    this.syncSelectedManagedTask();
    this.requestRoute({ kind: "tasks", threadId });
    return true;
  }

  private async createAndAdoptTask(
    pending: PendingTaskCreation,
    request: TaskStartIntent["request"],
    submission: Partial<ComposerSubmission>,
  ) {
    try {
      const created = await createTask(request);
      if (!this.adoptCreatedTask(created, submission)) {
        throw new Error(
          "The created Task could not take ownership of its prompt.",
        );
      }
      return created;
    } finally {
      if (this.pendingTaskCreation === pending) {
        this.pendingTaskCreation = null;
      }
    }
  }

  private applyRecheckedRecovery(recovery: ActiveTaskRecovery) {
    const threadId = taskDetailThreadId({ task: recovery });
    if (
      !threadId ||
      threadId !== this.selectedThreadId ||
      this.view !== "recovery"
    ) {
      return;
    }
    this.taskNavigator()?.upsertCanonicalTask(recovery);
    this.taskRecovery.value?.updateRecovery(recovery);
  }

  private resolveRecovery(
    intent: Extract<TaskRecoveryIntent, { type: "resolved" }>,
  ) {
    if (intent.resolution === "restored" && intent.task) {
      this.taskNavigator()?.acceptRestoredTask(
        intent.task,
        intent.activeTopPlacement,
      );
      this.requestRoute({ kind: "tasks", threadId: intent.task.threadId });
    } else if (intent.resolution === "archived" && intent.task) {
      this.taskNavigator()?.acceptArchivedTask(intent.task);
      this.requestRoute({ kind: "tasks" }, { correction: true });
    } else if (intent.resolution === "removed") {
      this.taskNavigator()?.removeTask(intent.threadId);
      this.requestRoute({ kind: "tasks" }, { correction: true });
    }
  }

  private newTaskContextPath() {
    return this.view === "detail"
      ? (this.taskDetail()?.newTaskContextPath() ?? "")
      : (this.taskNew.value?.selectedContextPath() ?? "");
  }

  private activeDirectSurfaceOwners() {
    if (this.taskStoreRecoveryVisible()) {
      const recovery = this.taskStoreRecovery.value;
      return recovery && !recovery.hidden ? [recovery] : [];
    }
    const owner =
      this.view === "detail"
        ? this.taskDetail()
        : this.view === "recovery"
          ? this.taskRecovery.value
          : this.taskNew.value;
    return owner && !owner.hidden ? [owner] : [];
  }

  private syncTaskListState(state: Partial<TaskNavigatorListState> = {}) {
    this.reconcileSelectedTask(state);
    this.reconcileSelectedSection(state);
    this.syncSelectedManagedTask();
    const count = Number(state.count ?? 0);
    const nextState = state.loaded
      ? count > 0
        ? "available"
        : "empty"
      : state.error
        ? "error"
        : count > 0
          ? "available"
          : "loading";
    if (this.taskListState === nextState) {
      return;
    }
    this.taskListState = nextState;
    this.draw();
  }

  private syncSelectedManagedTask() {
    const navigator = this.taskNavigator();
    const selected =
      this.view === "detail" &&
      this.selectedThreadId &&
      !this.selectedSectionId &&
      !navigator?.recoveryFor(this.selectedThreadId)
        ? (navigator?.taskFor(this.selectedThreadId) ?? null)
        : null;
    const repository =
      Boolean(selected) &&
      Boolean(navigator?.sectionForTask(this.selectedThreadId)?.repository);
    this.taskDetail()?.setManagedTask(selected, { repository });
  }

  private reconcileSelectedTask(state: Partial<TaskNavigatorListState>) {
    if (!this.selectedThreadId || !state.loaded) {
      return;
    }
    const recovery = this.taskNavigator()?.recoveryFor(this.selectedThreadId);
    if (!recovery) {
      return;
    }
    if (this.view === "recovery") {
      this.taskRecovery.value?.updateRecovery(recovery);
      return;
    }
    if (this.view === "detail") {
      this.requestRoute({
        kind: "tasks",
        threadId: this.selectedThreadId,
        recovery: true,
      });
    }
  }

  private reconcileSelectedSection(state: Partial<TaskNavigatorListState>) {
    const detail = this.taskDetail();
    if (
      !this.selectedSectionId ||
      this.view !== "detail" ||
      detail?.subjectKind !== "section"
    ) {
      return;
    }
    const section = state.selectedSection ?? null;
    if (!section) {
      if (state.loaded) {
        this.requestRoute({ kind: "tasks" }, { correction: true });
      }
      return;
    }
    if (!detail.sectionContextMatches(section)) {
      void detail.openSection(section, this.currentRoute);
    } else {
      detail.updateSection(section);
    }
  }

  private selectedSubject() {
    if (this.selectedThreadId) {
      return { kind: "task" as const, id: this.selectedThreadId };
    }
    if (this.selectedSectionId) {
      return { kind: "section" as const, id: this.selectedSectionId };
    }
    return null;
  }

  private requestRoute(
    route: TasksRoute,
    options: { correction?: boolean } = {},
  ) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: { ...route },
          correction: Boolean(options.correction),
        },
      }),
    );
  }

  private requestNewTaskRoute() {
    const cwd = this.newTaskContextPath();
    this.requestRoute({
      kind: "tasks",
      new: true,
      ...(cwd && cwd !== "." ? { cwd } : {}),
    });
  }

  private publishTransportState() {
    const navigator = this.taskNavigator();
    const listState = navigator?.listState();
    const detailActive = this.view === "detail";
    const listTransport =
      listState && listState.activeCount > 0 && listState.activeError
        ? TASK_TRANSPORT_STATE.UNAVAILABLE
        : (navigator?.streamState ?? TASK_TRANSPORT_STATE.IDLE);
    const targets = {
      list: {
        active: Boolean(navigator),
        content:
          listState?.loaded || (listState?.count ?? 0) > 0
            ? "present"
            : "absent",
        transport: listTransport,
      },
      detail: {
        active: detailActive,
        content:
          detailActive && this.taskDetail()?.hasSelectedDetail()
            ? "present"
            : "absent",
        transport: detailActive
          ? (this.taskDetail()?.streamState ?? TASK_TRANSPORT_STATE.IDLE)
          : "inactive",
      },
    };
    const publicationKey = JSON.stringify(targets);
    if (publicationKey === this.lastPublishedTransportTargets) {
      return;
    }
    this.lastPublishedTransportTargets = publicationKey;
    this.dispatchEvent(
      new CustomEvent("caffold:task-transport-status", {
        bubbles: true,
        composed: true,
        detail: { targets },
      }),
    );
  }

  // Whoever shows what Tasks shows, the Task list's selection and the
  // workspace's copy of the view, hears of each drawing.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.taskNavigator()?.setSelectedSubject(this.selectedSubject());
    this.dispatchEvent(
      new CustomEvent("caffold:tasks-presentation-change", { bubbles: true }),
    );
    this.publishTransportState();
  }
}

customElements.define("caffold-tasks-page", CaffoldTasksPage);

function reportForegroundValidationStage(
  progress: ForegroundProgress | undefined,
  targets: Iterable<string>,
) {
  const pending = new Set(targets);
  progress?.validatingTransports({
    detail: pending.has("detail"),
    list: pending.has("list"),
  });
}

function taskRoutePresentation(route: TasksRoute) {
  const domain = routeDomain(route);
  const target = routeTarget(route);
  if (domain === "git") {
    return route.kind === "compare" || target !== "list" ? "code" : "reading";
  }
  if (domain === "github") {
    return target === "files" || target === "file" ? "code" : "reading";
  }
  return target === "review" ||
    target === "review-file" ||
    target === "terminal"
    ? "code"
    : "reading";
}
