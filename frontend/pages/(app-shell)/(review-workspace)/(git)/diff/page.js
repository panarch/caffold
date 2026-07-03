import { getGitDiff } from "../../../../../api.js";
import "../../../../../components/file-viewer.js";
import "./components/changes-tree.js";

const LOADING_DELAY_MS = 180;

class CaffoldGitDiffPage extends HTMLElement {
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
        class="review-panel-resizer"
        role="separator"
        aria-label="Resize review side panel"
        aria-orientation="vertical"
        tabindex="0"
        data-resize-target="diff"
      ></div>
      <caffold-review-file-viewer></caffold-review-file-viewer>
    `;
    this.changesTree = this.querySelector("caffold-git-diff-changes-tree");
    this.viewer = this.querySelector("caffold-review-file-viewer");
    this.viewer.setCloseLabel("Back to changes");
    this.diffRequestId ??= 0;
    this.changesScrollTop ??= 0;
    this.setView(this.detailView ?? "list");
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

  setStatus(gitStatus) {
    this.ensureRendered();
    this.setContext({ repository: gitStatus?.repository });
    this.changesTree.setStatus(gitStatus);
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
}

customElements.define("caffold-git-diff-page", CaffoldGitDiffPage);
