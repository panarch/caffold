import { escapeHtml } from "../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import "../../components/markdown.js";

class CaffoldGithubPullDetailPage extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }

        if (button.dataset.action === "close-github-pull-viewer") {
          this.dispatchEvent(
            new CustomEvent("caffold:close-github-pull-viewer", {
              bubbles: true,
            }),
          );
          return;
        }

        if (button.dataset.action === "open-github-pull-files") {
          this.dispatchEvent(
            new CustomEvent("caffold:open-github-pull-files", {
              bubbles: true,
              detail: { number: Number.parseInt(button.dataset.pullNumber ?? "", 10) },
            }),
          );
        }
      });
      this.boundIconsReady = () => this.render();
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
      warmIcons();
    }

    if (!this.state) {
      this.setEmpty();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(number) {
    this.state = { status: "loading", number };
    this.render();
  }

  setPull(payload) {
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
        <section class="github-pull-viewer-panel">
          <p class="surface-message">Select a pull request to inspect it.</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="github-pull-viewer-panel" aria-busy="true">
          ${this.renderBasicHeader(`PR #${this.state.number}`)}
          <p class="surface-message">Loading pull request #${escapeHtml(`${this.state.number}`)}...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-pull-viewer-panel error-panel">
          ${this.renderBasicHeader(`PR #${this.state.number}`)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const pull = this.state.payload.pull;
    const markdownBlocks = [];
    this.innerHTML = `
      <section class="github-pull-viewer-panel">
        <header>
          <div class="github-pull-viewer-title-row">
            ${this.renderCloseButton()}
            <h2>${escapeHtml(pull.title)}</h2>
            <button
              type="button"
              class="github-pull-files-button"
              data-action="open-github-pull-files"
              data-pull-number="${escapeHtml(`${pull.number}`)}"
              aria-label="${escapeHtml(`Open files for PR #${pull.number}`)}"
            >
              ${renderInlineIcon("FileDiff", "Files", "github-pull-files-icon")}
              <span>${escapeHtml(`${pull.changedFiles} files`)}</span>
            </button>
            <a
              class="github-pull-link"
              href="${escapeHtml(pull.url)}"
              target="_blank"
              rel="noreferrer"
            >GitHub</a>
          </div>
          <div class="github-pull-viewer-meta">
            <span>#${escapeHtml(`${pull.number}`)}</span>
            <span>${escapeHtml(pull.state)}</span>
            ${pull.draft ? "<span>Draft</span>" : ""}
            ${pull.author ? `<span>${escapeHtml(pull.author)}</span>` : ""}
            <span>${escapeHtml(`${pull.baseRefName}...${pull.headRefName}`)}</span>
            <span>${escapeHtml(`+${pull.additions} -${pull.deletions}`)}</span>
          </div>
          ${this.renderLabels(pull.labels ?? [])}
        </header>
        <div class="github-pull-viewer-scroll">
          ${this.renderBody(pull, markdownBlocks)}
          ${this.renderComments("Conversation", pull.conversationComments ?? [], markdownBlocks)}
          ${this.renderReviews(pull.reviewComments ?? [], markdownBlocks)}
          ${this.renderCommits(pull.commitSummaries ?? [])}
        </div>
      </section>
    `;

    for (const [index, html] of markdownBlocks.entries()) {
      this.querySelector(`caffold-github-markdown[data-markdown-index="${index}"]`)?.setHtml(html);
    }
  }

  renderLabels(labels) {
    if (!labels.length) {
      return "";
    }

    return `
      <div class="github-pull-viewer-labels">
        ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
      </div>
    `;
  }

  renderBasicHeader(title) {
    return `
      <header>
        <div class="github-pull-viewer-title-row">
          ${this.renderCloseButton()}
          <h2>${escapeHtml(title)}</h2>
        </div>
      </header>
    `;
  }

  renderCloseButton() {
    const label = "Back to pull requests";

    return `
      <button
        type="button"
        class="github-pull-close-button"
        data-action="close-github-pull-viewer"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
      >
        ${renderInlineIcon("X", label, "github-pull-close-icon")}
      </button>
    `;
  }

  renderBody(pull, markdownBlocks) {
    return `
      <section class="github-pull-section github-pull-body-section">
        <h3>Description</h3>
        ${this.renderMarkdownOrRaw(pull.bodyHtml, pull.body, "No description.", markdownBlocks)}
      </section>
    `;
  }

  renderComments(title, comments, markdownBlocks) {
    if (!comments.length) {
      return `
        <section class="github-pull-section">
          <h3>${escapeHtml(title)}</h3>
          <p class="github-pull-empty-note">No comments.</p>
        </section>
      `;
    }

    return `
      <section class="github-pull-section">
        <h3>${escapeHtml(title)}</h3>
        <ol class="github-pull-comments">
          ${comments
            .map((comment) => this.renderComment(comment, markdownBlocks))
            .join("")}
        </ol>
      </section>
    `;
  }

  renderReviews(reviews, markdownBlocks) {
    if (!reviews.length) {
      return `
        <section class="github-pull-section">
          <h3>Reviews</h3>
          <p class="github-pull-empty-note">No review summaries.</p>
        </section>
      `;
    }

    return `
      <section class="github-pull-section">
        <h3>Reviews</h3>
        <ol class="github-pull-comments">
          ${reviews.map((review) => this.renderReview(review, markdownBlocks)).join("")}
        </ol>
      </section>
    `;
  }

  renderComment(comment, markdownBlocks) {
    return `
      <li class="github-pull-comment">
        <div class="github-pull-comment-meta">
          ${comment.author ? `<span>${escapeHtml(comment.author)}</span>` : ""}
          ${comment.updatedAt ? `<span>${escapeHtml(comment.updatedAt)}</span>` : ""}
          ${
            comment.url
              ? `<a href="${escapeHtml(comment.url)}" target="_blank" rel="noreferrer">GitHub</a>`
              : ""
          }
        </div>
        ${this.renderMarkdownOrRaw(comment.bodyHtml, comment.body, "No comment body.", markdownBlocks)}
      </li>
    `;
  }

  renderReview(review, markdownBlocks) {
    return `
      <li class="github-pull-comment">
        <div class="github-pull-comment-meta">
          ${review.author ? `<span>${escapeHtml(review.author)}</span>` : ""}
          <span>${escapeHtml(review.state)}</span>
          ${review.submittedAt ? `<span>${escapeHtml(review.submittedAt)}</span>` : ""}
        </div>
        ${this.renderMarkdownOrRaw(review.bodyHtml, review.body, "No review body.", markdownBlocks)}
      </li>
    `;
  }

  renderCommits(commits) {
    if (!commits.length) {
      return `
        <section class="github-pull-section">
          <h3>Commits</h3>
          <p class="github-pull-empty-note">No commits.</p>
        </section>
      `;
    }

    return `
      <section class="github-pull-section">
        <h3>Commits</h3>
        <ol class="github-pull-commits">
          ${commits.map((commit) => this.renderCommit(commit)).join("")}
        </ol>
      </section>
    `;
  }

  renderCommit(commit) {
    return `
      <li class="github-pull-commit">
        <a href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">
          <span>${escapeHtml(commit.shortSha)}</span>
          <span>${escapeHtml(commit.subject)}</span>
        </a>
        ${
          commit.authorName || commit.committedAt
            ? `<span>${escapeHtml([commit.authorName, commit.committedAt].filter(Boolean).join(" · "))}</span>`
            : ""
        }
      </li>
    `;
  }

  renderMarkdownOrRaw(html, raw, emptyText, markdownBlocks) {
    if (html?.trim()) {
      const index = markdownBlocks.push(html) - 1;
      return `<caffold-github-markdown data-markdown-index="${index}"></caffold-github-markdown>`;
    }

    return `
      <article class="github-pull-raw-body">
        ${escapeHtml(raw?.trim() || emptyText)}
      </article>
    `;
  }
}

customElements.define("caffold-github-pull-detail-page", CaffoldGithubPullDetailPage);
