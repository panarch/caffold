import { getGitStatus } from "../../../api.js";
import { escapeHtml } from "../../../components/dom.js";
import { renderInlineIcon } from "../../../components/icons.js";
import { createRefreshCoordinator, subscribeToWatch } from "../../../watch.js";
import { routeMode } from "../../../navigation-routes.js";
import "./compare/page.js";
import "./diff/page.js";
import "./(log)/layout.js";

class CaffoldGitReviewLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.watchScopePath) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <div class="git-review-view git-mode-diff" hidden>
        <caffold-git-diff-page></caffold-git-diff-page>
      </div>
      <div class="git-review-view git-mode-compare" hidden>
        <caffold-git-compare-page></caffold-git-compare-page>
      </div>
      <div class="git-review-view git-mode-log" hidden>
        <caffold-git-log-layout></caffold-git-log-layout>
      </div>
    `;
    this.diffView = this.querySelector(".git-mode-diff");
    this.compareView = this.querySelector(".git-mode-compare");
    this.logView = this.querySelector(".git-mode-log");
    this.diffPage = this.querySelector("caffold-git-diff-page");
    this.comparePage = this.querySelector("caffold-git-compare-page");
    this.logLayout = this.querySelector("caffold-git-log-layout");
    this.diffPage.ensureRendered();
    this.comparePage.ensureRendered();
    this.logLayout.ensureRendered();
    this.mode ??= null;
    this.currentPath ??= "";
    this.repository ??= null;
    this.gitStatus ??= null;
    this.gitStatusRequestId ??= 0;
    this.pendingRefresh ??= { status: false, refs: false };
    this.watchUnavailable ??= false;
    this.refreshCoordinator = createRefreshCoordinator(
      () => this.performPendingRefresh(),
      (state) => this.setRefreshState(state),
    );
    this.diffPage.addEventListener("caffold:git-diff-state-change", () => {
      this.emitStateChange();
    });
    this.addEventListener("caffold:open-git-diff", (event) => {
      event.stopPropagation();
      this.requestGitRoute(
        {
          kind: "diff",
          path: event.detail.path,
        },
        {
          kind: event.detail.kind,
          status: event.detail.status,
        },
      );
    });
    this.comparePage.addEventListener("caffold:git-compare-state-change", () => {
      if (this.comparePage.repository) {
        this.repository = this.comparePage.repository;
      }
      this.emitStateChange();
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      event.stopPropagation();
      this.requestGitRoute(
        {
          kind: "compare",
          baseRef: this.compareBaseRef,
          headRef: this.compareHeadRef,
          path: event.detail.path,
        },
        {
          status: event.detail.status,
        },
      );
    });
    this.logLayout.addEventListener("caffold:git-log-state-change", () => {
      this.emitStateChange();
    });
    this.addEventListener("caffold:open-git-commit", (event) => {
      event.stopPropagation();
      this.requestGitRoute({
        kind: "log",
        page: this.logPage,
        sha: event.detail.sha,
      });
    });
    this.addEventListener("caffold:change-log-page", (event) => {
      event.stopPropagation();
      this.requestGitRoute({
        kind: "log",
        page: event.detail.page,
      });
    });
    this.addEventListener("caffold:open-commit-diff", (event) => {
      event.stopPropagation();
      this.requestGitRoute(
        {
          kind: "log",
          page: this.logPage,
          sha: event.detail.sha,
          path: event.detail.path,
        },
        {
          status: event.detail.status,
        },
      );
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      const route = this.routeForCloseFileViewerTarget(event.target);
      if (!route) {
        return;
      }

      event.stopPropagation();
      this.requestGitRoute(route);
    });
    this.updateVisibleMode();
  }

  reset() {
    this.ensureRendered();
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.gitStatus = null;
    this.gitStatusRequestId += 1;
    this.diffPage.reset();
    this.comparePage.reset();
    this.logLayout.reset();
    this.setWatchScope(null);
    this.updateVisibleMode();
    this.emitStateChange();
  }

  setContext({ path, repository } = {}) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.diffPage.setContext({ path: this.currentPath, repository: this.repository });
    this.comparePage.setContext({ path: this.currentPath, repository: this.repository });
    this.logLayout.setContext({ path: this.currentPath, repository: this.repository });

    this.setWatchScope(this.repository?.rootPath ?? null);

    if (contextChanged) {
      this.gitStatus = null;
      this.gitStatusRequestId += 1;
      if (this.repository) {
        this.diffPage.setLoading(this.repository);
      }
    }
  }

  async applyRepositoryContext({ path, repository } = {}) {
    this.setContext({ path, repository });
    return await this.loadStatus(path ?? this.currentPath);
  }

  setGitStatus(status, options = {}) {
    this.ensureRendered();
    this.gitStatus = status ?? null;
    if (status?.repository) {
      this.repository = status.repository;
      this.diffPage.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.comparePage.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.logLayout.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.diffPage.setStatus(status, options);
    } else if (this.repository) {
      this.diffPage.setLoading(this.repository);
    }
    this.emitStateChange();
  }

  setGitStatusError(error) {
    this.ensureRendered();
    this.diffPage.setError(error, this.repository);
    this.emitStateChange();
  }

  async loadStatus(path) {
    this.ensureRendered();
    if (!this.repository) {
      return null;
    }

    const nextPath = path ?? this.currentPath ?? "";
    this.setContext({
      path: nextPath,
      repository: this.repository,
    });
    const requestId = ++this.gitStatusRequestId;
    this.setGitStatus(null);

    try {
      const status = await getGitStatus(nextPath);
      if (requestId !== this.gitStatusRequestId) {
        return null;
      }

      this.setGitStatus(status);
      return status;
    } catch (error) {
      if (requestId !== this.gitStatusRequestId) {
        return null;
      }

      this.setGitStatusError(error);
      return null;
    }
  }

  async refreshStatus() {
    if (!this.repository) {
      return null;
    }
    const requestId = ++this.gitStatusRequestId;
    try {
      const status = await getGitStatus(this.currentPath ?? "");
      if (requestId !== this.gitStatusRequestId) {
        return null;
      }
      this.setGitStatus(status, { preserveState: true });
      if (this.mode === "diff") {
        await this.diffPage.refreshSelectedDiff(status);
      }
      return status;
    } catch {
      return null;
    }
  }

  setWatchScope(path) {
    const nextPath = path ?? null;
    if (this.watchScopePath === nextPath && this.watchUnsubscribe) {
      return;
    }
    this.watchScopePath = nextPath;
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchUnavailable = false;
    this.setRefreshState("idle");
    if (nextPath && this.isConnected) {
      this.subscribeWatchScope(nextPath);
    }
  }

  subscribeWatchScope(path) {
    if (this.watchUnsubscribe) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          this.requestRefresh({ status: true, refs: true });
        }
      },
      onChange: (change) => {
        this.requestRefresh({
          status: Boolean(change.gitStatusChanged || change.overflow),
          refs: Boolean(change.gitRefsChanged || change.overflow),
        });
      },
      onRecover: () => this.requestRefresh({ status: true, refs: true }),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  refresh() {
    return this.requestRefresh({
      status: true,
      refs: this.mode === "compare" || this.mode === "log",
    });
  }

  requestRefresh(options = {}) {
    this.pendingRefresh.status ||= Boolean(options.status);
    this.pendingRefresh.refs ||= Boolean(options.refs);
    if (!this.pendingRefresh.status && !this.pendingRefresh.refs) {
      return Promise.resolve();
    }
    return this.refreshCoordinator.request();
  }

  async performPendingRefresh() {
    const pending = this.pendingRefresh;
    this.pendingRefresh = { status: false, refs: false };
    if (pending.status) {
      await this.refreshStatus();
    }
    if (pending.refs && this.mode === "compare") {
      await this.comparePage.refresh();
    } else if (pending.refs && this.mode === "log") {
      await this.logLayout.refresh();
    }
  }

  setRefreshState(state) {
    this.refreshState = state === "refreshing"
      ? "refreshing"
      : this.watchUnavailable
        ? "unavailable"
        : "idle";
    this.emitStateChange();
  }

  async ensureStatus(path) {
    this.ensureRendered();
    if (!this.repository) {
      return null;
    }

    if (this.gitStatus) {
      return this.gitStatus;
    }

    return await this.loadStatus(path ?? this.currentPath);
  }

  openDiffWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("diff");
    this.diffPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    if (options.preserveViewer) {
      this.diffPage.setView("viewer");
    } else {
      this.diffPage.showList();
    }
    if (!this.gitStatus) {
      this.diffPage.setLoading(this.repository);
    }
    if (!options.preserveViewer) {
      this.diffPage.setEmpty();
    }
    this.emitStateChange();
    return this.gitStatus;
  }

  async openDiff(path, kind, status = "") {
    if (!path) {
      return null;
    }

    this.setMode("diff");
    this.logLayout.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.diffPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const diff = await this.diffPage.openDiff(path, kind, status);
    this.emitStateChange();
    return diff;
  }

  async openCompareWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("compare");
    this.comparePage.setContext({
      path: this.currentPath,
      repository: this.repository,
      baseRef: options.baseRef,
      headRef: options.headRef,
    });
    const compare = await this.comparePage.openCompare({
      path: this.currentPath,
      repository: this.repository,
      baseRef: options.baseRef,
      headRef: options.headRef,
      preserveViewer: options.preserveViewer,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return compare;
  }

  async openCompareDiff(path, status = "") {
    if (!path || !this.comparePage.compare) {
      return null;
    }

    this.setMode("compare");
    this.diffPage.setSelectedPath("");
    this.logLayout.setSelectedPath("");
    const diff = await this.comparePage.openDiff(path, status);
    this.emitStateChange();
    return diff;
  }

  async openLogWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setView("list");
    this.comparePage.setView("list");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const log = await this.logLayout.openList({
      path: this.currentPath,
      repository: this.repository,
      page: options.page ?? 1,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return log;
  }

  async openCommit(sha, options = {}) {
    if (!sha || !this.repository) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const commit = await this.logLayout.openCommit(sha, options);
    this.emitStateChange();
    return commit;
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const diff = await this.logLayout.openCommitDiff(sha, path, status);
    this.emitStateChange();
    return diff;
  }

  prepareRoute(route) {
    this.ensureRendered();
    const mode = routeMode(route);
    if (!mode) {
      return;
    }

    if (mode === "diff") {
      this.setMode("diff");
      this.diffPage.setContext({
        path: this.currentPath,
        repository: this.repository,
      });
      if (route.path) {
        this.diffPage.setView("viewer");
      } else {
        this.diffPage.showList();
        this.diffPage.setSelectedPath("");
        this.diffPage.setEmpty();
      }
      this.emitStateChange();
      return;
    }

    if (mode === "compare") {
      this.setMode("compare");
      this.comparePage.setContext({
        path: this.currentPath,
        repository: this.repository,
        baseRef: route.baseRef,
        headRef: route.headRef,
      });
      if (route.path) {
        this.comparePage.setView("viewer");
      } else {
        this.comparePage.showList();
        this.comparePage.setSelectedPath("");
        this.comparePage.setEmpty();
      }
      this.emitStateChange();
      return;
    }

    if (mode === "log") {
      this.setMode("log");
      this.logLayout.setContext({
        path: this.currentPath,
        repository: this.repository,
      });
      this.logLayout.prepareRoute(route);
      this.emitStateChange();
    }
  }

  async openRoute(route, options = {}) {
    this.prepareRoute(route);
    const mode = routeMode(route);
    if (mode === "diff") {
      this.openDiffWorkspace({ preserveViewer: Boolean(route.path) });
      if (!route.path) {
        this.setSelectedPath("");
        return this.gitStatus;
      }

      await this.ensureStatus(this.currentPath);

      const fullPath = this.resolveRoutePath(route.path, options);
      if (!fullPath) {
        return null;
      }

      const file = this.findDiffFile(fullPath);
      return await this.openDiff(
        fullPath,
        file?.untracked ? "untracked" : file?.category ?? options.kind ?? "unstaged",
        file?.status ?? options.status ?? "",
      );
    }

    if (mode === "compare") {
      const routeBaseRef = route.baseRef || null;
      const routeHeadRef = route.headRef || null;
      const compare = await this.openCompareWorkspace({
        baseRef: routeBaseRef,
        headRef: routeHeadRef,
        preserveViewer: Boolean(route.path),
        skipReload: options.skipReload,
      });
      if (!route.path) {
        this.setSelectedPath("");
        return compare;
      }

      const fullPath = this.resolveRoutePath(route.path, options);
      if (!fullPath) {
        return null;
      }

      const file = this.findCompareFile(fullPath);
      return await this.openCompareDiff(fullPath, file?.status ?? options.status ?? "");
    }

    if (mode !== "log") {
      return null;
    }

    if (!route.sha) {
      return await this.openLogWorkspace({
        page: route.page,
        skipReload: options.skipReload,
      });
    }

    const commit = await this.openCommit(route.sha, {
      page: route.page,
      skipReload: options.skipReload,
      preserveViewer: Boolean(route.path),
    });
    if (!route.path) {
      return commit;
    }

    const fullPath = this.resolveRoutePath(route.path, options);
    if (!fullPath) {
      return null;
    }

    const file = this.findCommitFile(fullPath);
    return await this.openCommitDiff(route.sha, fullPath, file?.status ?? options.status ?? "");
  }

  routeForCloseFileViewerTarget(target) {
    if (this.diffPage.isFileViewer(target)) {
      return {
        kind: "diff",
        path: "",
      };
    }

    if (this.comparePage.isFileViewer(target)) {
      return {
        kind: "compare",
        baseRef: this.compareBaseRef,
        headRef: this.compareHeadRef,
        path: "",
      };
    }

    if (this.logLayout.isFileViewer(target)) {
      const sha = this.logLayout.currentCommitSha();
      if (!sha) {
        return null;
      }

      return {
        kind: "log",
        page: this.logPage,
        sha,
        path: "",
      };
    }

    return null;
  }

  setSelectedPath(path) {
    this.diffPage.setSelectedPath(path);
    this.logLayout.setSelectedPath(path);
    this.comparePage.setSelectedPath(path);
  }

  setView(view) {
    if (view !== "list") {
      return;
    }

    this.diffPage.setView("list");
    this.comparePage.setView("list");
    this.logLayout.backToList();
    this.emitStateChange();
  }

  canReuseDiffRoute(_route) {
    return this.mode === "diff" && Boolean(this.repository) && Boolean(this.gitStatus);
  }

  canReuseCompareRoute(route) {
    const routeBaseRef = route.baseRef || null;
    const routeHeadRef = route.headRef || null;
    return (
      this.mode === "compare" &&
      Boolean(this.repository) &&
      this.comparePage.hasCompare(routeBaseRef, routeHeadRef)
    );
  }

  canReuseLogRoute(route) {
    return this.mode === "log" && this.logLayout.canReuseRoute(route.page, route.sha);
  }

  canReuseRoute(route) {
    const mode = routeMode(route);
    if (mode === "diff") {
      return this.canReuseDiffRoute(route);
    }

    if (mode === "compare") {
      return this.canReuseCompareRoute(route);
    }

    if (mode === "log") {
      return this.canReuseLogRoute(route);
    }

    return false;
  }

  findDiffFile(path) {
    return this.gitStatus?.files?.find((entry) => entry.path === path) ?? null;
  }

  findCompareFile(path) {
    return this.comparePage.fileForPath(path);
  }

  findCommitFile(path) {
    return this.logLayout.findCommitFile(path);
  }

  reviewPanelForTarget(target) {
    if (target === "log") {
      return this.querySelector("caffold-git-log-commit-page");
    }

    if (target === "diff") {
      return this.diffPage;
    }

    if (target === "compare") {
      return this.comparePage;
    }

    return null;
  }

  isMobileDetailOpen() {
    return (
      (this.mode === "diff" && this.diffPage.dataset.detailView === "viewer") ||
      (this.mode === "compare" && this.comparePage.dataset.detailView === "viewer") ||
      (this.mode === "log" &&
        this.logLayout.dataset.logView === "detail" &&
        this.logLayout.detailView === "viewer")
    );
  }

  resolveRoutePath(path, options = {}) {
    return typeof options.resolvePath === "function" ? options.resolvePath(path) : path;
  }

  routeForAction(action) {
    if (action === "compare") {
      return this.routeForCompareRefs(this.compareBaseRef, this.compareHeadRef);
    }

    if (action === "log") {
      return {
        kind: "log",
        page: this.logPage,
      };
    }

    return {
      kind: "diff",
      path: "",
    };
  }

  routeForActiveMode() {
    if (this.activeMode === "log") {
      return {
        kind: "log",
        page: 1,
      };
    }

    if (this.activeMode === "compare") {
      return {
        kind: "compare",
        path: "",
      };
    }

    return {
      kind: "diff",
      path: "",
    };
  }

  routeForCompareRefs(baseRef, headRef) {
    return {
      kind: "compare",
      baseRef,
      headRef,
      path: "",
    };
  }

  routeForWorkspaceBack() {
    if (this.mode === "log" && this.logLayout.view === "detail") {
      return {
        kind: "log",
        page: this.logPage,
      };
    }

    return null;
  }

  requestGitRoute(route, options = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-git-route", {
        bubbles: true,
        detail: {
          route,
          options,
        },
      }),
    );
  }

  details() {
    if (this.mode === "diff") {
      return {
        title: "Diff",
        subtitle: this.workspaceSubtitle("Working tree"),
        backVisible: false,
        controlsHtml: this.renderRefreshControls(),
      };
    }

    if (this.mode === "compare") {
      return {
        title: "Compare",
        subtitle: this.comparePage.compareSubtitle(this.workspaceSubtitle("Branches")),
        backVisible: false,
        controlsHtml: this.renderCompareControls(),
      };
    }

    if (this.mode === "log" && this.logLayout.view === "detail") {
      return {
        title: "Commit",
        subtitle: this.logLayout.commitSubtitle(),
        backVisible: true,
        backLabel: "Back to log",
        controlsHtml: this.renderRefreshControls(),
      };
    }

    if (this.mode === "log") {
      return {
        title: "Log",
        subtitle: this.workspaceSubtitle("History"),
        backVisible: false,
        controlsHtml: this.renderRefreshControls(),
      };
    }

    return {
      title: "Git",
      subtitle: "",
      backVisible: false,
    };
  }

  workspaceSubtitle(label) {
    if (!this.repository) {
      return label;
    }

    const branch = this.repository.branch ?? "HEAD";
    const dirty = this.repository.dirty ? " *" : "";
    const count = this.gitStatus?.files?.length;
    const countLabel = count === undefined ? "" : ` · ${count} changes`;
    return `${label} · ${branch}${dirty}${countLabel}`;
  }

  renderCompareControls() {
    const refs = this.comparePage.refsPayload?.refs ?? [];
    return `
      <div class="git-review-controls">
        ${refs.length > 0 ? `
          <div class="review-compare-ref-controls" aria-label="Compare refs">
            <label for="caffold-compare-base-ref">Base</label>
            <select
              id="caffold-compare-base-ref"
              data-compare-ref="base"
              aria-label="Base ref"
              title="${escapeHtml(this.comparePage.baseRef ?? "")}"
            >
              ${renderRefOptions(refs, this.comparePage.baseRef)}
            </select>
            <span class="review-compare-ref-separator" aria-hidden="true">...</span>
            <label for="caffold-compare-head-ref">Head</label>
            <select
              id="caffold-compare-head-ref"
              data-compare-ref="head"
              aria-label="Head ref"
              title="${escapeHtml(this.comparePage.headRef ?? "")}"
            >
              ${renderRefOptions(refs, this.comparePage.headRef)}
            </select>
          </div>
        ` : ""}
        ${this.renderRefreshButton()}
      </div>
    `;
  }

  renderRefreshControls() {
    return `<div class="git-review-controls">${this.renderRefreshButton()}</div>`;
  }

  renderRefreshButton() {
    const refreshing = this.refreshState === "refreshing";
    const unavailable = this.refreshState === "unavailable";
    const title = unavailable
      ? "Live updates unavailable. Refresh manually."
      : `Refresh ${this.mode ?? "Git"}`;
    return `
      <button
        type="button"
        class="git-review-refresh${refreshing ? " is-refreshing" : ""}${unavailable ? " is-unavailable" : ""}"
        data-action="refresh-git-review"
        aria-label="${escapeHtml(title)}"
        title="${escapeHtml(title)}"
      >
        ${renderInlineIcon("RefreshCw", "Refresh Git review", "git-review-refresh-icon")}
      </button>
    `;
  }

  get compareBaseRef() {
    return this.comparePage.baseRef ?? "";
  }

  get compareHeadRef() {
    return this.comparePage.headRef ?? "";
  }

  get logPage() {
    return this.logLayout.page;
  }

  get activeMode() {
    return this.mode;
  }

  setMode(mode) {
    const nextMode = normalizeGitMode(mode);
    if (this.mode === nextMode) {
      return;
    }

    this.mode = nextMode;
    this.updateVisibleMode();
  }

  updateVisibleMode() {
    this.dataset.gitMode = this.mode ?? "";
    if (this.diffView) {
      this.diffView.hidden = this.mode !== "diff";
      this.diffView.dataset.detailView = this.diffPage.detailView;
    }
    if (this.compareView) {
      this.compareView.hidden = this.mode !== "compare";
      this.compareView.dataset.detailView = this.comparePage.detailView;
    }
    if (this.logView) {
      this.logView.hidden = this.mode !== "log";
      this.logView.dataset.logView = this.logLayout.view;
    }
  }

  emitStateChange() {
    this.updateVisibleMode();
    this.dispatchEvent(
      new CustomEvent("caffold:git-review-state-change", {
        bubbles: true,
        detail: {
          mode: this.mode,
          detailOpen: this.isMobileDetailOpen(),
        },
      }),
    );
  }
}

customElements.define("caffold-git-review-layout", CaffoldGitReviewLayout);

function normalizeGitMode(mode) {
  return mode === "compare" || mode === "log" ? mode : "diff";
}

function renderRefOptions(refs, selectedRef) {
  let lastKind = null;
  let html = "";

  for (const ref of refs) {
    if (ref.kind !== lastKind) {
      if (lastKind) {
        html += "</optgroup>";
      }
      lastKind = ref.kind;
      html += `<optgroup label="${escapeHtml(refKindLabel(ref.kind))}">`;
    }

    html += `
      <option value="${escapeHtml(ref.name)}" ${ref.name === selectedRef ? "selected" : ""}>
        ${escapeHtml(ref.name)}
      </option>
    `;
  }

  return lastKind ? `${html}</optgroup>` : html;
}

function refKindLabel(kind) {
  if (kind === "head") {
    return "Current";
  }

  return kind === "remote" ? "Remote" : "Local";
}
