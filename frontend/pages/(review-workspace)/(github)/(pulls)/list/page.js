import { escapeHtml } from "../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import "../../../../../components/pagination.js";

class CaffoldGithubPullsListPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-pull-number]");
      if (!button) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:open-github-pull", {
          bubbles: true,
          detail: { number: Number.parseInt(button.dataset.pullNumber ?? "", 10) },
        }),
      );
    });
    this.addEventListener("caffold:change-page", (event) => {
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:change-github-pulls-page", {
          bubbles: true,
          detail: { page: event.detail.page },
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    if (!this.state) {
      this.reset();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setLoading(status = null, previousPayload = null, page = null) {
    const payload = previousPayload ?? this.state?.payload ?? null;
    this.state = {
      status: "loading",
      githubStatus: status,
      payload: this.loadingPayload(payload, page),
    };
    this.render();
  }

  setUnavailable(status) {
    this.state = { status: "unavailable", githubStatus: status };
    this.render();
  }

  setPulls(payload) {
    this.state = { status: "ready", payload };
    this.render();
  }

  setSelectedPull(number) {
    this.selectedPullNumber = number ?? null;
    this.patchSelectedPull();
  }

  setError(error, status = null) {
    this.state = { status: "error", error, githubStatus: status };
    this.render();
  }

  reset() {
    this.selectedPullNumber = null;
    this.state = { status: "idle" };
    this.render();
  }

  patchSelectedPull() {
    for (const button of this.querySelectorAll("button[data-pull-number]")) {
      const selected =
        Number.parseInt(button.dataset.pullNumber ?? "", 10) === this.selectedPullNumber;
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
        <section class="github-pulls-panel">
          ${this.renderHeader(null, null)}
          <ol class="github-pulls-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      if (this.state.payload) {
        const pulls = this.state.payload.pulls ?? [];
        const totalPulls = this.state.payload.totalPulls ?? pulls.length;
        this.innerHTML = `
          <section class="github-pulls-panel" aria-busy="true">
            ${this.renderHeader(this.state.payload.github, totalPulls)}
            <div class="github-pulls-loading-body">
              <p class="surface-message" aria-live="polite">Loading pull requests...</p>
            </div>
            ${this.renderPagination(this.state.payload)}
          </section>
        `;
        this.patchSelectedPull();
        return;
      }

      this.innerHTML = `
        <section class="github-pulls-panel" aria-busy="true">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">Loading pull requests...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "unavailable") {
      this.innerHTML = `
        <section class="github-pulls-panel error-panel">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">${escapeHtml(this.state.githubStatus?.message ?? "GitHub pull requests are unavailable.")}</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-pulls-panel error-panel">
          ${this.renderHeader(this.state.githubStatus?.github, null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const pulls = this.state.payload.pulls ?? [];
    const totalPulls = this.state.payload.totalPulls ?? pulls.length;
    this.innerHTML = `
      <section class="github-pulls-panel">
        ${this.renderHeader(this.state.payload.github, totalPulls)}
        ${
          pulls.length === 0
            ? `<p class="surface-message">No pull requests.</p>`
            : `<ol class="github-pulls-list">${pulls.map((pull) => this.renderPull(pull)).join("")}</ol>`
        }
        ${this.renderPagination(this.state.payload)}
      </section>
    `;
    this.patchSelectedPull();
  }

  renderHeader(github, count) {
    const countLabel = count === null || count === undefined ? "" : `${count} PRs`;

    return `
      <header>
        <div class="github-pulls-title-row">
          <h2>Pull Requests</h2>
          <span class="github-pulls-count">${escapeHtml(countLabel)}</span>
        </div>
        ${
          github
            ? `<span class="github-pulls-repo">${escapeHtml(github.nameWithOwner)}</span>`
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
        aria-label="Pull request pagination"
        page="${escapeHtml(`${page}`)}"
        total-pages="${escapeHtml(`${totalPages}`)}"
        ${payload.hasPrevious ? "has-previous" : ""}
        ${payload.hasNext ? "has-next" : ""}
        first-label="Newest pull request page"
        previous-label="Newer pull request page"
        next-label="Older pull request page"
        last-label="Oldest pull request page"
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

  renderPull(pull) {
    const selected = pull.number === this.selectedPullNumber;
    const labels = (pull.labels ?? []).slice(0, 3);
    const comments = pull.comments ? `${pull.comments} comments` : "0 comments";
    const draft = pull.draft ? `<span class="github-pull-draft">Draft</span>` : "";

    return `
      <li class="github-pull-row">
        <button
          type="button"
          class="github-pull-button"
          data-pull-number="${escapeHtml(`${pull.number}`)}"
          ${selected ? 'aria-current="true"' : ""}
        >
          <span class="github-pull-title">
            ${renderInlineIcon("GitPullRequest", "Pull request", "github-pull-icon")}
            <span>${escapeHtml(pull.title)}</span>
          </span>
          <span class="github-pull-meta">
            #${escapeHtml(`${pull.number}`)}
            ${pull.author ? ` · ${escapeHtml(pull.author)}` : ""}
            · ${escapeHtml(comments)}
            ${draft}
          </span>
          ${
            labels.length
              ? `
                <span class="github-pull-labels">
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

customElements.define("caffold-github-pulls-list-page", CaffoldGithubPullsListPage);
