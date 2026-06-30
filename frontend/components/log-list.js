import { escapeHtml } from "./dom.js";

class CodgerLogList extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-commit-sha]");
      if (!button) {
        return;
      }

      this.setSelectedSha(button.dataset.commitSha);
      this.dispatchEvent(
        new CustomEvent("codger:open-git-commit", {
          bubbles: true,
          detail: {
            sha: button.dataset.commitSha,
          },
        }),
      );
    });

    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository) {
    this.state = { status: "loading", repository };
    this.render();
  }

  setLog(log) {
    this.state = { status: "ready", log };
    this.render();
  }

  setError(error, repository = null) {
    this.state = { status: "error", error, repository };
    this.render();
  }

  setSelectedSha(sha) {
    const nextSha = sha ?? "";
    if (this.selectedSha === nextSha) {
      return;
    }

    this.selectedSha = nextSha;
    this.patchSelectedSha();
  }

  patchSelectedSha() {
    for (const button of this.querySelectorAll('button[data-commit-sha][aria-current="true"]')) {
      button.setAttribute("aria-current", "false");
    }

    if (!this.selectedSha) {
      return;
    }

    const button = this.querySelector(
      `button[data-commit-sha="${CSS.escape(this.selectedSha)}"]`,
    );
    if (button) {
      button.setAttribute("aria-current", "true");
    }
  }

  reset() {
    this.selectedSha = "";
    this.state = { status: "idle" };
    this.render();
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
    this.innerHTML = `
      <section class="log-list-panel">
        ${this.renderHeader(this.state.log.repository, commits.length)}
        ${
          commits.length === 0
            ? `<p class="surface-message">No commits.</p>`
            : `<ol class="log-list">${commits.map((commit) => this.renderCommit(commit)).join("")}</ol>`
        }
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

  renderCommit(commit) {
    const selected = commit.sha === this.selectedSha;
    const date = formatCommitDate(commit.authorTimeMs);
    const author = commit.authorName || commit.authorEmail || "";
    const meta = [commit.shortSha, author, date].filter(Boolean).join(" ");

    return `
      <li>
        <button
          type="button"
          class="log-entry"
          data-commit-sha="${escapeHtml(commit.sha)}"
          aria-current="${selected ? "true" : "false"}"
          aria-label="${escapeHtml(`Open commit ${commit.shortSha} ${commit.subject}`)}"
          title="${escapeHtml(commit.subject)}"
        >
          <span class="log-subject">${escapeHtml(commit.subject || "(no subject)")}</span>
          <span class="log-meta">${escapeHtml(meta)}</span>
        </button>
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
