import { getCodexStatus, getHealth, openProject } from "../api.js";
import { parentRoute, parseRoute, routeEquals, routeUrl } from "../navigation-routes.js";
import "./components/pathbar.js";
import "./components/project-switcher.js";
import "./components/header-actions.js";
import "./files/page.js";
import "./(review-workspace)/(git)/layout.js";
import "./(review-workspace)/(github)/layout.js";
import "./(review-workspace)/layout.js";

const LAST_DIRECTORY_KEY_PREFIX = "caffold:last-directory-path";

class CaffoldAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.codexStatusRequestId = 0;
    this.codexStatus = null;
    this.workspaceMode = null;
    this.currentRoute = null;
    this.isApplyingRoute = false;
    this.render();
    this.filesPage = this.querySelector("caffold-files-page");
    this.filesPage.ensureRendered();
    this.pathbar = this.querySelector("caffold-pathbar");
    this.projectSwitcher = this.querySelector("caffold-project-switcher");
    this.headerActions = this.querySelector("caffold-header-actions");
    this.reviewWorkspace = this.querySelector("caffold-review-workspace");
    this.reviewWorkspace.ensureRendered();
    this.gitLayout = this.reviewWorkspace.querySelector("caffold-git-review-layout");
    this.gitLayout.ensureRendered();
    this.githubLayout = this.reviewWorkspace.querySelector("caffold-github-review-layout");
    this.githubLayout.ensureRendered();
    this.loadCodexStatus();

    this.installNavigationHandlers();

    this.addEventListener("caffold:navigate", (event) => {
      this.navigateToFileRoute(event.detail.path) || this.loadDirectory(event.detail.path);
    });
    this.addEventListener("caffold:open-directory", (event) => {
      this.navigateToFileRoute(event.detail.path) || this.loadDirectory(event.detail.path);
    });
    this.addEventListener("caffold:open-file", (event) => {
      this.navigateToFileRoute(event.detail.path) ||
        this.openFile(event.detail.path, event.detail.entry);
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      this.closeFileViewer(event);
    });
    this.addEventListener("caffold:open-diff-workspace", () => {
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("diff"));
    });
    this.addEventListener("caffold:open-log-workspace", () => {
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("log"));
    });
    this.addEventListener("caffold:open-compare-workspace", () => {
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("compare"));
    });
    this.addEventListener("caffold:open-github-issues-workspace", () => {
      this.navigateOrOpenGithubRoute(this.githubLayout.routeForAction("issues"));
    });
    this.addEventListener("caffold:open-github-pulls-workspace", () => {
      this.navigateOrOpenGithubRoute(this.githubLayout.routeForAction("pulls"));
    });
    this.addEventListener("caffold:close-review-workspace", () => {
      this.navigateToReviewParent({ closeWorkspace: true }) || this.closeReviewWorkspace();
    });
    this.addEventListener("caffold:back-review-workspace", () => {
      this.navigateToWorkspaceBackRoute() || this.navigateToReviewParent();
    });
    this.addEventListener("caffold:request-git-route", (event) => {
      this.navigateOrOpenGitRoute(event.detail.route, event.detail.options);
    });
    this.addEventListener("caffold:change-compare-refs", (event) => {
      this.navigateOrOpenGitRoute(
        this.gitLayout.routeForCompareRefs(event.detail.baseRef, event.detail.headRef),
      );
    });
    this.addEventListener("caffold:git-review-state-change", () => {
      if (this.workspaceMode === "git") {
        if (this.gitLayout.repository) {
          this.gitRepository = this.gitLayout.repository;
        }
        this.updateGitButton();
        this.updateWorkspaceChrome();
      }
    });
    this.addEventListener("caffold:request-github-route", (event) => {
      this.navigateOrOpenGithubRoute(event.detail.route, event.detail.options);
    });
    this.addEventListener("caffold:github-review-state-change", () => {
      if (this.gitRepository) {
        this.headerActions.githubStatus = this.githubStatus;
      }
      if (this.workspaceMode === "github") {
        this.updateWorkspaceChrome();
      }
    });
    this.addEventListener("caffold:project-selected", (event) => {
      this.openProjectRoute(event.detail.project);
    });
    this.bootstrap();
  }

  get currentPath() {
    return this.filesPage?.currentPath ?? "";
  }

  get githubStatus() {
    return this.githubLayout?.githubStatus ?? null;
  }

  get gitStatus() {
    return this.gitLayout?.gitStatus ?? null;
  }

  render() {
    this.innerHTML = `
      <header class="app-header">
        <div class="app-context">
          <div class="brand" aria-label="Caffold">
            <img class="brand-mark" src="/assets/icons/caffold-mark.svg" alt="" />
            <strong class="brand-name">Caffold</strong>
          </div>
          <caffold-project-switcher></caffold-project-switcher>
          <caffold-header-actions></caffold-header-actions>
        </div>
      </header>
      <caffold-pathbar></caffold-pathbar>
      <main class="app-main" aria-label="File browser">
        <caffold-files-page></caffold-files-page>
      </main>
      <caffold-review-workspace hidden></caffold-review-workspace>
    `;
  }

  installNavigationHandlers() {
    this.usesNavigationApi =
      "navigation" in window &&
      typeof window.navigation?.addEventListener === "function" &&
      typeof window.navigation?.navigate === "function";

    if (this.usesNavigationApi) {
      window.navigation.addEventListener("navigate", (event) => {
        if (!event.canIntercept || event.hashChange || event.downloadRequest) {
          return;
        }

        const destination = new URL(event.destination.url);
        if (destination.origin !== window.location.origin) {
          return;
        }

        const route = parseRoute(destination.href);
        if (!route) {
          return;
        }

        event.intercept({
          handler: async () => {
            if (this.currentRoute && routeEquals(this.currentRoute, route)) {
              return;
            }

            await this.applyRoute(route);
          },
        });
      });
      window.navigation.addEventListener("currententrychange", () => {
        const route = parseRoute(window.location.href);
        if (!route || (this.currentRoute && routeEquals(this.currentRoute, route))) {
          return;
        }

        this.applyRoute(route);
      });
      return;
    }

    window.addEventListener("popstate", () => {
      const route = parseRoute(window.location.href);
      if (route) {
        this.applyRoute(route);
      }
    });
  }

  async bootstrap() {
    try {
      const health = await getHealth();
      this.filesPage.setStorageKey(`${LAST_DIRECTORY_KEY_PREFIX}:${health.root}`);
      this.pathbar.homePath = health.homePath ?? null;
      const initialRoute = parseRoute(window.location.href);
      if (initialRoute) {
        await this.applyRoute(initialRoute);
        return;
      }

      const fallbackPath = health.initialPath ?? "";
      const initialPath = this.filesPage.loadStoredDirectoryPath() ?? fallbackPath;
      await this.loadDirectory(initialPath, { fallbackPath });
      this.replaceWithCurrentProjectFileRoute();
    } catch (error) {
      this.filesPage.setError(error);
    }
  }

  navigateToRoute(route, options = {}) {
    if (!route) {
      return false;
    }

    if (this.currentRoute && routeEquals(this.currentRoute, route)) {
      this.applyRoute(route);
      return true;
    }

    const url = routeUrl(route);
    if (this.usesNavigationApi) {
      this.currentRoute = route;
      window.navigation.navigate(url, {
        history: options.replace ? "replace" : "push",
      });
      this.applyRoute(route);
      return true;
    }

    const state = { caffoldRoute: route };
    if (options.replace) {
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
    this.applyRoute(route);
    return true;
  }

  replaceRoute(route) {
    if (!route) {
      return;
    }

    this.currentRoute = route;
    window.history.replaceState({ caffoldRoute: route }, "", routeUrl(route));
  }

  async applyRoute(route) {
    this.isApplyingRoute = true;
    this.currentRoute = route;
    try {
      const project = await this.openProjectForRoute(route.projectId);
      if (!project) {
        return false;
      }

      if (route.kind === "files") {
        await this.applyFilesRoute(project, route);
      } else if (route.kind === "diff" || route.kind === "compare" || route.kind === "log") {
        await this.applyGitRoute(project, route);
      } else if (route.kind === "issues" || route.kind === "pulls") {
        await this.applyGithubRoute(project, route);
      }

      return true;
    } catch (error) {
      this.filesPage.setError(error);
      return false;
    } finally {
      this.isApplyingRoute = false;
    }
  }

  async openProjectForRoute(projectId) {
    if (!projectId) {
      return null;
    }

    const project = await openProject(projectId);
    this.projectSwitcher.setCurrentProject(project);
    return project;
  }

  async applyFilesRoute(project, route) {
    this.closeReviewWorkspace();
    if (!route.path) {
      await this.loadDirectory(project.relativePath);
      this.showFileList();
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    const loadedEntry = this.filesPage.entryForPath(fullPath);
    if (loadedEntry && loadedEntry.kind !== "directory") {
      await this.openFile(fullPath, loadedEntry);
      return;
    }

    if (await this.loadDirectory(fullPath, { allowFailure: true })) {
      return;
    }

    const parent = this.projectPath(project, parentPath(route.path));
    const openedParent = await this.loadDirectory(parent, {
      fallbackPath: project.relativePath,
    });
    if (openedParent) {
      await this.openFile(fullPath);
    }
  }

  async applyGitRoute(project, route) {
    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    await this.openGitRoute(route, {
      resolvePath: (path) => this.projectPath(project, path),
      skipReload: this.canApplyLoadedGitRoute(project, route),
    });
  }

  async applyGithubRoute(project, route) {
    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    await this.openGithubRoute(route, {
      resolvePath: (path) => this.projectPath(project, path),
      skipReload: this.canApplyLoadedGithubRoute(project, route),
    });
  }

  navigateToFileRoute(path) {
    const routePath = this.projectRelativePath(path);
    if (routePath === null) {
      return false;
    }

    return this.navigateToCurrentProjectRoute({
      kind: "files",
      path: routePath,
    });
  }

  navigateToCurrentProjectRoute(route) {
    if (!this.projectSwitcher.currentProjectId) {
      return false;
    }

    return this.navigateToRoute({
      ...route,
      projectId: this.projectSwitcher.currentProjectId,
    });
  }

  navigateOrOpenGitRoute(route, options = {}) {
    const { fallbackRoute, ...openOptions } = options;
    const navigationRoute = this.projectRouteForReviewRoute(route);
    return (
      (navigationRoute && this.navigateToCurrentProjectRoute(navigationRoute)) ||
      this.openGitRoute(fallbackRoute ?? route, openOptions)
    );
  }

  navigateOrOpenGithubRoute(route, options = {}) {
    const { fallbackRoute, ...openOptions } = options;
    const navigationRoute = this.projectRouteForReviewRoute(route);
    return (
      (navigationRoute && this.navigateToCurrentProjectRoute(navigationRoute)) ||
      this.openGithubRoute(fallbackRoute ?? route, openOptions)
    );
  }

  projectRouteForReviewRoute(route) {
    if (!route) {
      return null;
    }

    if (!Object.prototype.hasOwnProperty.call(route, "path") || !route.path) {
      return route;
    }

    const path = this.projectRelativePath(route.path);
    if (path === null) {
      return null;
    }

    return {
      ...route,
      path,
    };
  }

  navigateToWorkspaceBackRoute() {
    if (this.workspaceMode === "git") {
      const route = this.gitLayout.routeForWorkspaceBack();
      return route ? this.navigateOrOpenGitRoute(route) : false;
    }

    if (this.workspaceMode === "github") {
      const route = this.githubLayout.routeForWorkspaceBack();
      return route ? this.navigateOrOpenGithubRoute(route) : false;
    }

    return false;
  }

  navigateToReviewParent(options = {}) {
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    if (!currentRoute) {
      if (options.closeWorkspace) {
        return this.navigateToCurrentProjectRoute({ kind: "files", path: "" });
      }
      return false;
    }

    const parent = options.closeWorkspace
      ? { kind: "files", projectId: currentRoute.projectId, path: "" }
      : parentRoute(currentRoute);
    return parent ? this.navigateToRoute(parent) : false;
  }

  replaceWithCurrentProjectFileRoute() {
    const routePath = this.projectRelativePath(this.currentPath);
    if (!this.projectSwitcher.currentProjectId || routePath === null) {
      return;
    }

    this.replaceRoute({
      kind: "files",
      projectId: this.projectSwitcher.currentProjectId,
      path: routePath,
    });
  }

  async loadDirectory(path, options = {}) {
    if (!this.isApplyingRoute && !options.preserveRoute) {
      this.currentRoute = null;
    }
    this.pathbar.path = path ?? "";
    const directory = await this.filesPage.loadDirectory(path, options);
    this.pathbar.path = this.currentPath;
    if (directory === null) {
      return false;
    }

    if (directory) {
      this.pathbar.path = directory.path;
      this.updateGitContext(directory);
      await this.refreshProjects(directory.path);
      return directory;
    }

    if (options.allowFailure) {
      return false;
    }

    this.clearGitContext();
    this.projectSwitcher.clearContext({ error: this.filesPage.lastError });
    return false;
  }

  async openFile(path, entry = null) {
    this.gitLayout.setSelectedPath("");
    return await this.filesPage.openFile(path, entry);
  }

  showFileList() {
    this.filesPage.showList();
  }

  closeFileViewer(event) {
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    if (this.filesPage.isFileViewer(event.target)) {
      if (currentRoute?.kind === "files" && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showFileList();
      return;
    }
  }

  async openGitRoute(route, options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    if (route.path || (route.kind === "log" && route.sha)) {
      this.filesPage.clearSelectedFile();
    }
    this.workspaceMode = "git";
    this.gitLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
    });
    const routePromise = this.gitLayout.openRoute(route, {
      kind: options.kind,
      resolvePath: options.resolvePath,
      skipReload: options.skipReload,
      status: options.status,
    });
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
    const result = await routePromise;
    this.updateWorkspaceChrome();
    return result;
  }

  async refreshProjects(path = this.currentPath) {
    return await this.projectSwitcher.refresh(path);
  }

  currentProject() {
    return this.projectSwitcher.currentProject();
  }

  projectPath(project, path = "") {
    const rootPath = cleanPath(project?.relativePath ?? "");
    const relativePath = cleanPath(path);
    if (!relativePath) {
      return rootPath;
    }

    return rootPath ? `${rootPath}/${relativePath}` : relativePath;
  }

  projectRelativePath(path) {
    const project = this.currentProject();
    if (!project) {
      return null;
    }

    const rootPath = cleanPath(project.relativePath ?? "");
    const fullPath = cleanPath(path ?? "");
    if (!rootPath) {
      return fullPath;
    }
    if (fullPath === rootPath) {
      return "";
    }
    if (fullPath.startsWith(`${rootPath}/`)) {
      return fullPath.slice(rootPath.length + 1);
    }

    return null;
  }

  isProjectRootLoaded(project) {
    return cleanPath(this.currentPath) === cleanPath(project?.relativePath ?? "");
  }

  async ensureProjectRootLoaded(project) {
    if (this.isProjectRootLoaded(project)) {
      return true;
    }

    return await this.loadDirectory(project.relativePath);
  }

  canApplyLoadedGitRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      this.workspaceMode !== "git" ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.gitLayout.canReuseRoute(route);
  }

  canApplyLoadedGithubRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      this.workspaceMode !== "github" ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.githubLayout.canReuseRoute(route);
  }

  async ensureGithubStatus() {
    if (!this.gitRepository) {
      return null;
    }

    this.githubLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
    });
    return await this.githubLayout.ensureStatus(this.currentPath);
  }

  async openProjectRoute(project) {
    if (!project?.id) {
      return;
    }

    this.navigateToRoute({
      kind: "files",
      projectId: project.id,
      path: "",
    }) || (await this.loadDirectory(project.relativePath));
  }

  async loadCodexStatus() {
    const requestId = ++this.codexStatusRequestId;

    try {
      const status = await getCodexStatus();
      if (requestId !== this.codexStatusRequestId) {
        return;
      }

      this.codexStatus = status;
      this.headerActions.codexStatus = status;
    } catch (error) {
      if (requestId !== this.codexStatusRequestId) {
        return;
      }

      const status = {
        available: false,
        codexCliAvailable: null,
        appServerAvailable: null,
        message: error.message,
      };
      this.codexStatus = status;
      this.headerActions.codexStatus = status;
    }
  }

  updateGitContext(directory) {
    if (!directory.git) {
      this.clearGitContext();
      return;
    }

    this.gitRepository = directory.git;
    this.headerActions.gitStatus = {
      available: true,
      branch: directory.git.branch,
      dirty: directory.git.dirty,
      count: null,
    };
    this.headerActions.githubStatus = null;
    this.gitLayout.setContext({
      path: directory.path,
      repository: directory.git,
    });
    this.githubLayout.setContext({
      path: directory.path,
      repository: directory.git,
      githubStatus: null,
    });
    this.loadGitStatus(directory.path);
    this.loadGithubStatus(directory.path);
    if (this.workspaceMode === "git") {
      if (this.gitLayout.activeMode === "log") {
        this.openGitRoute({
          kind: "log",
          page: 1,
        });
      } else if (this.gitLayout.activeMode === "compare") {
        this.openGitRoute({
          kind: "compare",
          path: "",
        });
      } else {
        this.openGitRoute({
          kind: "diff",
          path: "",
        });
      }
    } else if (this.workspaceMode === "github") {
      if (this.githubLayout.activeMode === "pulls") {
        this.openGithubRoute({
          kind: "pulls",
          page: 1,
        });
      } else {
        this.openGithubRoute({
          kind: "issues",
          page: 1,
        });
      }
    }
    this.updateWorkspaceChrome();
  }

  clearGitContext() {
    this.gitRepository = null;
    this.headerActions.gitStatus = {
      available: false,
      message: "Not a Git repository",
    };
    this.headerActions.githubStatus = {
      available: false,
      message: "No GitHub repository context",
    };
    this.gitLayout.reset();
    this.githubLayout.reset();
    this.closeReviewWorkspace();
  }

  async loadGitStatus(path) {
    if (!this.gitRepository) {
      return null;
    }

    this.gitLayout.setContext({
      path,
      repository: this.gitRepository,
    });
    const status = await this.gitLayout.loadStatus(path);
    if (status?.repository) {
      this.gitRepository = status.repository;
    }
    this.updateGitButton();
    this.updateWorkspaceChrome();
    return status;
  }

  async loadGithubStatus(path) {
    if (!this.gitRepository) {
      return null;
    }

    this.githubLayout.setContext({
      path,
      repository: this.gitRepository,
    });
    const status = await this.githubLayout.loadStatus(path);
    this.headerActions.githubStatus = this.githubStatus;
    if (this.workspaceMode === "github") {
      this.updateWorkspaceChrome();
    }
    return status;
  }

  async openGithubRoute(route, options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    const needsStatus = Boolean(route.number);
    const status = needsStatus ? await this.ensureGithubStatus() : this.githubStatus;
    this.workspaceMode = "github";
    if (route.path || route.number) {
      this.filesPage.clearSelectedFile();
      this.gitLayout.setSelectedPath("");
    }
    if (!route.number) {
      this.gitLayout.setView("list");
    }
    this.githubLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
      githubStatus: status,
    });
    const routePromise = this.githubLayout.openRoute(route, {
      resolvePath: options.resolvePath,
      skipReload: options.skipReload,
      status: options.status,
    });
    this.reviewWorkspace.open("github", this.workspaceDetails());
    this.updateGitButton();
    const result = await routePromise;
    this.updateWorkspaceChrome();

    if (!route.number && !options.skipReload && !this.githubStatus) {
      return await this.loadGithubStatus(this.currentPath);
    }

    return result;
  }

  closeReviewWorkspace() {
    if (!this.workspaceMode && this.reviewWorkspace.hidden) {
      return;
    }

    this.workspaceMode = null;
    this.gitLayout.setView("list");
    this.githubLayout.backToList();
    this.reviewWorkspace.close();
    this.updateGitButton();
  }

  updateWorkspaceChrome() {
    if (!this.workspaceMode) {
      return;
    }

    this.reviewWorkspace.updateDetails(this.workspaceDetails());
    if (this.workspaceMode === "git") {
      this.reviewWorkspace.setGitView();
    }
    if (this.workspaceMode === "github") {
      this.reviewWorkspace.setGithubView();
    }
  }

  updateGitButton() {
    if (!this.gitRepository) {
      this.headerActions.gitStatus = {
        available: false,
        message: "Not a Git repository",
      };
      return;
    }

    this.headerActions.gitStatus = {
      available: true,
      branch: this.gitRepository.branch,
      dirty: this.gitRepository.dirty,
      count: this.gitStatus?.files.length ?? null,
    };
    this.headerActions.githubStatus = this.githubStatus;
  }

  workspaceSubtitle(label) {
    if (!this.gitRepository) {
      return label;
    }

    const branch = this.gitRepository.branch ?? "HEAD";
    const dirty = this.gitRepository.dirty ? " *" : "";
    const count = this.gitStatus?.files.length;
    const countLabel = count === undefined ? "" : ` · ${count} changes`;
    return `${label} · ${branch}${dirty}${countLabel}`;
  }

  workspaceDetails() {
    if (this.workspaceMode === "git") {
      return this.gitLayout.details((label) => this.workspaceSubtitle(label));
    }

    if (this.workspaceMode === "github") {
      return this.githubLayout.details();
    }

    return {
      title: "Review",
      subtitle: "",
      backVisible: false,
    };
  }
}

customElements.define("caffold-app-shell", CaffoldAppShell);

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function parentPath(path) {
  const parts = cleanPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
