import { readFile } from "../api.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "./dom.js";
import "./file-navigator.js";
import "./file-viewer.js";

const LOADING_DELAY_MS = 180;
const LEFT_PANEL_DEFAULT_WIDTH = 320;
const LEFT_PANEL_MIN_WIDTH = 180;
const LEFT_PANEL_VIEWER_MIN_WIDTH = 320;
const LEFT_PANEL_MAX_RATIO = 0.7;

class CaffoldFileBrowser extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.browserView ??= "list";
    this.fileRequestId ??= 0;
    this.leftPanelWidth ??= LEFT_PANEL_DEFAULT_WIDTH;
    this.resizePointerId ??= null;
    this.fileScroll ??= null;
    this.imageRevision ??= 0;
    this.lastError = null;
    this.innerHTML = `
      <caffold-file-navigator></caffold-file-navigator>
      <div
        class="panel-resizer"
        role="separator"
        aria-label="Resize left panel"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
      <caffold-file-viewer></caffold-file-viewer>
    `;
    this.navigator = this.querySelector("caffold-file-navigator");
    this.panelResizer = this.querySelector(".panel-resizer");
    this.fileViewer = this.querySelector("caffold-file-viewer");
    this.fileViewer.setCloseLabel("Back to files");
    this.navigator.toggleAttribute(
      "external-navigation",
      this.hasAttribute("external-navigation"),
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
    this.addEventListener("caffold:file-navigator-open-file", (event) => {
      event.stopPropagation();
      void this.openFile(event.detail?.path ?? "", event.detail?.entry ?? null);
    });
    this.addEventListener("caffold:file-navigator-refresh-selected", (event) => {
      event.stopPropagation();
      void this.refreshSelectedFile(event.detail?.revision ?? null);
    });
    this.addEventListener("caffold:file-navigator-refresh-state", (event) => {
      event.stopPropagation();
      this.fileViewer.setRefreshState(event.detail?.state ?? "idle");
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      if (this.hasAttribute("external-navigation")) {
        return;
      }
      event.stopPropagation();
      this.showList();
    });
    this.addEventListener("caffold:refresh-file-viewer", (event) => {
      event.stopPropagation();
      void this.refreshSelectedFile();
    });
  }

  get currentPath() {
    return this.navigator?.currentPath ?? "";
  }

  get loadedDirectoryPath() {
    return this.navigator?.loadedDirectoryPath ?? null;
  }

  get selectedFilePath() {
    return this.navigator?.selectedPath ?? "";
  }

  get watchActive() {
    return this.navigator?.watchActive ?? false;
  }

  get watchUnsubscribe() {
    return this.navigator?.watchUnsubscribe ?? null;
  }

  async loadDirectory(path, options = {}) {
    this.ensureRendered();
    this.fileRequestId += 1;
    this.lastError = null;
    this.setBrowserView("list");
    this.fileViewer.setEmpty();
    return await this.navigator.loadDirectory(path, options);
  }

  async openPath(path, options = {}) {
    this.ensureRendered();
    const result = await this.navigator.resolvePath(path, options);
    if (result.kind !== "file") {
      return result;
    }
    const file = await this.openFile(path, result.entry ?? null);
    return { ...result, file };
  }

  async openFile(path, entry = null) {
    this.ensureRendered();
    const requestId = ++this.fileRequestId;
    this.lastError = null;
    this.fileScroll = this.navigator.captureScroll();
    this.navigator.setSelectedPath(path);
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
    this.navigator.restoreScroll(this.fileScroll);
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
    this.navigator.clearSelectedPath();
    if (options.resetViewer) {
      this.fileViewer.setEmpty();
    }
  }

  entryForPath(path) {
    this.ensureRendered();
    return this.navigator.entryForPath(path);
  }

  setStorageKey(key) {
    this.ensureRendered();
    this.navigator.setStorageKey(key);
  }

  setError(error) {
    this.ensureRendered();
    this.lastError = error;
    this.navigator.setError(error);
    this.fileViewer.setError("", error);
  }

  setWatchScope(path) {
    this.ensureRendered();
    this.navigator.setWatchScope(path);
  }

  setWatchActive(active) {
    this.ensureRendered();
    this.navigator.setWatchActive(active);
  }

  requestRefresh(options = {}) {
    this.ensureRendered();
    return this.navigator.requestRefresh({
      paths: options.paths,
      allDirectories: options.allDirectories,
      selected: options.file,
      revision: options.revision,
    });
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
      if (path === this.selectedFilePath) {
        this.fileViewer.setFile(file, { preserveScroll: true });
      }
    } catch (error) {
      if (path === this.selectedFilePath) {
        this.fileViewer.setError(path, error);
      }
    }
  }

  hasLoadedDirectory(path) {
    this.ensureRendered();
    return this.navigator.hasLoadedDirectory(path);
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
    return Math.min(
      Math.max(Math.round(width), LEFT_PANEL_MIN_WIDTH),
      this.leftPanelMaxWidth(),
    );
  }

  leftPanelMaxWidth() {
    const pageWidth = this.getBoundingClientRect().width;
    if (!pageWidth) {
      return LEFT_PANEL_DEFAULT_WIDTH;
    }
    return Math.max(
      LEFT_PANEL_MIN_WIDTH,
      Math.min(
        Math.round(pageWidth * LEFT_PANEL_MAX_RATIO),
        Math.max(LEFT_PANEL_MIN_WIDTH, pageWidth - LEFT_PANEL_VIEWER_MIN_WIDTH),
      ),
    );
  }

  canResizeLeftPanel() {
    return Boolean(
      this.panelResizer && window.matchMedia("(min-width: 861px)").matches,
    );
  }

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  loadStoredDirectoryPath() {
    this.ensureRendered();
    return this.navigator.loadStoredDirectoryPath();
  }

  clearStoredDirectoryPath() {
    this.ensureRendered();
    this.navigator.clearStoredDirectoryPath();
  }
}

if (!customElements.get("caffold-file-browser")) {
  customElements.define("caffold-file-browser", CaffoldFileBrowser);
}

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}
