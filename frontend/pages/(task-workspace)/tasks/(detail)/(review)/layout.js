import "#components/file-navigator.js";
import "#components/segmented-control.js";
import "#components/pane-resizer.js";
import "./components/working-tree-changes.js";
import "./components/branch-changes.js";
import "./components/selected-file.js";
import {
  fileRepresentationCapabilities,
  isFileRepresentation,
} from "./representations.js";
import {
  subscribeToWatch,
  watchChangeAffectsPath,
} from "#app/watch.js";
import { cleanLogicalPath } from "../../task-format.js";
import { taskThreadId } from "../../task-list-model.js";
import {
  normalizeForTask,
  normalizeReviewRoute,
  reviewContextKey,
  reviewRouteKey,
  routeForSelectedFile,
  taskRouteForReview,
  viewerStateKey,
} from "./layout/route.js";
import {
  joinLogicalPath,
  relativeTaskPath,
  taskRootPath,
  taskWorktreeRootPath,
} from "./layout/paths.js";
import {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "#app/scroll-scope.js";

// Matches the width where layout.css stops showing one pane at a time.
const REVIEW_SPLIT_MEDIA_QUERY = "(min-width: 561px)";

class CaffoldTaskReview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.active = true;
    this.markChangesOutdated();
    this.syncReview({ reactivated: true });
  }

  disconnectedCallback() {
    this.active = false;
    this.unsubscribeWatch();
    this.fileNavigator()?.setWatchActive(false);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.active = false;
    this.task = null;
    this.contextKey = "";
    this.route = normalizeReviewRoute();
    this.previousRouteKey = "";
    this.watchUnsubscribe = null;
    this.watchPath = "";
    this.pendingWatchViewerRefresh = false;
    this.navigatorScroll = new Map();
    this.liveUpdates = null;

    this.innerHTML = `
      <section class="task-review-workspace" aria-label="Task review">
        <div class="task-review-notices">
          <p class="task-review-error" role="alert" hidden></p>
        </div>
        <div class="task-review-layout">
          <aside class="task-review-navigator-pane" aria-label="Review navigator">
            <div class="task-review-pane-axis task-review-navigator-axis">
              <caffold-segmented-control data-review-axis="navigator"></caffold-segmented-control>
            </div>
            <div class="task-review-navigator" data-review-navigator="working">
              <caffold-review-working-tree-changes></caffold-review-working-tree-changes>
            </div>
            <div class="task-review-navigator" data-review-navigator="branch">
              <caffold-review-branch-changes></caffold-review-branch-changes>
            </div>
            <div class="task-review-navigator" data-review-navigator="files">
              <caffold-file-navigator></caffold-file-navigator>
            </div>
          </aside>
          <caffold-pane-resizer
            start-min="220"
            end-min="360"
            storage-key="caffold:pane-width:task-review"
            collapsed-storage-key="caffold:pane-collapsed:task-review"
            aria-label="Resize review navigator"
          ></caffold-pane-resizer>
          <section class="task-review-viewer-pane" aria-label="Review file">
            <div class="task-review-viewer-empty-header" aria-hidden="true"></div>
            <div class="task-review-pane-axis task-review-viewer-axis">
              <caffold-segmented-control data-review-axis="viewer"></caffold-segmented-control>
            </div>
            <caffold-review-selected-file></caffold-review-selected-file>
          </section>
        </div>
      </section>
    `;

    this.fileNavigator()?.setStorageKey(null);
    this.fileNavigator()?.setLiveUpdates(this.liveUpdates);
    this.fileNavigator()?.setWatchActive(false);
    this.fileNavigator()?.setRefreshVisible(false);
    this.applyPanelWidth();

    this.addEventListener("caffold:segmented-control-intent", (event) => {
      this.handleAxisIntent(event);
    });
    this.addEventListener("caffold:review-branch-intent", (event) => {
      event.stopPropagation();
      this.updateAxis("scope", "branch");
    });
    this.addEventListener("caffold:review-representation-intent", (event) => {
      event.stopPropagation();
      this.updateAxis("viewer", event.detail?.representation);
    });
    this.addEventListener("caffold:review-base-intent", (event) => {
      event.stopPropagation();
      this.captureLocalState();
      this.requestRoute({ ...this.route, baseRef: `${event.detail?.baseRef ?? ""}` });
    });
    this.addEventListener("caffold:review-changes-read", (event) => {
      event.stopPropagation();
      this.handleChangesRead(event.target, event.detail ?? {});
    });
    this.addEventListener("caffold:open-git-diff", (event) => {
      if (!closestElement(event.target, "caffold-git-diff-changes-tree")) {
        return;
      }
      event.stopPropagation();
      this.selectLogicalPath(event.detail?.path);
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      if (!closestElement(event.target, "caffold-git-compare-tree")) {
        return;
      }
      event.stopPropagation();
      this.selectLogicalPath(event.detail?.path);
    });
    this.addEventListener("caffold:file-navigator-open-file", (event) => {
      event.stopPropagation();
      this.selectLogicalPath(event.detail?.path);
    });
    this.addEventListener("caffold:file-navigator-refresh-selected", (event) => {
      event.stopPropagation();
      if (isFileRepresentation(this.route.viewer)) {
        this.selectedFile()?.reload(this.currentView(), { background: true });
      }
    });
    this.addEventListener("caffold:pane-resize", (event) => {
      event.stopPropagation();
      if (Number.isFinite(event.detail?.value)) {
        this.applyPanelWidth();
      }
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      event.stopPropagation();
      this.clearSelectedPath();
    });
  }

  setLiveUpdates(liveUpdates) {
    this.ensureRendered();
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    const path = this.watchPath;
    this.unsubscribeWatch();
    this.liveUpdates = liveUpdates ?? null;
    this.fileNavigator()?.setLiveUpdates(this.liveUpdates);
    if (this.active && path) {
      this.subscribeWatch(path);
    }
  }

  setTaskContext({ task = null, route = null } = {}) {
    this.ensureRendered();
    const contextKey = reviewContextKey(task);
    const contextChanged = contextKey !== this.contextKey;
    const previousRoute = this.route;
    const nextRoute = normalizeReviewRoute(route, task);
    const nextRouteKey = reviewRouteKey(nextRoute);
    const routeChanged = Boolean(
      this.previousRouteKey && this.previousRouteKey !== nextRouteKey,
    );
    const scopeChanged = routeChanged && previousRoute.scope !== nextRoute.scope;
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
    this.syncReview({ contextChanged, routeChanged, scopeChanged, revealFileSelection });
    return true;
  }

  setDetailContext({ identity = null, path = "", repository = null, route = null } = {}) {
    const id = `${identity?.id ?? ""}`;
    const contextPath = cleanLogicalPath(path || repository?.rootPath || "") || ".";
    const repositoryRootPath = repository
      ? cleanLogicalPath(repository.rootPath || path || "") || "."
      : "";
    return this.setTaskContext({
      task: id
        ? {
            threadId: identity?.kind === "task" ? id : `${identity?.kind ?? "detail"}:${id}`,
            cwdPath: contextPath,
            ...(repository
              ? { worktree: { ...repository, rootPath: repositoryRootPath } }
              : {}),
          }
        : null,
      route,
    });
  }

  currentTaskRoute() {
    const threadId = taskThreadId(this.task);
    if (!threadId || !this.route) {
      return null;
    }
    return taskRouteForReview(threadId, this.route);
  }

  actionHintScope() {
    this.ensureRendered();
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyActionHintScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane = this.querySelector(
      ":scope > .task-review-workspace > .task-review-layout > .task-review-navigator-pane",
    );
    const viewerPane = this.querySelector(
      ":scope > .task-review-workspace > .task-review-layout > .task-review-viewer-pane",
    );
    const navigatorActive = hasActionHintLayoutBox(navigatorPane);
    const viewerActive = hasActionHintLayoutBox(viewerPane);
    const navigatorClipRoots = [this, navigatorPane].filter(Boolean);
    const viewerClipRoots = [this, viewerPane].filter(Boolean);
    const navigatorAxis = navigatorActive
      ? this.axisControl("navigator")?.actionHintScope({
          scopeId: `${scopeId}:navigator-axis`,
          actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          clipRoots: navigatorClipRoots,
          labelForChoice: (choice) => `Show ${choice.label}`,
        })
      : null;
    const viewerAxis = viewerActive
      ? this.axisControl("viewer")?.actionHintScope({
          scopeId: `${scopeId}:viewer-axis`,
          actionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          clipRoots: viewerClipRoots,
          labelForChoice: (choice) => `Show ${choice.label}`,
        })
      : null;
    const navigatorScope = !navigatorActive
      ? null
      : this.route.navigator === "files"
        ? this.fileNavigator()?.actionHintScope({
            scopeId: `${scopeId}:files`,
            actionId: ACTION_HINT_ACTION.FILE_OPEN,
            disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            refreshActionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            clipRoots: navigatorClipRoots,
          })
        : this.route.scope === "branch"
          ? this.branchChanges()?.actionHintScope({
              scopeId: `${scopeId}:branch`,
              actionId: ACTION_HINT_ACTION.FILE_OPEN,
              disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
              selectActionId: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
              clipRoots: navigatorClipRoots,
            })
          : this.workingTreeChanges()?.actionHintScope({
              scopeId: `${scopeId}:working`,
              actionId: ACTION_HINT_ACTION.FILE_OPEN,
              disclosureActionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
              branchTargetId: `${scopeId}:scope:branch`,
              branchActionId: ACTION_HINT_ACTION.REVIEW_AXIS,
              clipRoots: navigatorClipRoots,
              isCurrent: () => this.isConnected && this.active && !this.hidden,
            });
    const viewerScope = viewerActive && this.route.path
      ? this.selectedFile()?.actionHintScope({
          scopeId: `${scopeId}:viewer`,
          actionId: ACTION_HINT_ACTION.PARENT,
          noticeActionId: ACTION_HINT_ACTION.REVIEW_AXIS,
          detailsActionId: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
          refreshActionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
          buttonActionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          clipRoots: viewerClipRoots,
        })
      : null;
    const resizer = this.resizer?.() ?? null;
    const contextKey = this.contextKey;
    const resizerScope = resizer?.actionHintScope?.({
      scopeId: `${scopeId}:navigator`,
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this],
      isCurrent: () =>
        this.isConnected &&
        this.active &&
        !this.hidden &&
        taskThreadId(this.task) === subjectId &&
        this.contextKey === contextKey &&
        this.resizer?.() === resizer,
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
    this.ensureRendered();
    const subjectId = taskThreadId(this.task);
    if (!this.active || this.hidden || !subjectId || !this.contextKey) {
      return emptyScrollSurfaceScope();
    }
    const scopeId = `review:${encodeURIComponent(subjectId)}`;
    const navigatorPane = this.querySelector(
      ":scope > .task-review-workspace > .task-review-layout > .task-review-navigator-pane",
    );
    const viewerPane = this.querySelector(
      ":scope > .task-review-workspace > .task-review-layout > .task-review-viewer-pane",
    );
    const navigatorClipRoots = [this, navigatorPane].filter(Boolean);
    const viewerClipRoots = [this, viewerPane].filter(Boolean);
    let navigatorScope = null;
    if (hasScrollLayoutBox(navigatorPane)) {
      navigatorScope = this.route.navigator === "files"
        ? this.fileNavigator()?.scrollSurfaceScope({
            scopeId: `${scopeId}:files`,
            label: "Files",
            clipRoots: navigatorClipRoots,
          })
        : this.route.scope === "branch"
          ? this.branchChanges()?.scrollSurfaceScope({
              scopeId: `${scopeId}:branch`,
              label: "Branch changes",
              clipRoots: navigatorClipRoots,
            })
          : this.workingTreeChanges()?.scrollSurfaceScope({
              scopeId: `${scopeId}:working`,
              label: "Working tree changes",
              clipRoots: navigatorClipRoots,
            });
    }
    const viewerScope =
      hasScrollLayoutBox(viewerPane) && this.route.path
        ? this.selectedFile()?.scrollSurfaceScope({
            scopeId: `${scopeId}:viewer`,
            clipRoots: viewerClipRoots,
          })
        : null;
    return mergeScrollSurfaceScopes(navigatorScope, viewerScope);
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    const subjectId = taskThreadId(this.task);
    const viewerPane = this.querySelector(
      ":scope > .task-review-workspace > .task-review-layout > .task-review-viewer-pane",
    );
    if (
      !this.active ||
      this.hidden ||
      !subjectId ||
      !this.contextKey ||
      !this.route.path ||
      !hasActionHintLayoutBox(viewerPane)
    ) {
      return [];
    }
    return this.selectedFile()?.keyboardNavigationContexts({
      scopeId: `review:${encodeURIComponent(subjectId)}:viewer`,
    }) ?? [];
  }

  resetContext() {
    this.unsubscribeWatch();
    this.pendingWatchViewerRefresh = false;
    this.previousRouteKey = "";
    this.fileNavigator()?.clearSelectedPath();
  }

  syncChildContexts() {
    const worktreeRootPath = taskWorktreeRootPath(this.task);
    const branch = this.task?.worktree?.branch ?? null;
    this.workingTreeChanges()?.setContext({ rootPath: worktreeRootPath, branch });
    this.branchChanges()?.setContext({
      rootPath: worktreeRootPath,
      branch,
      baseRef: this.route.baseRef,
    });
    this.branchChanges()?.setShown(this.route.scope === "branch");
    this.selectedFile()?.setContext({
      rootPath: taskRootPath(this.task),
      worktreeRootPath,
    });
  }

  markChangesOutdated() {
    this.workingTreeChanges()?.markOutdated();
    this.branchChanges()?.markOutdated();
  }

  syncReview(options = {}) {
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
      const working = this.workingTreeChanges().snapshot();
      if (
        options.contextChanged ||
        options.reactivated ||
        !working.data ||
        (options.scopeChanged && this.route.scope === "working" && working.outdated)
      ) {
        void this.readChanges(this.workingTreeChanges());
      }
      if (this.route.scope === "branch") {
        const branch = this.branchChanges().snapshot();
        if (
          options.reactivated ||
          (options.scopeChanged && branch.outdated) ||
          !branch.hasRefs ||
          !branch.data
        ) {
          void this.readChanges(this.branchChanges(), { force: branch.outdated });
        }
      }
    }
    this.selectedFile()?.show(this.currentView(), {
      force: Boolean(options.contextChanged || options.routeChanged || options.reactivated),
    });
    if (options.contextChanged || options.routeChanged || options.reactivated) {
      this.restoreNavigatorScroll();
    }
  }

  ensureFileNavigator({ refresh = false, revealSelection = false } = {}) {
    const navigator = this.fileNavigator();
    const rootPath = taskRootPath(this.task);
    if (!navigator || !rootPath) {
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
          .then(() => {
            if (selectedPath === this.logicalSelectedPath()) {
              return navigator.revealPath(selectedPath);
            }
            return false;
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
    } else {
      if (refresh) {
        void navigator.requestRefresh({ allDirectories: true });
      }
    }
  }

  readChanges(changes, options = {}) {
    const reading = changes.read(options);
    this.followRereadInViewer(changes);
    return reading;
  }

  handleChangesRead(changes, { ok, hadData, wasOutdated, background = false }) {
    if (changes !== this.workingTreeChanges() && changes !== this.branchChanges()) {
      return;
    }
    this.patchErrorState();
    if (!ok) {
      this.followRereadInViewer(changes);
      return;
    }
    if (changes === this.branchChanges()) {
      if (this.route.path && this.route.scope === "branch") {
        this.selectedFile()?.reload(this.currentView(), { reread: hadData });
      }
      return;
    }
    const canRefreshViewer = this.route.path && this.route.scope === "working";
    const pendingWatchViewerRefresh = this.pendingWatchViewerRefresh;
    this.pendingWatchViewerRefresh = false;
    // A watch change reloads the viewer only for its own file, unless the
    // status it replaces was read before the page came back.
    const refreshViewer = background
      ? canRefreshViewer && (pendingWatchViewerRefresh || wasOutdated)
      : canRefreshViewer;
    if (refreshViewer) {
      this.selectedFile()?.reload(this.currentView(), { background, reread: hadData });
    }
  }

  // Where the shown changes from before the page came back say the selected
  // file did not change, the viewer follows their reread: loading while it
  // runs, then the read's error if it fails.
  followRereadInViewer(changes) {
    if (
      changes !== this.shownChanges() ||
      !this.route.path ||
      this.route.viewer !== "diff"
    ) {
      return;
    }
    const { data, outdated } = changes.snapshot();
    if (!outdated || !data || changes.change(this.logicalSelectedPath())) {
      return;
    }
    this.selectedFile()?.reload(this.currentView());
  }

  currentView() {
    const logicalPath = this.logicalSelectedPath();
    return {
      stateKey: viewerStateKey(this.route),
      scope: this.route.scope,
      path: this.route.path,
      logicalPath,
      representation: this.route.viewer,
      line: this.route.line,
      entry: logicalPath ? this.fileNavigator()?.entryForPath(logicalPath) : null,
      changes: this.viewerChanges(logicalPath),
    };
  }

  viewerChanges(logicalPath) {
    const changes = this.task?.worktree ? this.shownChanges() : null;
    if (!changes) {
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

  captureLocalState() {
    const scroll = navigatorScroll(this.activeNavigator());
    if (scroll) {
      this.navigatorScroll.set(this.navigatorStateKey(), scroll);
    }
  }

  restoreNavigatorScroll() {
    restoreNavigatorScroll(
      this.activeNavigator(),
      this.navigatorScroll.get(this.navigatorStateKey()),
    );
  }

  patchControls() {
    const gitAvailable = Boolean(this.task?.worktree);
    const navigatorChoices = [
      ...(gitAvailable ? [{ value: "changes", label: "Changes" }] : []),
      { value: "files", label: "Files" },
    ];
    this.dataset.reviewNavigatorChoiceCount = `${navigatorChoices.length}`;
    this.axisControl("navigator")?.setSnapshot({
      label: "Review navigator",
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
    this.axisControl("viewer")?.setSnapshot({
      label: "Review viewer",
      selected: this.route.viewer,
      choices: viewerChoices,
    });
    this.patchErrorState();
  }

  patchErrorState() {
    const error = this.shownChanges()?.snapshot().error;
    const message = error
      ? `${this.route.scope === "branch" ? "Branch comparison" : "Working tree"} update failed: ${error.message}`
      : "";
    const notice = this.querySelector(".task-review-error");
    if (!notice) {
      return;
    }
    notice.textContent = message;
    notice.toggleAttribute("hidden", !message);
  }

  patchLayout() {
    for (const panel of this.querySelectorAll("[data-review-navigator]")) {
      const visible =
        panel.dataset.reviewNavigator === "files"
          ? this.route.navigator === "files"
          : this.route.navigator === "changes" &&
            panel.dataset.reviewNavigator === this.route.scope;
      panel.toggleAttribute("hidden", !visible);
    }
    this.toggleAttribute("data-file-selected", Boolean(this.route.path));
    this.dataset.reviewScope = this.route.scope;
    this.dataset.reviewNavigator = this.route.navigator;
    this.dataset.reviewViewer = this.route.viewer;
    this.applyPanelWidth();
    this.applySidePane();
  }

  syncSelection() {
    const logicalPath = this.logicalSelectedPath();
    this.workingTreeChanges()?.setSelectedPath(logicalPath);
    this.branchChanges()?.setSelectedPath(logicalPath);
    this.fileNavigator()?.setSelectedPath(logicalPath);
  }

  handleAxisIntent(event) {
    const control = event.target instanceof Element
      ? event.target.closest("caffold-segmented-control[data-review-axis]")
      : null;
    if (!control || !this.contains(control)) {
      return;
    }
    event.stopPropagation();
    this.updateAxis(control.dataset.reviewAxis, event.detail?.value);
  }

  updateAxis(axis, value) {
    const field = axis === "scope" ? "scope" : axis === "navigator" ? "navigator" : "viewer";
    if (this.route[field] === value) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, [field]: value });
  }

  selectLogicalPath(path) {
    const relative = relativeTaskPath(path, taskRootPath(this.task));
    if (!relative) {
      return;
    }
    this.requestRoute(routeForSelectedFile(this.route, relative));
  }

  clearSelectedPath() {
    if (!this.route.path) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, path: "", line: null });
  }

  requestRoute(state) {
    const route = taskRouteForReview(taskThreadId(this.task), state);
    this.dispatchEvent(
      new CustomEvent("caffold:task-review-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route },
      }),
    );
  }

  async refreshAll() {
    this.markChangesOutdated();
    const requests = [
      this.fileNavigator()?.requestRefresh({
        allDirectories: true,
        selected: Boolean(this.route.path),
      }),
    ];
    if (this.task?.worktree) {
      requests.push(
        this.route.scope === "branch"
          ? this.readChanges(this.branchChanges(), { force: true })
          : this.readChanges(this.workingTreeChanges()),
      );
    }
    await Promise.allSettled(requests.filter(Boolean));
  }

  subscribeWatch(path) {
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
        this.fileNavigator()?.requestRefresh({
          paths: change.paths ?? [],
          allDirectories: Boolean(change.overflow),
          selected: Boolean(
            this.route.path &&
              (change.overflow || (change.paths ?? []).includes(this.logicalSelectedPath())),
          ),
          revision: change.revision,
        });
        if (this.task?.worktree && change.gitStatusChanged) {
          this.pendingWatchViewerRefresh ||=
            this.route.scope === "working" &&
            watchChangeAffectsPath(change, this.logicalSelectedPath());
          void this.readChanges(this.workingTreeChanges(), { background: true });
        }
        if (this.task?.worktree && change.gitRefsChanged) {
          if (this.route.scope === "branch") {
            void this.readChanges(this.branchChanges(), { force: true });
          } else {
            this.branchChanges()?.forgetRefs();
          }
        }
      },
    });
  }

  unsubscribeWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
  }

  applyPanelWidth() {
    this.querySelector(".task-review-layout")?.style.setProperty(
      "--task-review-panel-width",
      `${this.resizer().value}px`,
    );
  }

  /**
   * The navigator the workspace's side pane toggle hides and shows.
   *
   * It collapses only while a file is open, the same state in which the
   * phone layout shows the viewer instead of the navigator.
   */
  sidePane() {
    this.ensureRendered();
    return {
      label: "review navigator",
      beside: window.matchMedia(REVIEW_SPLIT_MEDIA_QUERY).matches,
      collapsible: Boolean(this.route.path),
      collapsed: this.sidePaneCollapsed(),
      setCollapsed: (collapsed) => this.setSidePaneCollapsed(collapsed),
    };
  }

  setSidePaneCollapsed(collapsed) {
    this.resizer().setCollapsed(collapsed);
    this.applySidePane();
  }

  applySidePane() {
    this.toggleAttribute("data-side-pane-collapsed", this.sidePaneCollapsed());
    this.dispatchEvent(
      new CustomEvent("caffold:side-pane-change", { bubbles: true }),
    );
  }

  sidePaneCollapsed() {
    return Boolean(this.route.path) && this.resizer().collapsed;
  }

  logicalSelectedPath() {
    return this.route.path
      ? joinLogicalPath(taskRootPath(this.task), this.route.path)
      : "";
  }

  navigatorStateKey() {
    return `${this.route.scope}:${this.route.navigator}`;
  }

  activeNavigator() {
    return this.route.navigator === "files"
      ? this.fileNavigator()
      : this.shownChanges();
  }

  shownChanges() {
    return this.route.scope === "branch"
      ? this.branchChanges()
      : this.workingTreeChanges();
  }

  workingTreeChanges() {
    return this.querySelector("caffold-review-working-tree-changes");
  }

  branchChanges() {
    return this.querySelector("caffold-review-branch-changes");
  }

  fileNavigator() {
    return this.querySelector("caffold-file-navigator");
  }

  selectedFile() {
    return this.querySelector("caffold-review-selected-file");
  }

  resizer() {
    return this.querySelector("caffold-pane-resizer");
  }

  axisControl(axis) {
    return this.querySelector(
      `caffold-segmented-control[data-review-axis="${axis}"]`,
    );
  }

}

if (!customElements.get("caffold-task-review")) {
  customElements.define("caffold-task-review", CaffoldTaskReview);
}

function navigatorScroll(navigator) {
  if (navigator?.captureScroll) {
    return navigator.captureScroll();
  }
  return navigator?.captureListScroll?.() ?? null;
}

function restoreNavigatorScroll(navigator, scroll) {
  if (!scroll) {
    return;
  }
  if (navigator?.restoreScroll) {
    navigator.restoreScroll(scroll);
  } else {
    navigator?.restoreListScroll?.(scroll);
  }
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
