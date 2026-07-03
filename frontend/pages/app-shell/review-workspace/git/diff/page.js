import "../../../../../components/file-viewer.js";
import "./components/changes-tree.js";

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
    this.setView(this.detailView ?? "list");
  }

  reset() {
    this.ensureRendered();
    this.changesTree.reset();
    this.viewer.setEmpty();
    this.setView("list");
  }

  setLoading(repository) {
    this.ensureRendered();
    this.changesTree.setLoading(repository);
  }

  setStatus(gitStatus) {
    this.ensureRendered();
    this.changesTree.setStatus(gitStatus);
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.changesTree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.changesTree.setSelectedPath(path);
  }

  setView(view) {
    this.detailView = view === "viewer" ? "viewer" : "list";
    this.dataset.detailView = this.detailView;
  }
}

customElements.define("caffold-git-diff-page", CaffoldGitDiffPage);
