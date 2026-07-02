import {
  createProject,
  deleteProject,
  getGitCommit,
  getGitCommitDiff,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
  getGitHubIssue,
  getGitHubIssues,
  getGitHubStatus,
  getGitDiff,
  getGitLog,
  getGitStatus,
  getHealth,
  getProjectCandidate,
  listDirectory,
  listProjects,
  openProject,
  readFile,
  renameProject,
} from "../api.js";
import { parentRoute, parseRoute, routeEquals, routeUrl } from "../navigation-routes.js";
import { fileNameFromPath, imageTypeLabel, isPreviewableImagePath } from "./dom.js";
import "./pathbar.js";
import "./project-switcher.js";
import "./header-actions.js";
import "./file-list.js";
import "./file-viewer.js";
import "./changes-tree.js";
import "./log-list.js";
import "./commit-changes-tree.js";
import "./compare-tree.js";
import "./github-issues-list.js";
import "./github-issue-viewer.js";
import "./review-workspace.js";

const LOADING_DELAY_MS = 180;
const LAST_DIRECTORY_KEY_PREFIX = "caffold:last-directory-path";
const GITHUB_ISSUES_PER_PAGE = 50;
const LEFT_PANEL_DEFAULT_WIDTH = 320;
const LEFT_PANEL_MIN_WIDTH = 180;
const LEFT_PANEL_VIEWER_MIN_WIDTH = 320;
const LEFT_PANEL_MAX_RATIO = 0.7;

class CaffoldAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.currentPath = "";
    this.directoryRequestId = 0;
    this.fileRequestId = 0;
    this.gitStatusRequestId = 0;
    this.gitLogRequestId = 0;
    this.gitCommitRequestId = 0;
    this.gitCompareRequestId = 0;
    this.gitRefsRequestId = 0;
    this.githubStatusRequestId = 0;
    this.githubIssuesRequestId = 0;
    this.githubIssueRequestId = 0;
    this.projectRequestId = 0;
    this.gitStatus = null;
    this.githubStatus = null;
    this.githubIssues = null;
    this.projects = [];
    this.projectCandidate = null;
    this.currentProjectId = null;
    this.gitCompare = null;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.workspaceMode = null;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.logPage = 1;
    this.githubIssuesPage = 1;
    this.selectedCommitSummary = null;
    this.selectedGithubIssueSummary = null;
    this.scrollPositions = {};
    this.currentRoute = null;
    this.isApplyingRoute = false;
    this.routedProject = null;
    this.browserView = "list";
    this.setBrowserView(this.browserView);
    this.leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH;
    this.resizePointerId = null;
    this.render();
    this.appMain = this.querySelector(".app-main");
    this.pathbar = this.querySelector("caffold-pathbar");
    this.projectSwitcher = this.querySelector("caffold-project-switcher");
    this.headerActions = this.querySelector("caffold-header-actions");
    this.fileList = this.querySelector("caffold-file-list");
    this.panelResizer = this.querySelector(".panel-resizer");
    this.fileViewer = this.querySelector("caffold-file-viewer");
    this.reviewWorkspace = this.querySelector("caffold-review-workspace");
    this.reviewWorkspace.ensureRendered();
    this.changesTree = this.reviewWorkspace.querySelector("caffold-changes-tree");
    this.logList = this.reviewWorkspace.querySelector("caffold-log-list");
    this.commitChangesTree = this.reviewWorkspace.querySelector("caffold-commit-changes-tree");
    this.compareTree = this.reviewWorkspace.querySelector("caffold-compare-tree");
    this.githubIssuesList = this.reviewWorkspace.querySelector("caffold-github-issues-list");
    this.githubIssueViewer = this.reviewWorkspace.querySelector("caffold-github-issue-viewer");
    this.diffWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-diff caffold-review-file-viewer",
    );
    this.logWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-log caffold-review-file-viewer",
    );
    this.compareWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-compare caffold-review-file-viewer",
    );
    this.fileViewer.setCloseLabel("Back to files");
    this.diffWorkspaceViewer.setCloseLabel("Back to changes");
    this.logWorkspaceViewer.setCloseLabel("Back to commit");
    this.compareWorkspaceViewer.setCloseLabel("Back to compare");
    this.applyLeftPanelWidth(this.leftPanelWidth);

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
    this.addEventListener("caffold:open-diff-workspace", () => {
      this.navigateToCurrentProjectRoute({ kind: "diff", path: "" }) || this.openDiffWorkspace();
    });
    this.addEventListener("caffold:open-log-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "log",
        page: this.logPage,
      }) || this.openLogWorkspace();
    });
    this.addEventListener("caffold:open-compare-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "compare",
        baseRef: this.compareBaseRef ?? "",
        headRef: this.compareHeadRef ?? "",
        path: "",
      }) || this.openCompareWorkspace();
    });
    this.addEventListener("caffold:open-github-issues-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: this.githubIssuesPage,
      }) || this.openGithubIssuesWorkspace();
    });
    this.addEventListener("caffold:close-review-workspace", () => {
      this.navigateToReviewParent({ closeWorkspace: true }) || this.closeReviewWorkspace();
    });
    this.addEventListener("caffold:back-review-workspace", () => {
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
        page: this.logPage,
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
        page: this.logPage,
        sha: event.detail.sha,
        path: this.projectRelativePath(event.detail.path),
      }) || this.openCommitDiff(event.detail.sha, event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "compare",
        baseRef: this.compareBaseRef ?? "",
        headRef: this.compareHeadRef ?? "",
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
    this.addEventListener("caffold:open-github-issue", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: this.githubIssuesPage,
        number: event.detail.number,
      }) || this.openGithubIssue(event.detail.number);
    });
    this.addEventListener("caffold:change-github-issues-page", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "issues",
        page: event.detail.page,
      }) || this.changeGithubIssuesPage(event.detail.page);
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
    this.panelResizer.addEventListener("pointerdown", (event) => {
      this.startLeftPanelResize(event);
    });
    this.panelResizer.addEventListener("pointermove", (event) => {
      this.moveLeftPanelResize(event);
    });
    this.panelResizer.addEventListener("pointerup", (event) => {
      this.endLeftPanelResize(event);
    });
    this.panelResizer.addEventListener("pointercancel", (event) => {
      this.endLeftPanelResize(event);
    });
    this.panelResizer.addEventListener("keydown", (event) => {
      this.adjustLeftPanelWidthFromKeyboard(event);
    });

    this.bootstrap();
  }

  render() {
    this.innerHTML = `
      <header class="app-header">
        <div class="app-context">
          <div class="brand">
            <strong>Caffold</strong>
          </div>
          <caffold-project-switcher></caffold-project-switcher>
          <caffold-header-actions></caffold-header-actions>
        </div>
      </header>
      <caffold-pathbar></caffold-pathbar>
      <main class="app-main" aria-label="File browser">
        <caffold-file-list></caffold-file-list>
        <div
          class="panel-resizer"
          role="separator"
          aria-label="Resize left panel"
          aria-orientation="vertical"
          tabindex="0"
        ></div>
        <caffold-file-viewer></caffold-file-viewer>
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
    this.fileViewer.setEmpty();

    try {
      const health = await getHealth();
      this.storageKey = `${LAST_DIRECTORY_KEY_PREFIX}:${health.root}`;
      this.pathbar.homePath = health.homePath ?? null;
      const initialRoute = parseRoute(window.location.href);
      if (initialRoute) {
        await this.applyRoute(initialRoute);
        return;
      }

      const fallbackPath = health.initialPath ?? "";
      const initialPath = this.loadStoredDirectoryPath() ?? fallbackPath;
      await this.loadDirectory(initialPath, { fallbackPath });
      this.replaceWithCurrentProjectFileRoute();
    } catch (error) {
      this.fileList.setError(error);
      this.fileViewer.setError("", error);
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
      } else if (route.kind === "issues") {
        await this.applyIssuesRoute(project, route);
      }

      return true;
    } catch (error) {
      this.fileList.setError(error);
      this.fileViewer.setError("", error);
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
      this.openDiffWorkspace();
      if (!route.path) {
        this.changesTree.setSelectedPath("");
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.gitStatus?.files?.find((entry) => entry.path === fullPath);
      await this.openDiff(
        fullPath,
        file?.untracked ? "untracked" : file?.category ?? "unstaged",
        file?.status ?? "",
      );
      return;
    }

    await this.loadDirectory(project.relativePath);
    this.openDiffWorkspace();
    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    await this.ensureGitStatus();
    const file = this.gitStatus?.files?.find((entry) => entry.path === fullPath);
    await this.openDiff(
      fullPath,
      file?.untracked ? "untracked" : file?.category ?? "unstaged",
      file?.status ?? "",
    );
  }

  async applyCompareRoute(project, route) {
    if (this.canApplyLoadedCompareRoute(project, route)) {
      this.compareBaseRef = route.baseRef || null;
      this.compareHeadRef = route.headRef || null;
      this.openCompareWorkspace({ skipReload: true });
      if (!route.path) {
        this.compareTree.setSelectedPath("");
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.gitCompare?.files?.find((entry) => entry.path === fullPath);
      await this.openCompareDiff(fullPath, file?.status ?? "");
      return;
    }

    await this.loadDirectory(project.relativePath);
    this.compareBaseRef = route.baseRef || null;
    this.compareHeadRef = route.headRef || null;
    await this.openCompareWorkspace();
    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    const file = this.gitCompare?.files?.find((entry) => entry.path === fullPath);
    await this.openCompareDiff(fullPath, file?.status ?? "");
  }

  async applyLogRoute(project, route) {
    if (this.canApplyLoadedLogRoute(project, route)) {
      if (!route.sha) {
        await this.openLogWorkspace({
          page: route.page,
          skipReload: true,
        });
        return;
      }

      this.logPage = route.page ?? this.logPage;
      await this.openLogWorkspace({
        preserveViewer: true,
        skipReload: true,
        view: "detail",
      });
      if (!route.path) {
        this.commitChangesTree.setSelectedPath("");
        this.logWorkspaceViewer.setEmpty();
        this.showCommitFileList();
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.commitChangesTree.state?.commitPayload?.files?.find(
        (entry) => entry.path === fullPath,
      );
      await this.openCommitDiff(route.sha, fullPath, file?.status ?? "");
      return;
    }

    await this.loadDirectory(project.relativePath);
    if (!route.sha) {
      await this.openLogWorkspace({ page: route.page });
      return;
    }

    this.logPage = route.page ?? this.logPage;
    await this.openCommit(route.sha);
    if (!route.path) {
      return;
    }

    const fullPath = this.projectPath(project, route.path);
    const file = this.commitChangesTree.state?.commitPayload?.files?.find(
      (entry) => entry.path === fullPath,
    );
    await this.openCommitDiff(route.sha, fullPath, file?.status ?? "");
  }

  async applyIssuesRoute(project, route) {
    if (this.canApplyLoadedIssuesRoute(project, route)) {
      await this.openGithubIssuesWorkspace({
        page: route.page,
        skipReload: true,
      });
      if (route.number) {
        await this.openGithubIssue(route.number);
      }
      return;
    }

    await this.loadDirectory(project.relativePath);
    await this.openGithubIssuesWorkspace({ page: route.page });
    if (route.number) {
      await this.openGithubIssue(route.number);
    }
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
    const requestId = ++this.directoryRequestId;
    this.fileRequestId += 1;
    if (!this.isApplyingRoute && !options.preserveRoute) {
      this.currentRoute = null;
    }
    this.setBrowserView("list");
    this.currentPath = path ?? "";
    this.fileList.setSelectedPath("");
    this.pathbar.path = this.currentPath;
    this.fileViewer.setEmpty();
    const loadingTimer = this.showDirectoryLoadingAfterDelay(requestId);

    try {
      const directory = await listDirectory(this.currentPath);
      if (requestId !== this.directoryRequestId) {
        return;
      }

      window.clearTimeout(loadingTimer);
      this.currentPath = directory.path;
      this.pathbar.path = directory.path;
      this.fileList.setDirectory(directory);
      this.updateGitContext(directory);
      this.storeDirectoryPath(directory.path);
      await this.refreshProjects(directory.path);
      return true;
    } catch (error) {
      if (requestId !== this.directoryRequestId) {
        return false;
      }

      if (
        options.fallbackPath !== undefined &&
        this.currentPath !== options.fallbackPath
      ) {
        this.clearStoredDirectoryPath();
        return this.loadDirectory(options.fallbackPath);
      }

      if (options.allowFailure) {
        return false;
      }

      this.fileList.setError(error);
      this.clearGitContext();
      this.currentProjectId = null;
      this.projectCandidate = null;
      this.renderProjectState({ error });
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openFile(path, entry = null) {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath(path);
    this.rememberScroller("files", this.fileList, ".file-list");
    this.setBrowserView("viewer");
    this.changesTree.setSelectedPath("");
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath("");

    if (isPreviewableImagePath(path)) {
      this.fileViewer.setImage({
        path,
        name: fileNameFromPath(path),
        imageType: imageTypeLabel(path),
        size: entry?.size,
        modifiedMs: entry?.modifiedMs,
      });
      return;
    }

    const loadingTimer = this.showFileLoadingAfterDelay(path, requestId);

    try {
      const file = await readFile(path);
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setFile(file);
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showFileList() {
    this.setBrowserView("list");
    this.restoreScroller("files", this.fileList, ".file-list");
  }

  closeFileViewer(event) {
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    if (event.target === this.fileViewer) {
      if (currentRoute?.kind === "files" && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showFileList();
      return;
    }

    if (event.target === this.diffWorkspaceViewer) {
      if (currentRoute?.kind === "diff" && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showDiffList();
      return;
    }

    if (event.target === this.logWorkspaceViewer) {
      if (currentRoute?.kind === "log" && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showCommitFileList();
      return;
    }

    if (event.target === this.compareWorkspaceViewer) {
      if (currentRoute?.kind === "compare" && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showCompareList();
    }
  }

  setBrowserView(view) {
    const nextView = view === "viewer" ? "viewer" : "list";
    this.browserView = nextView;
    this.setAttribute("data-browser-view", nextView);
  }

  showDiffList() {
    this.diffWorkspaceView = "list";
    this.reviewWorkspace.setDiffView("list");
    this.restoreScroller("changes", this.changesTree, ".changes-tree-list");
  }

  showCompareList() {
    this.compareWorkspaceView = "list";
    this.reviewWorkspace.setCompareView("list");
    this.restoreScroller("compare", this.compareTree, ".compare-tree-list");
  }

  showCommitFileList() {
    this.logDetailFileView = "list";
    this.reviewWorkspace.setLogDetailView("list");
    this.restoreScroller("commit", this.commitChangesTree, ".commit-tree-list");
  }

  rememberScroller(key, host, selector) {
    const scroller = host?.querySelector(selector);
    if (!scroller) {
      return;
    }

    this.scrollPositions[key] = scroller.scrollTop;
  }

  restoreScroller(key, host, selector) {
    const top = this.scrollPositions[key] ?? 0;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = host?.querySelector(selector);
      if (!scroller) {
        return;
      }

      scroller.scrollTop = top;
      window.requestAnimationFrame(() => {
        if (scroller.scrollTop < top - 32) {
          scroller.scrollTop = top;
        }
      });
    });
  }

  async openDiff(path, kind, status = "") {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath(path);
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath("");
    this.rememberScroller("changes", this.changesTree, ".changes-tree-list");
    this.diffWorkspaceView = "viewer";
    this.reviewWorkspace.setDiffView("viewer");
    const loadingTimer = this.showWorkspaceLoadingAfterDelay(
      this.diffWorkspaceViewer,
      `Diff ${path}`,
      requestId,
    );

    try {
      const diff = await getGitDiff(this.currentPath, path, kind);
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.diffWorkspaceViewer.setDiff({ ...diff, status });
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.diffWorkspaceViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openCommit(sha) {
    if (!sha || !this.gitRepository) {
      return;
    }

    const requestId = ++this.gitCommitRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.selectedCommitSummary = {
      shortSha: sha.slice(0, 7),
      subject: "",
    };
    this.logDetailFileView = "list";
    this.openLogWorkspace({
      preserveViewer: true,
      skipReload: true,
      view: "detail",
    });
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath("");
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath("");
    this.commitChangesTree.setLoading(this.gitRepository);
    this.logWorkspaceViewer.setLoading(`Commit ${sha.slice(0, 7)}`);

    try {
      const commit = await getGitCommit(this.currentPath, sha);
      if (requestId !== this.gitCommitRequestId) {
        return;
      }

      this.commitChangesTree.setCommit(commit);
      this.selectedCommitSummary = commit.commit;
      this.updateWorkspaceChrome();
      if (viewerRequestId === this.fileRequestId) {
        this.logWorkspaceViewer.setEmpty();
      }
    } catch (error) {
      if (requestId !== this.gitCommitRequestId) {
        return;
      }

      this.commitChangesTree.setError(error, this.gitRepository);
      if (viewerRequestId === this.fileRequestId) {
        this.logWorkspaceViewer.setError(`Commit ${sha.slice(0, 7)}`, error);
      }
    }
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return;
    }

    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath("");
    this.commitChangesTree.setSelectedPath(path);
    this.compareTree.setSelectedPath("");
    this.rememberScroller("commit", this.commitChangesTree, ".commit-tree-list");
    this.logDetailFileView = "viewer";
    this.reviewWorkspace.setLogDetailView("viewer");
    const loadingTimer = this.showWorkspaceLoadingAfterDelay(
      this.logWorkspaceViewer,
      `Commit diff ${path}`,
      requestId,
    );

    try {
      const diff = await getGitCommitDiff(this.currentPath, sha, path);
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.logWorkspaceViewer.setDiff({ ...diff, status });
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.logWorkspaceViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openCompareDiff(path, status = "") {
    if (!path || !this.gitCompare) {
      return;
    }

    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath("");
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath(path);
    this.rememberScroller("compare", this.compareTree, ".compare-tree-list");
    this.compareWorkspaceView = "viewer";
    this.reviewWorkspace.setCompareView("viewer");
    const loadingTimer = this.showWorkspaceLoadingAfterDelay(
      this.compareWorkspaceViewer,
      `Compare diff ${path}`,
      requestId,
    );

    try {
      const diff = await getGitCompareDiff(
        this.currentPath,
        this.gitCompare.baseRef,
        this.gitCompare.headRef,
        path,
      );
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.compareWorkspaceViewer.setDiff({ ...diff, status });
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.compareWorkspaceViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
    }
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

  canApplyLoadedDiffRoute(project, _route) {
    return (
      this.isProjectRootLoaded(project) &&
      this.workspaceMode === "diff" &&
      Boolean(this.gitRepository) &&
      Boolean(this.gitStatus)
    );
  }

  canApplyLoadedCompareRoute(project, route) {
    const routeBaseRef = route.baseRef || null;
    const routeHeadRef = route.headRef || null;

    return (
      this.isProjectRootLoaded(project) &&
      this.workspaceMode === "compare" &&
      Boolean(this.gitRepository) &&
      Boolean(this.gitCompare) &&
      this.gitCompare.baseRef === routeBaseRef &&
      this.gitCompare.headRef === routeHeadRef
    );
  }

  canApplyLoadedLogRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      this.workspaceMode !== "log" ||
      !this.gitRepository
    ) {
      return false;
    }

    if (!route.sha) {
      return Boolean(this.logList.state?.log) && (route.page ?? this.logPage) === this.logPage;
    }

    const payload = this.commitChangesTree.state?.commitPayload;
    return payload?.commit?.sha === route.sha;
  }

  canApplyLoadedIssuesRoute(project, route) {
    if (
      !this.isProjectRootLoaded(project) ||
      this.workspaceMode !== "issues" ||
      !this.gitRepository ||
      !this.githubIssues
    ) {
      return false;
    }

    return (route.page ?? this.githubIssuesPage) === this.githubIssuesPage;
  }

  async ensureGitStatus() {
    if (!this.gitRepository || this.gitStatus) {
      return;
    }

    await this.loadGitStatus(this.currentPath);
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

  updateGitContext(directory) {
    if (!directory.git) {
      this.clearGitContext();
      return;
    }

    this.gitRepository = directory.git;
    this.gitStatus = null;
    this.githubStatus = null;
    this.githubIssues = null;
    this.gitCompare = null;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.headerActions.gitStatus = {
      branch: directory.git.branch,
      dirty: directory.git.dirty,
      count: null,
      workspaceMode: this.workspaceMode,
    };
    this.headerActions.githubStatus = null;
    this.changesTree.setLoading(directory.git);
    this.githubIssuesList.reset();
    this.githubIssueViewer.setEmpty();
    this.loadGitStatus(directory.path);
    this.loadGithubStatus(directory.path);
    if (this.workspaceMode === "log") {
      this.logPage = 1;
      this.loadGitLog(directory.path, this.logPage);
    } else if (this.workspaceMode === "compare") {
      this.loadGitRefsAndCompare(directory.path);
    } else if (this.workspaceMode === "issues") {
      this.githubIssuesPage = 1;
      this.githubIssuesList.setLoading(null);
    }
    this.updateWorkspaceChrome();
  }

  clearGitContext() {
    this.gitRepository = null;
    this.gitStatus = null;
    this.gitCompare = null;
    this.gitStatusRequestId += 1;
    this.gitLogRequestId += 1;
    this.gitCommitRequestId += 1;
    this.gitCompareRequestId += 1;
    this.gitRefsRequestId += 1;
    this.githubStatusRequestId += 1;
    this.githubIssuesRequestId += 1;
    this.githubIssueRequestId += 1;
    this.logPage = 1;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.githubIssuesPage = 1;
    this.selectedGithubIssueSummary = null;
    this.gitRefs = null;
    this.githubStatus = null;
    this.githubIssues = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.headerActions.gitStatus = null;
    this.headerActions.githubStatus = null;
    this.changesTree.reset();
    this.logList.reset();
    this.commitChangesTree.reset();
    this.compareTree.reset();
    this.githubIssuesList.reset();
    this.githubIssueViewer.setEmpty();
    this.reviewWorkspace.clearCompareRefs();
    this.reviewWorkspace.setDiffView("list");
    this.reviewWorkspace.setCompareView("list");
    this.reviewWorkspace.setLogDetailView("list");
    this.reviewWorkspace.setIssuesView("list");
    this.closeReviewWorkspace();
  }

  async loadGitStatus(path) {
    if (!this.gitRepository) {
      return;
    }

    const requestId = ++this.gitStatusRequestId;
    this.changesTree.setLoading(this.gitRepository);

    try {
      const status = await getGitStatus(path);
      if (requestId !== this.gitStatusRequestId) {
        return;
      }

      this.gitRepository = status.repository;
      this.gitStatus = status;
      this.updateGitButton();
      this.updateWorkspaceChrome();
      this.changesTree.setStatus(status);
    } catch (error) {
      if (requestId !== this.gitStatusRequestId) {
        return;
      }

      this.changesTree.setError(error, this.gitRepository);
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
      if (this.workspaceMode === "issues") {
        if (status.github && status.issuesAvailable) {
          await this.loadGithubIssues(path, "open", this.githubIssuesPage);
        } else {
          this.githubIssuesList.setUnavailable(status);
          this.githubIssueViewer.setEmpty();
        }
      }
      return status;
    } catch (error) {
      if (requestId !== this.githubStatusRequestId) {
        return;
      }

      this.githubStatus = null;
      this.headerActions.githubStatus = null;
      if (this.workspaceMode === "issues") {
        this.githubIssuesList.setError(error);
        this.githubIssueViewer.setEmpty();
      }
    }
  }

  async loadGithubIssues(path, state = "open", page = this.githubIssuesPage) {
    if (!this.gitRepository || !this.githubStatus?.github || !this.githubStatus.issuesAvailable) {
      return;
    }

    const requestId = ++this.githubIssuesRequestId;
    const loadingTimer = this.showGithubIssuesLoadingAfterDelay(requestId);

    try {
      const issues = await getGitHubIssues(path, state, page, GITHUB_ISSUES_PER_PAGE);
      if (requestId !== this.githubIssuesRequestId) {
        return;
      }

      this.githubIssuesPage = issues.page ?? page;
      this.githubIssues = issues;
      this.githubIssuesList.setIssues(issues);
      if (this.issuesWorkspaceView === "list") {
        this.selectedGithubIssueSummary = null;
        this.githubIssueViewer.setEmpty();
      }
      this.updateWorkspaceChrome();
      return issues;
    } catch (error) {
      if (requestId !== this.githubIssuesRequestId) {
        return;
      }

      this.githubIssuesList.setError(error, this.githubStatus);
      this.githubIssueViewer.setEmpty();
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openGithubIssue(number) {
    if (!this.gitRepository || !Number.isFinite(number)) {
      return;
    }

    const requestId = ++this.githubIssueRequestId;
    this.selectedGithubIssueSummary =
      this.githubIssues?.issues?.find((issue) => issue.number === number) ?? { number };
    this.issuesWorkspaceView = "detail";
    this.reviewWorkspace.setIssuesView("detail");
    this.updateWorkspaceChrome();
    this.githubIssuesList.setSelectedIssue(number);
    this.githubIssueViewer.setLoading(number);

    try {
      const issue = await getGitHubIssue(this.currentPath, number);
      if (requestId !== this.githubIssueRequestId) {
        return;
      }

      this.githubIssueViewer.setIssue(issue);
      this.selectedGithubIssueSummary = issue.issue;
      this.updateWorkspaceChrome();
      return issue;
    } catch (error) {
      if (requestId !== this.githubIssueRequestId) {
        return;
      }

      this.githubIssueViewer.setError(number, error);
    }
  }

  async loadGitLog(path, page = this.logPage) {
    if (!this.gitRepository) {
      return;
    }

    const requestId = ++this.gitLogRequestId;
    const loadingTimer = this.showGitLogLoadingAfterDelay(requestId);

    try {
      const log = await getGitLog(path, page);
      if (requestId !== this.gitLogRequestId) {
        return;
      }

      this.logPage = log.page ?? page;
      this.gitRepository = log.repository;
      this.updateGitButton();
      this.updateWorkspaceChrome();
      this.logList.setLog(log);
      return log;
    } catch (error) {
      if (requestId !== this.gitLogRequestId) {
        return;
      }

      this.logList.setError(error, this.gitRepository);
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async loadGitRefsAndCompare(path) {
    if (!this.gitRepository) {
      return;
    }

    const requestId = ++this.gitRefsRequestId;
    this.compareTree.setLoading(this.gitRepository);
    this.reviewWorkspace.setCompareRefs(this.gitRefs, this.compareBaseRef, this.compareHeadRef);
    this.showCompareList();
    this.compareWorkspaceViewer.setEmpty();

    try {
      const refs = await getGitRefs(path);
      if (requestId !== this.gitRefsRequestId) {
        return;
      }

      this.gitRefs = refs;
      this.gitRepository = refs.repository;
      this.compareBaseRef = chooseCompareRef(this.compareBaseRef, refs.defaultBaseRef, refs.refs);
      this.compareHeadRef = chooseCompareRef(this.compareHeadRef, refs.defaultHeadRef, refs.refs);
      this.reviewWorkspace.setCompareRefs(this.gitRefs, this.compareBaseRef, this.compareHeadRef);
      this.updateGitButton();
      this.updateWorkspaceChrome();
      return await this.loadGitCompare(path, this.compareBaseRef, this.compareHeadRef);
    } catch (error) {
      if (requestId !== this.gitRefsRequestId) {
        return;
      }

      this.compareTree.setError(error, this.gitRepository);
    }
  }

  async loadGitCompare(path, baseRef = this.compareBaseRef, headRef = this.compareHeadRef) {
    if (!this.gitRepository) {
      return;
    }

    const requestId = ++this.gitCompareRequestId;
    this.compareTree.setLoading(this.gitRepository);
    this.reviewWorkspace.setCompareRefs(this.gitRefs, baseRef, headRef);

    try {
      const compare = await getGitCompare(path, baseRef, headRef);
      if (requestId !== this.gitCompareRequestId) {
        return;
      }

      this.compareBaseRef = compare.baseRef;
      this.compareHeadRef = compare.headRef;
      this.gitCompare = compare;
      this.gitRepository = compare.repository;
      this.reviewWorkspace.setCompareRefs(this.gitRefs, this.compareBaseRef, this.compareHeadRef);
      this.updateGitButton();
      this.updateWorkspaceChrome();
      this.compareTree.setCompare(compare);
      return compare;
    } catch (error) {
      if (requestId !== this.gitCompareRequestId) {
        return;
      }

      this.compareTree.setError(error, this.gitRepository);
    }
  }

  changeCompareRefs(baseRef, headRef) {
    if (this.workspaceMode !== "compare") {
      return;
    }

    if (!baseRef || !headRef || (baseRef === this.compareBaseRef && headRef === this.compareHeadRef)) {
      return;
    }

    this.compareBaseRef = baseRef;
    this.compareHeadRef = headRef;
    this.gitCompare = null;
    this.compareTree.setSelectedPath("");
    this.reviewWorkspace.setCompareRefs(this.gitRefs, baseRef, headRef);
    this.showCompareList();
    this.compareWorkspaceViewer.setEmpty();
    this.loadGitCompare(this.currentPath, baseRef, headRef);
  }

  changeLogPage(page) {
    if (this.workspaceMode !== "log" || this.logWorkspaceView !== "list") {
      return;
    }

    const nextPage = Number.parseInt(`${page}`, 10);
    if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === this.logPage) {
      return;
    }

    this.loadGitLog(this.currentPath, nextPage);
  }

  changeGithubIssuesPage(page) {
    if (this.workspaceMode !== "issues") {
      return;
    }

    const nextPage = Number.parseInt(`${page}`, 10);
    if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === this.githubIssuesPage) {
      return;
    }

    this.githubIssuesPage = nextPage;
    this.loadGithubIssues(this.currentPath, "open", nextPage);
  }

  openDiffWorkspace() {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "diff";
    this.diffWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.reviewWorkspace.open("diff", {
      title: "Diff",
      subtitle: this.workspaceSubtitle("Working tree"),
      backVisible: false,
    });
    this.reviewWorkspace.setDiffView("list");
    this.updateGitButton();
    if (!this.gitStatus) {
      this.changesTree.setLoading(this.gitRepository);
    }
    this.diffWorkspaceViewer.setEmpty();
  }

  openCompareWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "compare";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.reviewWorkspace.open("compare", {
      title: "Compare",
      subtitle: this.compareSubtitle(),
      backVisible: false,
    });
    this.reviewWorkspace.setCompareView("list");
    this.reviewWorkspace.setCompareRefs(this.gitRefs, this.compareBaseRef, this.compareHeadRef);
    this.updateGitButton();
    this.compareWorkspaceViewer.setEmpty();
    if (options.skipReload) {
      return;
    }

    return this.loadGitRefsAndCompare(this.currentPath);
  }

  async openGithubIssuesWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "issues";
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.githubIssuesPage = options.page ?? 1;
    this.selectedGithubIssueSummary = null;
    this.reviewWorkspace.open("issues", this.workspaceDetails());
    this.reviewWorkspace.setIssuesView(this.issuesWorkspaceView);
    this.updateGitButton();
    this.githubIssueViewer.setEmpty();
    if (options.skipReload) {
      return;
    }

    if (!this.githubStatus) {
      this.githubIssuesList.setLoading(null);
      return await this.loadGithubStatus(this.currentPath);
    }

    if (!this.githubStatus.github || !this.githubStatus.issuesAvailable) {
      this.githubIssuesList.setUnavailable(this.githubStatus);
      return;
    }

    return await this.loadGithubIssues(this.currentPath, "open", this.githubIssuesPage);
  }

  async openLogWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "log";
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = options.view ?? "list";
    this.logDetailFileView = this.logWorkspaceView === "detail" ? this.logDetailFileView : "list";
    if (!options.skipReload) {
      this.logPage = options.page ?? 1;
    }
    if (this.logWorkspaceView === "list") {
      this.selectedCommitSummary = null;
    }
    this.reviewWorkspace.open("log", this.workspaceDetails());
    this.reviewWorkspace.setLogView(this.logWorkspaceView);
    this.reviewWorkspace.setLogDetailView(this.logDetailFileView);
    this.updateGitButton();
    if (!options.preserveViewer) {
      this.commitChangesTree.reset();
      this.logWorkspaceViewer.setEmpty();
    }
    if (!options.skipReload) {
      return await this.loadGitLog(this.currentPath, this.logPage);
    }
  }

  closeReviewWorkspace() {
    this.workspaceMode = null;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.logPage = 1;
    this.githubIssuesPage = 1;
    this.selectedCommitSummary = null;
    this.selectedGithubIssueSummary = null;
    this.githubIssuesList.setSelectedIssue(null);
    this.reviewWorkspace.setDiffView("list");
    this.reviewWorkspace.setCompareView("list");
    this.reviewWorkspace.setLogDetailView("list");
    this.reviewWorkspace.setIssuesView("list");
    this.reviewWorkspace.close();
    this.updateGitButton();
  }

  backReviewWorkspace() {
    if (this.workspaceMode === "log" && this.logWorkspaceView === "detail") {
      this.gitCommitRequestId += 1;
      this.fileRequestId += 1;
      this.logWorkspaceView = "list";
      this.logDetailFileView = "list";
      this.reviewWorkspace.setLogView("list");
      this.reviewWorkspace.setLogDetailView("list");
      this.updateWorkspaceChrome();
      return;
    }

    if (this.workspaceMode === "issues" && this.issuesWorkspaceView === "detail") {
      this.githubIssueRequestId += 1;
      this.issuesWorkspaceView = "list";
      this.selectedGithubIssueSummary = null;
      this.githubIssuesList.setSelectedIssue(null);
      this.githubIssueViewer.setEmpty();
      this.reviewWorkspace.setIssuesView("list");
      this.updateWorkspaceChrome();
    }
  }

  updateWorkspaceChrome() {
    if (!this.workspaceMode) {
      return;
    }

    this.reviewWorkspace.updateDetails(this.workspaceDetails());
    if (this.workspaceMode === "diff") {
      this.reviewWorkspace.setDiffView(this.diffWorkspaceView);
    }
    if (this.workspaceMode === "compare") {
      this.reviewWorkspace.setCompareView(this.compareWorkspaceView);
    }
    if (this.workspaceMode === "log") {
      this.reviewWorkspace.setLogView(this.logWorkspaceView);
      this.reviewWorkspace.setLogDetailView(this.logDetailFileView);
    }
    if (this.workspaceMode === "issues") {
      this.reviewWorkspace.setIssuesView(this.issuesWorkspaceView);
    }
  }

  updateGitButton() {
    if (!this.gitRepository) {
      this.headerActions.gitStatus = null;
      return;
    }

    this.headerActions.gitStatus = {
      branch: this.gitRepository.branch,
      dirty: this.gitRepository.dirty,
      count: this.gitStatus?.files.length ?? null,
      workspaceMode: this.workspaceMode,
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
    if (this.workspaceMode === "diff") {
      return {
        title: "Diff",
        subtitle: this.workspaceSubtitle("Working tree"),
        backVisible: false,
      };
    }

    if (this.workspaceMode === "compare") {
      return {
        title: "Compare",
        subtitle: this.compareSubtitle(),
        backVisible: false,
      };
    }

    if (this.workspaceMode === "log" && this.logWorkspaceView === "detail") {
      return {
        title: "Commit",
        subtitle: this.commitSubtitle(),
        backVisible: true,
        backLabel: "Back to log",
      };
    }

    if (this.workspaceMode === "log") {
      return {
        title: "Log",
        subtitle: this.workspaceSubtitle("History"),
        backVisible: false,
      };
    }

    if (this.workspaceMode === "issues" && this.issuesWorkspaceView === "detail") {
      return {
        title: "Issue",
        subtitle: this.githubIssueSubtitle(),
        backVisible: true,
        backLabel: "Back to issues",
      };
    }

    return {
      title: "Issues",
      subtitle: this.githubIssuesSubtitle(),
      backVisible: false,
    };
  }

  commitSubtitle() {
    const shortSha = this.selectedCommitSummary?.shortSha ?? "";
    const subject = this.selectedCommitSummary?.subject ?? "";
    return [shortSha, subject].filter(Boolean).join(" ");
  }

  compareSubtitle() {
    if (!this.gitCompare) {
      return this.workspaceSubtitle("Branches");
    }

    const count = this.gitCompare.files?.length ?? 0;
    const countLabel = `${count} ${count === 1 ? "file" : "files"}`;
    if ((this.gitRefs?.refs ?? []).length > 0) {
      return countLabel;
    }

    return `${this.gitCompare.baseRef}...${this.gitCompare.headRef} · ${countLabel}`;
  }

  githubIssuesSubtitle() {
    if (!this.githubStatus?.github) {
      return "GitHub";
    }

    const count = this.githubIssues?.totalIssues;
    const countLabel = count === undefined ? "" : ` · ${count} issues`;
    return `${this.githubStatus.github.nameWithOwner}${countLabel}`;
  }

  githubIssueSubtitle() {
    const issue = this.selectedGithubIssueSummary;
    if (!issue) {
      return "";
    }

    const number = issue.number === undefined ? "" : `#${issue.number}`;
    const title = issue.title ?? "";
    return [number, title].filter(Boolean).join(" ");
  }

  startLeftPanelResize(event) {
    if (!this.canResizeLeftPanel()) {
      return;
    }

    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.panelResizer.setPointerCapture(event.pointerId);
    this.classList.add("is-resizing-left-panel");
    this.updateLeftPanelWidthFromPointer(event);
  }

  moveLeftPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    this.updateLeftPanelWidthFromPointer(event);
  }

  endLeftPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    this.resizePointerId = null;
    this.classList.remove("is-resizing-left-panel");
    if (this.panelResizer.hasPointerCapture(event.pointerId)) {
      this.panelResizer.releasePointerCapture(event.pointerId);
    }
  }

  adjustLeftPanelWidthFromKeyboard(event) {
    if (!this.canResizeLeftPanel()) {
      return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextWidth = this.leftPanelWidth;

    if (event.key === "ArrowLeft") {
      nextWidth -= step;
    } else if (event.key === "ArrowRight") {
      nextWidth += step;
    } else if (event.key === "Home") {
      nextWidth = LEFT_PANEL_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.leftPanelMaxWidth();
    } else {
      return;
    }

    event.preventDefault();
    this.applyLeftPanelWidth(nextWidth);
  }

  updateLeftPanelWidthFromPointer(event) {
    const rect = this.appMain.getBoundingClientRect();
    this.applyLeftPanelWidth(event.clientX - rect.left);
  }

  applyLeftPanelWidth(width) {
    const nextWidth = this.clampLeftPanelWidth(width);
    this.leftPanelWidth = nextWidth;
    this.appMain.style.setProperty("--left-panel-width", `${nextWidth}px`);
    this.panelResizer.setAttribute("aria-valuemin", `${LEFT_PANEL_MIN_WIDTH}`);
    this.panelResizer.setAttribute("aria-valuemax", `${this.leftPanelMaxWidth()}`);
    this.panelResizer.setAttribute("aria-valuenow", `${nextWidth}`);
  }

  clampLeftPanelWidth(width) {
    return Math.min(Math.max(Math.round(width), LEFT_PANEL_MIN_WIDTH), this.leftPanelMaxWidth());
  }

  leftPanelMaxWidth() {
    const appWidth = this.appMain?.getBoundingClientRect().width ?? LEFT_PANEL_DEFAULT_WIDTH;
    const ratioMax = Math.round(appWidth * LEFT_PANEL_MAX_RATIO);
    const viewerMax = Math.max(LEFT_PANEL_MIN_WIDTH, appWidth - LEFT_PANEL_VIEWER_MIN_WIDTH);
    return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(ratioMax, viewerMax));
  }

  canResizeLeftPanel() {
    return (
      this.appMain &&
      this.panelResizer &&
      window.matchMedia("(min-width: 861px)").matches
    );
  }

  showDirectoryLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.directoryRequestId) {
        this.fileList.setLoading();
      }
    }, LOADING_DELAY_MS);
  }

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  showWorkspaceLoadingAfterDelay(viewer, path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        viewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  showGitLogLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.gitLogRequestId) {
        this.logList.setLoading(this.gitRepository);
      }
    }, LOADING_DELAY_MS);
  }

  showGithubIssuesLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.githubIssuesRequestId) {
        this.githubIssuesList.setLoading(
          this.githubStatus,
          this.githubIssues,
          this.githubIssuesPage,
        );
      }
    }, LOADING_DELAY_MS);
  }

  loadStoredDirectoryPath() {
    if (!this.storageKey) {
      return null;
    }

    try {
      return window.localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  storeDirectoryPath(path) {
    if (!this.storageKey) {
      return;
    }

    try {
      window.localStorage.setItem(this.storageKey, path);
    } catch {
      // localStorage can be unavailable in private or restricted browser contexts.
    }
  }

  clearStoredDirectoryPath() {
    if (!this.storageKey) {
      return;
    }

    try {
      window.localStorage.removeItem(this.storageKey);
    } catch {
      // Ignore storage failures; the app can always fall back to health.initialPath.
    }
  }
}

customElements.define("caffold-app-shell", CaffoldAppShell);

function chooseCompareRef(preferredRef, fallbackRef, refs = []) {
  const names = new Set((refs ?? []).map((ref) => ref.name));
  if (preferredRef && names.has(preferredRef)) {
    return preferredRef;
  }

  if (fallbackRef && names.has(fallbackRef)) {
    return fallbackRef;
  }

  return refs?.[0]?.name ?? fallbackRef ?? preferredRef ?? null;
}

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
