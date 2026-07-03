import "../../../../../components/file-viewer.js";
import "./components/compare-tree.js";

class CaffoldGitComparePage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-git-compare-tree></caffold-git-compare-tree>
      <div
        class="review-panel-resizer"
        role="separator"
        aria-label="Resize review side panel"
        aria-orientation="vertical"
        tabindex="0"
        data-resize-target="compare"
      ></div>
      <caffold-review-file-viewer></caffold-review-file-viewer>
    `;
    this.compareTree = this.querySelector("caffold-git-compare-tree");
    this.viewer = this.querySelector("caffold-review-file-viewer");
    this.setView(this.detailView ?? "list");
  }

  reset() {
    this.ensureRendered();
    this.compareTree.reset();
    this.viewer.setEmpty();
    this.setView("list");
  }

  setLoading(repository) {
    this.ensureRendered();
    this.compareTree.setLoading(repository);
  }

  setCompare(comparePayload) {
    this.ensureRendered();
    this.compareTree.setCompare(comparePayload);
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.compareTree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.compareTree.setSelectedPath(path);
  }

  setView(view) {
    this.detailView = view === "viewer" ? "viewer" : "list";
    this.dataset.detailView = this.detailView;
  }
}

customElements.define("caffold-git-compare-page", CaffoldGitComparePage);
