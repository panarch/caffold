import { getHealth, openProject } from "../api.js";
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
      if (this.gitLayout.repository) {
        this.gitRepository = this.gitLayout.repository;
      }
      this.syncHeaderReviewContext();
      if (this.reviewWorkspace.isActive("git")) {
        this.updateWorkspaceChrome();
      }
    });
    this.addEventListener("caffold:request-github-route", (event) => {
      this.navigateOrOpenGithubRoute(event.detail.route, event.detail.options);
    });
    this.addEventListener("caffold:github-review-state-change", () => {
      this.syncHeaderReviewContext();
      if (this.reviewWorkspace.isActive("github")) {
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
    if (!this.isCurrentRoute(route)) {
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
    if (!this.isCurrentRoute(route)) {
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

  isCurrentRoute(route) {
    return Boolean(this.currentRoute && routeEquals(this.currentRoute, route));
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
    if (this.reviewWorkspace.isActive("git")) {
      const route = this.gitLayout.routeForWorkspaceBack();
      return route ? this.navigateOrOpenGitRoute(route) : false;
    }

    if (this.reviewWorkspace.isActive("github")) {
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
      this.updateRepositoryContext(directory);
      await this.refreshProjects(directory.path);
      return directory;
    }

    if (options.allowFailure) {
      return false;
    }

    this.clearRepositoryContext();
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

    this.prepareGitReviewRoute(route);
    const routePromise = this.reviewWorkspace.openGitReviewRoute(route, {
      context: {
        path: this.currentPath,
        repository: this.gitRepository,
      },
      routeOptions: {
        kind: options.kind,
        resolvePath: options.resolvePath,
        skipReload: options.skipReload,
        status: options.status,
      },
      details: () => this.gitWorkspaceDetails(),
    });
    this.syncHeaderReviewContext();
    return await routePromise;
  }

  prepareGitReviewRoute(route) {
    if (route.path || (route.kind === "log" && route.sha)) {
      this.filesPage.clearSelectedFile();
    }
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
      !this.reviewWorkspace.isActive("git") ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.gitLayout.canReuseRoute(route);
  }

  canApplyLoadedGithubRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      !this.reviewWorkspace.isActive("github") ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.githubLayout.canReuseRoute(route);
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

  updateRepositoryContext(directory) {
    if (!directory.git) {
      this.clearRepositoryContext();
      return;
    }

    this.applyRepositoryContext(directory.path, directory.git);
    this.reloadActiveReviewContext();
    this.updateWorkspaceChrome();
  }

  applyRepositoryContext(path, repository) {
    this.gitRepository = repository;
    void this.gitLayout.applyRepositoryContext({ path, repository });
    void this.githubLayout.applyRepositoryContext({ path, repository });
    this.syncHeaderReviewContext();
  }

  reloadActiveReviewContext() {
    if (this.reviewWorkspace.isActive("git")) {
      this.openGitRoute(this.gitLayout.routeForActiveMode());
      return;
    }

    if (this.reviewWorkspace.isActive("github")) {
      this.openGithubRoute(this.githubLayout.routeForActiveMode());
    }
  }

  clearRepositoryContext() {
    this.gitRepository = null;
    this.gitLayout.reset();
    this.githubLayout.reset();
    this.syncHeaderReviewContext();
    this.closeReviewWorkspace();
  }

  async openGithubRoute(route, options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    this.prepareGithubReviewRoute(route);
    const routePromise = this.reviewWorkspace.openGithubReviewRoute(route, {
      context: {
        path: this.currentPath,
        repository: this.gitRepository,
        githubStatus: this.githubStatus,
      },
      routeOptions: {
        resolvePath: options.resolvePath,
        skipReload: options.skipReload,
        status: options.status,
      },
      details: () => this.githubWorkspaceDetails(),
    });
    this.syncHeaderReviewContext();
    return await routePromise;
  }

  prepareGithubReviewRoute(route) {
    if (route.path || route.number) {
      this.filesPage.clearSelectedFile();
      this.gitLayout.setSelectedPath("");
    }
    if (!route.number) {
      this.gitLayout.setView("list");
    }
  }

  closeReviewWorkspace() {
    if (!this.reviewWorkspace.activeMode && this.reviewWorkspace.hidden) {
      return;
    }

    this.reviewWorkspace.close();
    this.syncHeaderReviewContext();
  }

  updateWorkspaceChrome() {
    if (!this.reviewWorkspace.activeMode) {
      return;
    }

    this.reviewWorkspace.updateDetails(this.workspaceDetails());
  }

  syncHeaderReviewContext() {
    this.headerActions.setReviewContext({
      repository: this.gitRepository,
      gitStatus: this.gitStatus,
      githubStatus: this.githubStatus,
    });
  }

  workspaceDetails() {
    if (this.reviewWorkspace.isActive("git")) {
      return this.gitWorkspaceDetails();
    }

    if (this.reviewWorkspace.isActive("github")) {
      return this.githubWorkspaceDetails();
    }

    return {
      title: "Review",
      subtitle: "",
      backVisible: false,
    };
  }

  gitWorkspaceDetails() {
    return this.gitLayout.details();
  }

  githubWorkspaceDetails() {
    return this.githubLayout.details();
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
