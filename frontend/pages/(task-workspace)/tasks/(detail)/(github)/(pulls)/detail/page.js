import { escapeHtml } from "../../../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../../../components/icons.js";
import "../../components/markdown.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../../../../../../scroll-scope.js";

class CaffoldGithubPullDetailPage extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }

        if (button.dataset.action === "open-github-pull-files") {
          this.dispatchEvent(
            new CustomEvent("caffold:open-github-pull-files", {
              bubbles: true,
              detail: { number: Number.parseInt(button.dataset.pullNumber ?? "", 10) },
            }),
          );
        } else if (
          button.dataset.action === "start-github-task" &&
          this.state?.status === "ready"
        ) {
          this.dispatchEvent(
            new CustomEvent("caffold:start-github-task", {
              bubbles: true,
              composed: true,
              detail: {
                kind: "pull",
                payload: this.state.payload,
                opener: button,
              },
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

  actionHintScope({ scopeId = "github:pull", clipRoots = [] } = {}) {
    const state = this.state;
    const pull = state?.payload?.pull;
    const number = `${pull?.number ?? ""}`;
    if (
      this.hidden ||
      this.state?.status !== "ready" ||
      !number
    ) {
      return emptyActionHintScope();
    }
    const definitions = [
      {
        identity: "start-task",
        actionId: ACTION_HINT_ACTION.GITHUB_TASK_START,
        selector:
          ':scope > .github-pull-viewer-panel > header > .github-pull-viewer-title-row > .github-pull-actions > button.github-pull-start-button[data-action="start-github-task"]',
        fallbackLabel: `Start Task for pull request #${number}`,
        matchesControl: () => true,
      },
      {
        identity: "files",
        actionId: ACTION_HINT_ACTION.PULL_FILES,
        selector:
          ':scope > .github-pull-viewer-panel > header > .github-pull-viewer-title-row > .github-pull-actions > button.github-pull-files-button[data-action="open-github-pull-files"][data-pull-number]',
        fallbackLabel: `Open files for PR #${number}`,
        matchesControl: (control) =>
          `${control.dataset.pullNumber ?? ""}` === number,
      },
    ];
    const targets = definitions.flatMap((definition) => {
      const control = this.querySelector(definition.selector);
      if (
        !control ||
        control.disabled ||
        !definition.matchesControl(control) ||
        !hasActionHintLayoutBox(control)
      ) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${scopeId}:${encodeURIComponent(number)}:${definition.identity}`,
        actionId: definition.actionId,
        label: control.getAttribute("aria-label") || definition.fallbackLabel,
        control,
        clipRoots: [this, ...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          `${this.state?.payload?.pull?.number ?? ""}` === number &&
          this.querySelector(definition.selector) === control &&
          definition.matchesControl(control) &&
          !control.disabled &&
          hasActionHintLayoutBox(control),
      })];
    });
    const headerLinkSelector =
      ":scope > .github-pull-viewer-panel > header > .github-pull-viewer-title-row > .github-pull-actions > a.github-pull-link[href]";
    const headerLink = this.querySelector(headerLinkSelector);
    if (
      headerLink &&
      headerLink.getAttribute("href") === pull.url &&
      hasActionHintLayoutBox(headerLink)
    ) {
      targets.push(linkActionHintTarget({
        id: `${scopeId}:${encodeURIComponent(number)}:github`,
        actionId: ACTION_HINT_ACTION.LINK_OPEN,
        label: `Open pull request #${number} on GitHub in a new tab`,
        control: headerLink,
        clipRoots: [this, ...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(headerLinkSelector) === headerLink &&
          headerLink.getAttribute("href") === pull.url &&
          hasActionHintLayoutBox(headerLink),
      }));
    }
    const scrollport = this.querySelector(
      ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll",
    );
    if (scrollport) {
      for (
        const [index, comment] of (pull.conversationComments ?? []).entries()
      ) {
        if (!comment.url) {
          continue;
        }
        const selector =
          `:scope > .github-pull-viewer-panel > .github-pull-viewer-scroll a[data-github-pull-comment-index="${index}"][href]`;
        const link = this.querySelector(selector);
        if (
          !link ||
          link.getAttribute("href") !== comment.url ||
          !hasActionHintLayoutBox(link)
        ) {
          continue;
        }
        targets.push(linkActionHintTarget({
          id: `${scopeId}:${encodeURIComponent(number)}:comment:${index}`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open conversation comment ${index + 1} on GitHub in a new tab`,
          control: link,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.state === state &&
            this.state?.payload?.pull?.conversationComments?.[index] ===
              comment &&
            this.querySelector(selector) === link &&
            link.getAttribute("href") === comment.url &&
            hasActionHintLayoutBox(link),
        }));
      }
      for (
        const [index, commit] of (pull.commitSummaries ?? []).entries()
      ) {
        const selector =
          `:scope > .github-pull-viewer-panel > .github-pull-viewer-scroll a[data-github-pull-commit-index="${index}"][href]`;
        const link = this.querySelector(selector);
        if (
          !link ||
          link.getAttribute("href") !== commit.url ||
          !hasActionHintLayoutBox(link)
        ) {
          continue;
        }
        targets.push(linkActionHintTarget({
          id: `${scopeId}:${encodeURIComponent(number)}:commit:${encodeURIComponent(commit.sha)}`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open commit ${commit.shortSha} on GitHub in a new tab`,
          control: link,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.state === state &&
            this.state?.payload?.pull?.commitSummaries?.[index] === commit &&
            this.querySelector(selector) === link &&
            link.getAttribute("href") === commit.url &&
            hasActionHintLayoutBox(link),
        }));
      }
    }
    const ownScope = {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: scrollport ? [scrollport] : [],
    };
    if (!scrollport) {
      return ownScope;
    }
    const markdownScopes = Array.from(this.querySelectorAll(
      ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll caffold-github-markdown[data-markdown-index]",
    )).map((markdown) => {
      const index = `${markdown.dataset.markdownIndex ?? ""}`;
      return index
        ? markdown.actionHintScope?.({
            scopeId:
              `${scopeId}:${encodeURIComponent(number)}:markdown:${index}`,
            clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
            isCurrent: () =>
              this.isConnected &&
              !this.hidden &&
              this.state === state &&
              this.querySelector(
                `:scope > .github-pull-viewer-panel > .github-pull-viewer-scroll caffold-github-markdown[data-markdown-index="${index}"]`,
              ) === markdown,
          })
        : null;
    });
    return mergeActionHintScopes(ownScope, ...markdownScopes);
  }

  scrollSurfaceScope({ scopeId = "github:pull", clipRoots = [] } = {}) {
    const state = this.state;
    const number = `${state?.payload?.pull?.number ?? ""}`;
    if (this.hidden || state?.status !== "ready" || !number) {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(
      ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll",
    );
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    const ownScope = {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:body:scroll`,
        label: "Pull request details",
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(
            ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll",
          ) === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this, scrollport],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
    const markdownScopes = Array.from(this.querySelectorAll(
      ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll caffold-github-markdown[data-markdown-index]",
    )).map((markdown) => {
      const index = `${markdown.dataset.markdownIndex ?? ""}`;
      return index
        ? markdown.scrollSurfaceScope?.({
            scopeId:
              `${scopeId}:${encodeURIComponent(number)}:markdown:${index}`,
            label: `Pull request Markdown ${Number(index) + 1}`,
            clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
            isCurrent: () =>
              this.isConnected &&
              !this.hidden &&
              this.state === state &&
              this.querySelector(
                `:scope > .github-pull-viewer-panel > .github-pull-viewer-scroll caffold-github-markdown[data-markdown-index="${index}"]`,
              ) === markdown,
          })
        : null;
    });
    return mergeScrollSurfaceScopes(ownScope, ...markdownScopes);
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
            <h2>${escapeHtml(pull.title)}</h2>
            <div class="github-pull-actions">
              <button
                type="button"
                class="github-pull-start-button"
                data-action="start-github-task"
                aria-label="Start Task for pull request #${escapeHtml(`${pull.number}`)}"
                title="Start Task"
              >
                ${renderInlineIcon("Plus", "Start Task", "github-pull-start-icon")}
                <span>Start Task</span>
              </button>
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
          <h2>${escapeHtml(title)}</h2>
        </div>
      </header>
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
            .map((comment, index) =>
              this.renderComment(comment, index, markdownBlocks)
            )
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

  renderComment(comment, index, markdownBlocks) {
    return `
      <li class="github-pull-comment">
        <div class="github-pull-comment-meta">
          ${comment.author ? `<span>${escapeHtml(comment.author)}</span>` : ""}
          ${comment.updatedAt ? `<span>${escapeHtml(comment.updatedAt)}</span>` : ""}
          ${
            comment.url
              ? `<a data-github-pull-comment-index="${index}" href="${escapeHtml(comment.url)}" target="_blank" rel="noreferrer">GitHub</a>`
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
          ${commits.map((commit, index) =>
            this.renderCommit(commit, index)
          ).join("")}
        </ol>
      </section>
    `;
  }

  renderCommit(commit, index) {
    return `
      <li class="github-pull-commit">
        <a data-github-pull-commit-index="${index}" href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">
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
