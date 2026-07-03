import "../../../../../components/file-viewer.js";
import "./components/tree.js";

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
  }

  reset() {
    this.ensureRendered();
    this.tree.reset();
  }

  setLoading(repository, number = null) {
    this.ensureRendered();
    this.tree.setLoading(repository, number);
  }

  setFiles(payload) {
    this.ensureRendered();
    this.tree.setFiles(payload);
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.tree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    this.tree.setSelectedPath(path);
  }
}

customElements.define("caffold-github-pull-files-page", CaffoldGithubPullFilesPage);
