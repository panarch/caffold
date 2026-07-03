import "./list/page.js";
import "./detail/page.js";
import "./files/page.js";

class CaffoldGithubPullsLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (!this.dataset.pullsView) {
      this.setView("list");
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-github-pulls-list-page></caffold-github-pulls-list-page>
      <caffold-github-pull-detail-page></caffold-github-pull-detail-page>
      <caffold-github-pull-files-page></caffold-github-pull-files-page>
    `;
  }

  setView(view) {
    this.ensureRendered();
    this.dataset.pullsView = normalizePullsView(view);
  }
}

customElements.define("caffold-github-pulls-layout", CaffoldGithubPullsLayout);

function normalizePullsView(view) {
  return view === "detail" || view === "files" ? view : "list";
}
