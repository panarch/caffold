import { getHealth, listDirectory } from "../api.js";
import {
  parentRoute,
  parseRoute,
  routeDomain,
  routeEquals,
  routeSurface,
  routeUrl,
} from "../navigation-routes.js";
import "./components/pathbar.js";
import "./components/app-menu.js";
import "./components/header-actions.js";
import "./files/page.js";
import "./settings/page.js";
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
    this.taskReviewReturnRoute = null;
    this.taskReviewRelatedPaths = [];
    this.pendingTaskResumeRoute = null;
    this.initialPath = "";
    this.render();
    this.filesPage = this.querySelector("caffold-files-page");
    this.filesPage.ensureRendered();
    this.settingsPage = this.querySelector("caffold-settings-page");
    this.codexWorkspace = this.querySelector("caffold-codex-workspace");
    this.codexWorkspace.ensureRendered();
    this.pathbar = this.querySelector("caffold-pathbar");
    this.headerActions = this.querySelector("caffold-header-actions");
    this.reviewWorkspace = this.querySelector("caffold-review-workspace");
    this.reviewWorkspace.ensureRendered();
    this.gitLayout = this.reviewWorkspace.querySelector("caffold-git-review-layout");
    this.gitLayout.ensureRendered();
    this.githubLayout = this.reviewWorkspace.querySelector("caffold-github-review-layout");
    this.githubLayout.ensureRendered();
    this.installNavigationHandlers();
    const initialRoute = parseRoute(window.location.href);
    this.prepareRoute(
      initialRoute ??
        (window.location.pathname === "/"
          ? { kind: "tasks", new: false, threadId: "", cwd: "" }
          : null),
    );

    this.addEventListener("caffold:navigate", (event) => {
      this.navigateToDirectoryRoute(event.detail.path) || this.loadDirectory(event.detail.path);
    });
    this.addEventListener("caffold:open-directory", (event) => {
      this.navigateToDirectoryRoute(event.detail.path) || this.loadDirectory(event.detail.path);
    });
    this.addEventListener("caffold:open-file", (event) => {
      this.navigateToFileRoute(event.detail.path) ||
        this.openFile(event.detail.path, event.detail.entry);
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      this.closeFileViewer(event);
    });
    this.addEventListener("caffold:open-diff-workspace", () => {
      this.clearTaskReviewReturnRoute();
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("diff"));
    });
    this.addEventListener("caffold:open-log-workspace", () => {
      this.clearTaskReviewReturnRoute();
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("log"));
    });
    this.addEventListener("caffold:open-compare-workspace", () => {
      this.clearTaskReviewReturnRoute();
      this.navigateOrOpenGitRoute(this.gitLayout.routeForAction("compare"));
    });
    this.addEventListener("caffold:open-github-issues-workspace", () => {
      this.clearTaskReviewReturnRoute();
      this.navigateOrOpenGithubRoute(this.githubLayout.routeForAction("issues"));
    });
    this.addEventListener("caffold:open-github-pulls-workspace", () => {
      this.clearTaskReviewReturnRoute();
      this.navigateOrOpenGithubRoute(this.githubLayout.routeForAction("pulls"));
    });
    this.addEventListener("caffold:open-tasks", () => {
      this.navigateToRoute({
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: this.currentPath || ".",
      });
    });
    this.addEventListener("caffold:open-all-tasks", () => {
      this.navigateToRoute({
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: "",
      });
    });
    this.addEventListener("caffold:new-task", () => {
      this.navigateToRoute({
        kind: "tasks",
        new: true,
        threadId: "",
        cwd: this.currentPath || ".",
      });
    });
    this.addEventListener("caffold:open-settings", () => {
      if (this.currentRoute?.kind !== "settings") {
        this.settingsReturnRoute = this.currentRoute;
      }
      this.navigateToRoute({ kind: "settings" });
    });
    this.addEventListener("caffold:close-settings", () => {
      const returnRoute = this.settingsReturnRoute;
      this.settingsReturnRoute = null;
      if (returnRoute) {
        this.navigateToRoute(returnRoute);
        return;
      }

      window.location.assign("/");
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
      if (event.detail.options?.returnRoute) {
        this.taskReviewReturnRoute = event.detail.options.returnRoute;
        this.taskReviewRelatedPaths = (event.detail.options.taskRelatedPaths ?? [])
          .map(cleanPath)
          .filter(Boolean);
      }
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
          <caffold-app-menu></caffold-app-menu>
          <caffold-header-actions></caffold-header-actions>
        </div>
      </header>
      <caffold-pathbar></caffold-pathbar>
      <main class="app-main" aria-label="Workspace">
        <caffold-files-page></caffold-files-page>
        <caffold-settings-page hidden></caffold-settings-page>
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
      this.initialPath = health.initialPath ?? "";
      const initialRoute = parseRoute(window.location.href);
      if (initialRoute) {
        await this.applyRoute(initialRoute);
        return;
      }

      this.navigateToRoute(
        { kind: "tasks", new: false, threadId: "", cwd: "" },
        { replace: true },
      );
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
    route = this.routeWithResolvedContext(route);
    this.isApplyingRoute = true;
    this.currentRoute = route;
    if (window.location.pathname + window.location.search !== routeUrl(route)) {
      this.replaceRoute(route);
    }
    this.prepareRoute(route);
    try {
      const surface = routeSurface(route);
      const domain = routeDomain(route);
      if (surface === "files") {
        await this.applyFilesRoute(route);
      } else if (surface === "tasks") {
        await this.applyTasksRoute(route);
      } else if (surface === "settings") {
        this.settingsPage.prepareRoute();
      } else if (domain === "git") {
        await this.applyGitRoute(route);
      } else if (domain === "github") {
        await this.applyGithubRoute(route);
      }

      return true;
    } catch (error) {
      this.filesPage.setError(error);
      return false;
    } finally {
      this.isApplyingRoute = false;
    }
  }

  async applyFilesRoute(route) {
    this.clearTaskReviewReturnRoute();
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    this.closeReviewWorkspace();
    this.reviewWorkspace.prepareForFileBrowserOpen();
    const rootPath = route.cwd;
    const fullPath = joinLogicalPath(rootPath, route.path);
    this.pathbar.path = fullPath;
    if (!route.path && this.filesPage.showLoadedList(fullPath)) {
      this.pathbar.path = this.currentPath;
      return;
    }
    const result = await this.filesPage.openPath(fullPath, {
      fallbackPath: rootPath,
    });
    this.pathbar.path = this.currentPath;
    if (result?.directory) {
      await this.syncDirectoryContext(result.directory);
    }
  }

  async applyTasksRoute(route) {
    this.closeReviewWorkspace();
    this.reviewWorkspace.prepareForFileBrowserOpen();
    this.filesPage.hidden = true;
    this.codexWorkspace.hidden = false;
    this.pathbar.path = route.cwd || this.preferredContextPath();
    if (!this.isCurrentRoute(route)) {
      return;
    }
    const preserveLoadedTask = this.shouldPreserveLoadedTask(route);
    await this.codexWorkspace.openRoute(route, {
      preserveLoadedTask,
      defaultCwdPath:
        this.currentPath || this.filesPage.loadStoredDirectoryPath() || this.initialPath,
    });
  }

  async applyGitRoute(route) {
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    if (!(await this.ensureReviewContext(route.cwd))) {
      return;
    }
    route = this.canonicalReviewRoute(route);
    if (!this.isCurrentRoute(route)) {
      return;
    }

    await this.openGitRoute(route, {
      resolvePath: (path) =>
        joinLogicalPath(this.gitRepository?.rootPath ?? route.cwd, path),
      skipReload: this.canApplyLoadedGitRoute(route),
      taskRelatedPaths: this.taskReviewRelatedPaths
        .map((path) => this.repositoryRelativePath(path))
        .filter(Boolean),
    });
  }

  async applyGithubRoute(route) {
    this.codexWorkspace.hidden = true;
    this.filesPage.hidden = false;
    if (!(await this.ensureReviewContext(route.cwd))) {
      return;
    }
    route = this.canonicalReviewRoute(route);
    if (!this.isCurrentRoute(route)) {
      return;
    }

    await this.openGithubRoute(route, {
      resolvePath: (path) =>
        joinLogicalPath(this.gitRepository?.rootPath ?? route.cwd, path),
      skipReload: this.canApplyLoadedGithubRoute(route),
    });
  }

  navigateToDirectoryRoute(path) {
    return this.navigateToRoute({
      kind: "files",
      cwd: cleanPath(path),
      path: "",
    });
  }

  navigateToFileRoute(path) {
    const cwd = cleanPath(this.filesPage?.currentPath || this.preferredContextPath());
    const relativePath = relativeLogicalPath(cwd, path);
    if (relativePath === null) {
      return false;
    }

    return this.navigateToRoute({
      kind: "files",
      cwd,
      path: relativePath,
    });
  }

  isCurrentRoute(route) {
    return Boolean(this.currentRoute && routeEquals(this.currentRoute, route));
  }

  navigateOrOpenGitRoute(route, options = {}) {
    const { fallbackRoute, ...openOptions } = options;
    const navigationRoute = this.navigationReviewRoute(route);
    return navigationRoute
      ? this.navigateToRoute(navigationRoute)
      : this.openGitRoute(fallbackRoute ?? route, openOptions);
  }

  navigateOrOpenGithubRoute(route, options = {}) {
    const { fallbackRoute, ...openOptions } = options;
    const navigationRoute = this.navigationReviewRoute(route);
    return navigationRoute
      ? this.navigateToRoute(navigationRoute)
      : this.openGithubRoute(fallbackRoute ?? route, openOptions);
  }

  navigationReviewRoute(route) {
    if (!route) {
      return null;
    }

    const cwd = cleanPath(this.gitRepository?.rootPath || this.preferredReviewContextPath());
    if (!cwd) {
      return null;
    }
    const path = route.path ? this.repositoryRelativePath(route.path) : "";
    return { ...route, cwd, path };
  }

  navigateToReviewParent(options = {}) {
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    if (!currentRoute) {
      if (options.closeWorkspace) {
        return this.navigateToRoute({
          kind: "files",
          cwd: cleanPath(this.preferredReviewContextPath()),
          path: "",
        });
      }
      return false;
    }

    if (options.closeWorkspace && this.taskReviewReturnRoute) {
      const returnRoute = this.taskReviewReturnRoute;
      this.taskReviewReturnRoute = null;
      this.taskReviewRelatedPaths = [];
      this.pendingTaskResumeRoute = returnRoute;
      return this.navigateToRoute(returnRoute);
    }

    const parent = options.closeWorkspace
      ? {
          kind: "files",
          cwd: cleanPath(currentRoute.cwd || this.preferredReviewContextPath()),
          path: "",
        }
      : parentRoute(currentRoute);
    return parent ? this.navigateToRoute(parent) : false;
  }

  shouldPreserveLoadedTask(route) {
    if (this.pendingTaskResumeRoute && routeEquals(this.pendingTaskResumeRoute, route)) {
      this.pendingTaskResumeRoute = null;
      return true;
    }

    if (this.canPreserveLoadedTask(route)) {
      return true;
    }

    if (this.taskReviewReturnRoute) {
      this.clearTaskReviewReturnRoute();
    }
    return false;
  }

  canPreserveLoadedTask(route) {
    return Boolean(
      (this.pendingTaskResumeRoute && routeEquals(this.pendingTaskResumeRoute, route)) ||
        (this.taskReviewReturnRoute && routeEquals(this.taskReviewReturnRoute, route)),
    );
  }

  clearTaskReviewReturnRoute() {
    this.taskReviewReturnRoute = null;
    this.taskReviewRelatedPaths = [];
    this.pendingTaskResumeRoute = null;
  }

  navigateToCodexParent() {
    this.clearTaskReviewReturnRoute();
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    const parent = parentRoute(currentRoute);
    if (parent) {
      return this.navigateToRoute(parent);
    }

    return false;
  }

  navigateToHomeEntrypoint() {
    return this.navigateToRoute({
      kind: "tasks",
      new: false,
      threadId: "",
      cwd: "",
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
    return false;
  }

  async syncDirectoryContext(directory) {
    this.directoryContextPath = directory.path;
    this.pathbar.path = directory.path;
    this.updateRepositoryContext(directory);
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
        taskRelatedPaths: options.taskRelatedPaths,
      },
    });
    this.syncHeaderReviewContext();
    return await routePromise;
  }

  repositoryRelativePath(path) {
    const clean = cleanPath(path);
    const relative = relativeLogicalPath(this.gitRepository?.rootPath, clean);
    return relative === null ? clean : relative;
  }

  async ensureReviewContext(cwd) {
    const targetPath = cleanPath(cwd || this.preferredReviewContextPath());
    if (!targetPath) {
      return false;
    }
    if (cleanPath(this.gitRepository?.rootPath) === targetPath) {
      this.directoryContextPath = targetPath;
      this.pathbar.path = targetPath;
      return true;
    }

    const directory = await listDirectory(targetPath);
    if (!directory.git) {
      this.directoryContextPath = directory.path;
      this.pathbar.path = directory.path;
      this.clearRepositoryContext();
      return false;
    }

    const repositoryPath = cleanPath(directory.git.rootPath || directory.path);
    this.directoryContextPath = repositoryPath;
    this.pathbar.path = repositoryPath;
    this.applyRepositoryContext(repositoryPath, directory.git);
    return true;
  }

  canonicalReviewRoute(route) {
    const cwd = cleanPath(this.gitRepository?.rootPath || route.cwd);
    if (cwd === cleanPath(route.cwd)) {
      return route;
    }

    const canonicalRoute = { ...route, cwd };
    this.currentRoute = canonicalRoute;
    this.replaceRoute(canonicalRoute);
    return canonicalRoute;
  }

  canApplyLoadedGitRoute(route) {
    if (
      cleanPath(this.gitRepository?.rootPath) !== cleanPath(route.cwd) ||
      !this.reviewWorkspace.isActive("git") ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.gitLayout.canReuseRoute(route);
  }

  canApplyLoadedGithubRoute(route) {
    if (
      cleanPath(this.gitRepository?.rootPath) !== cleanPath(route.cwd) ||
      !this.reviewWorkspace.isActive("github") ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.githubLayout.canReuseRoute(route);
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

  routeWithResolvedContext(route) {
    if (!route || routeSurface(route) === "tasks" || route.kind === "settings") {
      return route;
    }
    if (cleanPath(route.cwd)) {
      return route;
    }

    const cwd =
      routeSurface(route) === "files"
        ? this.preferredContextPath()
        : this.preferredReviewContextPath();
    return { ...route, cwd: cleanPath(cwd) || "." };
  }

  preferredContextPath() {
    return cleanPath(
      this.codexWorkspace?.selectedTaskContextPath?.() ||
        this.filesPage?.currentPath ||
        this.filesPage?.loadStoredDirectoryPath?.() ||
        this.initialPath ||
        ".",
    );
  }

  preferredReviewContextPath() {
    return cleanPath(
      this.codexWorkspace?.selectedTaskContextPath?.() ||
        this.gitRepository?.rootPath ||
        this.filesPage?.currentPath ||
        this.initialPath ||
        ".",
    );
  }

  prepareRoute(route) {
    const surface = routeSurface(route);
    this.dataset.routeSurface = surface;
    delete this.dataset.routePending;
    this.pathbar.hidden = surface === "settings";
    this.settingsPage.hidden = surface !== "settings";

    if (surface === "review") {
      this.reviewWorkspace?.prepareRoute(route);
      return;
    }

    if (surface === "tasks") {
      this.closeReviewWorkspace();
      this.filesPage.hidden = true;
      this.codexWorkspace.hidden = false;
      this.codexWorkspace.prepareRoute(route, {
        preserveLoadedTask: this.canPreserveLoadedTask(route),
      });
      return;
    }

    if (surface === "settings") {
      this.closeReviewWorkspace();
      this.codexWorkspace.hidden = true;
      this.filesPage.hidden = true;
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

function joinLogicalPath(rootPath, relativePath = "") {
  const root = cleanPath(rootPath);
  const relative = cleanPath(relativePath);
  return root && relative ? `${root}/${relative}` : root || relative;
}

function relativeLogicalPath(rootPath, path) {
  const root = cleanPath(rootPath);
  const fullPath = cleanPath(path);
  if (!root) {
    return fullPath;
  }
  if (fullPath === root) {
    return "";
  }
  if (fullPath.startsWith(`${root}/`)) {
    return fullPath.slice(root.length + 1);
  }
  return null;
}
