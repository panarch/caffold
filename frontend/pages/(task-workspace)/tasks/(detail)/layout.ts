import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { TaskDetail } from "#app/api.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import {
  routeDomain,
  routeMode,
  type SectionDetailRoute,
  sectionDetailRoute,
} from "#app/navigation-routes.js";
import type { WorkspaceLiveUpdates } from "#app/pages/(task-workspace)/live-updates.js";
import type { TaskStoreStatusSnapshot } from "#app/pages/(task-workspace)/task-store-status.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import "#components/segmented-control.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type { CaffoldSegmentedControl } from "#components/segmented-control.js";
import type { ComposerSubmission } from "../components/composer.js";
import {
  type TaskTransportState,
  taskThreadStatusType,
} from "../runtime-state.js";
import { cleanLogicalPath } from "../task-format.js";
import { type ListedTask, taskThreadId } from "../task-list-model.js";
import "./(git)/layout.js";
import type { CaffoldTaskGitLayout } from "./(git)/layout.js";
import "./(github)/layout.js";
import type { CaffoldTaskGithubLayout } from "./(github)/layout.js";
import "./(review)/layout.js";
import type { CaffoldTaskReview } from "./(review)/layout.js";
import "./(section)/components/summary.js";
import type { CaffoldSectionDetailSummary } from "./(section)/components/summary.js";
import "./(section)/layout.js";
import type {
  CaffoldSectionDetail,
  DetailSection,
} from "./(section)/layout.js";
import "./(task)/components/summary.js";
import type {
  CaffoldTaskDetailSummary,
  TaskSummaryIntent,
} from "./(task)/components/summary.js";
import "./(task)/layout.js";
import type {
  CaffoldTaskDetail,
  TaskSubjectSnapshot,
} from "./(task)/layout.js";
import "./components/git-menu.js";
import type {
  CaffoldTaskDetailGit,
  GitMenuIntent,
} from "./components/git-menu.js";
import "./components/github-menu.js";
import type {
  CaffoldTaskDetailGithub,
  GitHubMenuIntent,
} from "./components/github-menu.js";
import "./components/terminal-button.js";
import type { CaffoldTaskDetailTerminal } from "./components/terminal-button.js";
import "./terminal/page.js";
import type { CaffoldTerminalPage } from "./terminal/page.js";

const CLEAN_REVIEW_CACHE_LIMIT = 6;

// A route a Task's Detail shows, with the fields its surfaces read.
interface TaskRoute {
  kind: string;
  threadId?: string;
  review?: boolean;
  terminal?: boolean;
  reviewScope?: string;
  reviewNavigator?: string;
  reviewViewer?: string;
  path?: string;
  line?: number | string | null;
  baseRef?: string;
  headRef?: string;
  page?: number;
  sha?: string;
  number?: number | null;
  files?: boolean;
}

// The fields a Section route request names; the Section route builder reads
// each and fills in the rest.
type SectionRouteRequest = Record<string, unknown> & {
  sectionId?: string | null;
};

// The subject Detail shows: a Task by its thread, or a Section by its id.
interface SubjectIdentity {
  kind: "task" | "section";
  id: string;
}

type SubjectKind = "" | "task" | "section";

/**
 * The detail half of Tasks: one subject, a Task or a Section, with its header
 * and the surfaces it shares between them, Integrated Review, Git, GitHub,
 * and the terminal.
 *
 * The Tasks layout binds a subject here and reads it right after, so it draws
 * at once. Each subject's Review is kept apart and moved into its slot, and
 * Git and GitHub are made once into theirs; the header and the slots show
 * what the subject and its route say.
 */
