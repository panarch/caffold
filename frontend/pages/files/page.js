import { listDirectory, readFile } from "../../api.js";
import {
  fileNameFromPath,
  imageTypeLabel,
  isPreviewableImagePath,
} from "../../components/dom.js";
import "./components/list.js";
import "../../components/file-viewer.js";

const LOADING_DELAY_MS = 180;
const LEFT_PANEL_DEFAULT_WIDTH = 320;
const LEFT_PANEL_MIN_WIDTH = 180;
const LEFT_PANEL_VIEWER_MIN_WIDTH = 320;
const LEFT_PANEL_MAX_RATIO = 0.7;

class CaffoldFilesPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
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
    this.lastError = null;

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
      this.fileList.setDirectory(directory);
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

  async openFile(path, entry = null) {
    this.ensureRendered();
    const requestId = ++this.fileRequestId;
    this.lastError = null;
    this.fileList.setSelectedPath(path);
    this.rememberScroller("files", this.fileList, ".file-list");
    this.setBrowserView("viewer");

    if (isPreviewableImagePath(path)) {
      this.fileViewer.setImage({
        path,
        name: fileNameFromPath(path),
        imageType: imageTypeLabel(path),
        size: entry?.size,
        modifiedMs: entry?.modifiedMs,
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

  clearSelectedFile(options = {}) {
    this.ensureRendered();
    if (options.cancelFileRequest !== false) {
      this.fileRequestId += 1;
    }
    this.fileList.setSelectedPath("");
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
    this.fileList.setError(error);
    this.fileViewer.setError("", error);
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
    const pageWidth = this.getBoundingClientRect().width || LEFT_PANEL_DEFAULT_WIDTH;
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

customElements.define("caffold-files-page", CaffoldFilesPage);
