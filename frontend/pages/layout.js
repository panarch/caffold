import {
  createProject,
  deleteProject,
  getCodexStatus,
  getGitHubStatus,
  getGitStatus,
  getHealth,
  getProjectCandidate,
  listProjects,
  openProject,
  renameProject,
} from "../api.js";
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
    this.gitStatusRequestId = 0;
    this.githubStatusRequestId = 0;
    this.codexStatusRequestId = 0;
    this.projectRequestId = 0;
    this.gitStatus = null;
    this.githubStatus = null;
    this.codexStatus = null;
    this.projects = [];
    this.projectCandidate = null;
    this.currentProjectId = null;
    this.workspaceMode = null;
    this.currentRoute = null;
    this.isApplyingRoute = false;
    this.routedProject = null;
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
    this.addEventListener("caffold:close-github-issue-viewer", () => {
      this.navigateToReviewParent() || this.backReviewWorkspace();
    });
    this.addEventListener("caffold:close-github-pull-viewer", () => {
      this.navigateToReviewParent() || this.backReviewWorkspace();
    });
    this.addEventListener("caffold:open-diff-workspace", () => {
      this.navigateToCurrentProjectRoute({ kind: "diff", path: "" }) || this.openDiffWorkspace();
    });
    this.addEventListener("caffold:open-log-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "log",
        page: this.gitLayout.logPage,
      }) || this.openLogWorkspace();
    });
    this.addEventListener("caffold:open-compare-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "compare",
        baseRef: this.gitLayout.compareBaseRef,
        headRef: this.gitLayout.compareHeadRef,
        path: "",
      }) || this.openCompareWorkspace();
    });
    this.addEventListener("caffold:open-github-issues-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: this.githubLayout.issuesPage,
      }) || this.openGithubIssuesWorkspace();
    });
    this.addEventListener("caffold:open-github-pulls-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: this.githubLayout.pullsPage,
      }) || this.openGithubPullsWorkspace();
    });
    this.addEventListener("caffold:close-review-workspace", () => {
      this.navigateToReviewParent({ closeWorkspace: true }) || this.closeReviewWorkspace();
    });
    this.addEventListener("caffold:back-review-workspace", () => {
      const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
      if (currentRoute?.kind === "log" && currentRoute.sha) {
        this.navigateToRoute({
          kind: "log",
          projectId: currentRoute.projectId,
          page: currentRoute.page,
        });
        return;
      }
      this.navigateToReviewParent() || this.backReviewWorkspace();
    });
    this.addEventListener("caffold:open-git-diff", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "diff",
        path: this.projectRelativePath(event.detail.path),
      }) || this.openDiff(event.detail.path, event.detail.kind, event.detail.status);
    });
    this.addEventListener("caffold:open-git-commit", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "log",
        page: this.gitLayout.logPage,
        sha: event.detail.sha,
      }) || this.openCommit(event.detail.sha);
    });
    this.addEventListener("caffold:change-log-page", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "log",
        page: event.detail.page,
      }) || this.changeLogPage(event.detail.page);
    });
    this.addEventListener("caffold:open-commit-diff", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "log",
        page: this.gitLayout.logPage,
        sha: event.detail.sha,
        path: this.projectRelativePath(event.detail.path),
      }) || this.openCommitDiff(event.detail.sha, event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "compare",
        baseRef: this.gitLayout.compareBaseRef,
        headRef: this.gitLayout.compareHeadRef,
        path: this.projectRelativePath(event.detail.path),
      }) || this.openCompareDiff(event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:change-compare-refs", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "compare",
        baseRef: event.detail.baseRef,
        headRef: event.detail.headRef,
        path: "",
      }) || this.changeCompareRefs(event.detail.baseRef, event.detail.headRef);
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
    this.addEventListener("caffold:open-github-issue", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: this.githubLayout.issuesPage,
        number: event.detail.number,
      }) || this.openGithubIssue(event.detail.number);
    });
    this.addEventListener("caffold:change-github-issues-page", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: event.detail.page,
      }) || this.changeGithubIssuesPage(event.detail.page);
    });
    this.addEventListener("caffold:github-review-state-change", () => {
      if (this.workspaceMode === "github") {
        this.updateWorkspaceChrome();
      }
    });
    this.addEventListener("caffold:open-github-pull", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: this.githubLayout.pullsPage,
        number: event.detail.number,
      }) || this.openGithubPull(event.detail.number);
    });
    this.addEventListener("caffold:change-github-pulls-page", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: event.detail.page,
      }) || this.changeGithubPullsPage(event.detail.page);
    });
    this.addEventListener("caffold:open-github-pull-files", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: this.githubLayout.pullsPage,
        number: event.detail.number,
        files: true,
        path: "",
      }) || this.openGithubPullFiles(event.detail.number);
    });
    this.addEventListener("caffold:open-github-pull-file", (event) => {
      const number = this.githubLayout.currentPullNumber();
      const path = this.projectRelativePath(event.detail.path);
      if (number && path !== null) {
        this.navigateToCurrentProjectRoute({
          kind: "pulls",
          page: this.githubLayout.pullsPage,
          number,
          files: true,
          path,
        }) || this.openGithubPullFile(event.detail.path, event.detail.status);
        return;
      }

      this.openGithubPullFile(event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:register-current-project", () => {
      this.registerCurrentProject();
    });
    this.addEventListener("caffold:open-project", (event) => {
      this.openRegisteredProject(event.detail.id);
    });
    this.addEventListener("caffold:rename-project", (event) => {
      this.renameRegisteredProject(event.detail.id, event.detail.name);
    });
    this.addEventListener("caffold:delete-project", (event) => {
      this.deleteRegisteredProject(event.detail.id);
    });
    this.bootstrap();
  }

  get currentPath() {
    return this.filesPage?.currentPath ?? "";
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
      } else if (route.kind === "diff") {
        await this.applyDiffRoute(project, route);
      } else if (route.kind === "compare") {
        await this.applyCompareRoute(project, route);
      } else if (route.kind === "log") {
        await this.applyLogRoute(project, route);
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
    this.currentProjectId = project.id;
    this.routedProject = project;
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

  async applyDiffRoute(project, route) {
    if (this.canApplyLoadedDiffRoute(project, route)) {
      this.openDiffWorkspace({ preserveViewer: Boolean(route.path) });
      if (!route.path) {
        this.gitLayout.setSelectedPath("");
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.gitLayout.findDiffFile(fullPath);
      await this.openDiff(
        fullPath,
        file?.untracked ? "untracked" : file?.category ?? "unstaged",
        file?.status ?? "",
      );
      return;
    }

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    this.openDiffWorkspace({ preserveViewer: Boolean(route.path) });
    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    await this.ensureGitStatus();
    const file = this.gitLayout.findDiffFile(fullPath);
    await this.openDiff(
      fullPath,
      file?.untracked ? "untracked" : file?.category ?? "unstaged",
      file?.status ?? "",
    );
  }

  async applyCompareRoute(project, route) {
    const routeBaseRef = route.baseRef || null;
    const routeHeadRef = route.headRef || null;
    const preserveViewer = Boolean(route.path);

    if (this.canApplyLoadedCompareRoute(project, route)) {
      await this.openCompareWorkspace({
        baseRef: routeBaseRef,
        headRef: routeHeadRef,
        preserveViewer,
        skipReload: true,
      });
      if (!route.path) {
        this.gitLayout.setSelectedPath("");
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.gitLayout.findCompareFile(fullPath);
      await this.openCompareDiff(fullPath, file?.status ?? "");
      return;
    }

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    await this.openCompareWorkspace({
      baseRef: routeBaseRef,
      headRef: routeHeadRef,
      preserveViewer,
    });

    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    const file = this.gitLayout.findCompareFile(fullPath);
    await this.openCompareDiff(fullPath, file?.status ?? "");
  }

  async applyLogRoute(project, route) {
    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    if (!route.sha) {
      await this.openLogWorkspace({
        page: route.page,
        skipReload: this.canApplyLoadedLogRoute(project, route),
      });
      return;
    }

    const canReuseCommit = this.canApplyLoadedLogRoute(project, route);
    await this.openCommit(route.sha, {
      page: route.page,
      skipReload: canReuseCommit,
      preserveViewer: Boolean(route.path),
    });
    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    const file = this.gitLayout.findCommitFile(fullPath);
    await this.openCommitDiff(route.sha, fullPath, file?.status ?? "");
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
    if (!this.currentProjectId) {
      return false;
    }

    return this.navigateToRoute({
      ...route,
      projectId: this.currentProjectId,
    });
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
    if (!this.currentProjectId || routePath === null) {
      return;
    }

    this.replaceRoute({
      kind: "files",
      projectId: this.currentProjectId,
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
    this.currentProjectId = null;
    this.projectCandidate = null;
    this.renderProjectState({ error: this.filesPage.lastError });
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

    const gitViewer = this.gitLayout.showFileListForTarget(event.target);
    if (gitViewer) {
      if (currentRoute?.kind === gitViewer && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.updateWorkspaceChrome();
      return;
    }

    if (this.githubLayout.isFileViewer(event.target)) {
      if (currentRoute?.kind === "pulls" && currentRoute.files && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.githubLayout.showPullFilesList();
    }
  }

  showDiffList() {
    this.gitLayout.showDiffList();
    this.updateWorkspaceChrome();
  }

  showCompareList() {
    this.gitLayout.showCompareList();
    this.updateWorkspaceChrome();
  }

  showCommitFileList() {
    this.gitLayout.showCommitFileList();
  }

  showPullFilesList() {
    this.githubLayout.showPullFilesList();
  }

  async openDiff(path, kind, status = "") {
    this.filesPage.clearSelectedFile();
    const diff = await this.gitLayout.openDiff(path, kind, status);
    this.updateWorkspaceChrome();
    return diff;
  }

  async openCommit(sha, options = {}) {
    if (!sha || !this.gitRepository) {
      return null;
    }

    this.filesPage.clearSelectedFile();
    this.workspaceMode = "git";
    const commitPromise = this.gitLayout.openCommit(sha, options);
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
    const commit = await commitPromise;
    this.updateWorkspaceChrome();
    return commit;
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return null;
    }

    this.filesPage.clearSelectedFile();
    this.workspaceMode = "git";
    const diffPromise = this.gitLayout.openCommitDiff(sha, path, status);
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
    const diff = await diffPromise;
    this.updateWorkspaceChrome();
    return diff;
  }

  async openCompareDiff(path, status = "") {
    if (!path) {
      return null;
    }

    this.filesPage.clearSelectedFile();
    const diff = await this.gitLayout.openCompareDiff(path, status);
    this.updateWorkspaceChrome();
    return diff;
  }

  async refreshProjects(path = this.currentPath) {
    const requestId = ++this.projectRequestId;

    try {
      const [projectsPayload, candidatePayload] = await Promise.all([
        listProjects(),
        getProjectCandidate(path),
      ]);

      if (requestId !== this.projectRequestId) {
        return;
      }

      this.projects = projectsPayload.projects ?? [];
      this.projectCandidate = candidatePayload.candidate ?? null;
      this.currentProjectId = this.projectCandidate?.alreadyRegistered
        ? this.projectCandidate.projectId
        : null;
      if (this.currentProjectId) {
        this.routedProject =
          this.projects.find((project) => project.id === this.currentProjectId) ??
          this.routedProject;
      }
      this.renderProjectState();
    } catch (error) {
      if (requestId !== this.projectRequestId) {
        return;
      }

      this.currentProjectId = null;
      this.projectCandidate = null;
      this.renderProjectState({ error });
    }
  }

  renderProjectState(options = {}) {
    this.projectSwitcher.setState({
      projects: this.projects,
      candidate: this.projectCandidate,
      currentProjectId: this.currentProjectId,
      error: options.error ?? null,
    });
  }

  currentProject() {
    return (
      this.projects.find((project) => project.id === this.currentProjectId) ??
      (this.routedProject?.id === this.currentProjectId ? this.routedProject : null)
    );
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

  canApplyLoadedDiffRoute(project, _route) {
    return (
      this.isProjectRootLoaded(project) &&
      this.workspaceMode === "git" &&
      Boolean(this.gitRepository) &&
      this.gitLayout.canReuseDiffRoute(_route)
    );
  }

  canApplyLoadedCompareRoute(project, route) {
    return (
      this.isProjectRootLoaded(project) &&
      this.workspaceMode === "git" &&
      Boolean(this.gitRepository) &&
      this.gitLayout.canReuseCompareRoute(route)
    );
  }

  canApplyLoadedLogRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      this.workspaceMode !== "git" ||
      !this.gitRepository
    ) {
      return false;
    }

    return this.gitLayout.canReuseLogRoute(route);
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

  async ensureGitStatus() {
    if (!this.gitRepository || this.gitStatus) {
      return;
    }

    await this.loadGitStatus(this.currentPath);
  }

  async ensureGithubStatus() {
    if (!this.gitRepository) {
      return null;
    }

    if (this.githubStatus) {
      return this.githubStatus;
    }

    return await this.loadGithubStatus(this.currentPath);
  }

  async registerCurrentProject() {
    const candidate = this.projectCandidate;
    if (!candidate || candidate.alreadyRegistered) {
      return;
    }

    try {
      const project = await createProject({
        rootPath: candidate.rootPath,
        name: candidate.name,
      });
      this.currentProjectId = project.id;
      this.routedProject = project;
      this.navigateToRoute({
        kind: "files",
        projectId: project.id,
        path: "",
      }) || (await this.loadDirectory(project.relativePath));
    } catch (error) {
      this.renderProjectState({ error });
    }
  }

  async openRegisteredProject(id) {
    if (!id) {
      return;
    }

    try {
      const project = await openProject(id);
      this.currentProjectId = project.id;
      this.routedProject = project;
      this.navigateToRoute({
        kind: "files",
        projectId: project.id,
        path: "",
      }) || (await this.loadDirectory(project.relativePath));
    } catch (error) {
      this.renderProjectState({ error });
    }
  }

  async renameRegisteredProject(id, name) {
    if (!id) {
      return;
    }

    try {
      await renameProject(id, name);
      await this.refreshProjects(this.currentPath);
    } catch (error) {
      this.renderProjectState({ error });
    }
  }

  async deleteRegisteredProject(id) {
    if (!id) {
      return;
    }

    const project = this.projects.find((candidate) => candidate.id === id);
    const name = project?.name ?? "this project";
    if (!window.confirm(`Delete ${name} from Caffold projects? Files are not deleted.`)) {
      return;
    }

    try {
      await deleteProject(id);
      await this.refreshProjects(this.currentPath);
    } catch (error) {
      this.renderProjectState({ error });
    }
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
    this.gitStatus = null;
    this.githubStatus = null;
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
    this.gitLayout.setGitStatus(null);
    this.githubLayout.setContext({
      path: directory.path,
      repository: directory.git,
      githubStatus: null,
    });
    this.loadGitStatus(directory.path);
    this.loadGithubStatus(directory.path);
    if (this.workspaceMode === "git") {
      if (this.gitLayout.activeMode === "log") {
        this.gitLayout.openLogWorkspace({ page: 1 });
      } else if (this.gitLayout.activeMode === "compare") {
        this.openCompareWorkspace();
      } else {
        this.openDiffWorkspace();
      }
    } else if (this.workspaceMode === "github") {
      if (this.githubLayout.activeMode === "pulls") {
        this.githubLayout.openPullsWorkspace({
          path: directory.path,
          repository: directory.git,
          githubStatus: null,
          page: 1,
        });
      } else {
        this.githubLayout.openIssuesWorkspace({
          path: directory.path,
          repository: directory.git,
          githubStatus: null,
          page: 1,
        });
      }
    }
    this.updateWorkspaceChrome();
  }

  clearGitContext() {
    this.gitRepository = null;
    this.gitStatus = null;
    this.gitStatusRequestId += 1;
    this.githubStatusRequestId += 1;
    this.githubStatus = null;
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
      return;
    }

    const requestId = ++this.gitStatusRequestId;
    this.gitLayout.setContext({
      path,
      repository: this.gitRepository,
    });
    this.gitLayout.setGitStatus(null);

    try {
      const status = await getGitStatus(path);
      if (requestId !== this.gitStatusRequestId) {
        return;
      }

      this.gitRepository = status.repository;
      this.gitStatus = status;
      this.gitLayout.setGitStatus(status);
      this.updateGitButton();
      this.updateWorkspaceChrome();
    } catch (error) {
      if (requestId !== this.gitStatusRequestId) {
        return;
      }

      this.gitLayout.setGitStatusError(error);
    }
  }

  async loadGithubStatus(path) {
    if (!this.gitRepository) {
      return;
    }

    const requestId = ++this.githubStatusRequestId;

    try {
      const status = await getGitHubStatus(path);
      if (requestId !== this.githubStatusRequestId) {
        return;
      }

      this.githubStatus = status;
      this.headerActions.githubStatus = status;
      this.updateWorkspaceChrome();
      if (this.workspaceMode === "github") {
        this.githubLayout.setContext({
          path,
          repository: this.gitRepository,
          githubStatus: status,
        });
        await this.githubLayout.setGithubStatus(status);
      }
      return status;
    } catch (error) {
      if (requestId !== this.githubStatusRequestId) {
        return;
      }

      const status = {
        available: false,
        repository: this.gitRepository,
        github: null,
        ghAvailable: false,
        authenticated: false,
        issuesAvailable: false,
        pullsAvailable: false,
        message: error.message,
      };
      this.githubStatus = status;
      this.headerActions.githubStatus = status;
      if (this.workspaceMode === "github") {
        this.githubLayout.setContext({
          path,
          repository: this.gitRepository,
          githubStatus: status,
        });
        await this.githubLayout.setGithubStatus(status);
      }
    }
  }

  async openGithubIssue(number) {
    return await this.openGithubRoute({
      kind: "issues",
      page: this.githubLayout.issuesPage,
      number,
    });
  }

  async openGithubRoute(route, options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    const needsStatus = Boolean(route.number);
    const status = needsStatus ? await this.ensureGithubStatus() : this.githubStatus;
    this.workspaceMode = "github";
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

  async openGithubPull(number, options = {}) {
    return await this.openGithubRoute(
      {
        kind: "pulls",
        page: options.page,
        number,
      },
      options,
    );
  }

  async openGithubPullFiles(number, options = {}) {
    return await this.openGithubRoute(
      {
        kind: "pulls",
        page: options.page,
        number,
        files: true,
        path: "",
      },
      options,
    );
  }

  async openGithubPullFile(path, status = "") {
    if (!path) {
      return null;
    }

    this.filesPage.clearSelectedFile();
    this.gitLayout.setSelectedPath("");
    this.workspaceMode = "github";
    const file = await this.githubLayout.openPullFile(path, status);
    this.updateWorkspaceChrome();
    return file;
  }

  changeCompareRefs(baseRef, headRef) {
    if (this.workspaceMode !== "git" || this.gitLayout.activeMode !== "compare") {
      return;
    }

    this.gitLayout.changeCompareRefs(baseRef, headRef);
  }

  changeLogPage(page) {
    if (this.workspaceMode !== "git" || this.gitLayout.activeMode !== "log") {
      return;
    }

    this.gitLayout.changeLogPage(page);
  }

  changeGithubIssuesPage(page) {
    if (this.workspaceMode !== "github" || this.githubLayout.activeMode !== "issues") {
      return;
    }

    const nextPage = Number.parseInt(`${page}`, 10);
    if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === this.githubLayout.issuesPage) {
      return;
    }

    this.githubLayout.changeIssuesPage(nextPage);
  }

  changeGithubPullsPage(page) {
    if (this.workspaceMode !== "github" || this.githubLayout.activeMode !== "pulls") {
      return;
    }

    const nextPage = Number.parseInt(`${page}`, 10);
    if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === this.githubLayout.pullsPage) {
      return;
    }

    this.githubLayout.changePullsPage(nextPage);
  }

  openDiffWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "git";
    this.gitLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
    });
    this.gitLayout.openDiffWorkspace(options);
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
  }

  async openCompareWorkspace(options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    this.workspaceMode = "git";
    this.gitLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
    });
    const comparePromise = this.gitLayout.openCompareWorkspace({
      baseRef: options.baseRef,
      headRef: options.headRef,
      preserveViewer: options.preserveViewer,
      skipReload: options.skipReload,
    });
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
    const compare = await comparePromise;
    this.updateWorkspaceChrome();
    return compare;
  }

  async openGithubIssuesWorkspace(options = {}) {
    return await this.openGithubRoute(
      {
        kind: "issues",
        page: options.page ?? 1,
      },
      options,
    );
  }

  async openGithubPullsWorkspace(options = {}) {
    return await this.openGithubRoute(
      {
        kind: "pulls",
        page: options.page ?? 1,
      },
      options,
    );
  }

  async openLogWorkspace(options = {}) {
    if (!this.gitRepository) {
      return null;
    }

    this.workspaceMode = "git";
    this.gitLayout.setContext({
      path: this.currentPath,
      repository: this.gitRepository,
    });
    const logPromise = this.gitLayout.openLogWorkspace({
      page: options.page ?? 1,
      skipReload: options.skipReload,
    });
    this.reviewWorkspace.open("git", this.workspaceDetails());
    this.updateGitButton();
    const log = await logPromise;
    this.updateWorkspaceChrome();
    return log;
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

  backReviewWorkspace() {
    if (this.workspaceMode === "git" && this.gitLayout.back()) {
      this.updateWorkspaceChrome();
      return;
    }

    if (this.workspaceMode === "github" && this.githubLayout.back()) {
      this.updateWorkspaceChrome();
    }
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
