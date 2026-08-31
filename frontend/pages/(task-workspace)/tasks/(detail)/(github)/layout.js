import { getGitHubStatus } from "../../../../../api.js";
import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import { routeMode } from "../../../../../navigation-routes.js";
import "./components/task-start-dialog.js";
import "./(issues)/layout.js";
import "./(pulls)/layout.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../action-hints.js";

class CaffoldTaskGithubLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
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
    this.innerHTML = `
      <section class="task-github-surface" aria-label="GitHub">
        <header class="task-domain-header">
          <button type="button" class="task-domain-back" data-action="domain-back" hidden></button>
          <div class="task-domain-title">
            <h2>GitHub</h2>
            <span class="task-domain-subtitle"></span>
          </div>
        </header>
        <div class="task-domain-body">
          <div class="github-review-view github-mode-issues" hidden>
            <caffold-github-issues-layout></caffold-github-issues-layout>
          </div>
          <div class="github-review-view github-mode-pulls" hidden>
            <caffold-github-pulls-layout></caffold-github-pulls-layout>
          </div>
        </div>
      </section>
      <caffold-github-task-start-dialog></caffold-github-task-start-dialog>
    `;
    this.backButton = this.querySelector(".task-domain-back");
    this.titleEl = this.querySelector(".task-domain-title h2");
    this.subtitleEl = this.querySelector(".task-domain-subtitle");
    this.issuesView = this.querySelector(".github-mode-issues");
    this.pullsView = this.querySelector(".github-mode-pulls");
    this.issuesLayout = this.querySelector("caffold-github-issues-layout");
    this.pullsLayout = this.querySelector("caffold-github-pulls-layout");
    this.taskStartDialog = this.querySelector("caffold-github-task-start-dialog");
    this.issuesLayout.ensureRendered();
    this.pullsLayout.ensureRendered();
    this.backButton.addEventListener("click", () => {
      const route = this.routeForWorkspaceBack();
      if (route) {
        this.requestGithubRoute(route);
      }
    });
    this.mode ??= null;
    this.active ??= false;
    this.activationGeneration ??= 0;
    this.currentPath ??= "";
    this.repository ??= null;
    this.composerSettings ??= null;
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
    this.pullsLayout.addEventListener("caffold:github-pulls-state-change", () => {
      this.emitStateChange();
    });
    this.addEventListener("caffold:start-github-task", (event) => {
      if (
        event.target !== this.issuesLayout.detailPage &&
        event.target !== this.pullsLayout.detailPage
      ) {
        return;
      }
      event.stopPropagation();
      this.taskStartDialog.open({
        kind: event.detail?.kind,
        payload: event.detail?.payload,
        repository: this.repository,
        composerSettings: this.composerSettings,
        opener: event.detail?.opener,
      });
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
    this.boundIconsReady = () => this.renderChrome();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  reset() {
    this.ensureRendered();
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.composerSettings = null;
    this.githubStatus = null;
    this.githubStatusRequestId += 1;
    this.taskStartDialog.deactivate();
    this.issuesLayout.reset();
    this.pullsLayout.reset();
    this.updateVisibleMode();
    this.emitStateChange();
  }

  async activate(route, options = {}) {
    this.ensureRendered();
    this.active = true;
    const generation = ++this.activationGeneration;
    this.githubStatusRequestId += 1;
    this.taskStartDialog.deactivate();
    this.issuesLayout.invalidateRequests();
    this.pullsLayout.invalidateRequests();
    this.setContext({ ...options.context, githubStatus: null });
    const result = await this.openRoute(route, {
      ...options.routeOptions,
      activationGeneration: generation,
      skipReload: false,
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
    this.githubStatusRequestId += 1;
    this.taskStartDialog.deactivate();
    this.issuesLayout.invalidateRequests();
    this.pullsLayout.invalidateRequests();
  }

  setContext(options = {}) {
    this.ensureRendered();
    const { path, repository, githubStatus } = options;
    this.currentPath = path ?? this.currentPath ?? "";
    this.repository = repository ?? this.repository ?? null;
    if (Object.hasOwn(options, "composerSettings")) {
      this.composerSettings = options.composerSettings ?? null;
      this.taskStartDialog.setComposerSettings(this.composerSettings);
    }
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

  async applyRepositoryContext({ path, repository } = {}) {
    this.setContext({ path, repository, githubStatus: null });
    return await this.loadStatus(path ?? this.currentPath);
  }

  async setGithubStatus(status) {
    this.ensureRendered();
    this.githubStatus = status ?? null;
    this.setContext({ githubStatus: this.githubStatus });

    if (this.mode === "issues") {
      this.issuesLayout.setGithubStatus(this.githubStatus);
      this.emitStateChange();
      return null;
    }

    if (this.mode === "pulls") {
      this.pullsLayout.setGithubStatus(this.githubStatus);
      this.emitStateChange();
      return null;
    }

    this.emitStateChange();
    return null;
  }

  async loadStatus(path) {
    this.ensureRendered();
    if (!this.active || !this.repository) {
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
      if (!this.active || requestId !== this.githubStatusRequestId) {
        return null;
      }

      await this.setGithubStatus(status);
      return status;
    } catch (error) {
      if (!this.active || requestId !== this.githubStatusRequestId) {
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

  async openIssue(number, options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("issues");
    const issue = await this.issuesLayout.openIssue(number, options);
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
    this.prepareRoute(route);
    const status = await this.ensureStatus(this.currentPath);
    if (!this.isCurrentActivation(options.activationGeneration)) {
      return null;
    }
    this.setContext({ githubStatus: status });
    const result = await this.openRouteContent(route, options);
    return result;
  }

  setRouteError(route, error) {
    this.prepareRoute(route);
    const mode = routeMode(route);
    if (mode === "issues") {
      this.issuesLayout.setRouteError(route, error);
    } else if (mode === "pulls") {
      this.pullsLayout.setRouteError(route, error);
    }
    this.emitStateChange();
  }

  prepareRoute(route) {
    this.ensureRendered();
    const mode = routeMode(route);
    if (mode === "issues") {
      this.setMode("issues");
      this.issuesLayout.prepareRoute(route);
      this.emitStateChange();
      return;
    }

    if (mode === "pulls") {
      this.setMode("pulls");
      this.pullsLayout.prepareRoute(route);
      this.emitStateChange();
    }
  }

  async openRouteContent(route, options = {}) {
    const mode = routeMode(route);
    if (mode === "issues") {
      if (route.number) {
        return await this.openIssue(route.number, { page: route.page });
      }

      return await this.openIssuesWorkspace({
        page: route.page,
        skipReload: options.skipReload,
      });
    }

    if (mode !== "pulls") {
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
        skipReload: options.skipReload || this.canReusePullFiles(route.number),
      });
      if (!this.isCurrentActivation(options.activationGeneration)) {
        return null;
      }
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

  isCurrentActivation(generation) {
    return (
      this.active &&
      (generation === undefined || generation === this.activationGeneration)
    );
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
    const mode = routeMode(route);
    if (mode === "issues") {
      return this.canReuseIssuesRoute(route);
    }

    if (mode === "pulls") {
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

  routeForActiveMode() {
    if (this.activeMode === "pulls") {
      return {
        kind: "pulls",
        page: 1,
      };
    }

    return {
      kind: "issues",
      page: 1,
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

  actionHintScope() {
    this.ensureRendered();
    if (!this.active || this.hidden || !this.mode) {
      return emptyActionHintScope();
    }
    const scopeId = `github:${encodeURIComponent(
      this.repository?.rootPath || this.currentPath || "repository",
    )}`;
    const body = this.querySelector(
      ":scope > .task-github-surface > .task-domain-body",
    );
    const backAvailable = this.backButton && !this.backButton.hidden &&
      !this.backButton.disabled;
    const parentKey = backAvailable
      ? githubParentKey(this.routeForWorkspaceBack())
      : "";
    const back = backAvailable && parentKey
      ? {
          targets: [buttonActionHintTarget({
            id: `${scopeId}:parent:${parentKey}`,
            actionId: ACTION_HINT_ACTION.PARENT,
            label: this.backButton.getAttribute("aria-label") || "Back",
            control: this.backButton,
            clipRoots: [this],
            isActionable: () =>
              this.isConnected &&
              this.active &&
              !this.hidden &&
              githubParentKey(this.routeForWorkspaceBack()) === parentKey &&
              this.backButton === this.querySelector(
                ':scope > .task-github-surface > .task-domain-header > .task-domain-back[data-action="domain-back"]',
              ) &&
              !this.backButton.hidden &&
              !this.backButton.disabled,
          })],
          mutationRoots: [this.backButton],
          scrollRoots: [],
        }
      : null;
    const activeChild = this.mode === "issues"
      ? this.issuesLayout.actionHintScope({
          scopeId: `${scopeId}:issues`,
          clipRoots: [this, body].filter(Boolean),
        })
      : this.pullsLayout.actionHintScope({
          scopeId: `${scopeId}:pulls`,
          clipRoots: [this, body].filter(Boolean),
        });
    return mergeActionHintScopes(back, activeChild);
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
    this.dataset.mobileDetail = this.isMobileDetailOpen() ? "true" : "false";
  }

  emitStateChange() {
    this.updateVisibleMode();
    this.renderChrome();
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

  renderChrome() {
    if (!this.rendered) {
      return;
    }
    const details = this.details();
    const fileOpen =
      this.mode === "pulls" &&
      this.pullsLayout.view === "files" &&
      this.pullsLayout.filesPage?.detailView === "viewer";
    this.titleEl.textContent = details.title;
    this.subtitleEl.textContent = details.subtitle ?? "";
    this.backButton.hidden = !details.backVisible || fileOpen;
    this.backButton.setAttribute("aria-label", details.backLabel ?? "Back");
    this.backButton.setAttribute("title", details.backLabel ?? "Back");
    this.backButton.innerHTML = renderInlineIcon(
      "ArrowLeft",
      details.backLabel ?? "Back",
      "task-domain-back-icon",
    );
  }
}

customElements.define("caffold-task-github-layout", CaffoldTaskGithubLayout);

function normalizeGithubMode(mode) {
  return mode === "pulls" ? "pulls" : "issues";
}

function githubParentKey(route) {
  if (!route?.kind) {
    return "";
  }
  if (route.kind === "pulls" && route.number) {
    return `pull:${encodeURIComponent(route.number)}`;
  }
  return `${route.kind}`;
}
