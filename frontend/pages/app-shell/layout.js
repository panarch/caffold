import {
  createProject,
  deleteProject,
  getCodexStatus,
  getGitCommit,
  getGitCommitDiff,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
  getGitHubIssue,
  getGitHubIssues,
  getGitHubPull,
  getGitHubPullFile,
  getGitHubPullFiles,
  getGitHubPulls,
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
} from "../../api.js";
import { parentRoute, parseRoute, routeEquals, routeUrl } from "../../navigation-routes.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "../../components/dom.js";
import "../../components/pathbar.js";
import "../../components/project-switcher.js";
import "../../components/header-actions.js";
import "./files/page.js";
import "./review-workspace/git/working-tree/page.js";
import "./review-workspace/git/log/page.js";
import "./review-workspace/git/compare/page.js";
import "./review-workspace/github/issues/layout.js";
import "./review-workspace/github/pulls/layout.js";
import "./review-workspace/layout.js";

const LOADING_DELAY_MS = 180;
const LAST_DIRECTORY_KEY_PREFIX = "caffold:last-directory-path";
const GITHUB_ISSUES_PER_PAGE = 50;
const GITHUB_PULLS_PER_PAGE = 50;
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
    this.githubPullsRequestId = 0;
    this.githubPullRequestId = 0;
    this.githubPullFilesRequestId = 0;
    this.codexStatusRequestId = 0;
    this.projectRequestId = 0;
    this.gitStatus = null;
    this.githubStatus = null;
    this.codexStatus = null;
    this.githubIssues = null;
    this.githubPulls = null;
    this.githubPullFiles = null;
    this.projects = [];
    this.projectCandidate = null;
    this.currentProjectId = null;
    this.gitCompare = null;
    this.pendingGitCompare = null;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.workspaceMode = null;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.pullsWorkspaceView = "list";
    this.pullFilesView = "list";
    this.logPage = 1;
    this.githubIssuesPage = 1;
    this.githubPullsPage = 1;
    this.selectedCommitSummary = null;
    this.selectedGithubIssueSummary = null;
    this.selectedGithubPullSummary = null;
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
    this.filesPage = this.querySelector("caffold-files-page");
    this.filesPage.ensureRendered();
    this.filesPage.setAttribute("data-browser-view", this.browserView);
    this.pathbar = this.querySelector("caffold-pathbar");
    this.projectSwitcher = this.querySelector("caffold-project-switcher");
    this.headerActions = this.querySelector("caffold-header-actions");
    this.fileList = this.filesPage.querySelector("caffold-file-list");
    this.panelResizer = this.filesPage.querySelector(".panel-resizer");
    this.fileViewer = this.filesPage.querySelector("caffold-file-viewer");
    this.reviewWorkspace = this.querySelector("caffold-review-workspace");
    this.reviewWorkspace.ensureRendered();
    this.changesTree = this.reviewWorkspace.querySelector("caffold-git-working-tree-page");
    this.logList = this.reviewWorkspace.querySelector("caffold-log-list");
    this.commitChangesTree = this.reviewWorkspace.querySelector("caffold-commit-changes-tree");
    this.compareTree = this.reviewWorkspace.querySelector("caffold-git-compare-page");
    this.githubIssuesList = this.reviewWorkspace.querySelector(
      "caffold-github-issues-list-page",
    );
    this.githubIssueViewer = this.reviewWorkspace.querySelector(
      "caffold-github-issue-detail-page",
    );
    this.githubPullsList = this.reviewWorkspace.querySelector("caffold-github-pulls-list-page");
    this.githubPullViewer = this.reviewWorkspace.querySelector("caffold-github-pull-detail-page");
    this.githubPullFilesPage = this.reviewWorkspace.querySelector(
      "caffold-github-pull-files-page",
    );
    this.diffWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-diff caffold-review-file-viewer",
    );
    this.logWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-log caffold-review-file-viewer",
    );
    this.compareWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-compare caffold-review-file-viewer",
    );
    this.pullWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-pulls caffold-review-file-viewer",
    );
    this.fileViewer.setCloseLabel("Back to files");
    this.diffWorkspaceViewer.setCloseLabel("Back to changes");
    this.logWorkspaceViewer.setCloseLabel("Back to commit");
    this.compareWorkspaceViewer.setCloseLabel("Back to compare");
    this.pullWorkspaceViewer.setCloseLabel("Back to PR files");
    this.applyLeftPanelWidth(this.leftPanelWidth);
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
    this.addEventListener("caffold:open-github-pulls-workspace", () => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: this.githubPullsPage,
      }) || this.openGithubPullsWorkspace();
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
    this.addEventListener("caffold:open-github-pull", (event) => {
      this.navigateToCurrentProjectRoute({
        kind: "pulls",
        page: this.githubPullsPage,
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
        page: this.githubPullsPage,
        number: event.detail.number,
        files: true,
        path: "",
      }) || this.openGithubPullFiles(event.detail.number);
    });
    this.addEventListener("caffold:open-github-pull-file", (event) => {
      const number = this.selectedGithubPullSummary?.number ?? this.githubPullFiles?.number;
      const path = this.projectRelativePath(event.detail.path);
      if (number && path !== null) {
        this.navigateToCurrentProjectRoute({
          kind: "pulls",
          page: this.githubPullsPage,
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
      } else if (route.kind === "pulls") {
        await this.applyPullsRoute(project, route);
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
    const loadedEntry = this.fileList.entryForPath(fullPath);
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

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    this.openDiffWorkspace({ preserveViewer: Boolean(route.path) });
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
    const routeBaseRef = route.baseRef || null;
    const routeHeadRef = route.headRef || null;

    if (this.canApplyLoadedCompareRoute(project, route)) {
      this.compareBaseRef = routeBaseRef;
      this.compareHeadRef = routeHeadRef;
      this.openCompareWorkspace({ preserveViewer: Boolean(route.path), skipReload: true });
      if (!route.path) {
        this.compareTree.setSelectedPath("");
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.gitCompare?.files?.find((entry) => entry.path === fullPath);
      await this.openCompareDiff(fullPath, file?.status ?? "");
      return;
    }

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    this.compareBaseRef = routeBaseRef;
    this.compareHeadRef = routeHeadRef;
    this.openCompareWorkspace({ preserveViewer: Boolean(route.path), skipReload: true });
    if (!this.gitRefs) {
      await this.loadGitRefsAndCompare(this.currentPath);
    } else if (
      !this.gitCompare ||
      this.gitCompare.baseRef !== routeBaseRef ||
      this.gitCompare.headRef !== routeHeadRef
    ) {
      this.compareTree.setSelectedPath("");
      this.showCompareList();
      if (!route.path) {
        this.compareWorkspaceViewer.setEmpty();
      }
      await this.loadGitCompare(this.currentPath, this.compareBaseRef, this.compareHeadRef);
    }

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

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

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

    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    await this.openGithubIssuesWorkspace({ page: route.page });
    if (route.number) {
      await this.openGithubIssue(route.number);
    }
  }

  async applyPullsRoute(project, route) {
    if (!(await this.ensureProjectRootLoaded(project))) {
      return;
    }

    if (!route.number) {
      await this.openGithubPullsWorkspace({ page: route.page });
      return;
    }

    this.githubPullsPage = route.page ?? this.githubPullsPage;

    if (route.files) {
      const skipReload = this.githubPullFiles?.number === route.number;
      await this.openGithubPullFiles(route.number, {
        preserveViewer: Boolean(route.path),
        skipReload,
      });
      if (!route.path) {
        this.githubPullFilesPage.setSelectedPath("");
        this.pullWorkspaceViewer.setEmpty();
        this.showPullFilesList();
        return;
      }

      const fullPath = this.projectPath(project, route.path);
      const file = this.githubPullFiles?.files?.find((entry) => entry.path === fullPath);
      await this.openGithubPullFile(fullPath, file?.status ?? "");
      return;
    }

    await this.openGithubPull(route.number);
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
      return;
    }

    if (event.target === this.pullWorkspaceViewer) {
      if (currentRoute?.kind === "pulls" && currentRoute.files && currentRoute.path) {
        this.navigateToRoute(parentRoute(currentRoute));
        return;
      }
      this.showPullFilesList();
    }
  }

  setBrowserView(view) {
    const nextView = view === "viewer" ? "viewer" : "list";
    this.browserView = nextView;
    this.setAttribute("data-browser-view", nextView);
    this.filesPage?.setAttribute("data-browser-view", nextView);
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

  showPullFilesList() {
    this.pullFilesView = "list";
    this.reviewWorkspace.setPullFilesView("list");
    this.restoreScroller("pull-files", this.githubPullFilesPage, ".github-pull-files-list");
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

  async ensureProjectRootLoaded(project) {
    if (this.isProjectRootLoaded(project)) {
      return true;
    }

    return await this.loadDirectory(project.relativePath);
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
    this.githubIssues = null;
    this.githubPulls = null;
    this.githubPullFiles = null;
    this.gitCompare = null;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.headerActions.gitStatus = {
      available: true,
      branch: directory.git.branch,
      dirty: directory.git.dirty,
      count: null,
    };
    this.headerActions.githubStatus = null;
    this.changesTree.setLoading(directory.git);
    this.githubIssuesList.reset();
    this.githubIssueViewer.setEmpty();
    this.githubPullsList.reset();
    this.githubPullViewer.setEmpty();
    this.githubPullFilesPage.reset();
    this.pullWorkspaceViewer.setEmpty();
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
    } else if (this.workspaceMode === "pulls") {
      this.githubPullsPage = 1;
      this.githubPullsList.setLoading(null);
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
    this.githubPullsRequestId += 1;
    this.githubPullRequestId += 1;
    this.githubPullFilesRequestId += 1;
    this.logPage = 1;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.pullsWorkspaceView = "list";
    this.pullFilesView = "list";
    this.githubIssuesPage = 1;
    this.githubPullsPage = 1;
    this.selectedGithubIssueSummary = null;
    this.selectedGithubPullSummary = null;
    this.gitRefs = null;
    this.githubStatus = null;
    this.githubIssues = null;
    this.githubPulls = null;
    this.githubPullFiles = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.headerActions.gitStatus = {
      available: false,
      message: "Not a Git repository",
    };
    this.headerActions.githubStatus = {
      available: false,
      message: "No GitHub repository context",
    };
    this.changesTree.reset();
    this.logList.reset();
    this.commitChangesTree.reset();
    this.compareTree.reset();
    this.githubIssuesList.reset();
    this.githubIssueViewer.setEmpty();
    this.githubPullsList.reset();
    this.githubPullViewer.setEmpty();
    this.githubPullFilesPage.reset();
    this.pullWorkspaceViewer.setEmpty();
    this.reviewWorkspace.clearCompareRefs();
    this.reviewWorkspace.setDiffView("list");
    this.reviewWorkspace.setCompareView("list");
    this.reviewWorkspace.setLogDetailView("list");
    this.reviewWorkspace.setIssuesView("list");
    this.reviewWorkspace.setPullsView("list");
    this.reviewWorkspace.setPullFilesView("list");
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
      } else if (this.workspaceMode === "pulls") {
        if (status.github && status.pullsAvailable && this.pullsWorkspaceView === "list") {
          await this.loadGithubPulls(path, "open", this.githubPullsPage);
        } else if (!status.github || !status.pullsAvailable) {
          this.githubPullsList.setUnavailable(status);
          this.githubPullViewer.setEmpty();
          this.githubPullFilesPage.reset();
          this.pullWorkspaceViewer.setEmpty();
        }
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
      if (this.workspaceMode === "issues") {
        this.githubIssuesList.setError(error);
        this.githubIssueViewer.setEmpty();
      } else if (this.workspaceMode === "pulls") {
        this.githubPullsList.setError(error);
        this.githubPullViewer.setEmpty();
        this.githubPullFilesPage.setError(error, this.gitRepository);
        this.pullWorkspaceViewer.setEmpty();
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

  async loadGithubPulls(path, state = "open", page = this.githubPullsPage) {
    if (!this.gitRepository || !this.githubStatus?.github || !this.githubStatus.pullsAvailable) {
      return;
    }

    const requestId = ++this.githubPullsRequestId;
    const loadingTimer = this.showGithubPullsLoadingAfterDelay(requestId);

    try {
      const pulls = await getGitHubPulls(path, state, page, GITHUB_PULLS_PER_PAGE);
      if (requestId !== this.githubPullsRequestId) {
        return;
      }

      this.githubPullsPage = pulls.page ?? page;
      this.githubPulls = pulls;
      this.githubPullsList.setPulls(pulls);
      if (this.pullsWorkspaceView === "list") {
        this.selectedGithubPullSummary = null;
        this.githubPullViewer.setEmpty();
        this.githubPullFilesPage.reset();
        this.pullWorkspaceViewer.setEmpty();
      }
      this.updateWorkspaceChrome();
      return pulls;
    } catch (error) {
      if (requestId !== this.githubPullsRequestId) {
        return;
      }

      this.githubPullsList.setError(error, this.githubStatus);
      this.githubPullViewer.setEmpty();
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openGithubPull(number) {
    if (!this.gitRepository || !Number.isFinite(number)) {
      return;
    }

    const status = await this.ensureGithubStatus();
    if (!status?.github || !status.pullsAvailable) {
      this.githubPullsList.setUnavailable(status);
      return;
    }

    const requestId = ++this.githubPullRequestId;
    this.selectedGithubPullSummary =
      this.githubPulls?.pulls?.find((pull) => pull.number === number) ?? { number };
    this.workspaceMode = "pulls";
    this.pullsWorkspaceView = "detail";
    this.pullFilesView = "list";
    this.reviewWorkspace.open("pulls", this.workspaceDetails());
    this.reviewWorkspace.setPullsView("detail");
    this.reviewWorkspace.setPullFilesView("list");
    this.updateGitButton();
    this.updateWorkspaceChrome();
    this.githubPullsList.setSelectedPull(number);
    this.githubPullViewer.setLoading(number);

    try {
      const pull = await getGitHubPull(this.currentPath, number);
      if (requestId !== this.githubPullRequestId) {
        return;
      }

      this.githubPullViewer.setPull(pull);
      this.selectedGithubPullSummary = pull.pull;
      this.updateWorkspaceChrome();
      return pull;
    } catch (error) {
      if (requestId !== this.githubPullRequestId) {
        return;
      }

      this.githubPullViewer.setError(number, error);
    }
  }

  async openGithubPullFiles(number, options = {}) {
    if (!this.gitRepository || !Number.isFinite(number)) {
      return;
    }

    const status = await this.ensureGithubStatus();
    if (!status?.github || !status.pullsAvailable) {
      this.githubPullsList.setUnavailable(status);
      return;
    }

    const requestId = ++this.githubPullFilesRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.selectedGithubPullSummary =
      this.selectedGithubPullSummary?.number === number
        ? this.selectedGithubPullSummary
        : (this.githubPulls?.pulls?.find((pull) => pull.number === number) ?? { number });
    this.workspaceMode = "pulls";
    this.pullsWorkspaceView = "files";
    this.pullFilesView = "list";
    this.reviewWorkspace.open("pulls", this.workspaceDetails());
    this.reviewWorkspace.setPullsView("files");
    this.reviewWorkspace.setPullFilesView("list");
    this.updateGitButton();
    this.updateWorkspaceChrome();
    this.githubPullsList.setSelectedPull(number);
    if (!options.skipReload) {
      this.githubPullFilesPage.setLoading(this.gitRepository, number);
    }
    if (!options.preserveViewer && viewerRequestId === this.fileRequestId) {
      this.pullWorkspaceViewer.setEmpty();
    }
    if (options.skipReload) {
      return this.githubPullFiles;
    }

    try {
      const files = await getGitHubPullFiles(this.currentPath, number);
      if (requestId !== this.githubPullFilesRequestId) {
        return;
      }

      this.githubPullFiles = files;
      this.githubPullFilesPage.setFiles(files);
      if (viewerRequestId === this.fileRequestId && !options.preserveViewer) {
        this.pullWorkspaceViewer.setEmpty();
      }
      this.updateWorkspaceChrome();
      return files;
    } catch (error) {
      if (requestId !== this.githubPullFilesRequestId) {
        return;
      }

      this.githubPullFilesPage.setError(error, this.gitRepository);
      if (viewerRequestId === this.fileRequestId) {
        this.pullWorkspaceViewer.setError(`PR #${number}`, error);
      }
    }
  }

  async openGithubPullFile(path, status = "") {
    const number = this.selectedGithubPullSummary?.number ?? this.githubPullFiles?.number;
    if (!number || !path) {
      return;
    }

    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath("");
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath("");
    this.githubPullFilesPage.setSelectedPath(path);
    this.rememberScroller("pull-files", this.githubPullFilesPage, ".github-pull-files-list");
    this.workspaceMode = "pulls";
    this.pullsWorkspaceView = "files";
    this.pullFilesView = "viewer";
    this.reviewWorkspace.setPullsView("files");
    this.reviewWorkspace.setPullFilesView("viewer");
    const loadingTimer = this.showWorkspaceLoadingAfterDelay(
      this.pullWorkspaceViewer,
      `PR diff ${path}`,
      requestId,
    );

    try {
      const diff = await getGitHubPullFile(this.currentPath, number, path);
      if (requestId !== this.fileRequestId) {
        return;
      }

      if (diff.diffUnavailable) {
        this.pullWorkspaceViewer.setError(path, new Error(diff.message ?? "Diff unavailable."));
      } else {
        this.pullWorkspaceViewer.setDiff({ ...diff, status });
      }
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.pullWorkspaceViewer.setError(path, error);
    } finally {
      window.clearTimeout(loadingTimer);
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

    const requestKey = `${path ?? ""}\u0000${baseRef ?? ""}\u0000${headRef ?? ""}`;
    if (this.pendingGitCompare?.key === requestKey) {
      return await this.pendingGitCompare.promise;
    }

    const requestId = ++this.gitCompareRequestId;
    this.compareTree.setLoading(this.gitRepository);
    this.reviewWorkspace.setCompareRefs(this.gitRefs, baseRef, headRef);

    const promise = (async () => {
      const compare = await getGitCompare(path, baseRef, headRef);
      if (requestId !== this.gitCompareRequestId) {
        return null;
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
    })();

    this.pendingGitCompare = { key: requestKey, promise };

    try {
      return await promise;
    } catch (error) {
      if (requestId !== this.gitCompareRequestId) {
        return null;
      }

      this.compareTree.setError(error, this.gitRepository);
      return null;
    } finally {
      if (this.pendingGitCompare?.key === requestKey && this.pendingGitCompare.promise === promise) {
        this.pendingGitCompare = null;
      }
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

  changeGithubPullsPage(page) {
    if (this.workspaceMode !== "pulls" || this.pullsWorkspaceView !== "list") {
      return;
    }

    const nextPage = Number.parseInt(`${page}`, 10);
    if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === this.githubPullsPage) {
      return;
    }

    this.githubPullsPage = nextPage;
    this.loadGithubPulls(this.currentPath, "open", nextPage);
  }

  openDiffWorkspace(options = {}) {
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
    if (!options.preserveViewer) {
      this.diffWorkspaceViewer.setEmpty();
    }
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
    if (!options.preserveViewer) {
      this.compareWorkspaceViewer.setEmpty();
    }
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

  async openGithubPullsWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "pulls";
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.pullsWorkspaceView = "list";
    this.pullFilesView = "list";
    this.githubPullsPage = options.page ?? 1;
    this.selectedGithubPullSummary = null;
    this.reviewWorkspace.open("pulls", this.workspaceDetails());
    this.reviewWorkspace.setPullsView(this.pullsWorkspaceView);
    this.reviewWorkspace.setPullFilesView(this.pullFilesView);
    this.updateGitButton();
    this.githubPullViewer.setEmpty();
    this.githubPullFilesPage.reset();
    this.pullWorkspaceViewer.setEmpty();
    if (options.skipReload) {
      return;
    }

    if (!this.githubStatus) {
      this.githubPullsList.setLoading(null);
      return await this.loadGithubStatus(this.currentPath);
    }

    if (!this.githubStatus.github || !this.githubStatus.pullsAvailable) {
      this.githubPullsList.setUnavailable(this.githubStatus);
      return;
    }

    return await this.loadGithubPulls(this.currentPath, "open", this.githubPullsPage);
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
    if (!this.workspaceMode && this.reviewWorkspace.hidden) {
      return;
    }

    this.workspaceMode = null;
    this.diffWorkspaceView = "list";
    this.compareWorkspaceView = "list";
    this.logWorkspaceView = "list";
    this.logDetailFileView = "list";
    this.issuesWorkspaceView = "list";
    this.pullsWorkspaceView = "list";
    this.pullFilesView = "list";
    this.logPage = 1;
    this.githubIssuesPage = 1;
    this.githubPullsPage = 1;
    this.selectedCommitSummary = null;
    this.selectedGithubIssueSummary = null;
    this.selectedGithubPullSummary = null;
    this.githubIssuesList.setSelectedIssue(null);
    this.githubPullsList.setSelectedPull(null);
    this.reviewWorkspace.setDiffView("list");
    this.reviewWorkspace.setCompareView("list");
    this.reviewWorkspace.setLogDetailView("list");
    this.reviewWorkspace.setIssuesView("list");
    this.reviewWorkspace.setPullsView("list");
    this.reviewWorkspace.setPullFilesView("list");
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
      return;
    }

    if (this.workspaceMode === "pulls" && this.pullsWorkspaceView === "detail") {
      this.githubPullRequestId += 1;
      this.pullsWorkspaceView = "list";
      this.selectedGithubPullSummary = null;
      this.githubPullsList.setSelectedPull(null);
      this.githubPullViewer.setEmpty();
      this.reviewWorkspace.setPullsView("list");
      this.updateWorkspaceChrome();
      return;
    }

    if (this.workspaceMode === "pulls" && this.pullsWorkspaceView === "files") {
      if (this.pullFilesView === "viewer") {
        this.fileRequestId += 1;
        this.pullFilesView = "list";
        this.pullWorkspaceViewer.setEmpty();
        this.githubPullFilesPage.setSelectedPath("");
        this.reviewWorkspace.setPullFilesView("list");
        this.updateWorkspaceChrome();
        return;
      }

      this.githubPullFilesRequestId += 1;
      this.pullsWorkspaceView = "detail";
      this.pullFilesView = "list";
      this.githubPullFilesPage.reset();
      this.pullWorkspaceViewer.setEmpty();
      this.reviewWorkspace.setPullsView("detail");
      this.reviewWorkspace.setPullFilesView("list");
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
    if (this.workspaceMode === "pulls") {
      this.reviewWorkspace.setPullsView(this.pullsWorkspaceView);
      this.reviewWorkspace.setPullFilesView(this.pullFilesView);
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

    if (this.workspaceMode === "issues") {
      return {
        title: "Issues",
        subtitle: this.githubIssuesSubtitle(),
        backVisible: false,
      };
    }

    if (this.workspaceMode === "pulls" && this.pullsWorkspaceView === "detail") {
      return {
        title: "PR",
        subtitle: this.githubPullSubtitle(),
        backVisible: true,
        backLabel: "Back to pull requests",
      };
    }

    if (this.workspaceMode === "pulls" && this.pullsWorkspaceView === "files") {
      return {
        title: "PR Files",
        subtitle: this.githubPullSubtitle(),
        backVisible: true,
        backLabel: "Back to PR",
      };
    }

    if (this.workspaceMode === "pulls") {
      return {
        title: "Pull Requests",
        subtitle: this.githubPullsSubtitle(),
        backVisible: false,
      };
    }

    return {
      title: "Review",
      subtitle: "",
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

  githubPullsSubtitle() {
    if (!this.githubStatus?.github) {
      return "GitHub";
    }

    const count = this.githubPulls?.totalPulls;
    const countLabel = count === undefined ? "" : ` · ${count} PRs`;
    return `${this.githubStatus.github.nameWithOwner}${countLabel}`;
  }

  githubPullSubtitle() {
    const pull = this.selectedGithubPullSummary;
    if (!pull) {
      return "";
    }

    const number = pull.number === undefined ? "" : `#${pull.number}`;
    const title = pull.title ?? "";
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

  showGithubPullsLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.githubPullsRequestId) {
        this.githubPullsList.setLoading(this.githubStatus, this.githubPulls, this.githubPullsPage);
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
