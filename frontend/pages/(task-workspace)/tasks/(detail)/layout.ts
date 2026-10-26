import { html, LitElement } from "lit";
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
import "#components/segmented-control.ts";
import type { CaffoldSegmentedControl } from "#components/segmented-control.ts";
import type { ComposerSubmission } from "../components/composer.ts";
import {
  type TaskTransportState,
  taskThreadStatusType,
} from "../runtime-state.js";
import { cleanLogicalPath } from "../task-format.js";
import { type ListedTask, taskThreadId } from "../task-list-model.js";
import "./(git)/layout.ts";
import type { CaffoldTaskGitLayout } from "./(git)/layout.ts";
import "./(github)/layout.ts";
import type { CaffoldTaskGithubLayout } from "./(github)/layout.ts";
import "./(review)/layout.ts";
import type { CaffoldTaskReview } from "./(review)/layout.ts";
import "./(section)/components/summary.ts";
import type { CaffoldSectionDetailSummary } from "./(section)/components/summary.ts";
import "./(section)/layout.ts";
import type {
  CaffoldSectionDetail,
  DetailSection,
} from "./(section)/layout.ts";
import "./(task)/components/summary.ts";
import type {
  CaffoldTaskDetailSummary,
  TaskSummaryIntent,
} from "./(task)/components/summary.ts";
import "./(task)/layout.ts";
import type {
  CaffoldTaskDetail,
  TaskSubjectSnapshot,
} from "./(task)/layout.ts";
import "./components/git-menu.ts";
import type {
  CaffoldTaskDetailGit,
  GitMenuIntent,
} from "./components/git-menu.ts";
import "./components/github-menu.ts";
import type {
  CaffoldTaskDetailGithub,
  GitHubMenuIntent,
} from "./components/github-menu.ts";
import "./components/terminal-button.ts";
import type { CaffoldTaskDetailTerminal } from "./components/terminal-button.ts";
import "./terminal/page.ts";
import type { CaffoldTerminalPage } from "./terminal/page.ts";

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

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
    this.disposeReviews();
    this.gitLayout()?.remove();
    this.githubLayout()?.remove();
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null | undefined) {
    this.performUpdate();
    this.liveUpdates = liveUpdates ?? null;
    this.taskDetail()?.setLiveUpdates(this.liveUpdates);
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
    const prepared = this.taskDetail()?.prepare(threadId, options);
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
    const result = await this.taskDetail()?.open(threadId, options);
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
    const adopted = this.taskDetail()?.adoptCreatedDetail(detail, submission);
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
    this.sectionDetail()?.setSection(this.section);
    this.sectionDetail()?.setTransportAvailable(this.transportAvailable);
    this.sectionDetail()?.setTaskStoreStatusSnapshot(
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
    this.sectionDetail()?.setSection(this.section);
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
    this.taskDetail()?.setManagedTask(nextTask);
    if (this.subjectKind === "task") {
      this.syncTaskPresentation();
    }
  }

  deactivate(options: { retainComposerDom?: boolean } = {}) {
    if (!this.hasUpdated) {
      return;
    }
    this.terminalPage()?.deactivate();
    if (this.subjectKind === "task") {
      this.taskDetail()?.deactivate(options);
      this.deactivateSharedChildren();
    } else {
      this.deactivateSectionSurfaces();
      this.sectionDetail()?.clear();
      this.section = null;
    }
    this.managedTask = null;
    this.managedTaskRepository = false;
  }

  suspendForeground() {
    if (this.subjectKind === "task") {
      this.taskDetail()?.suspendForeground();
    }
    this.terminalPage()?.suspendForeground();
  }

  recoverForeground() {
    const task =
      this.subjectKind === "task"
        ? this.taskDetail()?.recoverForeground()
        : null;
    const terminal =
      this.presentedSurface() === "terminal"
        ? this.terminalPage()?.recoverForeground()
        : null;
    if (!terminal) {
      return task;
    }
    return Promise.all([task, terminal]).then(
      ([result]) => result ?? { ok: true },
    );
  }

  currentDetail() {
    return this.taskDetail()?.currentDetail() ?? null;
  }

  hasSelectedTaskDetail() {
    return (
      this.subjectKind === "task" &&
      Boolean(this.taskDetail()?.hasSelectedTaskDetail())
    );
  }

  hasSelectedDetail() {
    return this.subjectKind === "section"
      ? Boolean(this.section?.id)
      : this.hasSelectedTaskDetail();
  }

  newTaskContextPath() {
    return this.subjectKind === "task"
      ? (this.taskDetail()?.newTaskContextPath() ?? "")
      : (this.sectionDetail()?.selectedContextPath() ?? "");
  }

  get taskDetailView() {
    return this.subjectKind === "task"
      ? (this.taskDetail()?.taskDetailView ?? "conversation")
      : (this.sectionRoute?.sectionSurface ?? "new");
  }

  get streamState(): TaskTransportState | "inactive" | undefined {
    const terminal =
      this.presentedSurface() === "terminal"
        ? this.terminalPage()?.transportState
        : null;
    if (terminal === "unavailable" || this.subjectKind !== "task") {
      return terminal ?? "inactive";
    }
    return this.taskDetail()?.streamState;
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.sectionDetail()?.setServerPaths(server);
  }

  setTransportAvailable(available: boolean) {
    this.transportAvailable = Boolean(available);
    this.sectionDetail()?.setTransportAvailable(this.transportAvailable);
  }

  setTaskStoreStatusSnapshot(snapshot: TaskStoreStatusSnapshot | null) {
    this.taskStoreStatusSnapshot = snapshot ?? null;
    this.sectionDetail()?.setTaskStoreStatusSnapshot(
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
    this.performUpdate();
    const identityKey = detailIdentityKey(this.subjectIdentity());
    if (!identityKey || this.hidden) {
      return emptyActionHintScope();
    }
    const surface = this.presentedSurface();
    const header = this.summaryHeader();
    const headerClipRoots = header ? [this, header] : [this];
    const viewSwitchScope = this.viewSwitch()?.actionHintScope({
      scopeId: `detail:${identityKey}:view`,
      actionId: ACTION_HINT_ACTION.DETAIL_VIEW,
      clipRoots: headerClipRoots,
      labelForChoice: (choice) => `Open ${choice.label}`,
    });
    let activeChildScope: ActionHintScope | null | undefined = null;
    let blocked = false;
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail();
      if (taskDetail && !taskDetail.hidden) {
        blocked = Boolean(taskDetail.loading);
        activeChildScope = taskDetail.actionHintScope();
      }
    } else if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail();
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
      activeChildScope = this.terminalPage()?.actionHintScope({
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
      this.gitMenu()?.actionHintScope(headerScope),
      this.githubMenu()?.actionHintScope(headerScope),
      this.terminalButton()?.actionHintScope(headerScope),
      this.subjectKind === "task"
        ? this.taskSummary()?.actionHintScope(headerScope)
        : null,
      activeChildScope,
    );
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    const identityKey = detailIdentityKey(this.subjectIdentity());
    if (!identityKey || this.hidden) {
      return [];
    }
    const scopeId = `detail:${identityKey}`;
    const surface = this.presentedSurface();
    let activeChild: ReturnType<typeof mergeKeyboardNavigationContexts> = [];
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail();
      activeChild =
        taskDetail && !taskDetail.hidden && !taskDetail.loading
          ? taskDetail.keyboardNavigationContexts()
          : [];
    } else if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail();
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
      this.gitMenu()?.keyboardNavigationContexts({ scopeId }) ?? [],
      this.githubMenu()?.keyboardNavigationContexts({ scopeId }) ?? [],
      this.subjectKind === "task"
        ? (this.taskSummary()?.keyboardNavigationContexts({ scopeId }) ?? [])
        : [],
      activeChild,
    );
  }

  scrollSurfaceScope() {
    this.performUpdate();
    if (!detailIdentityKey(this.subjectIdentity()) || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const surface = this.presentedSurface();
    if (this.subjectKind === "task" && surface === "conversation") {
      const taskDetail = this.taskDetail();
      return taskDetail && !taskDetail.hidden && !taskDetail.loading
        ? taskDetail.scrollSurfaceScope()
        : emptyScrollSurfaceScope();
    }
    if (this.subjectKind === "section" && surface === "new") {
      const sectionDetail = this.sectionDetail();
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
      Boolean(this.terminalPage()?.ownsInput(element))
    );
  }

  get headerHidden() {
    return this.hasAttribute("data-header-hidden");
  }

  protected firstUpdated() {
    this.taskDetail()?.setLiveUpdates(this.liveUpdates);
  }

  protected updated() {
    const kind = this.subjectKind;
    if (kind && this.dataset.detailSubject !== kind) {
      this.dataset.detailSubject = kind;
    }
  }

  render() {
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
          class="detail-layout-summary task-detail-summary"
          ?hidden=${headerHidden}
        >
          <caffold-task-detail-summary
            ?hidden=${kind !== "task"}
            @caffold:task-detail-summary-intent=${this.summaryIntent}
          ></caffold-task-detail-summary>
          <caffold-section-detail-summary
            ?hidden=${kind !== "section"}
          ></caffold-section-detail-summary>
          <div class="detail-layout-actions">
            <caffold-segmented-control
              data-detail-view-switch
              ?hidden=${kind === "task" ? !canonicalTask : !repository}
              @caffold:segmented-control-intent=${this.handleViewIntent}
            ></caffold-segmented-control>
            <caffold-task-detail-git
              ?hidden=${!inRepository}
              @caffold:task-detail-git-intent=${this.handleGitMenuIntent}
            ></caffold-task-detail-git>
            <caffold-task-detail-github
              ?hidden=${!inRepository}
              @caffold:task-detail-github-intent=${this.handleGithubMenuIntent}
            ></caffold-task-detail-github>
          </div>
          <caffold-task-detail-terminal
            @caffold:task-detail-terminal-intent=${this.terminalButtonIntent}
          ></caffold-task-detail-terminal>
        </header>
        <div class="detail-layout-body">
          <div
            class="detail-subject-slot"
            ?hidden=${surface !== subjectSurface}
          >
            <caffold-task-detail
              hidden
              @caffold:task-subject-snapshot=${this.taskSubjectSnapshot}
              @caffold:task-detail-transport-change=${this.taskTransportChange}
            ></caffold-task-detail>
            <caffold-section-detail
              hidden
              @caffold:section-detail-intent=${this.handleSectionDetailIntent}
            ></caffold-section-detail>
          </div>
          <div
            class="detail-review-slot"
            ?hidden=${surface !== "review"}
            @caffold:task-review-route-intent=${this.handleReviewRouteIntent}
          ></div>
          <div
            class="detail-git-slot"
            ?hidden=${surface !== "git"}
            @caffold:change-compare-refs=${this.changeCompareRefs}
            @caffold:refresh-git-review=${this.refreshGitReview}
            @caffold:request-git-route=${this.handleGitRouteIntent}
          ></div>
          <div
            class="detail-github-slot"
            ?hidden=${surface !== "github"}
            @caffold:request-github-route=${this.handleGithubRouteIntent}
          ></div>
          <div class="detail-terminal-slot" ?hidden=${surface !== "terminal"}>
            <caffold-terminal-page
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
      this.taskDetail()?.deactivate();
      this.deactivateSharedChildren();
    } else if (this.subjectKind === "section") {
      this.deactivateSectionSurfaces();
      this.sectionDetail()?.clear();
      this.section = null;
    }
    this.subjectKind = kind;
    this.hidden = false;
    this.draw();
    this.syncActivePresentation();
  }

  private selectedTaskContextPath() {
    return this.subjectKind === "task"
      ? (this.taskDetail()?.selectedTaskContextPath() ?? "")
      : (this.sectionDetail()?.selectedContextPath() ?? "");
  }

  private captureTaskSnapshot() {
    this.taskSnapshot =
      this.taskDetail()?.detailSnapshot() ?? this.taskSnapshot;
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
    this.taskSummary()?.setSnapshot({
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
    this.viewSwitch()?.setSnapshot({
      label: "Task view",
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
    this.gitMenu()?.setSnapshot({ available: repository });
    this.githubMenu()?.setSnapshot({ available: repository });
    this.terminalButton()?.setSnapshot({
      available: Boolean(canonicalTask?.cwdPath),
      pressed: surface === "terminal",
    });
    this.applySurfaceVisibility(surface);
    this.taskDetail()?.reconcileVisibleSurface();
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
    this.sectionSummary()?.setSnapshot({ section });
    this.viewSwitch()?.setSnapshot({
      label: "Section view",
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
    this.gitMenu()?.setSnapshot({ available: repository });
    this.githubMenu()?.setSnapshot({ available: repository });
    this.terminalButton()?.setSnapshot({
      available: true,
      pressed: surface === "terminal",
    });
    this.applySurfaceVisibility(surface);
    if (surface === "new") {
      this.sectionDetail()?.activate();
    } else {
      this.sectionDetail()?.deactivate();
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
      this.terminalPage()?.deactivate();
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
    this.taskDetail()?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "task",
    );
    this.sectionDetail()?.toggleAttribute(
      "hidden",
      !subjectActive || this.subjectKind !== "section",
    );
    this.syncHeaderVisibility(surface);
  }

  // The terminal screen may give the header's height to the terminal. Tasks
  // hears of each change, because the corner controls stand on this header.
  private syncHeaderVisibility(surface: string) {
    const hidden =
      surface === "terminal" && Boolean(this.terminalPage()?.headerHidden);
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
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
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
    this.sectionDetail()?.deactivate();
    this.terminalPage()?.deactivate();
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  private deactivateSharedChildren() {
    this.taskSummary()?.deactivate();
    this.terminalPage()?.deactivate();
    this.deactivateReview();
    this.gitLayout()?.deactivate();
    this.githubLayout()?.deactivate();
    this.gitMenu()?.deactivate();
    this.githubMenu()?.deactivate();
    this.sectionActivationKey = "";
    this.domainActivationPromise = null;
  }

  private taskSubjectSnapshot(event: CustomEvent<TaskSubjectSnapshot>) {
    if (event.target !== this.taskDetail()) {
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
    if (event.target !== this.taskDetail()) {
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
    if (event.target !== this.taskSummary()) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type === "archive") {
      void this.taskDetail()?.archiveSelectedTask();
    } else if (event.detail?.type === "fork") {
      void this.taskDetail()?.forkSelectedTask();
    } else if (event.detail?.type === "permission-instructions") {
      // Focus returns to the details button, because the popover the action
      // came from closes as the dialog takes over.
      this.taskDetail()?.openPermissionInstructions(
        this.taskSummary()?.querySelector(".task-detail-info-button"),
      );
    }
  }

  private handleViewIntent(event: CustomEvent<{ value?: string }>) {
    if (event.target !== this.viewSwitch()) {
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
    if (event.target !== this.gitMenu()) {
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
    if (event.target !== this.githubMenu()) {
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
      !this.sectionDetail()?.contains(event.target as Node) ||
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
    if (event.target !== this.terminalButton()) {
      return;
    }
    event.stopPropagation();
    this.toggleTerminal();
  }

  private terminalLeave(event: Event) {
    if (event.target !== this.terminalPage()) {
      return;
    }
    event.stopPropagation();
    this.leaveTerminal();
  }

  private terminalHeaderChange(event: Event) {
    if (event.target !== this.terminalPage()) {
      return;
    }
    event.stopPropagation();
    this.syncHeaderVisibility(this.presentedSurface());
  }

  private terminalStateChange(event: Event) {
    if (event.target !== this.terminalPage()) {
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
    const page = this.terminalPage();
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
    const slot = this.reviewSlot();
    if (!key || !slot) {
      return null;
    }
    if (this.activeReviewKey && this.activeReviewKey !== key) {
      this.deactivateReview({ prune: false });
    }
    let review = this.reviewComponents.get(key);
    if (!review) {
      review = document.createElement(
        "caffold-task-review",
      ) as CaffoldTaskReview;
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
      layout = document.createElement(
        "caffold-task-git-layout",
      ) as CaffoldTaskGitLayout;
      layout.setLiveUpdates(this.liveUpdates);
      this.gitSlot()?.replaceChildren(layout);
    }
    return layout;
  }

  private ensureGithubLayout() {
    let layout = this.githubLayout();
    if (!layout) {
      layout = document.createElement(
        "caffold-task-github-layout",
      ) as CaffoldTaskGithubLayout;
      this.githubSlot()?.replaceChildren(layout);
    }
    return layout;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private taskDetail() {
    return this.subjectSlot()?.querySelector<CaffoldTaskDetail>(
      ":scope > caffold-task-detail",
    );
  }

  private taskSummary() {
    return this.querySelector<CaffoldTaskDetailSummary>(
      "caffold-task-detail-summary",
    );
  }

  private summaryHeader() {
    return this.querySelector<HTMLElement>(".detail-layout-summary");
  }

  private sectionSummary() {
    return this.querySelector<CaffoldSectionDetailSummary>(
      "caffold-section-detail-summary",
    );
  }

  private viewSwitch() {
    return this.querySelector<CaffoldSegmentedControl>(
      "caffold-segmented-control[data-detail-view-switch]",
    );
  }

  private gitMenu() {
    return this.querySelector<CaffoldTaskDetailGit>(
      ":scope > .common-detail-shell caffold-task-detail-git",
    );
  }

  private githubMenu() {
    return this.querySelector<CaffoldTaskDetailGithub>(
      ":scope > .common-detail-shell caffold-task-detail-github",
    );
  }

  private sectionDetail() {
    return this.querySelector<CaffoldSectionDetail>("caffold-section-detail");
  }

  private subjectSlot() {
    return this.querySelector<HTMLElement>(".detail-subject-slot");
  }

  private reviewSlot() {
    return this.querySelector<HTMLElement>(".detail-review-slot");
  }

  private gitSlot() {
    return this.querySelector<HTMLElement>(".detail-git-slot");
  }

  private githubSlot() {
    return this.querySelector<HTMLElement>(".detail-github-slot");
  }

  private terminalPage() {
    return this.querySelector<CaffoldTerminalPage>(
      ".detail-terminal-slot > caffold-terminal-page",
    );
  }

  private terminalButton() {
    return this.summaryHeader()?.querySelector<CaffoldTaskDetailTerminal>(
      ":scope > caffold-task-detail-terminal",
    );
  }

  private review() {
    return this.activeReviewKey
      ? (this.reviewComponents.get(this.activeReviewKey) ?? null)
      : null;
  }

  private gitLayout() {
    return this.gitSlot()?.querySelector<CaffoldTaskGitLayout>(
      ":scope > caffold-task-git-layout",
    );
  }

  private githubLayout() {
    return this.githubSlot()?.querySelector<CaffoldTaskGithubLayout>(
      ":scope > caffold-task-github-layout",
    );
  }
}

customElements.define("caffold-detail-layout", CaffoldDetailLayout);

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
