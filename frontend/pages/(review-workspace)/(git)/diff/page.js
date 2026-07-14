import "../../../../components/git-diff-browser.js";

const DELEGATED_METHODS = [
  "reset",
  "setContext",
  "setLoading",
  "setStatus",
  "setError",
  "setSelectedPath",
  "setTaskRelatedPaths",
  "setEmpty",
  "showList",
  "openDiff",
  "refreshSelectedDiff",
  "isFileViewer",
  "setView",
];

class CaffoldGitDiffPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.browser) {
      return;
    }
    this.innerHTML = `<caffold-git-diff-browser></caffold-git-diff-browser>`;
    this.browser = this.querySelector("caffold-git-diff-browser");
    this.browser.ensureRendered();
    this.browser.addEventListener("caffold:git-diff-state-change", () => {
      this.dataset.detailView = this.browser.detailView;
    });
    this.dataset.detailView = this.browser.detailView;
  }

  get repository() {
    return this.browser?.repository ?? null;
  }

  get changesTree() {
    return this.browser?.changesTree ?? null;
  }

  get viewer() {
    return this.browser?.viewer ?? null;
  }

  get detailView() {
    return this.browser?.detailView ?? "list";
  }
}

for (const method of DELEGATED_METHODS) {
  CaffoldGitDiffPage.prototype[method] = function (...args) {
    this.ensureRendered();
    return this.browser[method](...args);
  };
}

customElements.define("caffold-git-diff-page", CaffoldGitDiffPage);
