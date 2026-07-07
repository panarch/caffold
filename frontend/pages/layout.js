import { getHealth, listDirectory, openProject } from "../api.js";
import {
  parentRoute,
  parseRoute,
  routeDomain,
  routeEquals,
  routeSurface,
  routeUrl,
} from "../navigation-routes.js";
import "./components/pathbar.js";
import "./components/project-switcher.js";
import "./components/header-actions.js";
import "./files/page.js";
import "./(codex)/layout.js";
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
    this.directoryContextPath = "";
    this.isApplyingRoute = false;
    this.render();
    this.filesPage = this.querySelector("caffold-files-page");
    this.filesPage.ensureRendered();
    this.codexWorkspace = this.querySelector("caffold-codex-workspace");
    this.codexWorkspace.ensureRendered();
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
    this.prepareRoute(parseRoute(window.location.href));

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
    this.addEventListener("caffold:open-tasks", () => {
      this.navigateToCurrentProjectRoute({ kind: "tasks" });
    });
    this.addEventListener("caffold:new-task", () => {
      this.navigateToCurrentProjectRoute({ kind: "tasks", new: true });
    });
    this.addEventListener("caffold:request-tasks-route", (event) => {
      this.navigateToRoute(event.detail.route);
    });
    this.addEventListener("caffold:close-codex-workspace", () => {
      this.navigateToCodexParent() || (this.codexWorkspace.hidden = true);
    });
    this.addEventListener("caffold:close-review-workspace", () => {
      this.navigateToReviewParent({ closeWorkspace: true }) || this.closeReviewWorkspace();
    });
    this.addEventListener("caffold:back-review-workspace", () => {
      this.navigateToReviewParent();
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
    });
    this.addEventListener("caffold:request-github-route", (event) => {
      this.navigateOrOpenGithubRoute(event.detail.route, event.detail.options);
    });
    this.addEventListener("caffold:github-review-state-change", () => {
      this.syncHeaderReviewContext();
    });
    this.addEventListener("caffold:project-selected", (event) => {
      this.openProjectRoute(event.detail.project);
    });
    this.bootstrap();
  }

  get currentPath() {
    return this.directoryContextPath || this.filesPage?.currentPath || "";
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
      <main class="app-main" aria-label="Project workspace">
        <caffold-files-page></caffold-files-page>
      </main>
      <caffold-codex-workspace hidden></caffold-codex-workspace>
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
    this.prepareRoute(route);
    try {
      const project = await this.openProjectForRoute(route.projectId);
      if (!project) {
        return false;
      }

      const surface = routeSurface(route);
      const domain = routeDomain(route);
      if (surface === "files") {
        await this.applyFilesRoute(project, route);
      } else if (surface === "tasks") {
        await this.applyTasksRoute(project, route);
      } else if (domain === "git") {
        await this.applyGitRoute(project, route);
      } else if (domain === "github") {
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
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    this.closeReviewWorkspace();
    this.reviewWorkspace.prepareForFileBrowserOpen();
    const fullPath = this.projectPath(project, route.path);
    this.pathbar.path = fullPath;
    const result = await this.filesPage.openPath(fullPath, {
      fallbackPath: project.relativePath,
    });
    this.pathbar.path = this.currentPath;
    if (result?.directory) {
      await this.syncDirectoryContext(result.directory);
    }
  }

  async applyTasksRoute(project, route) {
    this.closeReviewWorkspace();
    this.reviewWorkspace.prepareForFileBrowserOpen();
    this.filesPage.hidden = true;
    this.codexWorkspace.hidden = false;
    this.pathbar.path = project.relativePath;
    await this.ensureProjectReviewContext(project);
    if (!this.isCurrentRoute(route)) {
      return;
    }
    await this.codexWorkspace.openRoute(route, { project });
  }

  async applyGitRoute(project, route) {
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    if (!(await this.ensureProjectReviewContext(project))) {
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
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    if (!(await this.ensureProjectReviewContext(project))) {
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

  navigateToCodexParent() {
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    const projectId = currentRoute?.projectId ?? this.projectSwitcher.currentProjectId;
    if (!projectId) {
      return false;
    }

    return this.navigateToRoute({
      kind: "files",
      projectId,
      path: "",
    });
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
      await this.syncDirectoryContext(directory);
      return directory;
    }

    if (options.allowFailure) {
      return false;
    }

    this.clearRepositoryContext();
    this.projectSwitcher.clearContext({ error: this.filesPage.lastError });
    return false;
  }

  async syncDirectoryContext(directory) {
    this.directoryContextPath = directory.path;
    this.pathbar.path = directory.path;
    this.updateRepositoryContext(directory);
    await this.refreshProjects(directory.path);
  }

  async openFile(path, entry = null) {
    this.reviewWorkspace.prepareForFileBrowserOpen();
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

    this.reviewWorkspace.prepareForGitReviewRoute(route, {
      clearFileSelection: () => this.filesPage.clearSelectedFile(),
    });
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
    });
    this.syncHeaderReviewContext();
    return await routePromise;
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

  async ensureProjectReviewContext(project) {
    if (this.isProjectRootLoaded(project)) {
      return true;
    }

    const directory = await listDirectory(project.relativePath);
    this.directoryContextPath = directory.path;
    this.pathbar.path = directory.path;
    if (directory.git) {
      this.applyRepositoryContext(directory.path, directory.git);
    } else {
      this.clearRepositoryContext();
    }
    await this.refreshProjects(directory.path);
    return true;
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
  }

  applyRepositoryContext(path, repository) {
    this.gitRepository = repository;
    this.reviewWorkspace.applyRepositoryContext({ path, repository });
    this.syncHeaderReviewContext();
  }

  reloadActiveReviewContext() {
    this.reviewWorkspace.reloadActiveReviewContext({
      openGitRoute: (route) => this.openGitRoute(route),
      openGithubRoute: (route) => this.openGithubRoute(route),
    });
  }

  clearRepositoryContext() {
    this.gitRepository = null;
    this.reviewWorkspace.clearRepositoryContext();
    this.syncHeaderReviewContext();
  }

  async openGithubRoute(route, options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    this.reviewWorkspace.prepareForGithubReviewRoute(route, {
      clearFileSelection: () => this.filesPage.clearSelectedFile(),
    });
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
    });
    this.syncHeaderReviewContext();
    return await routePromise;
  }

  closeReviewWorkspace() {
    if (!this.reviewWorkspace.activeMode && this.reviewWorkspace.hidden) {
      return;
    }

    this.reviewWorkspace.close();
    this.syncHeaderReviewContext();
  }

  syncHeaderReviewContext() {
    this.headerActions.setReviewContext({
      repository: this.gitRepository,
      gitStatus: this.gitStatus,
      githubStatus: this.githubStatus,
    });
  }

  prepareRoute(route) {
    const surface = routeSurface(route);
    this.dataset.routeSurface = surface;
    delete this.dataset.routePending;

    if (surface === "review") {
      this.reviewWorkspace?.prepareRoute(route);
      return;
    }

    if (surface === "tasks") {
      this.closeReviewWorkspace();
      this.filesPage.hidden = true;
      this.codexWorkspace.hidden = false;
      this.codexWorkspace.prepareRoute(route);
      return;
    }

    this.closeReviewWorkspace();
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
  }
}

customElements.define("caffold-app-shell", CaffoldAppShell);

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}
