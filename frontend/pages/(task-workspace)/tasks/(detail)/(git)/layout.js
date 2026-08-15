import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import { routeMode } from "../../../../../navigation-routes.js";
import {
  createRefreshCoordinator,
  subscribeToWatch,
} from "../../../../../watch.js";
import "./components/controls.js";
import "./compare/page.js";
import "./(log)/layout.js";

class CaffoldTaskGitLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.active && this.watchScopePath) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    this.deactivate();
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.active = false;
    this.activationGeneration = 0;
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.pendingRefresh = false;
    this.watchUnavailable = false;
    this.refreshState = "idle";
    this.innerHTML = `
      <section class="task-git-surface" aria-label="Git">
        <header class="task-domain-header">
          <button type="button" class="task-domain-back" data-action="domain-back" hidden></button>
          <div class="task-domain-title">
            <h2>Git</h2>
            <span class="task-domain-subtitle"></span>
          </div>
          <caffold-git-review-controls></caffold-git-review-controls>
        </header>
        <div class="task-domain-body">
          <div class="git-review-view git-mode-compare" hidden>
            <caffold-git-compare-page></caffold-git-compare-page>
          </div>
          <div class="git-review-view git-mode-log" hidden>
            <caffold-git-log-layout></caffold-git-log-layout>
          </div>
        </div>
      </section>
    `;
    this.backButton = this.querySelector(".task-domain-back");
    this.titleEl = this.querySelector(".task-domain-title h2");
    this.subtitleEl = this.querySelector(".task-domain-subtitle");
    this.controls = this.querySelector("caffold-git-review-controls");
    this.compareView = this.querySelector(".git-mode-compare");
    this.logView = this.querySelector(".git-mode-log");
    this.comparePage = this.querySelector("caffold-git-compare-page");
    this.logLayout = this.querySelector("caffold-git-log-layout");
    this.comparePage.ensureRendered();
    this.logLayout.ensureRendered();
    this.refreshCoordinator = createRefreshCoordinator(
      () => this.performPendingRefresh(),
      (state) => this.setRefreshState(state),
    );
    this.backButton.addEventListener("click", () => {
      const route = this.routeForWorkspaceBack();
      if (route) {
        this.requestGitRoute(route);
      }
    });
    this.comparePage.addEventListener("caffold:git-compare-state-change", () => {
      if (this.comparePage.repository) {
        this.repository = this.comparePage.repository;
      }
      this.emitStateChange();
    });
    this.logLayout.addEventListener("caffold:git-log-state-change", () => {
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
        { status: event.detail.status },
      );
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
      this.requestGitRoute({ kind: "log", page: event.detail.page });
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
        { status: event.detail.status },
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
    this.boundIconsReady = () => this.renderChrome();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
    this.updateVisibleMode();
  }

  async activate(route, options = {}) {
    this.ensureRendered();
    this.active = true;
    const generation = ++this.activationGeneration;
    this.comparePage.invalidateRequests();
    this.logLayout.invalidateRequests();
    this.setContext(options.context);
    this.setWatchScope(this.repository?.rootPath ?? null);
    const result = await this.openRoute(route, {
      ...options.routeOptions,
      activationGeneration: generation,
      forceRefresh: true,
    });
    return this.active && generation === this.activationGeneration
      ? result
      : null;
  }

  deactivate() {
    if (!this.rendered || !this.active) {
      return;
    }
    this.active = false;
    this.activationGeneration += 1;
    this.pendingRefresh = false;
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.comparePage.invalidateRequests();
    this.logLayout.invalidateRequests();
    this.setRefreshState("idle");
  }

  reset() {
    this.ensureRendered();
    this.deactivate();
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.watchScopePath = null;
    this.comparePage.reset();
    this.logLayout.reset();
    this.updateVisibleMode();
  }

  setContext({ path, repository } = {}) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath;
    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.comparePage.setContext({ path: nextPath, repository: nextRepository });
    this.logLayout.setContext({ path: nextPath, repository: nextRepository });
    this.setWatchScope(nextRepository?.rootPath ?? null);
    if (contextChanged) {
      this.pendingRefresh = false;
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
    if (nextPath && this.active && this.isConnected) {
      this.subscribeWatchScope(nextPath);
    }
  }

  subscribeWatchScope(path) {
    if (this.watchUnsubscribe || !this.active) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          void this.requestRefresh();
        }
      },
      onChange: (change) => {
        if (change.gitRefsChanged) {
          void this.requestRefresh();
        }
      },
      onRecover: () => this.requestRefresh(),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  refresh() {
    return this.requestRefresh();
  }

  requestRefresh() {
    if (!this.active || !this.repository) {
      return Promise.resolve();
    }
    this.pendingRefresh = true;
    return this.refreshCoordinator.request();
  }

  async performPendingRefresh() {
    if (!this.active || !this.pendingRefresh) {
      this.pendingRefresh = false;
      return;
    }
    this.pendingRefresh = false;
    if (this.mode === "compare") {
      await this.comparePage.refresh();
    } else if (this.mode === "log") {
      await this.logLayout.refresh();
    }
  }

  setRefreshState(state) {
    this.refreshState = state === "refreshing"
      ? "refreshing"
      : this.watchUnavailable
        ? "unavailable"
        : "idle";
    this.renderChrome();
  }

  prepareRoute(route) {
    this.ensureRendered();
    const mode = routeMode(route);
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
    } else if (mode === "log") {
      this.setMode("log");
      this.logLayout.setContext({
        path: this.currentPath,
        repository: this.repository,
      });
      this.logLayout.prepareRoute(route);
    }
    this.emitStateChange();
  }

  async openRoute(route, options = {}) {
    this.prepareRoute(route);
    const mode = routeMode(route);
    if (!this.repository) {
      return null;
    }
    if (mode === "compare") {
      this.comparePage.setContext({
        path: this.currentPath,
        repository: this.repository,
        baseRef: route.baseRef || null,
        headRef: route.headRef || null,
      });
      const compare = options.forceRefresh
        ? await this.comparePage.refresh()
        : await this.comparePage.openCompare({
            path: this.currentPath,
            repository: this.repository,
            baseRef: route.baseRef || null,
            headRef: route.headRef || null,
            preserveViewer: Boolean(route.path),
          });
      if (!this.isCurrentActivation(options.activationGeneration)) {
        return null;
      }
      if (!route.path) {
        this.comparePage.showList();
        this.comparePage.setSelectedPath("");
        this.emitStateChange();
        return compare;
      }
      const fullPath = this.resolveRoutePath(route.path, options);
      const file = this.comparePage.fileForPath(fullPath);
      return fullPath
        ? await this.comparePage.openDiff(fullPath, file?.status ?? options.status ?? "")
        : null;
    }
    if (mode !== "log") {
      return null;
    }
    if (!route.sha) {
      const log = await this.logLayout.openList({
        path: this.currentPath,
        repository: this.repository,
        page: route.page ?? 1,
      });
      if (!this.isCurrentActivation(options.activationGeneration)) {
        return null;
      }
      this.emitStateChange();
      return log;
    }
    const commit = await this.logLayout.openCommit(route.sha, {
      path: this.currentPath,
      repository: this.repository,
      page: route.page,
      preserveViewer: Boolean(route.path),
    });
    if (!this.isCurrentActivation(options.activationGeneration)) {
      return null;
    }
    if (!route.path) {
      this.emitStateChange();
      return commit;
    }
    const fullPath = this.resolveRoutePath(route.path, options);
    const file = this.logLayout.findCommitFile(fullPath);
    return fullPath
      ? await this.logLayout.openCommitDiff(
          route.sha,
          fullPath,
          file?.status ?? options.status ?? "",
        )
      : null;
  }

  isCurrentActivation(generation) {
    return (
      this.active &&
      (generation === undefined || generation === this.activationGeneration)
    );
  }

  setRouteError(route, error) {
    this.prepareRoute(route);
    if (routeMode(route) === "compare") {
      this.comparePage.setError(error, this.repository);
    } else {
      this.logLayout.list.setError(error, this.repository);
    }
    this.emitStateChange();
  }

  resolveRoutePath(path, options = {}) {
    return typeof options.resolvePath === "function"
      ? options.resolvePath(path)
      : path;
  }

  routeForCloseFileViewerTarget(target) {
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
      return sha
        ? { kind: "log", page: this.logPage, sha, path: "" }
        : null;
    }
    return null;
  }

  routeForWorkspaceBack() {
    if (this.mode === "log" && this.logLayout.view === "detail") {
      return { kind: "log", page: this.logPage };
    }
    return null;
  }

  routeForCompareRefs(baseRef, headRef) {
    return { kind: "compare", baseRef, headRef, path: "" };
  }

  requestGitRoute(route, options = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-git-route", {
        bubbles: true,
        detail: { route, options },
      }),
    );
  }

  setMode(mode) {
    const nextMode = mode === "log" ? "log" : "compare";
    if (this.mode !== nextMode) {
      this.mode = nextMode;
      this.updateVisibleMode();
    }
  }

  updateVisibleMode() {
    this.dataset.gitMode = this.mode ?? "";
    if (this.compareView) {
      this.compareView.hidden = this.mode !== "compare";
      this.compareView.dataset.detailView = this.comparePage.detailView;
    }
    if (this.logView) {
      this.logView.hidden = this.mode !== "log";
      this.logView.dataset.logView = this.logLayout.view;
    }
  }

  renderChrome() {
    if (!this.rendered) {
      return;
    }
    const commit = this.mode === "log" && this.logLayout.view === "detail";
    const fileOpen =
      (this.mode === "compare" && this.comparePage.detailView === "viewer") ||
      (commit && this.logLayout.detailView === "viewer");
    this.titleEl.textContent = commit ? "Commit" : this.mode === "log" ? "Log" : "Compare";
    let subtitle = "";
    if (commit) {
      subtitle = this.logLayout.commitSubtitle();
    } else if (this.mode === "log") {
      subtitle = this.logLayout.logSubtitle();
    } else if (this.repository) {
      subtitle = `${this.repository.branch ?? "HEAD"}`;
    }
    this.subtitleEl.textContent = subtitle;
    this.subtitleEl.setAttribute("title", subtitle);
    this.backButton.hidden = !commit || fileOpen;
    this.backButton.setAttribute("aria-label", "Back to log");
    this.backButton.setAttribute("title", "Back to log");
    this.backButton.innerHTML = renderInlineIcon(
      "ArrowLeft",
      "Back to log",
      "task-domain-back-icon",
    );
    this.controls.setSnapshot({
      mode: this.mode,
      refs: this.mode === "compare" ? this.comparePage.refsPayload?.refs ?? [] : [],
      baseRef: this.mode === "compare" ? this.compareBaseRef : "",
      headRef: this.mode === "compare" ? this.compareHeadRef : "",
      refreshState: this.refreshState,
    });
  }

  isMobileDetailOpen() {
    return (
      (this.mode === "compare" && this.comparePage.detailView === "viewer") ||
      (this.mode === "log" && this.logLayout.view === "detail")
    );
  }

  emitStateChange() {
    this.updateVisibleMode();
    this.renderChrome();
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
}

customElements.define("caffold-task-git-layout", CaffoldTaskGitLayout);
