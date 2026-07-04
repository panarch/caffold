import { getGitHubPullFile, getGitHubPullFiles } from "../../../../../api.js";
import "../../../../../components/file-viewer.js";
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
      <div
        class="review-panel-resizer"
        role="separator"
        aria-label="Resize review side panel"
        aria-orientation="vertical"
        tabindex="0"
        data-resize-target="pulls"
      ></div>
      <caffold-review-file-viewer></caffold-review-file-viewer>
    `;
    this.tree = this.querySelector("caffold-github-pull-files-tree");
    this.fileViewer = this.querySelector("caffold-review-file-viewer");
    this.fileViewer.setCloseLabel("Back to PR files");
    this.filesRequestId ??= 0;
    this.fileRequestId ??= 0;
    this.detailView ??= "list";
  }

  reset() {
    this.ensureRendered();
    this.filesRequestId += 1;
    this.fileRequestId += 1;
    this.pullFiles = null;
    this.pullNumber = null;
    this.scrollTop = 0;
    this.setView("list");
    this.tree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
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

  setLoading(repository, number = null) {
    this.ensureRendered();
    this.setView("list");
    this.tree.setLoading(repository, number);
  }

  setFiles(payload) {
    this.ensureRendered();
    this.setView("list");
    this.tree.setFiles(payload);
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.setView("list");
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
    this.setView("list");

    if (!options.skipReload) {
      this.setLoading(this.repository, pullNumber);
    }
    if (!options.preserveViewer && viewerRequestId === this.fileRequestId) {
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
      this.setFiles(files);
      if (viewerRequestId === this.fileRequestId && !options.preserveViewer) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return files;
    } catch (error) {
      if (requestId !== this.filesRequestId) {
        return null;
      }

      this.setError(error, this.repository);
      if (viewerRequestId === this.fileRequestId) {
        this.fileViewer.setError(`PR #${pullNumber}`, error);
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
    const loadingTimer = this.showFileLoadingAfterDelay(path, requestId);

    try {
      const diff = await getGitHubPullFile(this.currentPath, number, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }

      if (diff.diffUnavailable) {
        this.fileViewer.setError(path, new Error(diff.message ?? "Diff unavailable."));
      } else {
        this.fileViewer.setDiff({ ...diff, status });
      }
      return diff;
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return null;
      }

      this.fileViewer.setError(path, error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showList() {
    this.fileRequestId += 1;
    this.setView("list");
    this.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.restoreScroll();
    this.emitStateChange();
  }

  clearViewer() {
    this.fileRequestId += 1;
    this.fileViewer.setEmpty();
  }

  canReuseFiles(number) {
    return this.pullFiles?.number === normalizePullNumber(number);
  }

  findFile(path) {
    return this.pullFiles?.files?.find((entry) => entry.path === path) ?? null;
  }

  currentPullNumber() {
    return this.pullNumber ?? this.pullFiles?.number ?? null;
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.fileViewer;
  }

  rememberScroll() {
    const scroller = this.querySelector(".github-pull-files-list");
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
      const scroller = this.querySelector(".github-pull-files-list");
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

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(path);
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
