import { getGitHubPullFile, getGitHubPullFiles } from "../../../../../../../../api.js";
import { diffViewerPresentation } from "../../../../../../../../components/file-viewer-presentation.js";
import "../../../../../../../../components/file-viewer.js";
import { REVIEW_PANEL_DEFAULT_WIDTH } from "../../../../../../../../components/review-panel-resizer.js";
import "./components/tree.js";

const LOADING_DELAY_MS = 180;

class CaffoldGithubPullFilesPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-github-pull-files-tree></caffold-github-pull-files-tree>
      <caffold-review-panel-resizer
        aria-label="Resize review side panel"
      ></caffold-review-panel-resizer>
      <caffold-review-file-viewer></caffold-review-file-viewer>
    `;
    this.tree = this.querySelector("caffold-github-pull-files-tree");
    this.panelResizer = this.querySelector("caffold-review-panel-resizer");
    this.fileViewer = this.querySelector("caffold-review-file-viewer");
    this.fileViewer.setCloseLabel("Back to PR files");
    this.filesRequestId ??= 0;
    this.fileRequestId ??= 0;
    this.viewerPresentation ??= null;
    this.detailView ??= "list";
    this.panelWidth ??= REVIEW_PANEL_DEFAULT_WIDTH;
    this.panelResizer.addEventListener("caffold:review-panel-resize", (event) => {
      this.handlePanelResize(event);
    });
    this.applyPanelWidth(this.panelWidth);
  }

  handlePanelResize(event) {
    event.stopPropagation();
    if (event.detail.phase === "start") {
      this.classList.add("is-resizing-panel");
      return;
    }
    if (event.detail.phase === "end") {
      this.classList.remove("is-resizing-panel");
      return;
    }
    if (event.detail.phase === "update") {
      this.applyPanelWidth(event.detail.value);
    }
  }

  applyPanelWidth(width) {
    const nextWidth = this.panelResizer.setValue(width);
    this.panelWidth = nextWidth;
    this.style.setProperty("--github-pull-files-panel-width", `${nextWidth}px`);
  }

  reset() {
    this.ensureRendered();
    this.filesRequestId += 1;
    this.fileRequestId += 1;
    this.pullFiles = null;
    this.pullNumber = null;
    this.viewerPresentation = null;
    this.scrollTop = 0;
    this.setView("list");
    this.tree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  invalidateRequests() {
    this.ensureRendered();
    this.filesRequestId += 1;
    this.fileRequestId += 1;
  }

  setContext(options = {}) {
    this.ensureRendered();
    const { path, repository } = options;
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;

    if (contextChanged) {
      this.filesRequestId += 1;
      this.fileRequestId += 1;
      this.pullFiles = null;
      this.pullNumber = null;
      this.viewerPresentation = null;
      this.scrollTop = 0;
      this.setView("list");
      this.tree.reset();
      this.fileViewer.setEmpty();
    }
  }

  setView(view) {
    this.ensureRendered();
    this.detailView = normalizeDetailView(view);
    this.dataset.detailView = this.detailView;
  }

  setLoading(repository, number = null, options = {}) {
    this.ensureRendered();
    if (!options.preserveView) {
      this.setView("list");
    }
    this.tree.setLoading(repository, number);
  }

  setFiles(payload, options = {}) {
    this.ensureRendered();
    if (!options.preserveView) {
      this.setView("list");
    }
    this.tree.setFiles(payload);
  }

  setError(error, repository = null, options = {}) {
    this.ensureRendered();
    if (!options.preserveView) {
      this.setView("list");
    }
    this.tree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.tree.setSelectedPath(path);
  }

  async openFiles(number, options = {}) {
    const pullNumber = normalizePullNumber(number);
    if (!this.repository || !Number.isFinite(pullNumber)) {
      return null;
    }

    const requestId = ++this.filesRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.pullNumber = pullNumber;
    if (options.preserveViewer) {
      this.setView("viewer");
    } else {
      this.setView("list");
    }

    if (!options.skipReload) {
      this.setLoading(this.repository, pullNumber, {
        preserveView: Boolean(options.preserveViewer),
      });
    }
    if (!options.preserveViewer && viewerRequestId === this.fileRequestId) {
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();

    if (options.skipReload) {
      return this.pullFiles;
    }

    try {
      const files = await getGitHubPullFiles(this.currentPath, pullNumber);
      if (requestId !== this.filesRequestId) {
        return null;
      }

      this.pullFiles = files;
      this.setFiles(files, {
        preserveView: Boolean(options.preserveViewer),
      });
      if (viewerRequestId === this.fileRequestId && !options.preserveViewer) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return files;
    } catch (error) {
      if (requestId !== this.filesRequestId) {
        return null;
      }

      this.setError(error, this.repository, {
        preserveView: Boolean(options.preserveViewer),
      });
      if (
        options.preserveViewer &&
        viewerRequestId === this.fileRequestId &&
        this.viewerPresentation
      ) {
        this.fileViewer.setError(this.viewerPresentation, error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openFile(path, status = "") {
    const number = this.currentPullNumber();
    if (!number || !path) {
      return null;
    }

    const requestId = ++this.fileRequestId;
    this.setSelectedPath(path);
    this.rememberScroll();
    this.setView("viewer");
    this.emitStateChange();
    const presentation = this.diffPresentation(path, status);
    this.viewerPresentation = presentation;
    const loadingTimer = this.showFileLoadingAfterDelay(presentation, requestId);

    try {
      const diff = await getGitHubPullFile(this.currentPath, number, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }

      const loadedPresentation = this.diffPresentation(path, status, number, diff);
      this.viewerPresentation = loadedPresentation;
      if (diff.diffUnavailable) {
        this.fileViewer.setError(
          loadedPresentation,
          new Error(diff.message ?? "Diff unavailable."),
        );
      } else {
        this.fileViewer.setDiff(
          { ...diff, status },
          { presentation: loadedPresentation },
        );
      }
      return diff;
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return null;
      }

      this.fileViewer.setError(presentation, error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showList() {
    this.fileRequestId += 1;
    this.setView("list");
    this.setSelectedPath("");
    this.viewerPresentation = null;
    this.fileViewer.setEmpty();
    this.restoreScroll();
    this.emitStateChange();
  }

  prepareRoute(number, options = {}) {
    this.ensureRendered();
    const pullNumber = normalizePullNumber(number);
    if (!Number.isFinite(pullNumber)) {
      this.reset();
      return;
    }

    this.pullNumber = pullNumber;
    if (options.path) {
      this.setSelectedPath(options.path);
      this.setView("viewer");
      this.viewerPresentation = this.diffPresentation(options.path, "", pullNumber);
      this.fileViewer.setLoading(this.viewerPresentation);
    } else {
      this.setSelectedPath("");
      this.setView("list");
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();
  }

  clearViewer() {
    this.fileRequestId += 1;
    this.viewerPresentation = null;
    this.fileViewer.setEmpty();
  }

  canReuseFiles(number) {
    return this.pullFiles?.number === normalizePullNumber(number);
  }

  findFile(path) {
    return this.pullFiles?.files?.find((entry) => entry.path === path) ?? null;
  }

  diffPresentation(path, status = "", number = this.currentPullNumber(), diff = {}) {
    const file = this.findFile(path);
    const fileStatsAvailable =
      Number.isFinite(file?.additions) &&
      Number.isFinite(file?.deletions) &&
      (file.patchAvailable || file.additions > 0 || file.deletions > 0);
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? this.repository,
      path: diff.path ?? path,
      repoRelativePath: diff.repoRelativePath ?? file?.repoRelativePath,
      kind: diff.kind || (Number.isFinite(number) ? `PR #${number}` : ""),
      status: status || file?.status || "",
      additions: Object.hasOwn(diff, "additions")
        ? diff.additions
        : fileStatsAvailable
          ? file.additions
          : undefined,
      deletions: Object.hasOwn(diff, "deletions")
        ? diff.deletions
        : fileStatsAvailable
          ? file.deletions
          : undefined,
    });
  }

  currentPullNumber() {
    return this.pullNumber ?? this.pullFiles?.number ?? null;
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.fileViewer;
  }

  rememberScroll() {
    const scroller = this.querySelector(".file-tree-scroll");
    if (scroller) {
      this.scrollTop = scroller.scrollTop;
    }
  }

  restoreScroll() {
    const top = this.scrollTop ?? 0;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = this.querySelector(".file-tree-scroll");
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

  showFileLoadingAfterDelay(presentation, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(presentation);
      }
    }, LOADING_DELAY_MS);
  }

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:github-pull-files-state-change", {
        bubbles: true,
        detail: {
          view: this.detailView,
          number: this.currentPullNumber(),
        },
      }),
    );
  }
}

customElements.define("caffold-github-pull-files-page", CaffoldGithubPullFilesPage);

function normalizeDetailView(view) {
  return view === "viewer" ? "viewer" : "list";
}

function normalizePullNumber(number) {
  return Number.parseInt(`${number ?? ""}`, 10);
}
