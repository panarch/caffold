import { getGitHubStatus } from "../../../api.js";
import "./(issues)/layout.js";
import "./(pulls)/layout.js";

class CaffoldGithubReviewLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <div class="github-review-view github-mode-issues" hidden>
        <caffold-github-issues-layout></caffold-github-issues-layout>
      </div>
      <div class="github-review-view github-mode-pulls" hidden>
        <caffold-github-pulls-layout></caffold-github-pulls-layout>
      </div>
    `;
    this.issuesView = this.querySelector(".github-mode-issues");
    this.pullsView = this.querySelector(".github-mode-pulls");
    this.issuesLayout = this.querySelector("caffold-github-issues-layout");
    this.pullsLayout = this.querySelector("caffold-github-pulls-layout");
    this.issuesLayout.ensureRendered();
    this.pullsLayout.ensureRendered();
    this.mode ??= null;
    this.currentPath ??= "";
    this.repository ??= null;
    this.githubStatus ??= null;
    this.githubStatusRequestId ??= 0;
    this.issuesLayout.addEventListener("caffold:github-issues-state-change", () => {
      this.emitStateChange();
    });
    this.addEventListener("caffold:open-github-issue", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "issues",
        page: this.issuesPage,
        number: event.detail.number,
      });
    });
    this.addEventListener("caffold:change-github-issues-page", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "issues",
        page: event.detail.page,
      });
    });
    this.addEventListener("caffold:close-github-issue-viewer", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "issues",
        page: this.issuesPage,
      });
    });
    this.pullsLayout.addEventListener("caffold:github-pulls-state-change", () => {
      this.emitStateChange();
    });
    this.addEventListener("caffold:open-github-pull", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "pulls",
        page: this.pullsPage,
        number: event.detail.number,
      });
    });
    this.addEventListener("caffold:change-github-pulls-page", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "pulls",
        page: event.detail.page,
      });
    });
    this.addEventListener("caffold:open-github-pull-files", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "pulls",
        page: this.pullsPage,
        number: event.detail.number,
        files: true,
        path: "",
      });
    });
    this.addEventListener("caffold:open-github-pull-file", (event) => {
      event.stopPropagation();
      const number = this.currentPullNumber();
      if (!number) {
        return;
      }

      this.requestGithubRoute(
        {
          kind: "pulls",
          page: this.pullsPage,
          number,
          files: true,
          path: event.detail.path,
        },
        {
          status: event.detail.status,
        },
      );
    });
    this.addEventListener("caffold:close-github-pull-viewer", (event) => {
      event.stopPropagation();
      this.requestGithubRoute({
        kind: "pulls",
        page: this.pullsPage,
      });
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      if (!this.isFileViewer(event.target)) {
        return;
      }

      event.stopPropagation();
      const number = this.currentPullNumber();
      if (!number) {
        return;
      }

      this.requestGithubRoute({
        kind: "pulls",
        page: this.pullsPage,
        number,
        files: true,
        path: "",
      });
    });
    this.updateVisibleMode();
  }

  reset() {
    this.ensureRendered();
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.githubStatus = null;
    this.githubStatusRequestId += 1;
    this.issuesLayout.reset();
    this.pullsLayout.reset();
    this.updateVisibleMode();
    this.emitStateChange();
  }

  setContext(options = {}) {
    this.ensureRendered();
    const { path, repository, githubStatus } = options;
    this.currentPath = path ?? this.currentPath ?? "";
    this.repository = repository ?? this.repository ?? null;
    this.githubStatus = Object.prototype.hasOwnProperty.call(options, "githubStatus")
      ? githubStatus
      : (this.githubStatus ?? null);
    const context = {
      path: this.currentPath,
      repository: this.repository,
      githubStatus: this.githubStatus,
    };
    this.issuesLayout.setContext(context);
    this.pullsLayout.setContext(context);
  }

  async setGithubStatus(status) {
    this.ensureRendered();
    this.githubStatus = status ?? null;
    this.setContext({ githubStatus: this.githubStatus });

    if (this.mode === "issues") {
      return await this.issuesLayout.setGithubStatus(this.githubStatus);
    }

    if (this.mode === "pulls") {
      return await this.pullsLayout.setGithubStatus(this.githubStatus);
    }

    this.emitStateChange();
    return null;
  }

  async loadStatus(path) {
    this.ensureRendered();
    if (!this.repository) {
      return null;
    }

    const nextPath = path ?? this.currentPath ?? "";
    const requestId = ++this.githubStatusRequestId;
    this.setContext({
      path: nextPath,
      githubStatus: null,
    });

    try {
      const status = await getGitHubStatus(nextPath);
      if (requestId !== this.githubStatusRequestId) {
        return null;
      }

      await this.setGithubStatus(status);
      return status;
    } catch (error) {
      if (requestId !== this.githubStatusRequestId) {
        return null;
      }

      const status = {
        available: false,
        repository: this.repository,
        github: null,
        ghAvailable: false,
        authenticated: false,
        issuesAvailable: false,
        pullsAvailable: false,
        message: error.message,
      };
      await this.setGithubStatus(status);
      return status;
    }
  }

  async ensureStatus(path) {
    this.ensureRendered();
    if (!this.repository) {
      return null;
    }

    if (this.githubStatus) {
      return this.githubStatus;
    }

    return await this.loadStatus(path ?? this.currentPath);
  }

  async openIssuesWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("issues");
    this.setContext(options);
    const issues = await this.issuesLayout.openList({
      path: this.currentPath,
      repository: this.repository,
      githubStatus: this.githubStatus,
      page: options.page ?? 1,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return issues;
  }

  async openIssue(number) {
    if (!this.repository) {
      return null;
    }

    this.setMode("issues");
    const issue = await this.issuesLayout.openIssue(number);
    this.emitStateChange();
    return issue;
  }

  async changeIssuesPage(page) {
    if (this.mode !== "issues") {
      return null;
    }

    return await this.issuesLayout.changePage(page);
  }

  async openPullsWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("pulls");
    this.setContext(options);
    const pulls = await this.pullsLayout.openList({
      path: this.currentPath,
      repository: this.repository,
      githubStatus: this.githubStatus,
      page: options.page ?? 1,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return pulls;
  }

  async openPull(number, options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("pulls");
    const pull = await this.pullsLayout.openPull(number, options);
    this.emitStateChange();
    return pull;
  }

  async openPullFiles(number, options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("pulls");
    const files = await this.pullsLayout.openFiles(number, options);
    this.emitStateChange();
    return files;
  }

  async openPullFile(path, status = "") {
    if (!path) {
      return null;
    }

    this.setMode("pulls");
    const file = await this.pullsLayout.openFile(path, status);
    this.emitStateChange();
    return file;
  }

  async changePullsPage(page) {
    if (this.mode !== "pulls" || this.pullsLayout.view !== "list") {
      return null;
    }

    return await this.pullsLayout.changePage(page);
  }

  async openRoute(route, options = {}) {
    if (route.kind === "issues") {
      const issues = await this.openIssuesWorkspace({
        page: route.page,
        skipReload: options.skipReload,
      });
      if (route.number) {
        return await this.openIssue(route.number);
      }

      return issues;
    }

    if (route.kind !== "pulls") {
      return null;
    }

    if (!route.number) {
      return await this.openPullsWorkspace({
        page: route.page,
        skipReload: options.skipReload,
      });
    }

    if (route.files) {
      const files = await this.openPullFiles(route.number, {
        page: route.page,
        preserveViewer: Boolean(route.path),
        skipReload: options.skipReload,
      });
      if (!route.path) {
        this.showPullFilesList();
        return files;
      }

      const fullPath =
        typeof options.resolvePath === "function" ? options.resolvePath(route.path) : route.path;
      if (!fullPath) {
        return null;
      }

      const file = this.findPullFile(fullPath);
      return await this.openPullFile(fullPath, file?.status ?? options.status ?? "");
    }

    return await this.openPull(route.number, { page: route.page });
  }

  backToList() {
    let changed = false;

    if (this.issuesLayout.backToList()) {
      changed = true;
    }

    if (this.pullsLayout.backToList()) {
      changed = true;
    }

    if (changed) {
      this.emitStateChange();
    }

    return changed;
  }

  showPullFilesList() {
    this.pullsLayout.showFilesList();
    this.emitStateChange();
  }

  setView(view) {
    if (view !== "list") {
      return;
    }

    this.backToList();
  }

  canReuseIssuesRoute(route) {
    return this.mode === "issues" && this.issuesLayout.canReuseRoute(route.page);
  }

  canReusePullsRoute(route) {
    if (this.mode !== "pulls") {
      return false;
    }

    if (!route.number) {
      return this.pullsLayout.canReuseList(route.page);
    }

    if (route.files) {
      return this.pullsLayout.canReuseFiles(route.number);
    }

    return this.pullsLayout.selectedPullSummary?.number === route.number;
  }

  canReuseRoute(route) {
    if (route.kind === "issues") {
      return this.canReuseIssuesRoute(route);
    }

    if (route.kind === "pulls") {
      return this.canReusePullsRoute(route);
    }

    return false;
  }

  canReusePullFiles(number) {
    return this.mode === "pulls" && this.pullsLayout.canReuseFiles(number);
  }

  findPullFile(path) {
    return this.pullsLayout.findFile(path);
  }

  currentPullNumber() {
    return this.pullsLayout.currentPullNumber();
  }

  isFileViewer(target) {
    return this.pullsLayout.isFileViewer(target);
  }

  reviewPanelForTarget(target) {
    if (target === "pulls") {
      return this.querySelector("caffold-github-pull-files-page");
    }

    return null;
  }

  isMobileDetailOpen() {
    return (
      (this.mode === "issues" && this.issuesLayout.dataset.issuesView === "detail") ||
      (this.mode === "pulls" &&
        (this.pullsLayout.dataset.pullsView === "detail" ||
          (this.pullsLayout.dataset.pullsView === "files" &&
            this.pullsLayout.filesPage?.dataset.detailView === "viewer")))
    );
  }

  routeForAction(action) {
    if (action === "pulls") {
      return {
        kind: "pulls",
        page: this.pullsPage,
      };
    }

    return {
      kind: "issues",
      page: this.issuesPage,
    };
  }

  routeForWorkspaceBack() {
    if (this.mode === "issues" && this.issuesLayout.view === "detail") {
      return {
        kind: "issues",
        page: this.issuesPage,
      };
    }

    if (this.mode === "pulls" && this.pullsLayout.view === "detail") {
      return {
        kind: "pulls",
        page: this.pullsPage,
      };
    }

    if (this.mode === "pulls" && this.pullsLayout.view === "files") {
      const number = this.currentPullNumber();
      if (!number) {
        return null;
      }

      return {
        kind: "pulls",
        page: this.pullsPage,
        number,
      };
    }

    return null;
  }

  requestGithubRoute(route, options = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-github-route", {
        bubbles: true,
        detail: {
          route,
          options,
        },
      }),
    );
  }

  details() {
    if (this.mode === "issues" && this.issuesLayout.view === "detail") {
      return {
        title: "Issue",
        subtitle: this.issuesLayout.issueSubtitle(),
        backVisible: true,
        backLabel: "Back to issues",
      };
    }

    if (this.mode === "issues") {
      return {
        title: "Issues",
        subtitle: this.issuesLayout.issuesSubtitle(),
        backVisible: false,
      };
    }

    if (this.mode === "pulls" && this.pullsLayout.view === "detail") {
      return {
        title: "PR",
        subtitle: this.pullsLayout.pullSubtitle(),
        backVisible: true,
        backLabel: "Back to pull requests",
      };
    }

    if (this.mode === "pulls" && this.pullsLayout.view === "files") {
      return {
        title: "PR Files",
        subtitle: this.pullsLayout.pullSubtitle(),
        backVisible: true,
        backLabel: "Back to PR",
      };
    }

    if (this.mode === "pulls") {
      return {
        title: "Pull Requests",
        subtitle: this.pullsLayout.pullsSubtitle(),
        backVisible: false,
      };
    }

    return {
      title: "GitHub",
      subtitle: "",
      backVisible: false,
    };
  }

  get issuesPage() {
    return this.issuesLayout.page;
  }

  get pullsPage() {
    return this.pullsLayout.page;
  }

  get activeMode() {
    return this.mode;
  }

  setMode(mode) {
    const nextMode = normalizeGithubMode(mode);
    if (this.mode === nextMode) {
      return;
    }

    this.mode = nextMode;
    this.updateVisibleMode();
  }

  updateVisibleMode() {
    this.dataset.githubMode = this.mode ?? "";
    if (this.issuesView) {
      this.issuesView.hidden = this.mode !== "issues";
      this.issuesView.dataset.issuesView = this.issuesLayout.view;
    }
    if (this.pullsView) {
      this.pullsView.hidden = this.mode !== "pulls";
      this.pullsView.dataset.pullsView = this.pullsLayout.view;
      this.pullsView.dataset.filesView = this.pullsLayout.filesView;
    }
  }

  emitStateChange() {
    this.updateVisibleMode();
    this.dispatchEvent(
      new CustomEvent("caffold:github-review-state-change", {
        bubbles: true,
        detail: {
          mode: this.mode,
          detailOpen: this.isMobileDetailOpen(),
        },
      }),
    );
  }
}

customElements.define("caffold-github-review-layout", CaffoldGithubReviewLayout);

function normalizeGithubMode(mode) {
  return mode === "pulls" ? "pulls" : "issues";
}
