import {
  createProject,
  deleteProject,
  getGitDiff,
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
import "./file-list.js";
import "./file-viewer.js";
import "./changes-tree.js";

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
    this.projectRequestId = 0;
    this.gitStatus = null;
    this.projects = [];
    this.projectCandidate = null;
    this.currentProjectId = null;
    this.viewMode = "files";
    this.leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH;
    this.resizePointerId = null;
    this.render();
    this.appMain = this.querySelector(".app-main");
    this.pathbar = this.querySelector("codger-pathbar");
    this.projectSwitcher = this.querySelector("codger-project-switcher");
    this.fileList = this.querySelector("codger-file-list");
    this.changesTree = this.querySelector("codger-changes-tree");
    this.panelResizer = this.querySelector(".panel-resizer");
    this.fileViewer = this.querySelector("codger-file-viewer");
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
    this.addEventListener("codger:toggle-git-mode", () => {
      this.toggleGitMode();
    });
    this.addEventListener("codger:open-git-diff", (event) => {
      this.openDiff(event.detail.path, event.detail.kind);
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
        </div>
      </header>
      <codger-pathbar></codger-pathbar>
      <main class="app-main" data-view-mode="files" aria-label="Review browser">
        <codger-file-list></codger-file-list>
        <codger-changes-tree hidden></codger-changes-tree>
        <div
          class="panel-resizer"
          role="separator"
          aria-label="Resize left panel"
          aria-orientation="vertical"
          tabindex="0"
        ></div>
        <codger-file-viewer></codger-file-viewer>
      </main>
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

  async openDiff(path, kind) {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath("");
    this.changesTree.setSelectedPath(path);
    const loadingTimer = this.showFileLoadingAfterDelay(`Diff ${path}`, requestId);

    try {
      const diff = await getGitDiff(this.currentPath, path, kind);
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setDiff(diff);
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return;
      }

      this.fileViewer.setError(path, error);
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
    this.pathbar.gitStatus = {
      branch: directory.git.branch,
      dirty: directory.git.dirty,
      count: null,
      active: this.viewMode === "changes",
    };
    this.changesTree.setLoading(directory.git);
    this.loadGitStatus(directory.path);
  }

  clearGitContext() {
    this.gitRepository = null;
    this.gitStatus = null;
    this.gitStatusRequestId += 1;
    this.pathbar.gitStatus = null;
    this.changesTree.reset();
    if (this.viewMode === "changes") {
      this.setViewMode("files", { preserveViewer: true });
    }
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
      this.changesTree.setStatus(status);
    } catch (error) {
      if (requestId !== this.gitStatusRequestId) {
        return;
      }

      this.changesTree.setError(error, this.gitRepository);
    }
  }

  toggleGitMode() {
    if (!this.gitRepository) {
      return;
    }

    this.setViewMode(this.viewMode === "changes" ? "files" : "changes");
  }

  setViewMode(mode, options = {}) {
    if (mode !== "files" && mode !== "changes") {
      return;
    }

    this.viewMode = mode;
    if (this.appMain) {
      this.appMain.dataset.viewMode = mode;
    }

    if (this.fileList) {
      this.fileList.hidden = mode !== "files";
    }

    if (this.changesTree) {
      this.changesTree.hidden = mode !== "changes";
    }

    this.updateGitButton();

    if (!options.preserveViewer) {
      this.fileList.setSelectedPath("");
      this.changesTree.setSelectedPath("");
      this.fileViewer.setEmpty();
    }
  }

  updateGitButton() {
    if (!this.gitRepository) {
      this.pathbar.gitStatus = null;
      return;
    }

    this.pathbar.gitStatus = {
      branch: this.gitRepository.branch,
      dirty: this.gitRepository.dirty,
      count: this.gitStatus?.files.length ?? null,
      active: this.viewMode === "changes",
    };
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
