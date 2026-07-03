import "./list/page.js";
import "./detail/page.js";

class CaffoldGithubIssuesLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (!this.dataset.issuesView) {
      this.setView("list");
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-github-issues-list-page></caffold-github-issues-list-page>
      <caffold-github-issue-detail-page></caffold-github-issue-detail-page>
    `;
  }

  setView(view) {
    this.ensureRendered();
    this.dataset.issuesView = view === "detail" ? "detail" : "list";
  }
}

customElements.define("caffold-github-issues-layout", CaffoldGithubIssuesLayout);
