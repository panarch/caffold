import {
  getGitCommit,
  getGitCommitDiff,
  getGitLog,
} from "../../../../../api.js";
import "./components/list.js";
import "./components/commit-tree.js";
import "../../../../../components/file-viewer.js";

const LOADING_DELAY_MS = 180;

class CaffoldGitLogLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-log-list></caffold-log-list>
      <div class="log-review-detail">
        <caffold-commit-changes-tree></caffold-commit-changes-tree>
        <div
          class="review-panel-resizer"
          role="separator"
          aria-label="Resize review side panel"
          aria-orientation="vertical"
          tabindex="0"
          data-resize-target="log"
        ></div>
        <caffold-review-file-viewer></caffold-review-file-viewer>
      </div>
    `;
    this.list = this.querySelector("caffold-log-list");
    this.commitTree = this.querySelector("caffold-commit-changes-tree");
    this.fileViewer = this.querySelector("caffold-review-file-viewer");
    this.fileViewer.setCloseLabel("Back to commit");
    this.logRequestId ??= 0;
    this.commitRequestId ??= 0;
    this.fileRequestId ??= 0;
    this.page ??= 1;
    this.view ??= "list";
    this.detailView ??= "list";
    this.scrollPositions ??= {};
  }

  reset() {
    this.ensureRendered();
    this.logRequestId += 1;
    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.log = null;
    this.commitPayload = null;
    this.selectedCommitSummary = null;
    this.page = 1;
    this.setView("list");
    this.setDetailView("list");
    this.list.reset();
    this.commitTree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  async openList(options = {}) {
    this.setContext(options);
    if (!options.skipReload) {
      this.page = normalizePage(options.page ?? this.page);
    }
    this.selectedCommitSummary = null;
    this.setView("list");
    this.setDetailView("list");
    this.commitTree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();

    if (options.skipReload) {
      return this.log;
    }

    return await this.loadLog(this.page);
  }

  async changePage(page) {
    if (this.view !== "list") {
      return null;
    }

    const nextPage = normalizePage(page);
    if (nextPage === this.page) {
      return null;
    }

    return await this.loadLog(nextPage);
  }

  async openCommit(sha, options = {}) {
    if (!sha || !this.repository) {
      return null;
    }

    this.setContext(options);
    this.page = normalizePage(options.page ?? this.page);
    if (options.skipReload && this.commitPayload?.commit?.sha === sha) {
      this.selectedCommitSummary = this.commitPayload.commit;
      this.setView("detail");
      this.setDetailView(options.preserveViewer ? this.detailView : "list");
      if (!options.preserveViewer) {
        this.commitTree.setSelectedPath("");
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return this.commitPayload;
    }

    const requestId = ++this.commitRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.selectedCommitSummary = {
      shortSha: sha.slice(0, 7),
      subject: "",
    };
    this.setView("detail");
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.commitTree.setLoading(this.repository);
    this.fileViewer.setLoading(`Commit ${sha.slice(0, 7)}`);
    this.emitStateChange();

    try {
      const commit = await getGitCommit(this.currentPath, sha);
      if (requestId !== this.commitRequestId) {
        return null;
      }

      this.commitPayload = commit;
      this.commitTree.setCommit(commit);
      this.selectedCommitSummary = commit.commit;
      if (viewerRequestId === this.fileRequestId) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return commit;
    } catch (error) {
      if (requestId !== this.commitRequestId) {
        return null;
      }

      this.commitTree.setError(error, this.repository);
      if (viewerRequestId === this.fileRequestId) {
        this.fileViewer.setError(`Commit ${sha.slice(0, 7)}`, error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return null;
    }

    const requestId = ++this.fileRequestId;
    this.commitTree.setSelectedPath(path);
    this.rememberScroller("commit", this.commitTree, ".commit-tree-list");
    this.setView("detail");
    this.setDetailView("viewer");
    this.emitStateChange();
    const loadingTimer = this.showFileLoadingAfterDelay(`Commit diff ${path}`, requestId);

    try {
      const diff = await getGitCommitDiff(this.currentPath, sha, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }

      this.fileViewer.setDiff({ ...diff, status });
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

  showCommitFileList() {
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.restoreScroller("commit", this.commitTree, ".commit-tree-list");
    this.emitStateChange();
  }

  backToList() {
    if (this.view === "list") {
      return false;
    }

    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.selectedCommitSummary = null;
    this.setView("list");
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.emitStateChange();
    return true;
  }

  setContext({ path, repository }) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;

    if (contextChanged) {
      this.logRequestId += 1;
      this.commitRequestId += 1;
      this.fileRequestId += 1;
      this.log = null;
      this.commitPayload = null;
      this.selectedCommitSummary = null;
      this.scrollPositions = {};
    }
  }

  async loadLog(page = this.page) {
    if (!this.repository) {
      return null;
    }

    const nextPage = normalizePage(page);
    const requestId = ++this.logRequestId;
    const loadingTimer = this.showLogLoadingAfterDelay(requestId);

    try {
      const log = await getGitLog(this.currentPath, nextPage);
      if (requestId !== this.logRequestId) {
        return null;
      }

      this.page = log.page ?? nextPage;
      this.repository = log.repository;
      this.log = log;
      this.list.setLog(log);
      this.emitStateChange();
      return log;
    } catch (error) {
      if (requestId !== this.logRequestId) {
        return null;
      }

      this.list.setError(error, this.repository);
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  canReuseRoute(page, sha) {
    if (!sha) {
      return Boolean(this.log) && normalizePage(page ?? this.page) === this.page;
    }

    return this.commitPayload?.commit?.sha === sha;
  }

  findCommitFile(path) {
    return this.commitPayload?.files?.find((entry) => entry.path === path) ?? null;
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.commitTree.setSelectedPath(path ?? "");
  }

  isFileViewer(target) {
    return target === this.fileViewer;
  }

  commitSubtitle() {
    const shortSha = this.selectedCommitSummary?.shortSha ?? "";
    const subject = this.selectedCommitSummary?.subject ?? "";
    return [shortSha, subject].filter(Boolean).join(" ");
  }

  setView(view) {
    this.ensureRendered();
    this.view = view === "detail" ? "detail" : "list";
    this.dataset.logView = this.view;
  }

  setDetailView(view) {
    this.ensureRendered();
    this.detailView = view === "viewer" ? "viewer" : "list";
    this.querySelector(".log-review-detail").dataset.detailView = this.detailView;
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

  showLogLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.logRequestId) {
        this.list.setLoading(this.repository);
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

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:git-log-state-change", {
        bubbles: true,
        detail: {
          view: this.view,
          detailView: this.detailView,
          page: this.page,
        },
      }),
    );
  }
}

customElements.define("caffold-git-log-layout", CaffoldGitLogLayout);

function normalizePage(page) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