@customElement("caffold-detail-layout")
export class CaffoldDetailLayout extends LitElement {
  subjectKind: SubjectKind = "";
  private section: DetailSection | null = null;
  private sectionRoute: SectionDetailRoute | null = null;
  private taskRoute: TaskRoute | null = null;
  private taskSnapshot: TaskSubjectSnapshot | null = null;
  private managedTask: ListedTask | null = null;
  private managedTaskRepository = false;
  private sectionActivationKey = "";
  private sharedDomainContextKey = "";
  private domainActivationPromise: Promise<unknown> | null = null;
  private readonly reviewComponents = new Map<string, CaffoldTaskReview>();
  private readonly reviewLastUsed = new Map<string, number>();
  private reviewUseSequence = 0;
  private activeReviewKey = "";
  private transportAvailable = true;
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot | null = null;
  private liveUpdates: WorkspaceLiveUpdates | null = null;
  // Where the terminal toggle returns to, per subject, and the subject whose
  // terminal screen the person asked for and is about to open.
  private readonly terminalReturnRoutes = new Map<
    string,
    TaskRoute | SectionRouteRequest
  >();
  private pendingTerminalTake = "";
  private readonly summaryHeader = new DrawnRef<HTMLElement>(this);
  private readonly taskSummary = new DrawnRef<CaffoldTaskDetailSummary>(this);
  private readonly sectionSummary = new DrawnRef<CaffoldSectionDetailSummary>(
    this,
  );
  private readonly viewSwitch = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly gitMenu = new DrawnRef<CaffoldTaskDetailGit>(this);
  private readonly githubMenu = new DrawnRef<CaffoldTaskDetailGithub>(this);
  private readonly terminalButton = new DrawnRef<CaffoldTaskDetailTerminal>(
    this,
  );
  private readonly taskDetail = new DrawnRef<CaffoldTaskDetail>(this);
  private readonly sectionDetail = new DrawnRef<CaffoldSectionDetail>(this);
  private readonly reviewSlot = new DrawnRef<HTMLDivElement>(this);
  private readonly gitSlot = new DrawnRef<HTMLDivElement>(this);
  private readonly githubSlot = new DrawnRef<HTMLDivElement>(this);
  private readonly terminalPage = new DrawnRef<CaffoldTerminalPage>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
    this.disposeReviews();
    this.gitLayout()?.remove();
    this.githubLayout()?.remove();
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null | undefined) {
    this.performUpdate();
    this.liveUpdates = liveUpdates ?? null;
    this.taskDetail.value?.setLiveUpdates(this.liveUpdates);
    this.gitLayout()?.setLiveUpdates(this.liveUpdates);
    for (const review of this.reviewComponents.values()) {
      review.setLiveUpdates(this.liveUpdates);
    }
  }

  prepare(
    threadId: string,
    options: { preserveLoadedTask?: boolean; route?: TaskRoute | null } = {},
  ) {
    this.performUpdate();
    if (taskThreadId(this.managedTask) !== `${threadId ?? ""}`) {
      this.managedTask = null;
      this.managedTaskRepository = false;
    }
    this.taskRoute = { ...(options.route ?? { kind: "tasks", threadId }) };
    this.keepTerminalTakeFor(this.taskRoute.terminal ? `task:${threadId}` : "");
    this.activateSubject("task");
    const prepared = this.taskDetail.value?.prepare(threadId, options);
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
    return prepared;
  }

  async open(
    threadId: string,
    options: { preserveLoadedTask?: boolean; route?: TaskRoute | null } = {},
  ) {
    this.performUpdate();
    this.taskRoute = { ...(options.route ?? { kind: "tasks", threadId }) };
    this.activateSubject("task");
    const result = await this.taskDetail.value?.open(threadId, options);
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
    await this.activateSharedSurface();
    return result;
  }

  adoptCreatedDetail(
    detail: TaskDetail | null | undefined,
    submission?: Partial<ComposerSubmission> | null,
  ) {
    this.performUpdate();
    this.activateSubject("task");
    const adopted = this.taskDetail.value?.adoptCreatedDetail(
      detail,
      submission,
    );
    if (!adopted) {
      return false;
    }
    this.captureTaskSnapshot();
    this.syncTaskPresentation();
    return true;
  }

  prepareSection(
    section: DetailSection | null | undefined,
    route: SectionRouteRequest | null | undefined,
  ) {
    this.performUpdate();
    if (!section?.id) {
      this.deactivate();
      return false;
    }
    this.managedTask = null;
    this.managedTaskRepository = false;
    const contextChanged = !this.sectionContextMatches(section);
    if (contextChanged) {
      this.deactivateSectionSurfaces();
      this.sectionActivationKey = "";
    }
    this.section = { ...section };
    this.sectionRoute = sectionDetailRoute({
      ...route,
      sectionId: section.id,
    });
    this.keepTerminalTakeFor(
      this.sectionRoute?.sectionSurface === "terminal"
        ? `section:${section.id}`
        : "",
    );
    this.activateSubject("section");
    this.sectionDetail.value?.setSection(this.section);
    this.sectionDetail.value?.setTransportAvailable(this.transportAvailable);
    this.sectionDetail.value?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
    this.syncSectionPresentation();
    return true;
  }

  async openSection(
    section: DetailSection | null | undefined,
    route: SectionRouteRequest | null | undefined,
  ) {
    if (!this.prepareSection(section, route) || !this.section) {
      return null;
    }
    const surface = this.sectionRoute?.sectionSurface;
    if (
      !this.section.repository &&
      surface !== "new" &&
      surface !== "terminal"
    ) {
      this.requestSectionRoute({ sectionId: this.section.id });
      return this.section;
    }
    await this.activateSharedSurface();
    return section;
  }

  sectionContextMatches(section: DetailSection | null | undefined) {
    return sectionContextKey(this.section) === sectionContextKey(section);
  }

  updateSection(section: DetailSection) {
    if (!this.sectionContextMatches(section)) {
      return false;
    }
    const previousSettings = JSON.stringify(
      this.section?.composerSettings ?? null,
    );
    const nextSettings = JSON.stringify(section?.composerSettings ?? null);
    this.section = { ...section };
    if (previousSettings === nextSettings) {
      return false;
    }
    this.sectionDetail.value?.setSection(this.section);
    this.githubLayout()?.setContext({
      composerSettings: this.section.composerSettings ?? null,
    });
    return true;
  }

  setManagedTask(
    task: ListedTask | null | undefined,
    { repository = false } = {},
  ) {
    this.performUpdate();
    const selectedThreadId = `${this.taskRoute?.threadId ?? ""}`;
    const nextTask =
      selectedThreadId && taskThreadId(task) === selectedThreadId
        ? (task ?? null)
        : null;
    const nextRepository = Boolean(nextTask) && Boolean(repository);
    if (
      this.managedTask === nextTask &&
      this.managedTaskRepository === nextRepository
    ) {
      return;
    }
    this.managedTask = nextTask;
    this.managedTaskRepository = nextRepository;
    this.taskDetail.value?.setManagedTask(nextTask);
    if (this.subjectKind === "task") {
      this.syncTaskPresentation();
    }
  }

  deactivate(options: { retainComposerDom?: boolean } = {}) {
    if (!this.hasUpdated) {
      return;
    }
    this.terminalPage.value?.deactivate();
    if (this.subjectKind === "task") {
      this.taskDetail.value?.deactivate(options);
      this.deactivateSharedChildren();
    } else {
      this.deactivateSectionSurfaces();
      this.sectionDetail.value?.clear();
      this.section = null;
    }
    this.managedTask = null;
    this.managedTaskRepository = false;
  }

  suspendForeground() {
    if (this.subjectKind === "task") {
      this.taskDetail.value?.suspendForeground();
    }
    this.terminalPage.value?.suspendForeground();
  }

  recoverForeground() {
    const task =
      this.subjectKind === "task"
        ? this.taskDetail.value?.recoverForeground()
        : null;
    const terminal =
      this.presentedSurface() === "terminal"
        ? this.terminalPage.value?.recoverForeground()
        : null;
    if (!terminal) {
      return task;
    }
    return Promise.all([task, terminal]).then(
      ([result]) => result ?? { ok: true },
    );
  }

  currentDetail() {
    return this.taskDetail.value?.currentDetail() ?? null;
  }

  hasSelectedTaskDetail() {
    return (
      this.subjectKind === "task" &&
      Boolean(this.taskDetail.value?.hasSelectedTaskDetail())
    );
  }

  hasSelectedDetail() {
    return this.subjectKind === "section"
      ? Boolean(this.section?.id)
      : this.hasSelectedTaskDetail();
  }

  newTaskContextPath() {
    return this.subjectKind === "task"
      ? (this.taskDetail.value?.newTaskContextPath() ?? "")
      : (this.sectionDetail.value?.selectedContextPath() ?? "");
  }

  get taskDetailView() {
    return this.subjectKind === "task"
      ? (this.taskDetail.value?.taskDetailView ?? "conversation")
      : (this.sectionRoute?.sectionSurface ?? "new");
  }

  get streamState(): TaskTransportState | "inactive" | undefined {
    const terminal =
      this.presentedSurface() === "terminal"
        ? this.terminalPage.value?.transportState
        : null;
    if (terminal === "unavailable" || this.subjectKind !== "task") {
      return terminal ?? "inactive";
    }
    return this.taskDetail.value?.streamState;
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.sectionDetail.value?.setServerPaths(server);
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
    this.sectionDetail.value?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.sectionDetail.value?.setTaskStoreStatusSnapshot(
      this.taskStoreStatusSnapshot,
    );
  }

  // The start pane of the code surface on screen: Integrated Review's
  // navigator or the file tree of Git or GitHub. The terminal has none, so the
  // corner toggle keeps its place there but cannot open anything.
  sidePane() {
    this.performUpdate();
    if (!detailIdentityKey(this.subjectIdentity()) || this.hidden) {
      return null;
    }
    const surface = this.presentedSurface();
    if (surface === "terminal") {
      return {
        label: "side panel",
        beside: true,
        collapsible: false,
        collapsed: true,
        setCollapsed: () => {},
      };
    }
    if (surface === "review") {
      return this.review()?.sidePane() ?? null;
    }
    if (surface === "git") {
      return this.gitLayout()?.sidePane() ?? null;
    }
    if (surface === "github") {
      return this.githubLayout()?.sidePane() ?? null;
    }
    return null;
  }

  actionHintScope(): ActionHintScope {
    const identityKey = detailIdentityKey(this.subjectIdentity());
    if (!identityKey || this.hidden) {
      return emptyActionHintScope();
    }
    const surface = this.presentedSurface();
    const header = this.summaryHeader.value;
    const headerClipRoots = header ? [this, header] : [this];
    const viewSwitchScope = this.viewSwitch.value?.actionHintScope({
      scopeId: `detail:${identityKey}:view`,
      actionId: ACTION_HINT_ACTION.DETAIL_VIEW,
      clipRoots: headerClipRoots,
    });
    let activeChildScope: ActionHintScope | null | undefined = null;
    let blocked = false;
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail.value;
      if (taskDetail && !taskDetail.hidden) {
        blocked = Boolean(taskDetail.loading);
        activeChildScope = taskDetail.actionHintScope();
      }
    } else if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail.value;
      if (sectionDetail && !sectionDetail.hidden) {
        activeChildScope = sectionDetail.actionHintScope();
      }
    } else if (surface === "review") {
      activeChildScope = this.review()?.actionHintScope();
    } else if (surface === "git") {
      activeChildScope = this.gitLayout()?.actionHintScope();
    } else if (surface === "github") {
      activeChildScope = this.githubLayout()?.actionHintScope();
    } else if (surface === "terminal") {
      activeChildScope = this.terminalPage.value?.actionHintScope({
        scopeId: `detail:${identityKey}`,
        clipRoots: [this],
      });
    }
    const headerScope = {
      scopeId: `detail:${identityKey}`,
      clipRoots: headerClipRoots,
    };
    return mergeActionHintScopes(
      { blocked, targets: [], mutationRoots: [], scrollRoots: [] },
      viewSwitchScope,
      this.gitMenu.value?.actionHintScope(headerScope),
      this.githubMenu.value?.actionHintScope(headerScope),
      this.terminalButton.value?.actionHintScope(headerScope),
      this.subjectKind === "task"
        ? this.taskSummary.value?.actionHintScope(headerScope)
        : null,
      activeChildScope,
    );
  }

  keyboardNavigationContexts() {
    const identityKey = detailIdentityKey(this.subjectIdentity());
    if (!identityKey || this.hidden) {
      return [];
    }
    const scopeId = `detail:${identityKey}`;
    const surface = this.presentedSurface();
    let activeChild: ReturnType<typeof mergeKeyboardNavigationContexts> = [];
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail.value;
      activeChild =
        taskDetail && !taskDetail.hidden && !taskDetail.loading
          ? taskDetail.keyboardNavigationContexts()
          : [];
    } else if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail.value;
      activeChild =
        sectionDetail && !sectionDetail.hidden
          ? sectionDetail.keyboardNavigationContexts()
          : [];
    } else if (surface === "review") {
      activeChild = this.review()?.keyboardNavigationContexts() ?? [];
    } else if (surface === "git") {
      activeChild = this.gitLayout()?.keyboardNavigationContexts() ?? [];
    } else if (surface === "github") {
      activeChild = this.githubLayout()?.keyboardNavigationContexts() ?? [];
    }
    return mergeKeyboardNavigationContexts(
      this.gitMenu.value?.keyboardNavigationContexts({ scopeId }) ?? [],
      this.githubMenu.value?.keyboardNavigationContexts({ scopeId }) ?? [],
      this.subjectKind === "task"
        ? (this.taskSummary.value?.keyboardNavigationContexts({ scopeId }) ??
            [])
        : [],
      activeChild,
    );
  }

  scrollSurfaceScope() {
    if (!detailIdentityKey(this.subjectIdentity()) || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const surface = this.presentedSurface();
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail.value;
      return taskDetail && !taskDetail.hidden && !taskDetail.loading
        ? taskDetail.scrollSurfaceScope()
        : emptyScrollSurfaceScope();
    }
    if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail.value;
      return sectionDetail && !sectionDetail.hidden
        ? sectionDetail.scrollSurfaceScope()
        : emptyScrollSurfaceScope();
    }
    if (surface === "review") {
      return this.review()?.scrollSurfaceScope() ?? emptyScrollSurfaceScope();
    }
    if (surface === "git") {
      return (
        this.gitLayout()?.scrollSurfaceScope() ?? emptyScrollSurfaceScope()
      );
    }
    if (surface === "github") {
      return (
        this.githubLayout()?.scrollSurfaceScope() ?? emptyScrollSurfaceScope()
      );
    }
    return emptyScrollSurfaceScope();
  }

  /**
   * The terminal toggle behind the header button and Ctrl+`. The terminal
   * screen returns to where it was before, whatever its connection shows; any
   * other screen enters the terminal, taking it from wherever it is shown.
   */
  toggleTerminal() {
    this.performUpdate();
    const identity = this.subjectIdentity();
    const key = detailIdentityKey(identity);
    if (!key || this.hidden || !this.terminalDirectory()) {
      return false;
    }
    if (this.activeSurface() === "terminal") {
      this.leaveTerminal();
      return true;
    }
    this.terminalReturnRoutes.set(
      key,
      this.subjectKind === "section"
        ? { ...this.sectionRoute }
        : { ...(this.taskRoute ?? { kind: "tasks" }) },
    );
    this.pendingTerminalTake = key;
    this.requestSubjectRoute(
      this.subjectKind === "section"
        ? { sectionId: identity.id, sectionSurface: "terminal" }
        : { kind: "tasks", threadId: identity.id, terminal: true },
    );
    return true;
  }

  /** Whether `element` takes keystrokes for the terminal on screen. */
  ownsTerminalInput(element: Element | null | undefined) {
    return (
      this.activeSurface() === "terminal" &&
      Boolean(this.terminalPage.value?.ownsInput(element))
    );
  }

  get headerHidden() {
    return this.hasAttribute("data-header-hidden");
  }

  protected override firstUpdated() {
    this.taskDetail.value?.setLiveUpdates(this.liveUpdates);
  }

  protected override updated() {
    const kind = this.subjectKind;
    if (kind && this.dataset.detailSubject !== kind) {
      this.dataset.detailSubject = kind;
    }
  }

  override render() {
    const kind = this.subjectKind;
    const surface = kind ? this.presentedSurface() : "";
    const canonicalTask = kind === "task" ? this.canonicalTask() : null;
    const listedTask = kind === "task" ? this.listedTask() : null;
    const repository =
      kind === "section"
        ? Boolean(this.section?.repository)
        : Boolean(canonicalTask?.worktree?.rootPath);
    // Before the Task's details arrive, the Section it is listed in says
    // whether it is in a Git repository.
    const inRepository =
      kind !== "task" || canonicalTask
        ? repository
        : Boolean(listedTask) && this.managedTaskRepository;
    const headerHidden =
      kind === "task" ? !(canonicalTask ?? listedTask) : !this.section;
    const subjectSurface = kind === "task" ? "conversation" : "new";
    return html`
      <div class="common-detail-shell">
        <header
          ${drawn(this.summaryHeader)}
          class="detail-layout-summary task-detail-summary"
          ?hidden=${headerHidden}
        >
          <caffold-task-detail-summary
            ${drawn(this.taskSummary)}
            ?hidden=${kind !== "task"}
            @caffold:task-detail-summary-intent=${this.summaryIntent}
          ></caffold-task-detail-summary>
          <caffold-section-detail-summary
            ${drawn(this.sectionSummary)}
            ?hidden=${kind !== "section"}
          ></caffold-section-detail-summary>
          <div class="detail-layout-actions">
            <caffold-segmented-control
              ${drawn(this.viewSwitch)}
              data-detail-view-switch
              ?hidden=${kind === "task" ? !canonicalTask : !repository}
              @caffold:segmented-control-intent=${this.handleViewIntent}
            ></caffold-segmented-control>
            <caffold-task-detail-git
              ${drawn(this.gitMenu)}
              ?hidden=${!inRepository}
              @caffold:task-detail-git-intent=${this.handleGitMenuIntent}
            ></caffold-task-detail-git>
            <caffold-task-detail-github
              ${drawn(this.githubMenu)}
              ?hidden=${!inRepository}
              @caffold:task-detail-github-intent=${this.handleGithubMenuIntent}
            ></caffold-task-detail-github>
          </div>
          <caffold-task-detail-terminal
            ${drawn(this.terminalButton)}
            @caffold:task-detail-terminal-intent=${this.terminalButtonIntent}
          ></caffold-task-detail-terminal>
        </header>
        <div class="detail-layout-body">
          <div
            class="detail-subject-slot"
            ?hidden=${surface !== subjectSurface}
          >
            <caffold-task-detail
              ${drawn(this.taskDetail)}
              hidden
              @caffold:task-subject-snapshot=${this.taskSubjectSnapshot}
              @caffold:task-detail-transport-change=${this.taskTransportChange}
            ></caffold-task-detail>
            <caffold-section-detail
              ${drawn(this.sectionDetail)}
              hidden
              @caffold:section-detail-intent=${this.handleSectionDetailIntent}
            ></caffold-section-detail>
          </div>
          <div
            ${drawn(this.reviewSlot)}
            class="detail-review-slot"
            ?hidden=${surface !== "review"}
            @caffold:task-review-route-intent=${this.handleReviewRouteIntent}
          ></div>
          <div
            ${drawn(this.gitSlot)}
            class="detail-git-slot"
            ?hidden=${surface !== "git"}
            @caffold:change-compare-refs=${this.changeCompareRefs}
            @caffold:refresh-git-review=${this.refreshGitReview}
            @caffold:request-git-route=${this.handleGitRouteIntent}
          ></div>
          <div
            ${drawn(this.githubSlot)}
            class="detail-github-slot"
            ?hidden=${surface !== "github"}
            @caffold:request-github-route=${this.handleGithubRouteIntent}
          ></div>
          <div class="detail-terminal-slot" ?hidden=${surface !== "terminal"}>
            <caffold-terminal-page
              ${drawn(this.terminalPage)}
              @caffold:terminal-page-leave=${this.terminalLeave}
              @caffold:terminal-page-header=${this.terminalHeaderChange}
              @caffold:terminal-page-state=${this.terminalStateChange}
            ></caffold-terminal-page>
          </div>
        </div>
      </div>
    `;
  }

  private activateSubject(kind: "task" | "section") {
    if (this.subjectKind === kind) {
      this.hidden = false;
      return;
    }
    if (this.subjectKind === "task") {
      this.taskDetail.value?.deactivate();
      this.deactivateSharedChildren();
    } else if (this.subjectKind === "section") {
      this.deactivateSectionSurfaces();
      this.sectionDetail.value?.clear();
      this.section = null;
    }
    this.subjectKind = kind;
    this.hidden = false;
    this.draw();
    this.syncActivePresentation();
  }

  private selectedTaskContextPath() {
    return this.subjectKind === "task"
      ? (this.taskDetail.value?.selectedTaskContextPath() ?? "")
      : (this.sectionDetail.value?.selectedContextPath() ?? "");
  }

  private captureTaskSnapshot() {
    this.taskSnapshot =
      this.taskDetail.value?.detailSnapshot() ?? this.taskSnapshot;
  }

  private syncActivePresentation() {
    if (this.subjectKind === "task") {
      this.captureTaskSnapshot();
      this.syncTaskPresentation();
    } else if (this.subjectKind === "section") {
      this.syncSectionPresentation();
    }
  }

  private syncTaskPresentation() {
    if (this.subjectKind !== "task") {
      return;
    }
    const snapshot = this.taskSnapshot;
    const canonicalTask = this.canonicalTask();
    const task = canonicalTask ?? this.listedTask();
    const repository = Boolean(canonicalTask?.worktree?.rootPath);
    this.rebindSharedDomainContext();
    const surface = this.presentedSurface();
    this.draw();
    this.taskSummary.value?.setSnapshot({
      task,
      canonicalTaskAvailable: Boolean(canonicalTask),
      archiveBlockedByActive: taskThreadStatusType(canonicalTask) === "active",
      // A Task's Detail never reads as inactive.
      transportState: (snapshot?.transportState ??
        this.streamState ??
        "idle") as TaskTransportState,
      contextPath: snapshot?.contextPath ?? this.selectedTaskContextPath(),
      provider: snapshot?.provider,
      permissionMode: snapshot?.permissionMode,
      archiveState: snapshot?.archiveState,
      forkState: snapshot?.forkState,
    });
    const reviewChoice = !repository
      ? "review"
      : this.taskRoute?.reviewScope === "branch"
        ? "branch"
        : "working";
    this.viewSwitch.value?.setSnapshot({
      label: "Task view",
      actionVerb: "Open",
      selected: surface === "review" ? reviewChoice : surface,
      choices: repository
        ? [
            { value: "conversation", label: "Conversation" },
            { value: "working", label: "Working Tree" },
            {
              value: "branch",
              label: "Branch",
              title: `Compare with ${this.taskRoute?.baseRef || "the default branch"}`,
            },
          ]
        : [
            { value: "conversation", label: "Conversation" },
            { value: "review", label: "Review" },
          ],
    });
    this.gitMenu.value?.setSnapshot({ available: repository });
    this.githubMenu.value?.setSnapshot({ available: repository });
    this.terminalButton.value?.setSnapshot({
      available: Boolean(canonicalTask?.cwdPath),
      pressed: surface === "terminal",
    });
    this.applySurfaceVisibility(surface);
    this.taskDetail.value?.reconcileVisibleSurface();
  }

  private syncSectionPresentation() {
    const section = this.section;
    if (this.subjectKind !== "section" || !section) {
      return;
    }
    const repository = Boolean(section.repository);
    this.rebindSharedDomainContext();
    const surface = this.sectionRoute?.sectionSurface ?? "new";
    this.draw();
    this.sectionSummary.value?.setSnapshot({ section });
    this.viewSwitch.value?.setSnapshot({
      label: "Section view",
      actionVerb: "Open",
      selected:
        surface === "review"
          ? this.sectionRoute?.reviewScope === "branch"
            ? "branch"
            : "working"
          : surface,
      choices: repository
        ? [
            { value: "new", label: "New Task" },
            { value: "working", label: "Working Tree" },
            {
              value: "branch",
              label: "Branch",
              title: `Compare with ${this.sectionRoute?.baseRef || "the default branch"}`,
            },
          ]
        : [{ value: "new", label: "New Task" }],
    });
    this.gitMenu.value?.setSnapshot({ available: repository });
    this.githubMenu.value?.setSnapshot({ available: repository });
    this.terminalButton.value?.setSnapshot({
      available: true,
      pressed: surface === "terminal",
    });
    this.applySurfaceVisibility(surface);
    if (surface === "new") {
      this.sectionDetail.value?.activate();
    } else {
      this.sectionDetail.value?.deactivate();
    }
  }

  private async activateSharedSurface() {
    this.syncActivePresentation();
    const surface = this.presentedSurface();
    if (surface !== "review") {
      this.deactivateReview();
    }
    if (surface !== "git") {
      this.gitLayout()?.deactivate();
    }
    if (surface !== "github") {
      this.githubLayout()?.deactivate();
    }
    if (surface !== "terminal") {
      this.terminalPage.value?.deactivate();
    }
    if (this.subjectKind === "task" && !this.taskSnapshot?.task) {
      return null;
    }
    if (surface === "terminal") {
      return this.activateTerminal();
    }
    if (surface === "review") {
      const review = this.ensureReview();
      if (!review) {
        return null;
      }
      review.setDetailContext({
        identity: this.subjectIdentity(),
        path: this.reviewRootPath(),
        repository: this.hasRepository() ? this.repositorySnapshot() : null,
        route: this.reviewContextRoute(),
      });
      return review;
    }
    if (surface !== "git" && surface !== "github") {
      this.sectionActivationKey = "";
      this.domainActivationPromise = null;
      return null;
    }
    const child =
      surface === "git" ? this.ensureGitLayout() : this.ensureGithubLayout();
    const route = this.domainContextRoute();
    const identity = this.subjectIdentity();
    const rootPath = this.repositoryRootPath();
    if (!identity.id || !this.hasRepository() || !rootPath) {
      child.deactivate();
      child.reset();
      child.prepareRoute(route);
      return child;
    }
    const key = JSON.stringify([
      identity.kind,
      identity.id,
      surface,
      route,
      rootPath,
    ]);
    if (key === this.sectionActivationKey && child.active) {
      return child;
    }
    if (key === this.sectionActivationKey && this.domainActivationPromise) {
      return await this.domainActivationPromise;
    }
    this.sectionActivationKey = key;
    child.prepareRoute(route);
    const activation = child.activate(route, {
      context: {
        path: rootPath,
        repository: this.repositorySnapshot(),
        composerSettings:
          this.subjectKind === "section"
            ? (this.section?.composerSettings ?? null)
            : null,
      },
      routeOptions: {
        resolvePath: (path: string) => joinLogicalPath(rootPath, path),
      },
    });
    this.domainActivationPromise = activation;
    try {
      return await activation;
    } finally {
      if (this.domainActivationPromise === activation) {
        this.domainActivationPromise = null;
      }
    }
  }

  // The subject's own screen shows only on its surface. The slots follow the
  // drawn surface; the subject's screens also hide themselves when they go.
  private applySurfaceVisibility(surface: string) {
    const subjectActive =
      surface === (this.subjectKind === "task" ? "conversation" : "new");
    this.taskDetail.value?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "task",
    );
    this.sectionDetail.value?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "section",
    );
    this.syncHeaderVisibility(surface);
  }

  // The terminal screen may give the header's height to the terminal. Tasks
  // hears of each change, because the corner controls stand on this header.
  private syncHeaderVisibility(surface: string) {
    const hidden =
      surface === "terminal" && Boolean(this.terminalPage.value?.headerHidden);
    if (hidden === this.headerHidden) {
      return;
    }
    this.toggleAttribute("data-header-hidden", hidden);
    this.dispatchEvent(
      new CustomEvent("caffold:detail-header-change", { bubbles: true }),
    );
  }

  // The surface on screen. A Task's own surfaces wait for its canonical Task,
  // and until it is read, or while it is archived or missing, the conversation
  // slot holds what stands in for it. A surface not on screen has no active
  // lifetime.
  private presentedSurface() {
    return this.subjectKind === "task" && !this.canonicalTask()
      ? "conversation"
      : this.activeSurface();
  }

  private canonicalTask() {
    const selectedThreadId = `${this.taskRoute?.threadId ?? ""}`;
    const task = this.taskSnapshot?.task ?? null;
    return selectedThreadId && taskThreadId(task) === selectedThreadId
      ? task
      : null;
  }

  // The Task the Active list holds for the route, which stands in for the
  // Task's own details until they are read.
  private listedTask() {
    const selectedThreadId = `${this.taskRoute?.threadId ?? ""}`;
    return !this.taskSnapshot?.absent &&
      selectedThreadId &&
      taskThreadId(this.managedTask) === selectedThreadId
      ? this.managedTask
      : null;
  }

  // The surface the route asks for.
  private activeSurface() {
    if (this.subjectKind === "section") {
      return this.sectionRoute?.sectionSurface ?? "new";
    }
    if (this.taskRoute?.terminal) {
      return "terminal";
    }
    const domain = routeDomain(this.taskRoute);
    return domain || (this.taskRoute?.review ? "review" : "conversation");
  }

  private subjectIdentity(): SubjectIdentity {
    return this.subjectKind === "section"
      ? { kind: "section", id: `${this.section?.id ?? ""}` }
      : {
          kind: "task",
          id:
            taskThreadId(this.taskSnapshot?.task) ||
            `${this.taskRoute?.threadId ?? ""}`,
        };
  }

  private rebindSharedDomainContext() {
    const identity = this.subjectIdentity();
    const key = JSON.stringify([
      identity.kind,
      identity.id,
      this.repositoryRootPath(),
      this.hasRepository(),
    ]);
    if (key === this.sharedDomainContextKey) {
      return false;
    }
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitLayout()?.reset();
    this.githubLayout()?.reset();
    this.gitMenu.value?.deactivate();
    this.githubMenu.value?.deactivate();
    this.sharedDomainContextKey = key;
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
    return true;
  }

  private repositoryRootPath() {
    return cleanLogicalPath(
      this.subjectKind === "section"
        ? (this.section?.name ?? "")
        : (this.taskSnapshot?.task?.worktree?.rootPath ?? ""),
    );
  }

  private repositorySnapshot() {
    const rootPath = this.repositoryRootPath();
    return this.subjectKind === "section"
      ? { rootPath }
      : { ...(this.taskSnapshot?.task?.worktree ?? {}), rootPath };
  }

  private hasRepository() {
    return this.subjectKind === "section"
      ? Boolean(this.section?.repository)
      : Boolean(this.taskSnapshot?.task?.worktree?.rootPath);
  }

  private reviewRootPath() {
    return cleanLogicalPath(
      this.subjectKind === "section"
        ? (this.section?.name ?? "")
        : (this.taskSnapshot?.contextPath ??
            this.taskSnapshot?.task?.worktree?.rootPath ??
            this.taskSnapshot?.task?.cwdPath ??
            ""),
    );
  }

  private reviewContextRoute(): TaskRoute | null {
    return this.subjectKind === "section"
      ? {
          kind: "tasks",
          threadId: `section:${this.section?.id ?? ""}`,
          review: true,
          ...reviewFields(this.sectionRoute),
        }
      : this.taskRoute;
  }

  private domainContextRoute(): TaskRoute {
    return this.subjectKind === "section"
      ? {
          kind: `${routeMode(this.sectionRoute)}`,
          threadId: `section:${this.section?.id ?? ""}`,
          ...domainFields(this.sectionRoute),
        }
      : (this.taskRoute ?? { kind: "tasks" });
  }

  private deactivateSectionSurfaces() {
    this.sectionDetail.value?.deactivate();
    this.terminalPage.value?.deactivate();
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu.value?.deactivate();
    this.githubMenu.value?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  private deactivateSharedChildren() {
    this.taskSummary.value?.deactivate();
    this.terminalPage.value?.deactivate();
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu.value?.deactivate();
    this.githubMenu.value?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  private taskSubjectSnapshot(event: CustomEvent<TaskSubjectSnapshot>) {
    if (event.target !== this.taskDetail.value) {
      return;
    }
    event.stopPropagation();
    this.taskSnapshot = event.detail ?? null;
    if (this.subjectKind === "task") {
      this.syncTaskPresentation();
      void this.activateSharedSurface();
    }
  }

  private taskTransportChange(event: CustomEvent) {
    if (event.target !== this.taskDetail.value) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-transport-change", {
        bubbles: true,
        composed: true,
        detail: event.detail,
      }),
    );
  }

  private summaryIntent(event: CustomEvent<TaskSummaryIntent>) {
    if (event.target !== this.taskSummary.value) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type === "archive") {
      void this.taskDetail.value?.archiveSelectedTask();
    } else if (event.detail?.type === "fork") {
      void this.taskDetail.value?.forkSelectedTask();
    } else if (event.detail?.type === "permission-instructions") {
      // Focus returns to the details button, because the popover the action
      // came from closes as the dialog takes over.
      this.taskDetail.value?.openPermissionInstructions(
        this.taskSummary.value?.detailsButton(),
      );
    }
  }

  private handleViewIntent(event: CustomEvent<{ value?: string }>) {
    if (event.target !== this.viewSwitch.value) {
      return;
    }
    event.stopPropagation();
    const view = event.detail?.value;
    const preservedReviewRoute: TaskRoute | null =
      this.reviewForSubject()?.currentTaskRoute() ?? null;
    if (this.subjectKind === "section") {
      const sectionId = `${this.section?.id ?? ""}`;
      this.requestSectionRoute(
        view === "new"
          ? { sectionId }
          : {
              sectionId,
              sectionSurface: "review",
              ...reviewFields(preservedReviewRoute ?? this.sectionRoute),
              reviewScope: view === "branch" ? "branch" : "working",
            },
      );
      return;
    }
    const threadId = this.subjectIdentity().id;
    const worktree = this.taskSnapshot?.task?.worktree;
    this.requestTaskRoute(
      view === "conversation"
        ? { kind: "tasks", threadId }
        : {
            ...(preservedReviewRoute ?? {}),
            kind: "tasks",
            threadId,
            review: true,
            reviewScope: view === "branch" ? "branch" : "working",
            reviewNavigator:
              preservedReviewRoute?.reviewNavigator ??
              (worktree ? "changes" : "files"),
            reviewViewer:
              preservedReviewRoute?.reviewViewer ??
              (worktree ? "diff" : "source"),
            path: preservedReviewRoute?.path ?? "",
            baseRef: preservedReviewRoute?.baseRef ?? "",
          },
    );
  }

  private handleGitMenuIntent(event: CustomEvent<GitMenuIntent>) {
    if (event.target !== this.gitMenu.value) {
      return;
    }
    event.stopPropagation();
    const reviewKind = `${event.detail?.reviewKind ?? ""}`;
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: `${this.section?.id ?? ""}`,
        sectionSurface: "git",
        sectionTool: reviewKind,
      });
    } else {
      this.requestTaskRoute({
        kind: reviewKind,
        threadId: this.subjectIdentity().id,
        baseRef: "",
        headRef: "",
        page: 1,
        sha: "",
        path: "",
      });
    }
  }

  private handleGithubMenuIntent(event: CustomEvent<GitHubMenuIntent>) {
    if (event.target !== this.githubMenu.value) {
      return;
    }
    event.stopPropagation();
    const reviewKind = `${event.detail?.reviewKind ?? ""}`;
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: `${this.section?.id ?? ""}`,
        sectionSurface: "github",
        sectionTool: reviewKind,
      });
    } else {
      this.requestTaskRoute({
        kind: reviewKind,
        threadId: this.subjectIdentity().id,
        page: 1,
        number: null,
        files: false,
        path: "",
      });
    }
  }

  private handleReviewRouteIntent(event: CustomEvent<{ route?: TaskRoute }>) {
    if (event.target !== this.review()) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: `${this.section?.id ?? ""}`,
        sectionSurface: "review",
        ...reviewFields(event.detail?.route),
      });
    } else {
      this.requestTaskRoute(event.detail?.route);
    }
  }

  private changeCompareRefs(
    event: CustomEvent<{ baseRef?: string; headRef?: string }>,
  ) {
    if (!this.gitLayout()?.contains(event.target as Node)) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        ...this.sectionRoute,
        sectionSurface: "git",
        sectionTool: "compare",
        baseRef: event.detail?.baseRef ?? "",
        headRef: event.detail?.headRef ?? "",
        path: "",
      });
    } else {
      this.requestTaskRoute({
        kind: "compare",
        threadId: this.subjectIdentity().id,
        baseRef: event.detail?.baseRef ?? "",
        headRef: event.detail?.headRef ?? "",
        path: "",
      });
    }
  }

  private refreshGitReview(event: Event) {
    if (!this.gitLayout()?.contains(event.target as Node)) {
      return;
    }
    event.stopPropagation();
    void this.gitLayout()?.refresh();
  }

  private handleGitRouteIntent(event: CustomEvent<{ route?: TaskRoute }>) {
    if (!this.gitLayout()?.contains(event.target as Node)) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: `${this.section?.id ?? ""}`,
        sectionSurface: "git",
        sectionTool: event.detail?.route?.kind,
        ...domainFields(event.detail?.route),
      });
    } else {
      this.requestTaskDomainRoute(event.detail?.route);
    }
  }

  private handleGithubRouteIntent(event: CustomEvent<{ route?: TaskRoute }>) {
    if (!this.githubLayout()?.contains(event.target as Node)) {
      return;
    }
    event.stopPropagation();
    if (this.subjectKind === "section") {
      this.requestSectionRoute({
        sectionId: `${this.section?.id ?? ""}`,
        sectionSurface: "github",
        sectionTool: event.detail?.route?.kind,
        ...domainFields(event.detail?.route),
      });
    } else {
      this.requestTaskDomainRoute(event.detail?.route);
    }
  }

  private handleSectionDetailIntent(
    event: CustomEvent<{ type?: string; kind?: string }>,
  ) {
    const kind = event.detail?.kind;
    if (
      !this.sectionDetail.value?.contains(event.target as Node) ||
      event.detail?.type !== "open-github" ||
      (kind !== "issues" && kind !== "pulls")
    ) {
      return;
    }
    event.stopPropagation();
    this.requestSectionRoute({
      sectionId: this.section?.id,
      sectionSurface: "github",
      sectionTool: kind,
    });
  }

  private terminalButtonIntent(event: Event) {
    if (event.target !== this.terminalButton.value) {
      return;
    }
    event.stopPropagation();
    this.toggleTerminal();
  }

  private terminalLeave(event: Event) {
    if (event.target !== this.terminalPage.value) {
      return;
    }
    event.stopPropagation();
    this.leaveTerminal();
  }

  private terminalHeaderChange(event: Event) {
    if (event.target !== this.terminalPage.value) {
      return;
    }
    event.stopPropagation();
    this.syncHeaderVisibility(this.presentedSurface());
  }

  private terminalStateChange(event: Event) {
    if (event.target !== this.terminalPage.value) {
      return;
    }
    event.stopPropagation();
    // A lost terminal socket is recovered like a lost Task stream.
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-transport-change", {
        bubbles: true,
        composed: true,
        detail: {},
      }),
    );
  }

  /** Returns from the terminal to the surface the subject showed before it. */
  private leaveTerminal() {
    const key = detailIdentityKey(this.subjectIdentity());
    if (!key || this.activeSurface() !== "terminal") {
      return;
    }
    this.requestSubjectRoute(
      this.terminalReturnRoutes.get(key) ?? this.subjectHomeRoute(),
    );
    this.terminalReturnRoutes.delete(key);
  }

  private activateTerminal() {
    const identity = this.subjectIdentity();
    const mode =
      this.pendingTerminalTake === detailIdentityKey(identity)
        ? "take"
        : "resume";
    this.pendingTerminalTake = "";
    const page = this.terminalPage.value;
    page?.activate({ subject: identity, cwd: this.terminalDirectory(), mode });
    return page;
  }

  // A take asked for by the toggle lasts only until a route other than that
  // subject's terminal is shown.
  private keepTerminalTakeFor(key: string) {
    if (this.pendingTerminalTake !== key) {
      this.pendingTerminalTake = "";
    }
  }

  private terminalDirectory() {
    return this.subjectKind === "section"
      ? `${this.section?.name ?? ""}`
      : `${this.taskSnapshot?.task?.cwdPath ?? ""}`;
  }

  private subjectHomeRoute(): TaskRoute | SectionRouteRequest {
    const { id } = this.subjectIdentity();
    return this.subjectKind === "section"
      ? { sectionId: id }
      : { kind: "tasks", threadId: id };
  }

  private requestSubjectRoute(route: TaskRoute | SectionRouteRequest) {
    if (this.subjectKind === "section") {
      this.requestSectionRoute(route as SectionRouteRequest);
    } else {
      this.requestTaskRoute(route as TaskRoute);
    }
  }

  private requestTaskDomainRoute(route: TaskRoute | undefined) {
    if (!route) {
      return;
    }
    const rootPath = this.repositoryRootPath();
    this.requestTaskRoute({
      ...route,
      threadId: this.subjectIdentity().id,
      ...(route.path ? { path: taskRelativePath(rootPath, route.path) } : {}),
    });
  }

  private requestTaskRoute(route: TaskRoute | null | undefined) {
    if (!route || !this.subjectIdentity().id) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: routeDomain(route) ? "domain-route" : "review-route",
          route,
        },
      }),
    );
  }

  private requestSectionRoute(route: SectionRouteRequest) {
    const normalized = sectionDetailRoute(route);
    if (!normalized) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: routeDomain(normalized) ? "domain-route" : "review-route",
          route: normalized,
        },
      }),
    );
  }

  private ensureReview() {
    const identity = this.subjectIdentity();
    const key = detailIdentityKey(identity);
    const slot = this.reviewSlot.value;
    if (!key || !slot) {
      return null;
    }
    if (this.activeReviewKey && this.activeReviewKey !== key) {
      this.deactivateReview({ prune: false });
    }
    let review = this.reviewComponents.get(key);
    if (!review) {
      review = document.createElement("caffold-task-review");
      review.setLiveUpdates(this.liveUpdates);
      this.reviewComponents.set(key, review);
    }
    this.activeReviewKey = key;
    this.reviewLastUsed.set(key, ++this.reviewUseSequence);
    if (review.parentElement !== slot) {
      slot.replaceChildren(review);
    }
    this.pruneReviewCache();
    return review;
  }

  private reviewForSubject() {
    return (
      this.reviewComponents.get(detailIdentityKey(this.subjectIdentity())) ??
      null
    );
  }

  private deactivateReview({ prune = true } = {}) {
    const key = this.activeReviewKey;
    if (!key) {
      return;
    }
    this.reviewComponents.get(key)?.remove();
    this.reviewLastUsed.set(key, ++this.reviewUseSequence);
    this.activeReviewKey = "";
    if (prune) {
      this.pruneReviewCache();
    }
  }

  private pruneReviewCache() {
    const inactive = [...this.reviewComponents.keys()]
      .filter((key) => key !== this.activeReviewKey)
      .sort(
        (left, right) =>
          (this.reviewLastUsed.get(left) ?? 0) -
          (this.reviewLastUsed.get(right) ?? 0),
      );
    const excess = Math.max(
      0,
      this.reviewComponents.size - CLEAN_REVIEW_CACHE_LIMIT,
    );
    for (let index = 0; index < excess; index += 1) {
      const key = inactive[index];
      this.reviewComponents.get(key)?.remove();
      this.reviewComponents.delete(key);
      this.reviewLastUsed.delete(key);
    }
  }

  private disposeReviews() {
    for (const review of this.reviewComponents.values()) {
      review.remove();
    }
    this.reviewComponents.clear();
    this.reviewLastUsed.clear();
    this.reviewUseSequence = 0;
    this.activeReviewKey = "";
  }

  private ensureGitLayout() {
    let layout = this.gitLayout();
    if (!layout) {
      layout = document.createElement("caffold-task-git-layout");
      layout.setLiveUpdates(this.liveUpdates);
      this.gitSlot.value?.replaceChildren(layout);
    }
    return layout;
  }

  private ensureGithubLayout() {
    let layout = this.githubLayout();
    if (!layout) {
      layout = document.createElement("caffold-task-github-layout");
      this.githubSlot.value?.replaceChildren(layout);
    }
    return layout;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private review() {
    return this.activeReviewKey
      ? (this.reviewComponents.get(this.activeReviewKey) ?? null)
      : null;
  }

  private gitLayout() {
    return this.gitSlot.value?.querySelector<CaffoldTaskGitLayout>(
      ":scope > caffold-task-git-layout",
    );
  }

  private githubLayout() {
    return this.githubSlot.value?.querySelector<CaffoldTaskGithubLayout>(
      ":scope > caffold-task-github-layout",
    );
  }
}

