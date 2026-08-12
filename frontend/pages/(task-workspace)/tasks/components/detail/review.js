import {
  getGitCompare,
  getGitCompareDiff,
  getGitDiff,
  getGitRefs,
  getGitStatus,
  readFile,
} from "../../../../../api.js";
import "../../../../../components/file-navigator.js";
import "../../../../../components/file-viewer.js";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "../../../../../components/file-viewer-presentation.js";
import { fileStatusPresentation } from "../../../../../file-status.js";
import "../../../../../components/git-compare-browser/compare-tree.js";
import "./review/changes-tree.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "../../../../../components/dom.js";
import "../../../../../components/review-panel-resizer.js";
import {
  subscribeToWatch,
  watchChangeAffectsPath,
} from "../../../../../watch.js";
import { cleanLogicalPath } from "../../task-format.js";
import { taskThreadId } from "../../task-list-model.js";

const REVIEW_PANEL_DEFAULT_WIDTH = 320;

class CaffoldTaskReview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.active = true;
    this.syncReview({ reactivated: true });
  }

  disconnectedCallback() {
    this.active = false;
    this.unsubscribeWatch();
    this.invalidateRequests();
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
    this.status = null;
    this.compare = null;
    this.refs = null;
    this.statusError = null;
    this.compareError = null;
    this.statusGeneration = 0;
    this.branchGeneration = 0;
    this.viewerGeneration = 0;
    this.imageRevision = 0;
    this.watchUnsubscribe = null;
    this.watchPath = "";
    this.pendingWatchViewerRefresh = false;
    this.panelWidth = REVIEW_PANEL_DEFAULT_WIDTH;
    this.navigatorScroll = new Map();
    this.viewerScroll = new Map();
    this.pendingRepresentationLine = new Map();

    this.innerHTML = `
      <section class="task-review-workspace" aria-label="Task review">
        <div class="task-review-notices">
          <p class="task-review-git-notice" hidden>Git review is unavailable for this task. Browse files and source instead.</p>
          <p class="task-review-error" role="alert" hidden></p>
        </div>
        <div class="task-review-layout">
          <aside class="task-review-navigator-pane" aria-label="Review navigator">
            <div class="task-review-pane-axis task-review-navigator-axis" role="group" aria-label="Review navigator">
              <div class="task-review-axis-options">
                <button type="button" data-review-axis="navigator" data-review-value="changes"><span>Changes</span></button>
                <button type="button" data-review-axis="navigator" data-review-value="files"><span>Files</span></button>
              </div>
            </div>
            <div class="task-review-navigator" data-review-navigator="working">
              <caffold-git-diff-changes-tree></caffold-git-diff-changes-tree>
              <div class="task-review-empty-action" hidden>
                <p>Review committed changes against the branch base.</p>
                <button type="button" class="task-secondary-button" data-review-action="review-branch">Review branch changes</button>
              </div>
            </div>
            <div class="task-review-navigator" data-review-navigator="branch">
              <caffold-git-compare-tree></caffold-git-compare-tree>
            </div>
            <div class="task-review-navigator" data-review-navigator="files">
              <caffold-file-navigator></caffold-file-navigator>
            </div>
          </aside>
          <caffold-review-panel-resizer
            panel-min="220"
            viewer-min="360"
            aria-label="Resize review navigator"
          ></caffold-review-panel-resizer>
          <section class="task-review-viewer-pane" aria-label="Review file">
            <div class="task-review-viewer-empty-header" aria-hidden="true"></div>
            <div class="task-review-pane-axis task-review-viewer-axis" role="group" aria-label="Review viewer">
              <div class="task-review-axis-options">
                <button type="button" data-review-axis="viewer" data-review-value="diff"><span>Diff</span></button>
                <button type="button" data-review-axis="viewer" data-review-value="source"><span>Source</span></button>
              </div>
            </div>
            <caffold-review-file-viewer compact-chrome></caffold-review-file-viewer>
          </section>
        </div>
      </section>
    `;

    this.fileNavigator()?.setStorageKey(null);
    this.fileNavigator()?.setWatchActive(false);
    this.fileNavigator()?.setRefreshVisible(false);
    this.viewer()?.setCloseLabel("Back to navigator");
    this.viewer()?.setCloseMode("back");
    this.resizer()?.setValue(this.panelWidth);
    this.applyPanelWidth();

    this.addEventListener("click", (event) => this.handleClick(event));
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
    this.addEventListener("caffold:select-compare-base", (event) => {
      if (!closestElement(event.target, "caffold-git-compare-tree")) {
        return;
      }
      event.stopPropagation();
      this.selectCompareBase(event.detail?.baseRef);
    });
    this.addEventListener("caffold:file-navigator-open-file", (event) => {
      event.stopPropagation();
      this.selectLogicalPath(event.detail?.path);
    });
    this.addEventListener("caffold:file-navigator-refresh-selected", (event) => {
      event.stopPropagation();
      if (this.route.viewer === "source") {
        void this.loadViewer();
      }
    });
    this.addEventListener("caffold:review-panel-resize", (event) => {
      event.stopPropagation();
      if (Number.isFinite(event.detail?.value)) {
        this.panelWidth = event.detail.value;
        this.applyPanelWidth();
      }
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      event.stopPropagation();
      this.clearSelectedPath();
    });
  }

  setTaskContext({ task = null, route = null } = {}) {
    this.ensureRendered();
    const contextKey = reviewContextKey(task);
    const contextChanged = contextKey !== this.contextKey;
    const taskChanged = this.task !== task;
    const previousRoute = this.route;
    const nextRoute = normalizeReviewRoute(route, task);
    const nextRouteKey = reviewRouteKey(nextRoute);
    const routeChanged = Boolean(
      this.previousRouteKey && this.previousRouteKey !== nextRouteKey,
    );
    const revealFileSelection = Boolean(
      nextRoute.navigator === "files" &&
        nextRoute.path &&
        (contextChanged ||
          previousRoute.navigator !== "files" ||
          previousRoute.path !== nextRoute.path),
    );
    if (
      this.active &&
      !contextChanged &&
      !routeChanged &&
      !taskChanged
    ) {
      return false;
    }
    if (contextChanged) {
      this.resetContext();
      this.contextKey = contextKey;
    } else if (routeChanged) {
      this.captureLocalState();
      if (previousRoute.baseRef !== nextRoute.baseRef) {
        this.compare = null;
        this.compareError = null;
      }
    }
    this.active = true;
    this.task = task;
    this.route = nextRoute;
    this.previousRouteKey = nextRouteKey;

    const normalizedForTask = normalizeForTask(nextRoute, task);
    if (reviewRouteKey(normalizedForTask) !== nextRouteKey) {
      this.requestRoute(normalizedForTask, { replace: true });
      return true;
    }
    this.syncReview({ contextChanged, routeChanged, revealFileSelection });
    return true;
  }

  currentTaskRoute() {
    const threadId = taskThreadId(this.task);
    if (!threadId || !this.route) {
      return null;
    }
    return taskRouteForReview(threadId, this.route);
  }

  resetContext() {
    this.unsubscribeWatch();
    this.invalidateRequests();
    this.status = null;
    this.compare = null;
    this.refs = null;
    this.statusError = null;
    this.compareError = null;
    this.pendingWatchViewerRefresh = false;
    this.previousRouteKey = "";
    this.workingTree()?.reset();
    this.branchTree()?.reset();
    this.fileNavigator()?.clearSelectedPath();
    this.viewer()?.setEmpty();
  }

  invalidateRequests() {
    this.statusGeneration += 1;
    this.branchGeneration += 1;
    this.viewerGeneration += 1;
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
      if (options.contextChanged || options.reactivated || !this.status) {
        void this.refreshWorking();
      }
      if (
        this.route.scope === "branch" &&
        (options.reactivated ||
          !this.refs ||
          !this.compare ||
          this.compare.baseRef !== this.route.baseRef)
      ) {
        void this.ensureBranchData({ force: options.reactivated });
      }
    }
    if (!this.route.path) {
      this.viewer()?.setEmpty();
    } else if (
      options.contextChanged ||
      options.routeChanged ||
      options.reactivated ||
      ["empty", "error"].includes(this.viewer()?.state?.status)
    ) {
      void this.loadViewer();
    }
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

  async refreshWorking(options = {}) {
    const rootPath = taskWorktreeRootPath(this.task);
    if (!rootPath) {
      return null;
    }
    const generation = ++this.statusGeneration;
    if (!this.status) {
      this.workingTree()?.setLoading({
        rootPath,
        branch: this.task?.worktree?.branch ?? null,
      });
    }
    try {
      const status = await getGitStatus(rootPath);
      if (!this.acceptRequest("status", generation, rootPath)) {
        return null;
      }
      const hadStatus = Boolean(this.status);
      this.status = status;
      this.statusError = null;
      this.patchErrorState();
      if (hadStatus) {
        this.workingTree()?.updateStatus(status);
      } else {
        this.workingTree()?.setStatus(status);
      }
      this.syncSelection();
      this.patchEmptyStates();
      const canRefreshViewer = this.route.path && this.route.scope === "working";
      const pendingWatchViewerRefresh = this.pendingWatchViewerRefresh;
      this.pendingWatchViewerRefresh = false;
      const refreshViewer = options.background
        ? canRefreshViewer && pendingWatchViewerRefresh
        : canRefreshViewer;
      if (refreshViewer) {
        void this.loadViewer({ background: Boolean(options.background) });
      }
      return status;
    } catch (error) {
      if (!this.acceptRequest("status", generation, rootPath)) {
        return null;
      }
      this.statusError = error;
      if (!this.status) {
        this.workingTree()?.setError(error, { rootPath });
      }
      this.patchErrorState();
      return null;
    }
  }

  async ensureBranchData({ force = false } = {}) {
    const rootPath = taskWorktreeRootPath(this.task);
    if (!rootPath) {
      return null;
    }
    const generation = ++this.branchGeneration;
    try {
      const refs = force || !this.refs ? await getGitRefs(rootPath) : this.refs;
      if (!this.acceptRequest("branch", generation, rootPath)) {
        return null;
      }
      this.refs = refs;
      const baseRef = selectedCompareBaseRef(this.route.baseRef, refs);
      this.branchTree()?.setBaseSelection({ refs: refs.refs, value: baseRef });
      if (this.route.baseRef !== baseRef) {
        this.requestRoute({ ...this.route, baseRef }, { replace: true });
        return null;
      }
      this.patchControls();
      if (!this.compare) {
        this.branchTree()?.setLoading(refs.repository, {
          baseRef,
          headRef: taskCompareHeadRef(this.task, refs),
        });
      }
      const compare = await getGitCompare(
        rootPath,
        baseRef,
        taskCompareHeadRef(this.task, refs),
      );
      if (!this.acceptRequest("branch", generation, rootPath)) {
        return null;
      }
      const hadCompare = Boolean(this.compare);
      this.compare = compare;
      this.compareError = null;
      this.patchErrorState();
      this.branchTree()?.setEmptyMessage(
        `No changes compared with ${baseRef || "the selected base"}.`,
      );
      if (hadCompare) {
        this.branchTree()?.updateCompare(compare);
      } else {
        this.branchTree()?.setCompare(compare);
      }
      this.syncSelection();
      this.patchControls();
      this.patchEmptyStates();
      if (this.route.path && this.route.scope === "branch") {
        void this.loadViewer();
      }
      return compare;
    } catch (error) {
      if (!this.acceptRequest("branch", generation, rootPath)) {
        return null;
      }
      this.compareError = error;
      if (!this.compare) {
        this.branchTree()?.setError(error, this.refs?.repository ?? null);
      }
      this.patchErrorState();
      return null;
    }
  }

  acceptRequest(owner, generation, rootPath) {
    return (
      this.active &&
      this.isConnected &&
      (owner !== "branch" || this.route.scope === "branch") &&
      generation ===
        (owner === "branch" ? this.branchGeneration : this.statusGeneration) &&
      rootPath === taskWorktreeRootPath(this.task)
    );
  }

  async loadViewer(options = {}) {
    const selectedPath = this.logicalSelectedPath();
    if (!selectedPath || !this.active) {
      this.viewer()?.setEmpty();
      return;
    }
    const generation = ++this.viewerGeneration;
    const sourceMode = this.route.viewer === "source";
    if (
      !sourceMode &&
      ((this.route.scope === "working" && !this.status) ||
        (this.route.scope === "branch" && !this.compare))
    ) {
      return;
    }
    const change = this.selectedChange();
    if (sourceMode && change?.deleted) {
      this.viewer()?.setNotice(
        "This file was deleted in the selected scope. Diff remains available.",
        { title: fileNameFromPath(selectedPath) },
      );
      return;
    }
    if (sourceMode && isPreviewableImagePath(selectedPath)) {
      const entry = this.fileNavigator()?.entryForPath(selectedPath);
      this.viewer()?.setImage({
        path: selectedPath,
        name: fileNameFromPath(selectedPath),
        imageType: imageTypeLabel(selectedPath),
        size: entry?.size,
        modifiedMs: entry?.modifiedMs,
        revision: ++this.imageRevision,
      });
      return;
    }
    if (!sourceMode && !change) {
      this.viewer()?.setNotice("No changes in this scope.", {
        actionLabel: "View source",
        action: "view-source",
        title: fileNameFromPath(selectedPath),
      });
      return;
    }
    const viewer = this.viewer();
    const saved = this.viewerScroll.get(this.viewerStateKey());
    const background = Boolean(options.background);
    const presentation = sourceMode
      ? sourceViewerPresentation({ path: selectedPath })
      : this.diffPresentation(selectedPath, change);
    if (!background) {
      viewer?.setLoading(presentation);
    }
    const viewerOptions = background
      ? { preserveScroll: true }
      : sourceMode && this.route.line
        ? { line: this.route.line }
        : { scroll: saved?.scroll ?? null };
    try {
      if (sourceMode) {
        const file = await readFile(selectedPath);
        if (!this.acceptViewer(generation, selectedPath)) {
          return;
        }
        viewer?.setFile(file, viewerOptions);
      } else {
        const diff = this.route.scope === "branch"
          ? await getGitCompareDiff(
              taskWorktreeRootPath(this.task),
              this.route.baseRef,
              taskCompareHeadRef(this.task, this.refs),
              selectedPath,
            )
          : await getGitDiff(
              taskWorktreeRootPath(this.task),
              selectedPath,
              change.kind,
            );
        if (!this.acceptViewer(generation, selectedPath)) {
          return;
        }
        const loadedPresentation = this.diffPresentation(selectedPath, change, diff);
        viewer?.setDiff(diff, {
          ...viewerOptions,
          presentation: loadedPresentation,
        });
      }
      if (!background && !(sourceMode && this.route.line)) {
        this.restoreViewerPosition(saved);
      }
    } catch (error) {
      if (this.acceptViewer(generation, selectedPath)) {
        viewer?.setError(presentation, error);
      }
    }
  }

  diffPresentation(selectedPath, change, diff = {}) {
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? { rootPath: taskWorktreeRootPath(this.task) },
      path: diff.path ?? selectedPath,
      repoRelativePath: diff.repoRelativePath ?? this.route.path,
      kind:
        diff.kind ||
        (this.route.scope === "branch"
          ? `${this.route.baseRef}...${taskCompareHeadRef(this.task, this.refs)}`
          : change?.kind ?? ""),
      status: change?.file
        ? fileStatusPresentation(change.file.status, change.file).code
        : "",
    });
  }

  acceptViewer(generation, selectedPath) {
    return (
      this.active &&
      this.isConnected &&
      generation === this.viewerGeneration &&
      selectedPath === this.logicalSelectedPath()
    );
  }

  selectedChange() {
    const selected = this.logicalSelectedPath();
    const files = this.route.scope === "branch"
      ? this.compare?.files ?? []
      : this.status?.files ?? [];
    const file = files.find((entry) => entry.path === selected);
    if (!file) {
      return null;
    }
    return {
      file,
      deleted: `${file.status ?? ""}`.includes("D"),
      kind: file.untracked ? "untracked" : file.category || "unstaged",
    };
  }

  captureLocalState() {
    const navigator = this.activeNavigator();
    const scroll = navigatorScroll(navigator);
    if (scroll) {
      this.navigatorScroll.set(this.navigatorStateKey(), scroll);
    }
    if (this.route.path) {
      this.viewerScroll.set(this.viewerStateKey(), {
        scroll: this.viewer()?.captureContentScroll?.() ?? null,
        line: this.viewer()?.visibleLine?.() ?? null,
      });
    }
  }

  restoreNavigatorScroll() {
    restoreNavigatorScroll(
      this.activeNavigator(),
      this.navigatorScroll.get(this.navigatorStateKey()),
    );
  }

  restoreViewerPosition(saved) {
    const line =
      saved?.line ?? this.pendingRepresentationLine.get(this.viewerStateKey());
    if (!line) {
      return;
    }
    this.pendingRepresentationLine.delete(this.viewerStateKey());
    requestAnimationFrame(() => {
      this.viewer()?.scrollToLine(line);
      window.setTimeout(() => this.viewer()?.scrollToLine(line), 40);
    });
  }

  patchControls() {
    const gitAvailable = Boolean(this.task?.worktree);
    for (const button of this.querySelectorAll("button[data-review-axis]")) {
      const axis = button.dataset.reviewAxis;
      const value = button.dataset.reviewValue;
      const current = this.route[axis];
      button.setAttribute("aria-pressed", current === value ? "true" : "false");
      const gitOnly =
        (axis === "navigator" && value === "changes") ||
        (axis === "viewer" && value === "diff");
      button.disabled = gitOnly && !gitAvailable;
      button.toggleAttribute("hidden", gitOnly && !gitAvailable);
      if (button.disabled) {
        button.title = "Unavailable outside a Git worktree";
      } else {
        button.removeAttribute("title");
      }
    }
    const notice = this.querySelector(".task-review-git-notice");
    notice?.toggleAttribute("hidden", gitAvailable);
    this.patchErrorState();
  }

  patchErrorState() {
    const error = this.route.scope === "branch" ? this.compareError : this.statusError;
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
    this.patchEmptyStates();
  }

  patchEmptyStates() {
    const workingEmpty = Boolean(this.status && (this.status.files?.length ?? 0) === 0);
    this.querySelector(".task-review-empty-action")?.toggleAttribute("hidden", !workingEmpty);
  }

  syncSelection() {
    const logicalPath = this.logicalSelectedPath();
    this.workingTree()?.setSelectedPath(logicalPath);
    this.branchTree()?.setSelectedPath(logicalPath);
    this.fileNavigator()?.setSelectedPath(logicalPath);
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-review-action]");
    if (action && this.contains(action)) {
      event.stopPropagation();
      if (action.dataset.reviewAction === "review-branch") {
        this.updateAxis("scope", "branch");
      }
      return;
    }
    const noticeAction = closestElement(event.target, '[data-action="view-source"]');
    if (noticeAction && this.contains(noticeAction)) {
      event.stopPropagation();
      this.updateAxis("viewer", "source");
      return;
    }
    const axis = closestElement(event.target, "button[data-review-axis]");
    if (!axis || !this.contains(axis) || axis.disabled) {
      return;
    }
    event.stopPropagation();
    this.updateAxis(axis.dataset.reviewAxis, axis.dataset.reviewValue);
  }

  updateAxis(axis, value) {
    const field = axis === "scope" ? "scope" : axis === "navigator" ? "navigator" : "viewer";
    if (this.route[field] === value) {
      return;
    }
    this.captureLocalState();
    if (field === "viewer" && this.route.path) {
      const line = this.viewer()?.visibleLine?.();
      if (line) {
        const nextKey = viewerStateKey({ ...this.route, viewer: value });
        this.pendingRepresentationLine.set(nextKey, line);
      }
    }
    this.requestRoute({ ...this.route, [field]: value }, { replace: true });
  }

  selectLogicalPath(path) {
    const relative = relativeTaskPath(path, taskRootPath(this.task));
    if (!relative) {
      return;
    }
    const replace = Boolean(this.route.path);
    this.requestRoute({ ...this.route, path: relative, line: null }, { replace });
  }

  selectCompareBase(baseRef) {
    const next = `${baseRef ?? ""}`;
    if (
      !next ||
      next === this.route.baseRef ||
      !this.refs?.refs?.some((ref) => ref.name === next)
    ) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, baseRef: next }, { replace: true });
  }

  clearSelectedPath() {
    if (!this.route.path) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, path: "", line: null }, { replace: true });
  }

  requestRoute(state, options = {}) {
    const route = taskRouteForReview(taskThreadId(this.task), state);
    this.dispatchEvent(
      new CustomEvent("caffold:task-review-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route, replace: Boolean(options.replace) },
      }),
    );
  }

  async refreshAll() {
    const requests = [
      this.fileNavigator()?.requestRefresh({
        allDirectories: true,
        selected: Boolean(this.route.path),
      }),
    ];
    if (this.task?.worktree) {
      requests.push(
        this.route.scope === "branch"
          ? this.ensureBranchData({ force: true })
          : this.refreshWorking(),
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
    this.watchUnsubscribe = subscribeToWatch(path, {
      onReady: ({ recovered }) => {
        if (path !== this.watchPath) {
          return;
        }
        if (recovered) {
          void this.refreshAll();
        }
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
          void this.refreshWorking({ background: true });
        }
        if (this.task?.worktree && change.gitRefsChanged) {
          if (this.route.scope === "branch") {
            void this.ensureBranchData({ force: true });
          } else {
            this.refs = null;
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
      `${this.panelWidth}px`,
    );
  }

  logicalSelectedPath() {
    return this.route.path
      ? joinLogicalPath(taskRootPath(this.task), this.route.path)
      : "";
  }

  navigatorStateKey() {
    return `${this.route.scope}:${this.route.navigator}`;
  }

  viewerStateKey() {
    return viewerStateKey(this.route);
  }

  activeNavigator() {
    return this.route.navigator === "files"
      ? this.fileNavigator()
      : this.route.scope === "branch"
        ? this.branchTree()
        : this.workingTree();
  }

  workingTree() {
    return this.querySelector("caffold-git-diff-changes-tree");
  }

  branchTree() {
    return this.querySelector("caffold-git-compare-tree");
  }

  fileNavigator() {
    return this.querySelector("caffold-file-navigator");
  }

  viewer() {
    return this.querySelector("caffold-review-file-viewer");
  }

  resizer() {
    return this.querySelector("caffold-review-panel-resizer");
  }

}

if (!customElements.get("caffold-task-review")) {
  customElements.define("caffold-task-review", CaffoldTaskReview);
}

function normalizeReviewRoute(route = {}, task = null) {
  const path = reviewFilePath(route?.path);
  return {
    scope: route?.reviewScope === "branch" ? "branch" : "working",
    navigator: route?.reviewNavigator === "files" ? "files" : "changes",
    viewer: route?.reviewViewer === "source" ? "source" : "diff",
    path,
    line: path ? positiveLine(route?.line) : null,
    baseRef: `${route?.baseRef ?? ""}`,
    ...(task ? { threadId: taskThreadId(task) } : {}),
  };
}

function taskRouteForReview(threadId, state) {
  return {
    kind: "tasks",
    threadId,
    review: true,
    reviewScope: state.scope,
    reviewNavigator: state.navigator,
    reviewViewer: state.viewer,
    path: state.path,
    line: state.line,
    baseRef: state.baseRef,
  };
}

function normalizeForTask(route, task) {
  if (task?.worktree) {
    return route;
  }
  return { ...route, scope: "working", navigator: "files", viewer: "source", baseRef: "" };
}

function reviewRouteKey(route) {
  return [route.scope, route.navigator, route.viewer, route.path, route.line, route.baseRef].join("\u0000");
}

function viewerStateKey(route) {
  return `${route.scope}:${route.path}:${route.viewer}`;
}

function reviewContextKey(task) {
  return [taskThreadId(task), taskRootPath(task), taskWorktreeRootPath(task)].join("\u0000");
}

function taskRootPath(task) {
  const path = task?.worktree?.rootPath || task?.cwdPath || task?.cwd || ".";
  return cleanLogicalPath(path) || ".";
}

function taskWorktreeRootPath(task) {
  const path = task?.worktree?.rootPath;
  return path ? cleanLogicalPath(path) || "." : "";
}

function taskCompareHeadRef(task, refs = null) {
  return task?.worktree?.branch || refs?.defaultHeadRef || "HEAD";
}

function selectedCompareBaseRef(preferredRef, refsPayload = {}) {
  const refs = Array.isArray(refsPayload.refs) ? refsPayload.refs : [];
  const hasRef = (candidate) =>
    Boolean(candidate && refs.some((ref) => ref.name === candidate));
  if (hasRef(preferredRef)) {
    return `${preferredRef}`;
  }
  if (hasRef(refsPayload.defaultBaseRef)) {
    return `${refsPayload.defaultBaseRef}`;
  }
  return refs[0]?.name || refsPayload.defaultBaseRef || "";
}

function relativeTaskPath(path, rootPath) {
  const normalizedPath = cleanLogicalPath(path);
  const normalizedRoot = cleanLogicalPath(rootPath) || ".";
  if (!normalizedPath) {
    return "";
  }
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  const rootSegments = logicalSegments(normalizedRoot);
  const pathSegments = logicalSegments(normalizedPath);
  const common = rootSegments.findIndex((segment, index) => pathSegments[index] !== segment);
  const commonLength = common < 0
    ? Math.min(rootSegments.length, pathSegments.length)
    : common;
  return [
    ...Array(rootSegments.length - commonLength).fill(".."),
    ...pathSegments.slice(commonLength),
  ].join("/");
}

function joinLogicalPath(root, relative) {
  const segments = logicalSegments(cleanLogicalPath(root) || ".");
  for (const segment of reviewFilePath(relative).split("/")) {
    if (!segment) {
      continue;
    }
    if (segment === "..") {
      if (!segments.length) {
        return "";
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function reviewFilePath(path) {
  const segments = [];
  for (const segment of `${path ?? ""}`.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function logicalSegments(path) {
  return `${path ?? ""}`.split("/").filter((segment) => segment && segment !== ".");
}

function positiveLine(line) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
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
