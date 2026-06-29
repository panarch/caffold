import { getGitDiff, getGitStatus, getHealth, listDirectory, readFile } from "../api.js";
import "./pathbar.js";
import "./file-list.js";
import "./file-viewer.js";
import "./changes-tree.js";

const LOADING_DELAY_MS = 180;
const LAST_DIRECTORY_KEY_PREFIX = "codger:last-directory-path";

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
    this.gitStatus = null;
    this.viewMode = "files";
    this.render();
    this.appMain = this.querySelector(".app-main");
    this.pathbar = this.querySelector("codger-pathbar");
    this.fileList = this.querySelector("codger-file-list");
    this.changesTree = this.querySelector("codger-changes-tree");
    this.fileViewer = this.querySelector("codger-file-viewer");

    this.addEventListener("codger:navigate", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-directory", (event) => {
      this.loadDirectory(event.detail.path);
    });
    this.addEventListener("codger:open-file", (event) => {
      this.openFile(event.detail.path);
    });
    this.addEventListener("codger:toggle-git-mode", () => {
      this.toggleGitMode();
    });
    this.addEventListener("codger:open-git-diff", (event) => {
      this.openDiff(event.detail.path, event.detail.kind);
    });

    this.bootstrap();
  }

  render() {
    this.innerHTML = `
      <header class="app-header">
        <div class="brand">
          <strong>Codger</strong>
        </div>
      </header>
      <codger-pathbar></codger-pathbar>
      <main class="app-main" data-view-mode="files" aria-label="Review browser">
        <codger-file-list></codger-file-list>
        <codger-changes-tree hidden></codger-changes-tree>
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

      this.currentPath = directory.path;
      this.pathbar.path = directory.path;
      this.fileList.setDirectory(directory);
      this.updateGitContext(directory);
      this.storeDirectoryPath(directory.path);
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
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openFile(path) {
    const requestId = ++this.fileRequestId;
    this.fileList.setSelectedPath(path);
    this.changesTree.setSelectedPath("");
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
