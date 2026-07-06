import { getGitCommit, getGitCommitDiff } from "../../../../../api.js";
import "../../../../../components/file-viewer.js";
import "./components/changes-tree.js";

const LOADING_DELAY_MS = 180;

class CaffoldGitLogCommitPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
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
    `;
    this.commitTree = this.querySelector("caffold-commit-changes-tree");
    this.fileViewer = this.querySelector("caffold-review-file-viewer");
    this.fileViewer.setCloseLabel("Back to commit");
    this.commitRequestId ??= 0;
    this.fileRequestId ??= 0;
    this.detailView ??= "list";
    this.scrollPositions ??= {};
  }

  reset() {
    this.ensureRendered();
    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.commitPayload = null;
    this.selectedCommitSummary = null;
    this.scrollPositions = {};
    this.setDetailView("list");
    this.commitTree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  prepareForList() {
    this.ensureRendered();
    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.selectedCommitSummary = null;
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  prepareRoute(options = {}) {
    this.ensureRendered();
    const sha = options.sha ?? "";
    if (!sha) {
      this.prepareForList();
      return;
    }

    this.currentPath = options.currentPath ?? this.currentPath ?? "";
    this.repository = options.repository ?? this.repository ?? null;
    this.selectedCommitSummary = {
      sha,
      shortSha: sha.slice(0, 7),
      subject:
        this.commitPayload?.commit?.sha === sha
          ? (this.commitPayload.commit.subject ?? "")
          : "",
    };
    this.commitTree.setSelectedPath(options.path ?? "");
    if (this.repository) {
      this.commitTree.setLoading(this.repository, this.selectedCommitSummary);
    }
    if (options.path) {
      this.setDetailView("viewer");
      this.fileViewer.setLoading(`Commit diff ${options.path}`);
    } else {
      this.setDetailView("list");
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();
  }

  async openCommit(options = {}) {
    this.ensureRendered();
    const sha = options.sha ?? "";
    if (!sha) {
      return null;
    }

    this.currentPath = options.currentPath ?? this.currentPath ?? "";
    this.repository = options.repository ?? this.repository ?? null;
    if (!this.repository) {
      return null;
    }

    if (options.skipReload && this.commitPayload?.commit?.sha === sha) {
      this.selectedCommitSummary = this.commitPayload.commit;
      this.commitTree.setCommit(this.commitPayload);
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
      sha,
      shortSha: sha.slice(0, 7),
      subject: "",
    };
    this.setDetailView(options.preserveViewer ? "viewer" : "list");
    this.commitTree.setSelectedPath("");
    this.commitTree.setLoading(this.repository, this.selectedCommitSummary);
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

      this.commitTree.setError(error, this.repository, this.selectedCommitSummary);
      if (viewerRequestId === this.fileRequestId) {
        this.fileViewer.setError(`Commit ${sha.slice(0, 7)}`, error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openDiff(options = {}) {
    this.ensureRendered();
    const sha = options.sha ?? "";
    const path = options.path ?? "";
    if (!sha || !path) {
      return null;
    }

    this.currentPath = options.currentPath ?? this.currentPath ?? "";
    const requestId = ++this.fileRequestId;
    this.commitTree.setSelectedPath(path);
    this.rememberScroller("commit", this.commitTree, ".commit-tree-list");
    this.setDetailView("viewer");
    this.emitStateChange();
    const loadingTimer = this.showFileLoadingAfterDelay(`Commit diff ${path}`, requestId);

    try {
      const diff = await getGitCommitDiff(this.currentPath, sha, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }

      this.fileViewer.setDiff({ ...diff, status: options.status ?? "" });
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

  showFileList() {
    this.ensureRendered();
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.restoreScroller("commit", this.commitTree, ".commit-tree-list");
    this.emitStateChange();
  }

  canReuse(sha) {
    return this.commitPayload?.commit?.sha === sha;
  }

  currentCommitSha() {
    return this.commitPayload?.commit?.sha ?? this.selectedCommitSummary?.sha ?? "";
  }

  findFile(path) {
    return this.commitPayload?.files?.find((entry) => entry.path === path) ?? null;
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.commitTree.setSelectedPath(path ?? "");
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.fileViewer;
  }

  commitSubtitle() {
    const shortSha = this.selectedCommitSummary?.shortSha ?? "";
    const subject = this.selectedCommitSummary?.subject ?? "";
    return [shortSha, subject].filter(Boolean).join(" ");
  }

  setDetailView(view) {
    this.ensureRendered();
    this.detailView = view === "viewer" ? "viewer" : "list";
    this.dataset.detailView = this.detailView;
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

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:git-log-commit-state-change", {
        bubbles: true,
        detail: {
          detailView: this.detailView,
        },
      }),
    );
  }
}

customElements.define("caffold-git-log-commit-page", CaffoldGitLogCommitPage);