function reviewFields(route: Partial<TaskRoute> | null | undefined) {
  const viewer = route?.reviewViewer;
  return {
    reviewScope: route?.reviewScope === "branch" ? "branch" : "working",
    reviewNavigator: route?.reviewNavigator === "files" ? "files" : "changes",
    reviewViewer: viewer === "source" || viewer === "preview" ? viewer : "diff",
    path: `${route?.path ?? ""}`,
    line: route?.line ?? null,
    baseRef: `${route?.baseRef ?? ""}`,
  };
}

function detailIdentityKey(identity: Partial<SubjectIdentity> = {}) {
  const kind = `${identity.kind ?? ""}`.trim();
  const id = `${identity.id ?? ""}`.trim();
  return kind && id ? `${kind}:${id}` : "";
}

function sectionContextKey(section: DetailSection | null | undefined) {
  const id = `${section?.id ?? ""}`;
  if (!id) {
    return "";
  }
  return JSON.stringify([
    id,
    cleanLogicalPath(section?.name ?? ""),
    Boolean(section?.repository),
  ]);
}

function domainFields(route: Partial<TaskRoute> | null | undefined) {
  return {
    baseRef: `${route?.baseRef ?? ""}`,
    headRef: `${route?.headRef ?? ""}`,
    page: route?.page ?? 1,
    sha: `${route?.sha ?? ""}`,
    number: route?.number ?? null,
    files: Boolean(route?.files),
    path: `${route?.path ?? ""}`,
  };
}

function joinLogicalPath(root: string, path: string) {
  const base = cleanLogicalPath(root);
  const relative = cleanLogicalPath(path);
  return relative && relative !== "."
    ? cleanLogicalPath(`${base}/${relative}`)
    : base;
}

function taskRelativePath(rootPath: string, path: string) {
  const root = cleanLogicalPath(rootPath);
  const target = cleanLogicalPath(path);
  if (!root || root === "." || target === root) {
    return target === root ? "" : target;
  }
  const prefix = `${root}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-detail-layout": CaffoldDetailLayout;
  }
}
