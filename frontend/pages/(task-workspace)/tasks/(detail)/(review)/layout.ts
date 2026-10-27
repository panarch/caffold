import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";
import { subscribeToWatch, watchChangeAffectsPath } from "#app/watch.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-navigator.js";
import type { CaffoldFileNavigator } from "#components/file-navigator.js";
import "#components/pane-resizer.js";
import type { CaffoldPaneResizer } from "#components/pane-resizer.js";
import "#components/segmented-control.js";
import type { CaffoldSegmentedControl } from "#components/segmented-control.js";
import { cleanLogicalPath } from "#tasks/task-format.js";
import { taskThreadId } from "#tasks/task-list-model.js";
import "./components/branch-changes.js";
import type { CaffoldReviewBranchChanges } from "./components/branch-changes.js";
import "./components/selected-file.js";
import type {
  ReviewChanges,
  ReviewView,
} from "./components/selected-file/content.js";
import type { CaffoldReviewSelectedFile } from "./components/selected-file.js";
import "./components/working-tree-changes.js";
import type { CaffoldReviewWorkingTreeChanges } from "./components/working-tree-changes.js";
import {
  joinLogicalPath,
  type ReviewTask,
  relativeTaskPath,
  taskRootPath,
  taskWorktreeRootPath,
} from "./layout/paths.js";
import {
  normalizeForTask,
  normalizeReviewRoute,
  type ReviewRoute,
  type ReviewRouteInput,
  reviewContextKey,
  reviewRouteKey,
  routeForSelectedFile,
  taskRouteForReview,
  viewerStateKey,
} from "./layout/route.js";
import {
  fileRepresentationCapabilities,
  isFileRepresentation,
} from "./representations.js";

// Matches the width where layout.css stops showing one pane at a time.
const REVIEW_SPLIT_MEDIA_QUERY = "(min-width: 561px)";

type ReviewChangesElement =
  | CaffoldReviewWorkingTreeChanges
  | CaffoldReviewBranchChanges;

interface ChangesRead {
  ok: boolean;
  hadData?: boolean;
  wasOutdated?: boolean;
  background?: boolean;
}

interface SyncOptions {
  contextChanged?: boolean;
  routeChanged?: boolean;
  scopeChanged?: boolean;
  revealFileSelection?: boolean;
  reactivated?: boolean;
}

@customElement("caffold-task-review")
export class CaffoldTaskReview extends LitElement {
  @state()
  private accessor route: ReviewRoute = normalizeReviewRoute();
  @state()
  private accessor errorMessage = "";
  @state()
  private accessor panelWidth: number | null = null;

