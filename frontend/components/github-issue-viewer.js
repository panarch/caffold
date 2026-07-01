import { escapeHtml } from "./dom.js";
import "./github-markdown.js";

class CodgerGithubIssueViewer extends HTMLElement {
  connectedCallback() {
    if (!this.state) {
      this.setEmpty();
    }
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(number) {
    this.state = { status: "loading", number };
    this.render();
  }

  setIssue(payload) {
    this.state = { status: "ready", payload };
    this.render();
  }

  setError(number, error) {
    this.state = { status: "error", number, error };
    this.render();
  }

  render() {
    if (!this.state || this.state.status === "empty") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel">
          <p class="surface-message">Select an issue to inspect it.</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel" aria-busy="true">
          <p class="surface-message">Loading issue #${escapeHtml(`${this.state.number}`)}...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel error-panel">
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const issue = this.state.payload.issue;
    const bodyHtml = issue.bodyHtml?.trim();
    this.innerHTML = `
      <section class="github-issue-viewer-panel">
        <header>
          <div class="github-issue-viewer-title-row">
            <h2>${escapeHtml(issue.title)}</h2>
            <a
              class="github-issue-link"
              href="${escapeHtml(issue.url)}"
              target="_blank"
              rel="noreferrer"
            >GitHub</a>
          </div>
          <div class="github-issue-viewer-meta">
            <span>#${escapeHtml(`${issue.number}`)}</span>
            <span>${escapeHtml(issue.state)}</span>
            ${issue.author ? `<span>${escapeHtml(issue.author)}</span>` : ""}
            <span>${escapeHtml(`${issue.comments} comments`)}</span>
          </div>
          ${this.renderLabels(issue.labels ?? [])}
        </header>
        ${this.renderBody(issue, bodyHtml)}
      </section>
    `;

    if (bodyHtml) {
      this.querySelector("codger-github-markdown")?.setHtml(bodyHtml);
    }
  }

  renderLabels(labels) {
    if (!labels.length) {
      return "";
    }

    return `
      <div class="github-issue-viewer-labels">
        ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
      </div>
    `;
  }

  renderBody(issue, bodyHtml) {
    if (bodyHtml) {
      return `<codger-github-markdown class="github-issue-body"></codger-github-markdown>`;
    }

    return `
      <article class="github-issue-body github-issue-raw-body">
        ${escapeHtml(issue.body?.trim() || "No description.")}
      </article>
    `;
  }
}

customElements.define("codger-github-issue-viewer", CodgerGithubIssueViewer);
