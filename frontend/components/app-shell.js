import {
  createProject,
  deleteProject,
  getGitCommit,
  getGitCommitDiff,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
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
import "./review-workspace.js";

const LOADING_DELAY_MS = 180;
const LAST_DIRECTORY_KEY_PREFIX = "codger:last-directory-path";
const LEFT_PANEL_DEFAULT_WIDTH = 320;
const LEFT_PANEL_MIN_WIDTH = 180;
const LEFT_PANEL_VIEWER_MIN_WIDTH = 320;
const LEFT_PANEL_MAX_RATIO = 0.7;

class CodgerAppShell extends HTMLElement {
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
    this.projectRequestId = 0;
    this.gitStatus = null;
    this.projects = [];
    this.projectCandidate = null;
    this.currentProjectId = null;
    this.gitCompare = null;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.workspaceMode = null;
    this.logWorkspaceView = "list";
    this.logPage = 1;
    this.selectedCommitSummary = null;
    this.leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH;
    this.resizePointerId = null;
    this.render();
    this.appMain = this.querySelector(".app-main");
    this.pathbar = this.querySelector("codger-pathbar");
    this.projectSwitcher = this.querySelector("codger-project-switcher");
    this.headerActions = this.querySelector("codger-header-actions");
    this.fileList = this.querySelector("codger-file-list");
    this.panelResizer = this.querySelector(".panel-resizer");
    this.fileViewer = this.querySelector("codger-file-viewer");
    this.reviewWorkspace = this.querySelector("codger-review-workspace");
    this.reviewWorkspace.ensureRendered();
    this.changesTree = this.reviewWorkspace.querySelector("codger-changes-tree");
    this.logList = this.reviewWorkspace.querySelector("codger-log-list");
    this.commitChangesTree = this.reviewWorkspace.querySelector("codger-commit-changes-tree");
    this.compareTree = this.reviewWorkspace.querySelector("codger-compare-tree");
    this.diffWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-diff codger-review-file-viewer",
    );
    this.logWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-log codger-review-file-viewer",
    );
    this.compareWorkspaceViewer = this.reviewWorkspace.querySelector(
      ".workspace-mode-compare codger-review-file-viewer",
    );
    this.applyLeftPanelWidth(this.leftPanelWidth);

    this.addEventListener("codger:navigate", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-directory", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-file", (event) => {
      this.openFile(event.detail.path, event.detail.entry);
    });
    this.addEventListener("codger:open-diff-workspace", () => {
      this.openDiffWorkspace();
    });
    this.addEventListener("codger:open-log-workspace", () => {
      this.openLogWorkspace();
    });
    this.addEventListener("codger:open-compare-workspace", () => {
      this.openCompareWorkspace();
    });
    this.addEventListener("codger:close-review-workspace", () => {
      this.closeReviewWorkspace();
    });
    this.addEventListener("codger:back-review-workspace", () => {
      this.backReviewWorkspace();
    });
    this.addEventListener("codger:open-git-diff", (event) => {
      this.openDiff(event.detail.path, event.detail.kind, event.detail.status);
    });
    this.addEventListener("codger:open-git-commit", (event) => {
      this.openCommit(event.detail.sha);
    });
    this.addEventListener("codger:change-log-page", (event) => {
      this.changeLogPage(event.detail.page);
    });
    this.addEventListener("codger:open-commit-diff", (event) => {
      this.openCommitDiff(event.detail.sha, event.detail.path, event.detail.status);
    });
    this.addEventListener("codger:open-compare-diff", (event) => {
      this.openCompareDiff(event.detail.path, event.detail.status);
    });
    this.addEventListener("codger:change-compare-refs", (event) => {
      this.changeCompareRefs(event.detail.baseRef, event.detail.headRef);
    });
    this.addEventListener("codger:register-current-project", () => {
      this.registerCurrentProject();
    });
    this.addEventListener("codger:open-project", (event) => {
      this.openRegisteredProject(event.detail.id);
    });
    this.addEventListener("codger:rename-project", (event) => {
      this.renameRegisteredProject(event.detail.id, event.detail.name);
    });
    this.addEventListener("codger:delete-project", (event) => {
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
            <strong>Codger</strong>
          </div>
          <codger-project-switcher></codger-project-switcher>
          <codger-header-actions></codger-header-actions>
        </div>
      </header>
      <codger-pathbar></codger-pathbar>
      <main class="app-main" aria-label="File browser">
        <codger-file-list></codger-file-list>
        <div
          class="panel-resizer"
          role="separator"
          aria-label="Resize left panel"
          aria-orientation="vertical"
          tabindex="0"
        ></div>
        <codger-file-viewer></codger-file-viewer>
      </main>
      <codger-review-workspace hidden></codger-review-workspace>
    `;
  }

  async bootstrap() {
    this.fileViewer.setEmpty();

    try {
      const health = await getHealth();
      this.storageKey = `${LAST_DIRECTORY_KEY_PREFIX}:${health.root}`;
      this.pathbar.homePath = health.homePath ?? null;
      const fallbackPath = health.initialPath ?? "";
      const initialPath = this.loadStoredDirectoryPath() ?? fallbackPath;
      await this.loadDirectory(initialPath, { fallbackPath });
    } catch (error) {
      this.fileList.setError(error);
      this.fileViewer.setError("", error);
    }
  }

  async loadDirectory(path, options = {}) {
    const requestId = ++this.directoryRequestId;
    this.fileRequestId += 1;
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

  async openDiff(path, kind, status = "") {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath(path);
    this.commitChangesTree.setSelectedPath("");
    this.compareTree.setSelectedPath("");
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
      if (commit.files?.length) {
        await this.openCommitDiff(sha, commit.files[0].path, commit.files[0].status);
      } else if (viewerRequestId === this.fileRequestId) {
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
      await this.loadDirectory(project.relativePath);
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
      await this.loadDirectory(project.relativePath);
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
    if (!window.confirm(`Delete ${name} from Codger projects? Files are not deleted.`)) {
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
    this.changesTree.setLoading(directory.git);
    this.loadGitStatus(directory.path);
    if (this.workspaceMode === "log") {
      this.logPage = 1;
      this.loadGitLog(directory.path, this.logPage);
    } else if (this.workspaceMode === "compare") {
      this.loadGitRefsAndCompare(directory.path);
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
    this.logPage = 1;
    this.gitRefs = null;
    this.compareBaseRef = null;
    this.compareHeadRef = null;
    this.headerActions.gitStatus = null;
    this.changesTree.reset();
    this.logList.reset();
    this.commitChangesTree.reset();
    this.compareTree.reset();
    this.reviewWorkspace.clearCompareRefs();
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
      await this.loadGitCompare(path, this.compareBaseRef, this.compareHeadRef);
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

  openDiffWorkspace() {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "diff";
    this.logWorkspaceView = "list";
    this.reviewWorkspace.open("diff", {
      title: "Diff",
      subtitle: this.workspaceSubtitle("Working tree"),
      backVisible: false,
    });
    this.updateGitButton();
    if (!this.gitStatus) {
      this.changesTree.setLoading(this.gitRepository);
    }
    this.diffWorkspaceViewer.setEmpty();
  }

  openCompareWorkspace() {
    if (!this.gitRepository) {
      return;
    }

    this.workspaceMode = "compare";
    this.logWorkspaceView = "list";
    this.reviewWorkspace.open("compare", {
      title: "Compare",
      subtitle: this.compareSubtitle(),
      backVisible: false,
    });
    this.updateGitButton();
    this.compareWorkspaceViewer.setEmpty();
    this.loadGitRefsAndCompare(this.currentPath);
  }

  openLogWorkspace(options = {}) {
    if (!this.gitRepository) {
      return;
    }

    const wasLogWorkspace = this.workspaceMode === "log";
    this.workspaceMode = "log";
    this.logWorkspaceView = options.view ?? "list";
    if (!options.skipReload) {
      this.logPage = options.page ?? 1;
    }
    if (this.logWorkspaceView === "list") {
      this.selectedCommitSummary = null;
    }
    this.reviewWorkspace.open("log", this.workspaceDetails());
    this.reviewWorkspace.setLogView(this.logWorkspaceView);
    this.updateGitButton();
    if (!options.preserveViewer) {
      this.commitChangesTree.reset();
      this.logWorkspaceViewer.setEmpty();
    }
    if (!options.skipReload) {
      this.loadGitLog(this.currentPath, this.logPage);
    }
  }

  closeReviewWorkspace() {
    this.workspaceMode = null;
    this.logWorkspaceView = "list";
    this.logPage = 1;
    this.selectedCommitSummary = null;
    this.reviewWorkspace.close();
    this.updateGitButton();
  }

  backReviewWorkspace() {
    if (this.workspaceMode !== "log" || this.logWorkspaceView !== "detail") {
      return;
    }

    this.logWorkspaceView = "list";
    this.reviewWorkspace.setLogView("list");
    this.updateWorkspaceChrome();
  }

  updateWorkspaceChrome() {
    if (!this.workspaceMode) {
      return;
    }

    this.reviewWorkspace.updateDetails(this.workspaceDetails());
    if (this.workspaceMode === "log") {
      this.reviewWorkspace.setLogView(this.logWorkspaceView);
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

    return {
      title: "Log",
      subtitle: this.workspaceSubtitle("History"),
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

customElements.define("codger-app-shell", CodgerAppShell);

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
