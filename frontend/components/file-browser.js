import { listDirectory, readFile } from "../api.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "./dom.js";
import { createRefreshCoordinator, subscribeToWatch } from "../watch.js";
import "./file-browser/list.js";
import "./file-viewer.js";

const LOADING_DELAY_MS = 180;
const LEFT_PANEL_DEFAULT_WIDTH = 320;
const LEFT_PANEL_MIN_WIDTH = 180;
const LEFT_PANEL_VIEWER_MIN_WIDTH = 320;
const LEFT_PANEL_MAX_RATIO = 0.7;

class CaffoldFileBrowser extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.watchScopePath) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.currentPath ??= "";
    this.browserView ??= "list";
    this.directoryRequestId ??= 0;
    this.fileRequestId ??= 0;
    this.leftPanelWidth ??= LEFT_PANEL_DEFAULT_WIDTH;
    this.resizePointerId ??= null;
    this.scrollPositions ??= {};
    this.storageKey ??= null;
    this.loadedDirectoryPath ??= null;
    this.lastError = null;
    this.selectedFilePath ??= "";
    this.imageRevision ??= 0;
    this.pendingRefresh = createPendingRefresh();
    this.watchUnavailable = false;

    this.innerHTML = `
      <caffold-file-list></caffold-file-list>
      <div
        class="panel-resizer"
        role="separator"
        aria-label="Resize left panel"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
      <caffold-file-viewer></caffold-file-viewer>
    `;
    this.fileList = this.querySelector("caffold-file-list");
    this.panelResizer = this.querySelector(".panel-resizer");
    this.fileViewer = this.querySelector("caffold-file-viewer");
    this.fileViewer.setCloseLabel("Back to files");
    this.refreshCoordinator = createRefreshCoordinator(
      () => this.performPendingRefresh(),
      (state) => this.setRefreshState(state),
    );
    this.setBrowserView(this.browserView);
    this.applyLeftPanelWidth(this.leftPanelWidth);

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
    this.addEventListener("caffold:open-directory", (event) => {
      this.handleOpenDirectoryEvent(event);
    });
    this.addEventListener("caffold:open-file", (event) => {
      this.handleOpenFileEvent(event);
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      this.handleCloseFileViewerEvent(event);
    });
    this.addEventListener("caffold:refresh-file-list", (event) => {
      event.stopPropagation();
      this.requestRefresh({ allDirectories: true });
    });
    this.addEventListener("caffold:refresh-file-viewer", (event) => {
      event.stopPropagation();
      this.requestRefresh({ file: true });
    });
  }

  usesExternalNavigation() {
    return this.hasAttribute("external-navigation");
  }

  handleOpenDirectoryEvent(event) {
    if (this.usesExternalNavigation()) {
      return;
    }

    event.stopPropagation();
    this.openPath(event.detail?.path ?? "");
  }

  handleOpenFileEvent(event) {
    if (this.usesExternalNavigation()) {
      return;
    }

    event.stopPropagation();
    this.openFile(event.detail?.path ?? "", event.detail?.entry ?? null);
  }

  handleCloseFileViewerEvent(event) {
    if (this.usesExternalNavigation()) {
      return;
    }

    event.stopPropagation();
    this.showList();
  }

  async loadDirectory(path, options = {}) {
    this.ensureRendered();
    const requestId = ++this.directoryRequestId;
    this.fileRequestId += 1;
    this.lastError = null;
    this.setBrowserView("list");
    this.currentPath = path ?? "";
    this.clearSelectedFile({ cancelFileRequest: false, resetViewer: true });
    const loadingTimer = this.showDirectoryLoadingAfterDelay(requestId);

    try {
      const directory = await listDirectory(this.currentPath);
      if (requestId !== this.directoryRequestId) {
        return null;
      }

      window.clearTimeout(loadingTimer);
      this.currentPath = directory.path;
      this.loadedDirectoryPath = directory.path;
      this.fileList.setDirectory(directory);
      this.setWatchScope(directory.git?.rootPath ?? directory.path);
      this.storeDirectoryPath(directory.path);
      return directory;
    } catch (error) {
      if (requestId !== this.directoryRequestId) {
        return null;
      }

      this.lastError = error;
      if (
        options.fallbackPath !== undefined &&
        this.currentPath !== options.fallbackPath
      ) {
        this.clearStoredDirectoryPath();
        const { fallbackPath: _fallbackPath, ...nextOptions } = options;
        return this.loadDirectory(options.fallbackPath, nextOptions);
      }

      if (options.allowFailure) {
        return false;
      }

      this.fileList.setError(error);
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async openPath(path, options = {}) {
    this.ensureRendered();
    const targetPath = path ?? "";
    const fallbackPath = options.fallbackPath ?? "";

    const loadedEntry = this.entryForPath(targetPath);
    if (loadedEntry && loadedEntry.kind !== "directory") {
      const file = await this.openFile(targetPath, loadedEntry);
      return {
        kind: "file",
        directory: null,
        file,
      };
    }

    const directory = await this.loadDirectory(targetPath, { allowFailure: true });
    if (directory) {
      return {
        kind: "directory",
        directory,
      };
    }
    if (directory === null) {
      return {
        kind: "stale",
        directory: null,
      };
    }

    const parentDirectory = await this.loadDirectory(parentPath(targetPath), {
      fallbackPath,
    });
    if (parentDirectory) {
      const file = await this.openFile(targetPath);
      return {
        kind: "file",
        directory: parentDirectory,
        file,
      };
    }

    return {
      kind: "error",
      directory: parentDirectory,
    };
  }

  async openFile(path, entry = null) {
    this.ensureRendered();
    const requestId = ++this.fileRequestId;
    this.lastError = null;
    this.fileList.setSelectedPath(path);
    this.selectedFilePath = path;
    this.rememberScroller("files", this.fileList, ".file-list");
    this.setBrowserView("viewer");

    if (isPreviewableImagePath(path)) {
      this.fileViewer.setImage({
        path,
        name: fileNameFromPath(path),
        imageType: imageTypeLabel(path),
        size: entry?.size,
        modifiedMs: entry?.modifiedMs,
        revision: this.imageRevision,
      });
      return true;
    }

    const loadingTimer = this.showFileLoadingAfterDelay(path, requestId);

    try {
      const file = await readFile(path);
      if (requestId !== this.fileRequestId) {
        return false;
      }

      this.fileViewer.setFile(file);
      return file;
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return false;
      }

      this.lastError = error;
      this.fileViewer.setError(path, error);
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showList() {
    this.setBrowserView("list");
    this.restoreScroller("files", this.fileList, ".file-list");
  }

  showLoadedList(path) {
    if (
      !this.selectedFilePath ||
      cleanPath(this.loadedDirectoryPath) !== cleanPath(path)
    ) {
      return false;
    }

    this.showList();
    return true;
  }

  clearSelectedFile(options = {}) {
    this.ensureRendered();
    if (options.cancelFileRequest !== false) {
      this.fileRequestId += 1;
    }
    this.fileList.setSelectedPath("");
    this.selectedFilePath = "";
    if (options.resetViewer) {
      this.fileViewer.setEmpty();
    }
  }

  entryForPath(path) {
    this.ensureRendered();
    return this.fileList.entryForPath(path);
  }

  setStorageKey(key) {
    this.storageKey = key ?? null;
  }

  setError(error) {
    this.ensureRendered();
    this.lastError = error;
    this.loadedDirectoryPath = null;
    this.fileList.setError(error);
    this.fileViewer.setError("", error);
  }

  setWatchScope(path) {
    const nextPath = path ?? "";
    if (this.watchScopePath === nextPath && this.watchUnsubscribe) {
      return;
    }
    this.watchScopePath = nextPath;
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchUnavailable = false;
    this.setRefreshState("idle");
    if (this.isConnected) {
      this.subscribeWatchScope(nextPath);
    }
  }

  subscribeWatchScope(path) {
    if (this.watchUnsubscribe) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          this.requestRefresh({ allDirectories: true, file: true });
        }
      },
      onChange: (change) => this.handleWatchChange(change),
      onRecover: () => this.requestRefresh({ allDirectories: true, file: true }),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  handleWatchChange(change) {
    const paths = Array.isArray(change.paths) ? change.paths : [];
    const selectedChanged = Boolean(
      this.selectedFilePath &&
      (change.overflow || paths.includes(this.selectedFilePath)),
    );
    this.requestRefresh({
      paths,
      allDirectories: Boolean(change.overflow),
      file: selectedChanged,
      revision: change.revision,
    });
  }

  requestRefresh(options = {}) {
    this.pendingRefresh.allDirectories ||= Boolean(options.allDirectories);
    this.pendingRefresh.file ||= Boolean(options.file);
    this.pendingRefresh.revision = options.revision ?? this.pendingRefresh.revision;
    for (const path of options.paths ?? []) {
      this.pendingRefresh.paths.add(path);
    }
    return this.refreshCoordinator.request();
  }

  async performPendingRefresh() {
    const pending = this.pendingRefresh;
    this.pendingRefresh = createPendingRefresh();
    await this.refreshDirectories(pending);
    if (pending.file && this.selectedFilePath) {
      await this.refreshSelectedFile(pending.revision);
    }
  }

  async refreshDirectories(pending) {
    const cachedPaths = this.fileList.cachedDirectoryPaths();
    const targets = new Set();
    if (pending.allDirectories) {
      cachedPaths.forEach((path) => targets.add(path));
    } else {
      for (const changedPath of pending.paths) {
        const parent = parentPath(changedPath);
        if (cachedPaths.includes(parent)) {
          targets.add(parent);
        }
        if (cachedPaths.includes(changedPath)) {
          targets.add(changedPath);
        }
      }
    }
    if (targets.size === 0) {
      return;
    }

    const directories = [];
    const paths = Array.from(targets);
    for (let index = 0; index < paths.length; index += 4) {
      const batch = paths.slice(index, index + 4);
      const results = await Promise.allSettled(batch.map((path) => listDirectory(path)));
      results.forEach((result, offset) => {
        if (result.status === "fulfilled") {
          directories.push(result.value);
        } else if (batch[offset] === this.loadedDirectoryPath) {
          this.fileList.setError(result.reason);
        }
      });
    }
    this.fileList.updateDirectories(directories);
  }

  async refreshSelectedFile(revision = null) {
    const path = this.selectedFilePath;
    if (!path) {
      return;
    }
    try {
      if (isPreviewableImagePath(path)) {
        const entry = this.entryForPath(path);
        this.imageRevision = revision ?? this.imageRevision + 1;
        this.fileViewer.setImage({
          path,
          name: fileNameFromPath(path),
          imageType: imageTypeLabel(path),
          size: entry?.size,
          modifiedMs: entry?.modifiedMs,
          revision: this.imageRevision,
        });
        return;
      }
      const file = await readFile(path);
      if (path !== this.selectedFilePath) {
        return;
      }
      this.fileViewer.setFile(file, { preserveScroll: true });
    } catch (error) {
      if (path === this.selectedFilePath) {
        this.fileViewer.setError(path, error);
      }
    }
  }

  setRefreshState(state) {
    const nextState = state === "refreshing"
      ? "refreshing"
      : this.watchUnavailable
        ? "unavailable"
        : "idle";
    this.fileList.setRefreshState(nextState);
    this.fileViewer.setRefreshState(nextState);
  }

  hasLoadedDirectory(path) {
    return this.loadedDirectoryPath === (path ?? "");
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.fileViewer;
  }

  setBrowserView(view) {
    const nextView = view === "viewer" ? "viewer" : "list";
    this.browserView = nextView;
    this.setAttribute("data-browser-view", nextView);
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
    const rect = this.getBoundingClientRect();
    this.applyLeftPanelWidth(event.clientX - rect.left);
  }

  applyLeftPanelWidth(width) {
    const nextWidth = this.clampLeftPanelWidth(width);
    this.leftPanelWidth = nextWidth;
    this.style.setProperty("--left-panel-width", `${nextWidth}px`);
    this.panelResizer.setAttribute("aria-valuemin", `${LEFT_PANEL_MIN_WIDTH}`);
    this.panelResizer.setAttribute("aria-valuemax", `${this.leftPanelMaxWidth()}`);
    this.panelResizer.setAttribute("aria-valuenow", `${nextWidth}`);
  }

  clampLeftPanelWidth(width) {
    return Math.min(Math.max(Math.round(width), LEFT_PANEL_MIN_WIDTH), this.leftPanelMaxWidth());
  }

  leftPanelMaxWidth() {
    const pageWidth = this.getBoundingClientRect().width;
    if (!pageWidth) {
      return LEFT_PANEL_DEFAULT_WIDTH;
    }

    const ratioMax = Math.round(pageWidth * LEFT_PANEL_MAX_RATIO);
    const viewerMax = Math.max(LEFT_PANEL_MIN_WIDTH, pageWidth - LEFT_PANEL_VIEWER_MIN_WIDTH);
    return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(ratioMax, viewerMax));
  }

  canResizeLeftPanel() {
    return (
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

customElements.define("caffold-file-browser", CaffoldFileBrowser);

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

function createPendingRefresh() {
  return {
    allDirectories: false,
    file: false,
    paths: new Set(),
    revision: null,
  };
}
