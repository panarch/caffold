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
import "../../../../../components/git-compare-browser/compare-tree.js";
import "../../../../../components/git-diff-browser/changes-tree.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import "../../../../../components/review-panel-resizer.js";
import { subscribeToWatch } from "../../../../../watch.js";
import { latestTaskRelatedWorktreePaths } from "../../task-events.js";
import { cleanLogicalPath } from "../../task-format.js";
import { taskThreadId } from "../../task-list-model.js";

const REVIEW_PANEL_DEFAULT_WIDTH = 320;

class CaffoldTaskReview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.active = true;
    this.attachGlobalListeners();
    this.syncReview({ reactivated: true });
  }

  disconnectedCallback() {
    this.active = false;
    this.detachGlobalListeners();
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
    this.events = [];
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
    this.watchUnavailable = false;
    this.refreshing = false;
    this.panelWidth = REVIEW_PANEL_DEFAULT_WIDTH;
    this.navigatorScroll = new Map();
    this.viewerScroll = new Map();
    this.pendingRepresentationLine = new Map();
    this.globalListenersAttached = false;
    this.boundIconsReady = () => this.patchRefreshButton();
    warmIcons();

    this.innerHTML = `
      <section class="task-review-workspace" aria-label="Task review">
        <header class="task-review-toolbar">
          <div class="task-review-axis" role="group" aria-label="Review scope">
            <span class="task-review-axis-label">Scope</span>
            <div class="task-review-axis-options">
              <button type="button" data-review-axis="scope" data-review-value="working">Working Tree</button>
              <button type="button" data-review-axis="scope" data-review-value="branch">Branch</button>
            </div>
          </div>
          <div class="task-review-axis" role="group" aria-label="Review navigator">
            <span class="task-review-axis-label">Navigator</span>
            <div class="task-review-axis-options">
              <button type="button" data-review-axis="navigator" data-review-value="changes">Changes</button>
              <button type="button" data-review-axis="navigator" data-review-value="files">Files</button>
            </div>
          </div>
          <div class="task-review-axis" role="group" aria-label="Review viewer">
            <span class="task-review-axis-label">Viewer</span>
            <div class="task-review-axis-options">
              <button type="button" data-review-axis="viewer" data-review-value="diff">Diff</button>
              <button type="button" data-review-axis="viewer" data-review-value="source">Source</button>
            </div>
          </div>
          <label class="task-review-base">
            <span>Base</span>
            <select data-review-base disabled><option value="">Loading refs...</option></select>
          </label>
          <button
            type="button"
            class="task-icon-button task-review-refresh"
            data-review-action="refresh"
            aria-label="Refresh review"
            title="Refresh review"
          >${renderInlineIcon("RefreshCw", "Refresh review", "task-refresh-icon")}</button>
        </header>
        <div class="task-review-notices">
          <p class="task-review-git-notice" hidden>Git review is unavailable for this task. Browse files and source instead.</p>
          <p class="task-review-error" role="alert" hidden></p>
        </div>
        <div class="task-review-layout">
          <aside class="task-review-navigator-pane" aria-label="Review navigator">
            <div class="task-review-navigator" data-review-navigator="working">
              <caffold-git-diff-changes-tree></caffold-git-diff-changes-tree>
              <div class="task-review-empty-action" hidden>
                <p>The working tree has no changes.</p>
                <button type="button" class="task-secondary-button" data-review-action="review-branch">Review branch changes</button>
              </div>
            </div>
            <div class="task-review-navigator" data-review-navigator="branch">
              <caffold-git-compare-tree></caffold-git-compare-tree>
              <p class="task-review-branch-empty" hidden></p>
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
            <button type="button" class="task-review-mobile-back" data-review-action="back-to-navigator">
              ${renderInlineIcon("ArrowLeft", "Back to navigator", "task-action-icon")}
              <span>Back</span>
            </button>
            <caffold-review-file-viewer></caffold-review-file-viewer>
          </section>
        </div>
      </section>
    `;

    this.fileNavigator()?.setStorageKey(null);
    this.fileNavigator()?.setWatchActive(false);
    this.resizer()?.setValue(this.panelWidth);
    this.applyPanelWidth();

    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("change", (event) => this.handleChange(event));
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

  attachGlobalListeners() {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setTaskContext({ task = null, events = [], route = null } = {}) {
    this.ensureRendered();
    const contextKey = reviewContextKey(task);
    const contextChanged = contextKey !== this.contextKey;
    const previousRoute = this.route;
    const nextRoute = normalizeReviewRoute(route, task);
    const nextRouteKey = reviewRouteKey(nextRoute);
    const routeChanged = Boolean(
      this.previousRouteKey && this.previousRouteKey !== nextRouteKey,
    );
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
    this.events = Array.isArray(events) ? events : [];
    this.route = nextRoute;
    this.previousRouteKey = nextRouteKey;

    const normalizedForTask = normalizeForTask(nextRoute, task);
    if (reviewRouteKey(normalizedForTask) !== nextRouteKey) {
      this.requestRoute(normalizedForTask, { replace: true });
      return;
    }
    this.syncReview({ contextChanged, routeChanged });
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
    this.patchToolbar();
    this.patchLayout();
    this.syncSelection();
    this.ensureFileNavigator({ refresh: options.reactivated });
    this.subscribeWatch(taskRootPath(this.task));
    if (this.task.worktree) {
      if (this.status) {
        this.workingTree()?.setTaskRelatedPaths(
          latestTaskRelatedWorktreePaths(this.events, this.task),
        );
      }
      if (options.contextChanged || options.reactivated || !this.status) {
        void this.refreshWorking();
      }
      if (
        this.route.scope === "branch" &&
        (options.reactivated ||
          !this.compare ||
          this.compare.baseRef !== this.route.baseRef)
      ) {
        void this.ensureBranchData({ force: options.reactivated });
      }
    }
    if (
      this.route.path &&
      (options.contextChanged ||
        options.routeChanged ||
        options.reactivated ||
        ["empty", "error"].includes(this.viewer()?.state?.status))
    ) {
      void this.loadViewer();
    } else {
      this.viewer()?.setEmpty();
    }
    this.restoreNavigatorScroll();
  }

  ensureFileNavigator({ refresh = false } = {}) {
    const navigator = this.fileNavigator();
    const rootPath = taskRootPath(this.task);
    if (!navigator || !rootPath) {
      return;
    }
    navigator.setWatchActive(false);
    if (!navigator.hasLoadedDirectory(rootPath)) {
      void navigator.loadDirectory(rootPath, { allowFailure: true }).then(() => {
        if (this.route.path) {
          void navigator.revealPath(this.logicalSelectedPath());
        }
      });
    } else {
      if (refresh) {
        void navigator.requestRefresh({ allDirectories: true });
      }
      if (this.route.navigator === "files" && this.route.path) {
        void navigator.revealPath(this.logicalSelectedPath());
      }
    }
  }

  async refreshWorking() {
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
      this.workingTree()?.setTaskRelatedPaths(
        latestTaskRelatedWorktreePaths(this.events, this.task),
      );
      this.syncSelection();
      this.patchEmptyStates();
      if (this.route.path && this.route.scope === "working") {
        void this.loadViewer();
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
      const baseRef = this.route.baseRef || refs.defaultBaseRef || refs.refs?.[0]?.name || "";
      if (!this.route.baseRef && baseRef) {
        this.requestRoute({ ...this.route, baseRef }, { replace: true });
        return null;
      }
      this.patchToolbar();
      if (!this.compare) {
        this.branchTree()?.setLoading(refs.repository);
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
      if (hadCompare) {
        this.branchTree()?.updateCompare(compare);
      } else {
        this.branchTree()?.setCompare(compare);
      }
      this.syncSelection();
      this.patchToolbar();
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
      generation ===
        (owner === "branch" ? this.branchGeneration : this.statusGeneration) &&
      rootPath === taskWorktreeRootPath(this.task)
    );
  }

  async loadViewer() {
    const selectedPath = this.logicalSelectedPath();
    if (!selectedPath || !this.active) {
      this.viewer()?.setEmpty();
      return;
    }
    const generation = ++this.viewerGeneration;
    const viewer = this.viewer();
    const saved = this.viewerScroll.get(this.viewerStateKey());
    viewer?.setLoading(selectedPath);
    try {
      if (this.route.viewer === "source") {
        if (this.selectedChange()?.deleted) {
          viewer?.setNotice("This file was deleted in the selected scope. Diff remains available.");
          return;
        }
        if (isPreviewableImagePath(selectedPath)) {
          const entry = this.fileNavigator()?.entryForPath(selectedPath);
          viewer?.setImage({
            path: selectedPath,
            name: fileNameFromPath(selectedPath),
            imageType: imageTypeLabel(selectedPath),
            size: entry?.size,
            modifiedMs: entry?.modifiedMs,
            revision: ++this.imageRevision,
          });
          return;
        }
        const file = await readFile(selectedPath);
        if (!this.acceptViewer(generation, selectedPath)) {
          return;
        }
        viewer?.setFile(file, { scroll: saved?.scroll ?? null });
      } else {
        if (
          (this.route.scope === "working" && !this.status) ||
          (this.route.scope === "branch" && !this.compare)
        ) {
          return;
        }
        const change = this.selectedChange();
        if (!change) {
          viewer?.setNotice("No changes in this scope.", {
            actionLabel: "View source",
            action: "view-source",
          });
          return;
        }
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
        viewer?.setDiff(diff, { scroll: saved?.scroll ?? null });
      }
      this.restoreViewerPosition(saved);
    } catch (error) {
      if (this.acceptViewer(generation, selectedPath)) {
        viewer?.setError(selectedPath, error);
      }
    }
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

  patchToolbar() {
    const gitAvailable = Boolean(this.task?.worktree);
    for (const button of this.querySelectorAll("button[data-review-axis]")) {
      const axis = button.dataset.reviewAxis;
      const value = button.dataset.reviewValue;
      const current = this.route[axis];
      button.setAttribute("aria-pressed", current === value ? "true" : "false");
      const gitOnly =
        (axis === "scope" && value === "branch") ||
        (axis === "navigator" && value === "changes") ||
        (axis === "viewer" && value === "diff");
      button.disabled = gitOnly && !gitAvailable;
      if (button.disabled) {
        button.title = "Unavailable outside a Git worktree";
      } else {
        button.removeAttribute("title");
      }
    }
    const notice = this.querySelector(".task-review-git-notice");
    notice?.toggleAttribute("hidden", gitAvailable);
    const base = this.baseSelect();
    const refs = this.refs?.refs ?? [];
    if (base) {
      base.closest("label")?.toggleAttribute("hidden", this.route.scope !== "branch");
      base.innerHTML = refs.length
        ? refs.map((ref) => `<option value="${escapeAttribute(ref.name)}">${escapeText(ref.name)}</option>`).join("")
        : `<option value="">Loading refs...</option>`;
      base.disabled = refs.length === 0;
      if (this.route.baseRef) {
        base.value = this.route.baseRef;
      }
      base.title = this.route.baseRef;
    }
    this.patchRefreshButton();
    this.patchErrorState();
  }

  patchErrorState() {
    const error = this.route.scope === "branch" ? this.compareError : this.statusError;
    const message = error
      ? `${this.route.scope === "branch" ? "Branch comparison" : "Working tree"} refresh failed: ${error.message}`
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
    const branchEmpty = Boolean(this.compare && (this.compare.files?.length ?? 0) === 0);
    const branch = this.querySelector(".task-review-branch-empty");
    if (branch) {
      branch.textContent = branchEmpty
        ? `No changes compared with ${this.route.baseRef || "the selected base"}.`
        : "";
      branch.toggleAttribute("hidden", !branchEmpty);
    }
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
      if (action.dataset.reviewAction === "refresh") {
        void this.refresh();
      } else if (action.dataset.reviewAction === "review-branch") {
        this.updateAxis("scope", "branch");
      } else if (action.dataset.reviewAction === "back-to-navigator") {
        this.clearSelectedPath();
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

  handleChange(event) {
    const select = closestElement(event.target, "select[data-review-base]");
    if (!select || !this.contains(select)) {
      return;
    }
    event.stopPropagation();
    this.compare = null;
    this.compareError = null;
    this.requestRoute({ ...this.route, baseRef: select.value }, { replace: true });
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
    this.requestRoute({ ...this.route, path: relative }, { replace });
  }

  clearSelectedPath() {
    if (!this.route.path) {
      return;
    }
    this.captureLocalState();
    this.requestRoute({ ...this.route, path: "" }, { replace: true });
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

  async refresh() {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    this.patchRefreshButton();
    try {
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
    } finally {
      this.refreshing = false;
      this.patchRefreshButton();
    }
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
        this.watchUnavailable = false;
        this.patchRefreshButton();
        if (recovered) {
          void this.refresh();
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
        if (this.task?.worktree && (change.gitStatusChanged || change.overflow)) {
          void this.refreshWorking();
        }
        if (
          this.task?.worktree &&
          this.route.scope === "branch" &&
          (change.gitRefsChanged || change.overflow)
        ) {
          void this.ensureBranchData({ force: true });
        }
      },
      onError: () => {
        if (path !== this.watchPath) {
          return;
        }
        this.watchUnavailable = true;
        this.patchRefreshButton();
      },
    });
  }

  unsubscribeWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
    this.watchUnavailable = false;
  }

  patchRefreshButton() {
    const button = this.querySelector(".task-review-refresh");
    if (!button) {
      return;
    }
    const label = this.watchUnavailable
      ? "Live updates unavailable. Refresh manually."
      : "Refresh review";
    button.innerHTML = renderInlineIcon("RefreshCw", label, "task-refresh-icon");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.classList.toggle("is-refreshing", this.refreshing);
    button.classList.toggle("is-unavailable", this.watchUnavailable);
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

  baseSelect() {
    return this.querySelector("select[data-review-base]");
  }
}

if (!customElements.get("caffold-task-review")) {
  customElements.define("caffold-task-review", CaffoldTaskReview);
}

function normalizeReviewRoute(route = {}, task = null) {
  return {
    scope: route?.reviewScope === "branch" ? "branch" : "working",
    navigator: route?.reviewNavigator === "files" ? "files" : "changes",
    viewer: route?.reviewViewer === "source" ? "source" : "diff",
    path: safeRelativePath(route?.path),
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
  return [route.scope, route.navigator, route.viewer, route.path, route.baseRef].join("\u0000");
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

function relativeTaskPath(path, rootPath) {
  const normalizedPath = cleanLogicalPath(path);
  const normalizedRoot = cleanLogicalPath(rootPath) || ".";
  if (!normalizedPath) {
    return "";
  }
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  const prefix = normalizedRoot === "." ? "" : `${normalizedRoot}/`;
  return prefix && normalizedPath.startsWith(prefix)
    ? safeRelativePath(normalizedPath.slice(prefix.length))
    : normalizedRoot === "."
      ? safeRelativePath(normalizedPath)
      : "";
}

function joinLogicalPath(root, relative) {
  const normalizedRoot = cleanLogicalPath(root) || ".";
  const normalizedRelative = safeRelativePath(relative);
  return normalizedRoot === "."
    ? normalizedRelative
    : cleanLogicalPath(`${normalizedRoot}/${normalizedRelative}`);
}

function safeRelativePath(path) {
  const segments = `${path ?? ""}`.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    return "";
  }
  return segments.filter((segment) => segment && segment !== ".").join("/");
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

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = `${value ?? ""}`;
  return span.innerHTML;
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', "&quot;");
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