  private active = false;
  private task: ReviewTask | null = null;
  private contextKey = "";
  private previousRouteKey = "";
  private watchUnsubscribe: (() => void) | null = null;
  private watchPath = "";
  private pendingWatchViewerRefresh = false;
  private readonly navigatorScroll = new Map<
    string,
    { top: number; left: number }
  >();
  private liveUpdates: unknown = null;
  private readonly navigatorPane = new DrawnRef<HTMLElement>(this);
  private readonly viewerPane = new DrawnRef<HTMLElement>(this);
  private readonly navigatorAxis = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly viewerAxis = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly workingList = new DrawnRef<CaffoldReviewWorkingTreeChanges>(
    this,
  );
  private readonly branchList = new DrawnRef<CaffoldReviewBranchChanges>(this);
  private readonly filesList = new DrawnRef<CaffoldFileNavigator>(this);
  private readonly paneResizer = new DrawnRef<CaffoldPaneResizer>(this);
  private readonly fileViewer = new DrawnRef<CaffoldReviewSelectedFile>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.active = true;
    this.markChangesOutdated();
    this.syncReview({ reactivated: true });
    this.performUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.active = false;
    this.unsubscribeWatch();
    this.fileNavigator.setWatchActive(false);
  }

  override render() {
    const route = this.route;
    const changesShown = route.navigator === "changes";
    return html`
      <section class="task-review-workspace" aria-label="Task review">
        <div class="task-review-notices">
          <p
            class="task-review-error"
            role="alert"
            ?hidden=${!this.errorMessage}
          >${this.errorMessage}</p>
        </div>
        <div
          class="task-review-layout"
          style=${
            this.panelWidth === null
              ? nothing
              : `--task-review-panel-width: ${this.panelWidth}px`
          }
        >
          <aside
            ${drawn(this.navigatorPane)}
            class="task-review-navigator-pane"
            aria-label="Review navigator"
          >
            <div class="task-review-pane-axis task-review-navigator-axis">
              <caffold-segmented-control
                ${drawn(this.navigatorAxis)}
                data-review-axis="navigator"
                @caffold:segmented-control-intent=${this.chooseAxis}
              ></caffold-segmented-control>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="working"
              ?hidden=${!changesShown || route.scope !== "working"}
            >
              <caffold-review-working-tree-changes
                ${drawn(this.workingList)}
                @caffold:review-branch-intent=${this.reviewBranch}
                @caffold:review-changes-read=${this.followChangesRead}
                @caffold:open-git-diff=${this.openChange}
              ></caffold-review-working-tree-changes>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="branch"
              ?hidden=${!changesShown || route.scope !== "branch"}
            >
              <caffold-review-branch-changes
                ${drawn(this.branchList)}
                @caffold:review-base-intent=${this.chooseBase}
                @caffold:review-changes-read=${this.followChangesRead}
                @caffold:open-compare-diff=${this.openChange}
              ></caffold-review-branch-changes>
            </div>
            <div
              class="task-review-navigator"
              data-review-navigator="files"
              ?hidden=${route.navigator !== "files"}
            >
              <caffold-file-navigator
                ${drawn(this.filesList)}
                @caffold:file-navigator-open-file=${this.openChange}
                @caffold:file-navigator-refresh-selected=${this.refreshFile}
              ></caffold-file-navigator>
            </div>
          </aside>
          <caffold-pane-resizer
            ${drawn(this.paneResizer)}
            start-min="220"
            end-min="360"
            storage-key="caffold:pane-width:task-review"
            collapsed-storage-key="caffold:pane-collapsed:task-review"
            aria-label="Resize review navigator"
            @caffold:pane-resize=${this.resizePanel}
          ></caffold-pane-resizer>
          <section
            ${drawn(this.viewerPane)}
            class="task-review-viewer-pane"
            aria-label="Review file"
          >
            <div
              class="task-review-viewer-empty-header"
              aria-hidden="true"
            ></div>
            <div class="task-review-pane-axis task-review-viewer-axis">
              <caffold-segmented-control
                ${drawn(this.viewerAxis)}
                data-review-axis="viewer"
                @caffold:segmented-control-intent=${this.chooseAxis}
              ></caffold-segmented-control>
            </div>
            <caffold-review-selected-file
              ${drawn(this.fileViewer)}
              @caffold:review-representation-intent=${this.chooseRepresentation}
              @caffold:close-file-viewer=${this.closeFile}
            ></caffold-review-selected-file>
          </section>
        </div>
      </section>
    `;
  }

  override firstUpdated() {
    this.fileNavigator.setStorageKey(null);
    this.fileNavigator.setLiveUpdates(this.liveUpdates);
    this.fileNavigator.setWatchActive(false);
    this.fileNavigator.setRefreshVisible(false);
    this.applyPanelWidth();
  }

  setLiveUpdates(liveUpdates: unknown) {
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    const path = this.watchPath;
    this.unsubscribeWatch();
    this.liveUpdates = liveUpdates ?? null;
    this.fileNavigator.setLiveUpdates(this.liveUpdates);
    if (this.active && path) {
      this.subscribeWatch(path);
    }
  }

  setDetailContext({
    identity = null,
    path = "",
    repository = null,
    route = null,
  }: {
    identity?: { id?: string | null; kind?: string | null } | null;
    path?: string;
    repository?: { rootPath?: string; branch?: string | null } | null;
    route?: ReviewRouteInput | null;
  } = {}) {
    const id = `${identity?.id ?? ""}`;
    const contextPath =
      cleanLogicalPath(path || repository?.rootPath || "") || ".";
    const repositoryRootPath = repository
      ? cleanLogicalPath(repository.rootPath || path || "") || "."
      : "";
    const changed = this.setTaskContext(
      id
        ? {
            threadId:
              identity?.kind === "task"
                ? id
                : `${identity?.kind ?? "detail"}:${id}`,
            cwdPath: contextPath,
            ...(repository
              ? { worktree: { ...repository, rootPath: repositoryRootPath } }
              : {}),
          }
        : null,
      route,
    );
    this.performUpdate();
    return changed;
  }

  currentTaskRoute() {
    const threadId = taskThreadId(this.task);
    if (!threadId) {
      return null;
    }
    return taskRouteForReview(threadId, this.route);
  }

  actionHintScope() {
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyActionHintScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane: Element | null = this.navigatorPane.value ?? null;
    const viewerPane: Element | null = this.viewerPane.value ?? null;
    const navigatorActive = hasActionHintLayoutBox(navigatorPane);
    const viewerActive = hasActionHintLayoutBox(viewerPane);
    const navigatorClipRoots = [this, navigatorPane].filter(
      (root): root is Element => root !== null,
    );
    const viewerClipRoots = [this, viewerPane].filter(
      (root): root is Element => root !== null,
    );
    const navigatorAxis = navigatorActive
      ? this.axisControl("navigator").actionHintScope({
          scopeId: `${scopeId}:navigator-axis`,
          actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          clipRoots: navigatorClipRoots,
        })
      : null;
    const viewerAxis = viewerActive
      ? this.axisControl("viewer").actionHintScope({
          scopeId: `${scopeId}:viewer-axis`,
          actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          clipRoots: viewerClipRoots,
        })
      : null;
    const navigatorScope = !navigatorActive
      ? null
      : this.route.navigator === "files"
        ? this.fileNavigator.actionHintScope({
            scopeId: `${scopeId}:files`,
            actions: {
              file: ACTION_HINT_ACTION.FILE_OPEN,
              disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
              refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            },
            clipRoots: navigatorClipRoots,
          })
        : this.route.scope === "branch"
          ? this.branchChanges.actionHintScope({
              scopeId: `${scopeId}:branch`,
              actions: {
                file: ACTION_HINT_ACTION.FILE_OPEN,
                disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                select: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
              },
              clipRoots: navigatorClipRoots,
            })
          : this.workingTreeChanges.actionHintScope({
              scopeId: `${scopeId}:working`,
              actions: {
                file: ACTION_HINT_ACTION.FILE_OPEN,
                disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                branch: ACTION_HINT_ACTION.REVIEW_AXIS,
              },
              clipRoots: navigatorClipRoots,
            });
    const viewerScope =
      viewerActive && this.route.path
        ? this.selectedFile.actionHintScope({
            scopeId: `${scopeId}:viewer`,
            actions: {
              parent: ACTION_HINT_ACTION.PARENT,
              notice: ACTION_HINT_ACTION.REVIEW_AXIS,
              details: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
              refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              link: ACTION_HINT_ACTION.LINK_OPEN,
              button: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            },
            clipRoots: viewerClipRoots,
          })
        : null;
    const resizerScope = this.resizer.actionHintScope({
      scopeId: `${scopeId}:navigator`,
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this],
    });
    return mergeActionHintScopes(
      navigatorAxis,
      viewerAxis,
      navigatorScope,
      resizerScope,
      viewerScope,
    );
  }

  scrollSurfaceScope() {
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyScrollSurfaceScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane: Element | null = this.navigatorPane.value ?? null;
    const viewerPane: Element | null = this.viewerPane.value ?? null;
    const navigatorClipRoots = [this, navigatorPane].filter(
      (root): root is Element => root !== null,
    );
    const viewerClipRoots = [this, viewerPane].filter(
      (root): root is Element => root !== null,
    );
    const navigatorScope = !hasScrollLayoutBox(navigatorPane)
      ? null
      : this.route.navigator === "files"
        ? this.fileNavigator.scrollSurfaceScope({
            scopeId: `${scopeId}:files`,
            label: "Files",
            clipRoots: navigatorClipRoots,
          })
        : this.route.scope === "branch"
          ? this.branchChanges.scrollSurfaceScope({
              scopeId: `${scopeId}:branch`,
              label: "Branch changes",
              clipRoots: navigatorClipRoots,
            })
          : this.workingTreeChanges.scrollSurfaceScope({
              scopeId: `${scopeId}:working`,
              label: "Working tree changes",
              clipRoots: navigatorClipRoots,
            });
    const viewerScope =
      hasScrollLayoutBox(viewerPane) && this.route.path
        ? this.selectedFile.scrollSurfaceScope({
            scopeId: `${scopeId}:viewer`,
            clipRoots: viewerClipRoots,
          })
        : null;
    return mergeScrollSurfaceScopes(navigatorScope, viewerScope);
  }

  keyboardNavigationContexts() {
    const subjectId = taskThreadId(this.task);
    if (
      !this.active ||
      this.hidden ||
      !subjectId ||
      !this.contextKey ||
      !this.route.path ||
      !hasActionHintLayoutBox(this.viewerPane.value ?? null)
    ) {
      return [];
    }
    return this.selectedFile.keyboardNavigationContexts({
      scopeId: `review:${encodeURIComponent(subjectId)}:viewer`,
    });
  }

  /**
   * The navigator the workspace's side pane toggle hides and shows.
   *
   * It collapses only while a file is open, the same state in which the
   * phone layout shows the viewer instead of the navigator.
   */
  sidePane() {
    return {
      label: "review navigator",
      beside: window.matchMedia(REVIEW_SPLIT_MEDIA_QUERY).matches,
      collapsible: Boolean(this.route.path),
      collapsed: this.sidePaneCollapsed(),
      setCollapsed: (collapsed: boolean) => {
        this.resizer.setCollapsed(collapsed);
        this.applySidePane();
      },
    };
  }

  private setTaskContext(
    task: ReviewTask | null,
    route: ReviewRouteInput | null,
  ) {
    const contextKey = reviewContextKey(task);
    const contextChanged = contextKey !== this.contextKey;
    const previousRoute = this.route;
    const nextRoute = normalizeReviewRoute(route, task);
    const nextRouteKey = reviewRouteKey(nextRoute);
    const routeChanged = Boolean(
      this.previousRouteKey && this.previousRouteKey !== nextRouteKey,
    );
    const scopeChanged =
      routeChanged && previousRoute.scope !== nextRoute.scope;
    const revealFileSelection = Boolean(
      nextRoute.navigator === "files" &&
        nextRoute.path &&
        (contextChanged ||
          previousRoute.navigator !== "files" ||
          previousRoute.path !== nextRoute.path),
    );
    if (this.active && !contextChanged && !routeChanged) {
      // Detail hands the context over on every Task update; keep its newest
      // branch and HEAD for later requests without restarting any load.
      this.task = task;
      this.syncChildContexts();
      return false;
    }
    if (contextChanged) {
      this.resetContext();
      this.contextKey = contextKey;
    } else if (routeChanged) {
      this.captureLocalState();
    }
    this.active = true;
    this.task = task;
    this.route = nextRoute;
    this.previousRouteKey = nextRouteKey;
    this.syncChildContexts();

    const normalizedForTask = normalizeForTask(nextRoute, task);
    if (reviewRouteKey(normalizedForTask) !== nextRouteKey) {
      this.requestRoute(normalizedForTask);
      return true;
    }
    this.syncReview({
      contextChanged,
      routeChanged,
      scopeChanged,
      revealFileSelection,
    });
    return true;
  }

  private chooseAxis(event: CustomEvent<{ value?: string }>) {
    event.stopPropagation();
    const axis = (event.currentTarget as HTMLElement).dataset.reviewAxis;
    const value = `${event.detail?.value ?? ""}`;
    if (axis === "navigator") {
      this.updateRoute({ navigator: value === "files" ? "files" : "changes" });
    } else {
      this.chooseViewer(value);
    }
  }

  private reviewBranch(event: Event) {
    event.stopPropagation();
    this.updateRoute({ scope: "branch" });
  }

  private chooseRepresentation(
    event: CustomEvent<{ representation?: string }>,
  ) {
    event.stopPropagation();
    this.chooseViewer(`${event.detail?.representation ?? ""}`);
  }

  private chooseBase(event: CustomEvent<{ baseRef?: string }>) {
    event.stopPropagation();
    this.captureLocalState();
    this.requestRoute({
      ...this.route,
      baseRef: `${event.detail?.baseRef ?? ""}`,
    });
  }

  private followChangesRead(event: CustomEvent<ChangesRead>) {
    event.stopPropagation();
    const changes = event.currentTarget as ReviewChangesElement;
    const { ok, hadData, wasOutdated, background = false } = event.detail;
    this.patchErrorState();
    if (!ok) {
      this.followRereadInViewer(changes);
      return;
    }
    if (changes === this.branchChanges) {
      if (this.route.path && this.route.scope === "branch") {
        this.selectedFile.reload(this.currentView(), { reread: hadData });
      }
      return;
    }
    const canRefreshViewer =
      Boolean(this.route.path) && this.route.scope === "working";
    const pendingWatchViewerRefresh = this.pendingWatchViewerRefresh;
    this.pendingWatchViewerRefresh = false;
    // A watch change reloads the viewer only for its own file, unless the
    // status it replaces was read before the page came back.
    const refreshViewer = background
      ? canRefreshViewer && (pendingWatchViewerRefresh || wasOutdated)
      : canRefreshViewer;
    if (refreshViewer) {
      this.selectedFile.reload(this.currentView(), {
        background,
        reread: hadData,
      });
    }
  }

  private openChange(event: CustomEvent<{ path?: string }>) {
    event.stopPropagation();
    const relative = relativeTaskPath(
      event.detail?.path,
      taskRootPath(this.task),
    );
    if (!relative) {
      return;
    }
    this.requestRoute(routeForSelectedFile(this.route, relative));
  }

  private refreshFile(event: Event) {
    event.stopPropagation();
    if (isFileRepresentation(this.route.viewer)) {
      this.selectedFile.reload(this.currentView(), { background: true });
    }
  }

  private resizePanel(event: CustomEvent<{ value?: number }>) {
    event.stopPropagation();
    if (Number.isFinite(event.detail?.value)) {
      this.applyPanelWidth();
    }
  }

  private closeFile(event: Event) {
    event.stopPropagation();
    if (!this.route.path) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, path: "", line: null });
  }

  private resetContext() {
    this.unsubscribeWatch();
    this.pendingWatchViewerRefresh = false;
    this.previousRouteKey = "";
    this.fileNavigator.clearSelectedPath();
  }

  private syncChildContexts() {
    const worktreeRootPath = taskWorktreeRootPath(this.task);
    const branch = this.task?.worktree?.branch ?? null;
    this.workingTreeChanges.setContext({ rootPath: worktreeRootPath, branch });
    this.branchChanges.setContext({
      rootPath: worktreeRootPath,
      branch,
      baseRef: this.route.baseRef,
    });
    this.branchChanges.setShown(this.route.scope === "branch");
    this.selectedFile.setContext({
      rootPath: taskRootPath(this.task),
      worktreeRootPath,
    });
  }

  private markChangesOutdated() {
    this.workingTreeChanges.markOutdated();
    this.branchChanges.markOutdated();
  }

  private syncReview(options: SyncOptions = {}) {
    if (!this.active || !this.task) {
      return;
    }
    this.patchControls();
    this.patchLayout();
    this.syncSelection();
    this.ensureFileNavigator({
      refresh: options.reactivated,
      revealSelection: options.revealFileSelection || options.reactivated,
    });
    this.subscribeWatch(taskRootPath(this.task));
    if (this.task.worktree) {
      const working = this.workingTreeChanges.snapshot();
      if (
        options.contextChanged ||
        options.reactivated ||
        !working.data ||
        (options.scopeChanged &&
          this.route.scope === "working" &&
          working.outdated)
      ) {
        void this.readChanges(this.workingTreeChanges);
      }
      if (this.route.scope === "branch") {
        const branch = this.branchChanges.snapshot();
        if (
          options.reactivated ||
          (options.scopeChanged && branch.outdated) ||
          !branch.hasRefs ||
          !branch.data
        ) {
          void this.readChanges(this.branchChanges, {
            force: branch.outdated,
          });
        }
      }
    }
    const reload = Boolean(
      options.contextChanged || options.routeChanged || options.reactivated,
    );
    this.selectedFile.show(this.currentView(), { force: reload });
    if (reload) {
      this.restoreNavigatorScroll();
    }
  }

  private ensureFileNavigator({
    refresh = false,
    revealSelection = false,
  }: {
    refresh?: boolean;
    revealSelection?: boolean;
  }) {
    const navigator = this.fileNavigator;
    const rootPath = taskRootPath(this.task);
    if (!rootPath) {
      return;
    }
    navigator.setWatchActive(false);
    const selectedPath =
      this.route.navigator === "files" && this.route.path
        ? this.logicalSelectedPath()
        : "";
    if (selectedPath) {
      if (revealSelection) {
        void navigator
          .resolvePath(selectedPath, { fallbackPath: rootPath })
          .then(async () => {
            if (selectedPath === this.logicalSelectedPath()) {
              await navigator.revealPath(selectedPath);
            }
          })
          .then(() => {
            if (refresh && selectedPath === this.logicalSelectedPath()) {
              void navigator.requestRefresh({ allDirectories: true });
            }
          });
      } else if (refresh) {
        void navigator.requestRefresh({ allDirectories: true });
      }
      return;
    }
    if (!navigator.hasLoadedDirectory(rootPath)) {
      void navigator.loadDirectory(rootPath, { allowFailure: true });
    } else if (refresh) {
      void navigator.requestRefresh({ allDirectories: true });
    }
  }

  private readChanges(
    changes: ReviewChangesElement,
    options: { background?: boolean; force?: boolean } = {},
  ) {
    const reading = changes.read(options);
    this.followRereadInViewer(changes);
    return reading;
  }

  // Where the shown changes from before the page came back say the selected
  // file did not change, the viewer follows their reread: loading while it
  // runs, then the read's error if it fails.
  private followRereadInViewer(changes: ReviewChangesElement) {
    if (
      changes !== this.shownChanges ||
      !this.route.path ||
      this.route.viewer !== "diff"
    ) {
      return;
    }
    const { data, outdated } = changes.snapshot();
    if (!outdated || !data || changes.change(this.logicalSelectedPath())) {
      return;
    }
    this.selectedFile.reload(this.currentView());
  }

  private currentView(): ReviewView {
    const logicalPath = this.logicalSelectedPath();
    return {
      stateKey: viewerStateKey(this.route),
      scope: this.route.scope,
      path: this.route.path,
      logicalPath,
      representation: this.route.viewer,
      line: this.route.line,
      entry: logicalPath
        ? (this.fileNavigator.entryForPath(logicalPath) ?? null)
        : null,
      changes: this.viewerChanges(logicalPath),
    };
  }

  private viewerChanges(logicalPath: string): ReviewChanges {
    if (!this.task?.worktree) {
      return {
        ready: false,
        outdated: false,
        failed: false,
        error: null,
        change: null,
        diffKind: "",
        readDiff: null,
      };
    }
    const changes = this.shownChanges;
    const { data, error, outdated, failed } = changes.snapshot();
    return {
      ready: Boolean(data),
      outdated,
      failed,
      error,
      change: logicalPath ? changes.change(logicalPath) : null,
      diffKind: changes.diffKind(),
      readDiff: () => changes.readDiff(logicalPath),
    };
  }

  private captureLocalState() {
    const scroll =
      this.route.navigator === "files"
        ? this.fileNavigator.captureScroll()
        : this.shownChanges.captureListScroll();
    if (scroll) {
      this.navigatorScroll.set(this.navigatorStateKey(), scroll);
    }
  }

  private restoreNavigatorScroll() {
    const scroll = this.navigatorScroll.get(this.navigatorStateKey());
    if (!scroll) {
      return;
    }
    if (this.route.navigator === "files") {
      this.fileNavigator.restoreScroll(scroll);
    } else {
      this.shownChanges.restoreListScroll(scroll);
    }
  }

  private patchControls() {
    const gitAvailable = Boolean(this.task?.worktree);
    const navigatorChoices = [
      ...(gitAvailable ? [{ value: "changes", label: "Changes" }] : []),
      { value: "files", label: "Files" },
    ];
    this.dataset.reviewNavigatorChoiceCount = `${navigatorChoices.length}`;
    this.axisControl("navigator").setSnapshot({
      label: "Review navigator",
      actionVerb: "Show",
      selected: this.route.navigator,
      choices: navigatorChoices,
    });
    const representations = fileRepresentationCapabilities(this.route.path);
    const preserveUnboundPreview =
      !this.route.path && this.route.viewer === "preview";
    const viewerChoices = [
      ...(gitAvailable ? [{ value: "diff", label: "Diff" }] : []),
      ...(representations.source ? [{ value: "source", label: "Source" }] : []),
      ...(representations.previewKind || preserveUnboundPreview
        ? [{ value: "preview", label: "Preview" }]
        : []),
    ];
    this.dataset.reviewViewerChoiceCount = `${viewerChoices.length}`;
    this.axisControl("viewer").setSnapshot({
      label: "Review viewer",
      actionVerb: "Show",
      selected: this.route.viewer,
      choices: viewerChoices,
    });
    this.patchErrorState();
  }

  private patchErrorState() {
    const error = this.shownChanges.snapshot().error;
    const failed =
      this.route.scope === "branch" ? "Branch comparison" : "Working tree";
    this.errorMessage = error
      ? `${failed} update failed: ${error.message}`
      : "";
  }

  private patchLayout() {
    this.toggleAttribute("data-file-selected", Boolean(this.route.path));
    this.dataset.reviewScope = this.route.scope;
    this.dataset.reviewNavigator = this.route.navigator;
    this.dataset.reviewViewer = this.route.viewer;
    this.applyPanelWidth();
    this.applySidePane();
  }

  private syncSelection() {
    const logicalPath = this.logicalSelectedPath();
    this.workingTreeChanges.setSelectedPath(logicalPath);
    this.branchChanges.setSelectedPath(logicalPath);
    this.fileNavigator.setSelectedPath(logicalPath);
  }

  private chooseViewer(value: string) {
    if (value === "diff" || value === "source" || value === "preview") {
      this.updateRoute({ viewer: value });
    }
  }

  private updateRoute(
    change: Partial<Pick<ReviewRoute, "scope" | "navigator" | "viewer">>,
  ) {
    const route = { ...this.route, ...change };
    if (reviewRouteKey(route) === reviewRouteKey(this.route)) {
      return;
    }
    this.captureLocalState();
    this.requestRoute(route);
  }

  private requestRoute(state: ReviewRoute) {
    const route = taskRouteForReview(taskThreadId(this.task), state);
    this.dispatchEvent(
      new CustomEvent("caffold:task-review-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route },
      }),
    );
  }

  private async refreshAll() {
    this.markChangesOutdated();
    const requests: Array<Promise<unknown>> = [
      this.fileNavigator.requestRefresh({
        allDirectories: true,
        selected: Boolean(this.route.path),
      }),
    ];
    if (this.task?.worktree) {
      requests.push(
        this.route.scope === "branch"
          ? this.readChanges(this.branchChanges, { force: true })
          : this.readChanges(this.workingTreeChanges),
      );
    }
    await Promise.allSettled(requests);
  }

  private subscribeWatch(path: string) {
    if (!path || (path === this.watchPath && this.watchUnsubscribe)) {
      return;
    }
    this.unsubscribeWatch();
    this.watchPath = path;
    this.watchUnsubscribe = subscribeToWatch(this.liveUpdates, path, {
      onReady: ({ recovered }) => {
        if (path !== this.watchPath) {
          return;
        }
        if (recovered) {
          void this.refreshAll();
        }
      },
      onRecover: () => {
        if (path !== this.watchPath) {
          return;
        }
        void this.refreshAll();
      },
      onChange: (change) => {
        if (path !== this.watchPath) {
          return;
        }
        void this.fileNavigator.requestRefresh({
          paths: change.paths ?? [],
          allDirectories: Boolean(change.overflow),
          selected: Boolean(
            this.route.path &&
              (change.overflow ||
                (change.paths ?? []).includes(this.logicalSelectedPath())),
          ),
          revision: change.revision,
        });
        if (this.task?.worktree && change.gitStatusChanged) {
          this.pendingWatchViewerRefresh ||=
            this.route.scope === "working" &&
            watchChangeAffectsPath(change, this.logicalSelectedPath());
          void this.readChanges(this.workingTreeChanges, {
            background: true,
          });
        }
        if (this.task?.worktree && change.gitRefsChanged) {
          if (this.route.scope === "branch") {
            void this.readChanges(this.branchChanges, { force: true });
          } else {
            this.branchChanges.forgetRefs();
          }
        }
      },
    });
  }

  private unsubscribeWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
  }

  private applyPanelWidth() {
    this.panelWidth = this.resizer.value;
  }

  private applySidePane() {
    this.toggleAttribute("data-side-pane-collapsed", this.sidePaneCollapsed());
    this.dispatchEvent(
      new CustomEvent("caffold:side-pane-change", { bubbles: true }),
    );
  }

  private sidePaneCollapsed() {
    return Boolean(this.route.path) && this.resizer.collapsed;
  }

  private logicalSelectedPath() {
    return this.route.path
      ? joinLogicalPath(taskRootPath(this.task), this.route.path)
      : "";
  }

  private navigatorStateKey() {
    return `${this.route.scope}:${this.route.navigator}`;
  }

  private get shownChanges(): ReviewChangesElement {
    return this.route.scope === "branch"
      ? this.branchChanges
      : this.workingTreeChanges;
  }

  // The children are drawn the first time one is needed, which can be before
  // Review is in the document.
  private get workingTreeChanges() {
    this.performUpdate();
    return this.workingList.value as CaffoldReviewWorkingTreeChanges;
  }

  private get branchChanges() {
    this.performUpdate();
    return this.branchList.value as CaffoldReviewBranchChanges;
  }

  private get fileNavigator() {
    this.performUpdate();
    return this.filesList.value as CaffoldFileNavigator;
  }

  private get selectedFile() {
    this.performUpdate();
    return this.fileViewer.value as CaffoldReviewSelectedFile;
  }

  private get resizer() {
    this.performUpdate();
    return this.paneResizer.value as CaffoldPaneResizer;
  }

  private axisControl(axis: "navigator" | "viewer") {
    this.performUpdate();
    return (axis === "navigator" ? this.navigatorAxis : this.viewerAxis)
      .value as CaffoldSegmentedControl;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-review": CaffoldTaskReview;
  }
}
