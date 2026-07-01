import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";
import "./pagination.js";

class CodgerLogList extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      if (button.dataset.action === "toggle-commit-body") {
        this.toggleCommitBody(button.dataset.commitSha);
        return;
      }

      if (button.dataset.action !== "open-commit") {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("codger:open-git-commit", {
          bubbles: true,
          detail: {
            sha: button.dataset.commitSha,
          },
        }),
      );
    });
    this.addEventListener("codger:change-page", (event) => {
      event.stopPropagation();
      this.changePage(event.detail.page);
    });

    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();

    this.expandedShas ??= new Set();
    if (!this.state) {
      this.reset();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  setLoading(repository) {
    this.state = { status: "loading", repository };
    this.render();
  }

  setLog(log) {
    this.expandedShas = new Set();
    this.state = { status: "ready", log };
    this.render();
  }

  setError(error, repository = null) {
    this.state = { status: "error", error, repository };
    this.render();
  }

  reset() {
    this.expandedShas = new Set();
    this.state = { status: "idle" };
    this.render();
  }

  changePage(pageValue) {
    const page = Number.parseInt(pageValue ?? "", 10);
    if (!Number.isFinite(page) || page < 1) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("codger:change-log-page", {
        bubbles: true,
        detail: { page },
      }),
    );
  }

  toggleCommitBody(sha) {
    if (!sha) {
      return;
    }

    const commit = this.findCommit(sha);
    const body = commit?.body?.trim() ?? "";
    if (!commit || body.length === 0) {
      return;
    }

    const expanded = !this.expandedShas.has(sha);
    if (expanded) {
      this.expandedShas.add(sha);
    } else {
      this.expandedShas.delete(sha);
    }

    this.patchCommitBody(commit, expanded);
  }

  findCommit(sha) {
    return (this.state?.log?.commits ?? []).find((commit) => commit.sha === sha);
  }

  patchCommitBody(commit, expanded) {
    const entry = this.querySelector(`.log-entry[data-commit-sha="${CSS.escape(commit.sha)}"]`);
    if (!entry) {
      return;
    }

    const toggle = entry.querySelector("button[data-action='toggle-commit-body']");
    if (toggle) {
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute("aria-label", commitBodyToggleLabel(commit, expanded));
    }

    const body = entry.querySelector(".log-body");
    if (expanded) {
      if (!body) {
        entry.insertAdjacentHTML("beforeend", renderCommitBody(commit.body?.trim() ?? ""));
      }
      return;
    }

    body?.remove();
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="log-list-panel">
          ${this.renderHeader(null, null)}
          <ol class="log-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="log-list-panel" aria-busy="true">
          ${this.renderHeader(this.state.repository, null)}
          <p class="surface-message">Loading log...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="log-list-panel error-panel">
          ${this.renderHeader(this.state.repository, null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const commits = this.state.log.commits ?? [];
    const totalCount = this.state.log.totalCommits ?? commits.length;
    this.innerHTML = `
      <section class="log-list-panel">
        ${this.renderHeader(this.state.log.repository, totalCount)}
        ${
          commits.length === 0
            ? `<p class="surface-message">No commits.</p>`
            : `<ol class="log-list">${commits.map((commit) => this.renderCommit(commit)).join("")}</ol>`
        }
        ${this.renderPagination(this.state.log)}
      </section>
    `;
  }

  renderHeader(repository, count) {
    const branch = repository?.branch ?? "HEAD";
    const countLabel = count === null || count === undefined ? "" : `${count} commits`;

    return `
      <header>
        <div class="log-title-row">
          <h2>Log</h2>
          <span class="log-count">${escapeHtml(countLabel)}</span>
        </div>
        ${
          repository
            ? `<span class="log-branch">${escapeHtml(branch)}</span>`
            : ""
        }
      </header>
    `;
  }

  renderPagination(log) {
    const page = log.page ?? 1;
    const totalPages = log.totalPages ?? 0;
    if (totalPages <= 1) {
      return "";
    }

    return `
      <codger-pagination
        aria-label="Log pagination"
        page="${escapeHtml(`${page}`)}"
        total-pages="${escapeHtml(`${totalPages}`)}"
        ${log.hasPrevious ? "has-previous" : ""}
        ${log.hasNext ? "has-next" : ""}
        first-label="Newest page"
        previous-label="Newer page"
        next-label="Older page"
        last-label="Oldest page"
      ></codger-pagination>
    `;
  }

  renderCommit(commit) {
    const body = commit.body?.trim() ?? "";
    const expanded = body.length > 0 && this.expandedShas.has(commit.sha);
    const date = formatCommitDate(commit.authorTimeMs);
    const author = commit.authorName || commit.authorEmail || "";
    const meta = [commit.shortSha, author, date].filter(Boolean).join(" ");
    const summary = `
      <span class="log-subject">${escapeHtml(commit.subject || "(no subject)")}</span>
      <span class="log-meta">${escapeHtml(meta)}</span>
    `;

    return `
      <li
        class="log-entry"
        data-commit-sha="${escapeHtml(commit.sha)}"
      >
        ${
          body.length > 0
            ? `<button
                type="button"
                class="log-summary log-summary-toggle"
                data-action="toggle-commit-body"
                data-commit-sha="${escapeHtml(commit.sha)}"
                aria-expanded="${expanded ? "true" : "false"}"
                aria-label="${escapeHtml(commitBodyToggleLabel(commit, expanded))}"
                title="${escapeHtml(commit.subject)}"
              >
                ${summary}
              </button>`
            : `<div class="log-summary" title="${escapeHtml(commit.subject)}">
                ${summary}
              </div>`
        }
        <button
          type="button"
          class="log-review-button"
          data-action="open-commit"
          data-commit-sha="${escapeHtml(commit.sha)}"
          aria-label="${escapeHtml(`Open commit diff for ${commit.shortSha} ${commit.subject}`)}"
          title="${escapeHtml(`Open commit diff for ${commit.shortSha}`)}"
        >
          ${renderInlineIcon("FileDiff", "Diff", "log-review-icon")}
          <span class="log-review-label">Diff</span>
        </button>
        ${
          expanded
            ? renderCommitBody(body)
            : ""
        }
      </li>
    `;
  }
}

customElements.define("codger-log-list", CodgerLogList);

function formatCommitDate(ms) {
  if (!ms) {
    return "";
  }

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function commitBodyToggleLabel(commit, expanded) {
  return `${expanded ? "Collapse" : "Expand"} commit body for ${commit.shortSha}`;
}

function renderCommitBody(body) {
  return `<p class="log-body">${escapeHtml(body)}</p>`;
}
