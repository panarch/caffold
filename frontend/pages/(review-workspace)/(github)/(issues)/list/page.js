import { escapeHtml } from "../../../../../components/dom.js";
import "../../../../../components/pagination.js";

class CaffoldGithubIssuesListPage extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-issue-number]");
      if (!button) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:open-github-issue", {
          bubbles: true,
          detail: { number: Number.parseInt(button.dataset.issueNumber ?? "", 10) },
        }),
      );
    });
    this.addEventListener("caffold:change-page", (event) => {
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:change-github-issues-page", {
          bubbles: true,
          detail: { page: event.detail.page },
        }),
      );
    });

    if (!this.state) {
      this.reset();
    }
  }

  setLoading(status = null, previousPayload = null, page = null) {
    this.state = {
      status: "loading",
      githubStatus: status,
      payload: this.loadingPayload(previousPayload, page),
    };
    this.render();
  }

  setUnavailable(status) {
    this.state = { status: "unavailable", githubStatus: status };
    this.render();
  }

  setIssues(payload) {
    this.state = { status: "ready", payload };
    this.render();
  }

  setSelectedIssue(number) {
    this.selectedIssueNumber = number ?? null;
    this.patchSelectedIssue();
  }

  setError(error, status = null) {
    this.state = { status: "error", error, githubStatus: status };
    this.render();
  }

  reset() {
    this.selectedIssueNumber = null;
    this.state = { status: "idle" };
    this.render();
  }

  patchSelectedIssue() {
    for (const button of this.querySelectorAll("button[data-issue-number]")) {
      const selected =
        Number.parseInt(button.dataset.issueNumber ?? "", 10) === this.selectedIssueNumber;
      if (selected) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="github-issues-panel">
          ${this.renderHeader(null, null)}
          <ol class="github-issues-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      if (this.state.payload) {
        const issues = this.state.payload.issues ?? [];
        const totalIssues = this.state.payload.totalIssues ?? issues.length;
        this.innerHTML = `
          <section class="github-issues-panel" aria-busy="true">
            ${this.renderHeader(this.state.payload.github, totalIssues)}
            <div class="github-issues-loading-body">
              <p class="surface-message" aria-live="polite">Loading issues...</p>
            </div>
            ${this.renderPagination(this.state.payload)}
          </section>
        `;
        this.patchSelectedIssue();
        return;
      }

      this.innerHTML = `
        <section class="github-issues-panel" aria-busy="true">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">Loading issues...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "unavailable") {
      this.innerHTML = `
        <section class="github-issues-panel error-panel">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">${escapeHtml(this.state.githubStatus?.message ?? "GitHub issues are unavailable.")}</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-issues-panel error-panel">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const issues = this.state.payload.issues ?? [];
    const totalIssues = this.state.payload.totalIssues ?? issues.length;
    this.innerHTML = `
      <section class="github-issues-panel">
        ${this.renderHeader(this.state.payload.github, totalIssues)}
        ${
          issues.length === 0
            ? `<p class="surface-message">No issues.</p>`
            : `<ol class="github-issues-list">${issues.map((issue) => this.renderIssue(issue)).join("")}</ol>`
        }
        ${this.renderPagination(this.state.payload)}
      </section>
    `;
    this.patchSelectedIssue();
  }

  renderHeader(github, count) {
    const countLabel = count === null || count === undefined ? "" : `${count} issues`;

    return `
      <header>
        <div class="github-issues-title-row">
          <h2>Issues</h2>
          <span class="github-issues-count">${escapeHtml(countLabel)}</span>
        </div>
        ${
          github
            ? `<span class="github-issues-repo">${escapeHtml(github.nameWithOwner)}</span>`
            : ""
        }
      </header>
    `;
  }

  renderPagination(payload) {
    const page = payload.page ?? 1;
    const totalPages = payload.totalPages ?? 0;
    if (totalPages <= 1) {
      return "";
    }

    return `
      <caffold-pagination
        aria-label="Issue pagination"
        page="${escapeHtml(`${page}`)}"
        total-pages="${escapeHtml(`${totalPages}`)}"
        ${payload.hasPrevious ? "has-previous" : ""}
        ${payload.hasNext ? "has-next" : ""}
        first-label="Newest issue page"
        previous-label="Newer issue page"
        next-label="Older issue page"
        last-label="Oldest issue page"
      ></caffold-pagination>
    `;
  }

  loadingPayload(payload, page) {
    if (!payload) {
      return null;
    }

    const targetPage = Number.parseInt(`${page ?? payload.page ?? 1}`, 10);
    const totalPages = Number.parseInt(`${payload.totalPages ?? 0}`, 10);
    const nextPage = Number.isFinite(targetPage) && targetPage > 0 ? targetPage : 1;
    return {
      ...payload,
      page: nextPage,
      hasPrevious: nextPage > 1,
      hasNext: totalPages > 0 ? nextPage < totalPages : Boolean(payload.hasNext),
    };
  }

  renderIssue(issue) {
    const selected = issue.number === this.selectedIssueNumber;
    const labels = (issue.labels ?? []).slice(0, 3);
    const comments = issue.comments ? `${issue.comments} comments` : "0 comments";

    return `
      <li class="github-issue-row">
        <button
          type="button"
          class="github-issue-button"
          data-issue-number="${escapeHtml(`${issue.number}`)}"
          ${selected ? 'aria-current="true"' : ""}
        >
          <span class="github-issue-title">${escapeHtml(issue.title)}</span>
          <span class="github-issue-meta">
            #${escapeHtml(`${issue.number}`)}
            ${issue.author ? ` · ${escapeHtml(issue.author)}` : ""}
            · ${escapeHtml(comments)}
          </span>
          ${
            labels.length
              ? `
                <span class="github-issue-labels">
                  ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
                </span>
              `
              : ""
          }
        </button>
      </li>
    `;
  }
}

customElements.define("caffold-github-issues-list-page", CaffoldGithubIssuesListPage);
