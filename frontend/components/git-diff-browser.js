import { getGitDiff } from "../api.js";
import "./file-viewer.js";
import "./git-diff-browser/changes-tree.js";

const LOADING_DELAY_MS = 180;
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 180;
const VIEWER_MIN_WIDTH = 320;
const PANEL_MAX_RATIO = 0.7;

class CaffoldGitDiffBrowser extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-git-diff-changes-tree></caffold-git-diff-changes-tree>
      <div
        class="git-diff-panel-resizer"
        role="separator"
        aria-label="Resize review side panel"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
      <caffold-review-file-viewer refresh-action="refresh-git-review"></caffold-review-file-viewer>
    `;
    this.changesTree = this.querySelector("caffold-git-diff-changes-tree");
    this.panelResizer = this.querySelector(".git-diff-panel-resizer");
    this.viewer = this.querySelector("caffold-review-file-viewer");
    this.viewer.setCloseLabel("Back to changes");
    this.diffRequestId ??= 0;
    this.changesScrollTop ??= 0;
    this.panelWidth ??= PANEL_DEFAULT_WIDTH;
    this.resizePointerId ??= null;
    this.setView(this.detailView ?? "list");
    this.applyPanelWidth(this.panelWidth);

    this.panelResizer.addEventListener("pointerdown", (event) => {
      this.startPanelResize(event);
    });
    this.panelResizer.addEventListener("pointermove", (event) => {
      this.movePanelResize(event);
    });
    this.panelResizer.addEventListener("pointerup", (event) => {
      this.endPanelResize(event);
    });
    this.panelResizer.addEventListener("pointercancel", (event) => {
      this.endPanelResize(event);
    });
    this.panelResizer.addEventListener("keydown", (event) => {
      this.adjustPanelWidthFromKeyboard(event);
    });
  }

  reset() {
    this.ensureRendered();
    this.diffRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.changesScrollTop = 0;
    this.changesTree.reset();
    this.viewer.setEmpty();
    this.setView("list");
  }

  setContext({ path, repository } = {}) {
    this.currentPath = path ?? this.currentPath ?? "";
    this.repository = repository ?? this.repository ?? null;
  }

  setLoading(repository) {
    this.ensureRendered();
    this.setContext({ repository });
    this.changesTree.setLoading(repository);
  }

  setStatus(gitStatus, options = {}) {
    this.ensureRendered();
    this.setContext({ repository: gitStatus?.repository });
    if (options.preserveState) {
      this.changesTree.updateStatus(gitStatus);
    } else {
      this.changesTree.setStatus(gitStatus);
    }
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.changesTree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    if (!path) {
      this.diffRequestId += 1;
    }
    this.changesTree.setSelectedPath(path);
  }

  setTaskRelatedPaths(paths) {
    this.ensureRendered();
    this.changesTree.setTaskRelatedPaths(paths);
  }

  setEmpty() {
    this.ensureRendered();
    this.diffRequestId += 1;
    this.viewer.setEmpty();
  }

  showList() {
    this.ensureRendered();
    this.setView("list");
    this.restoreChangesScroll();
  }

  async openDiff(path, kind, status = "") {
    if (!path) {
      return null;
    }

    this.ensureRendered();
    const requestId = ++this.diffRequestId;
    this.rememberChangesScroll();
    this.changesTree.setSelectedPath(path);
    this.setView("viewer");
    const loadingTimer = this.showLoadingAfterDelay(`Diff ${path}`, requestId);

    try {
      const diff = await getGitDiff(this.currentPath ?? "", path, kind);
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setDiff({ ...diff, status });
      return diff;
    } catch (error) {
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setError(path, error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async refreshSelectedDiff(gitStatus) {
    this.ensureRendered();
    const path = this.changesTree.selectedPath ?? "";
    if (!path) {
      return null;
    }
    const file = gitStatus?.files?.find((entry) => entry.path === path);
    if (!file) {
      this.changesTree.setSelectedPath("");
      if (window.matchMedia("(max-width: 860px)").matches) {
        this.showList();
      } else {
        this.viewer.setNotice("This file no longer has uncommitted changes.");
      }
      return null;
    }

    const requestId = ++this.diffRequestId;
    try {
      const kind = file.untracked ? "untracked" : file.category ?? "unstaged";
      const diff = await getGitDiff(this.currentPath ?? "", path, kind);
      if (requestId !== this.diffRequestId || path !== this.changesTree.selectedPath) {
        return null;
      }
      this.viewer.setDiff({ ...diff, status: file.status ?? "" }, { preserveScroll: true });
      return diff;
    } catch (error) {
      if (requestId === this.diffRequestId) {
        this.viewer.setError(path, error);
      }
      return null;
    }
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.viewer;
  }

  setView(view) {
    const nextView = view === "viewer" ? "viewer" : "list";
    const changed = this.detailView !== nextView || this.dataset.detailView !== nextView;
    this.detailView = nextView;
    this.dataset.detailView = this.detailView;
    if (changed) {
      this.dispatchEvent(
        new CustomEvent("caffold:git-diff-state-change", {
          bubbles: true,
          detail: { view: this.detailView },
        }),
      );
    }
  }

  showLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.diffRequestId) {
        this.viewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  rememberChangesScroll() {
    const scroller = this.querySelector(".changes-tree-list");
    if (!scroller) {
      return;
    }

    this.changesScrollTop = scroller.scrollTop;
  }

  restoreChangesScroll() {
    const top = this.changesScrollTop ?? 0;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = this.querySelector(".changes-tree-list");
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

  startPanelResize(event) {
    if (!this.canResizePanel()) {
      return;
    }

    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.panelResizer.setPointerCapture(event.pointerId);
    this.classList.add("is-resizing-panel");
    this.updatePanelWidthFromPointer(event);
  }

  movePanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    this.updatePanelWidthFromPointer(event);
  }

  endPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    this.resizePointerId = null;
    this.classList.remove("is-resizing-panel");
    if (this.panelResizer.hasPointerCapture(event.pointerId)) {
      this.panelResizer.releasePointerCapture(event.pointerId);
    }
  }

  adjustPanelWidthFromKeyboard(event) {
    if (!this.canResizePanel()) {
      return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextWidth = this.panelWidth;
    if (event.key === "ArrowLeft") {
      nextWidth -= step;
    } else if (event.key === "ArrowRight") {
      nextWidth += step;
    } else if (event.key === "Home") {
      nextWidth = PANEL_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.panelMaxWidth();
    } else {
      return;
    }

    event.preventDefault();
    this.applyPanelWidth(nextWidth);
  }

  updatePanelWidthFromPointer(event) {
    const rect = this.getBoundingClientRect();
    this.applyPanelWidth(event.clientX - rect.left);
  }

  applyPanelWidth(width) {
    const nextWidth = this.clampPanelWidth(width);
    this.panelWidth = nextWidth;
    this.style.setProperty("--git-diff-panel-width", `${nextWidth}px`);
    this.panelResizer.setAttribute("aria-valuemin", `${PANEL_MIN_WIDTH}`);
    this.panelResizer.setAttribute("aria-valuemax", `${this.panelMaxWidth()}`);
    this.panelResizer.setAttribute("aria-valuenow", `${nextWidth}`);
  }

  clampPanelWidth(width) {
    return Math.min(Math.max(Math.round(width), PANEL_MIN_WIDTH), this.panelMaxWidth());
  }

  panelMaxWidth() {
    const width = this.getBoundingClientRect().width;
    if (!width) {
      return PANEL_DEFAULT_WIDTH;
    }

    const ratioMax = Math.round(width * PANEL_MAX_RATIO);
    const viewerMax = Math.max(PANEL_MIN_WIDTH, width - VIEWER_MIN_WIDTH);
    return Math.max(PANEL_MIN_WIDTH, Math.min(ratioMax, viewerMax));
  }

  canResizePanel() {
    return window.matchMedia("(min-width: 861px)").matches;
  }
}

customElements.define("caffold-git-diff-browser", CaffoldGitDiffBrowser);
