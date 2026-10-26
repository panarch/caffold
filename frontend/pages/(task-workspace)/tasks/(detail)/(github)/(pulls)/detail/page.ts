import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScopeOptions,
  type ActionHintTarget,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitHubPull } from "#app/api.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "../../components/markdown.ts";
import type { CaffoldGithubMarkdown } from "../../components/markdown.ts";

const ACTIONS =
  ":scope > .github-pull-viewer-panel > header > .github-pull-viewer-title-row > .github-pull-actions";
const START_BUTTON = `${ACTIONS} > button.github-pull-start-button[data-action="start-github-task"]`;
const FILES_BUTTON = `${ACTIONS} > button.github-pull-files-button[data-action="open-github-pull-files"][data-pull-number]`;
const GITHUB_LINK = `${ACTIONS} > a.github-pull-link[href]`;
const SCROLL =
  ":scope > .github-pull-viewer-panel > .github-pull-viewer-scroll";

type PullState =
  | { status: "empty" }
  | { status: "loading"; number: number }
  | { status: "ready"; payload: GitHubPull }
  | { status: "error"; number: number | null; error: Error };

export class CaffoldGithubPullDetailPage extends LitElement {
  static properties = {
    state: { state: true },
  };

  declare private state: PullState;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.state = { status: "empty" };
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const state = this.state;
    if (state.status === "empty") {
      return html`
        <section class="github-pull-viewer-panel">
          <p class="surface-message">Select a pull request to inspect it.</p>
        </section>
      `;
    }
    if (state.status !== "ready") {
      const header = html`
        <header>
          <div class="github-pull-viewer-title-row">
            <h2>PR #${state.number}</h2>
          </div>
        </header>
      `;
      const loadingLabel = `Loading pull request #${state.number}...`;
      return state.status === "loading"
        ? html`
            <section
              class="github-pull-viewer-panel loading-panel"
              aria-busy="true"
            >
              ${header}
              <p class="surface-message">
                <caffold-loading-text>${loadingLabel}</caffold-loading-text>
              </p>
            </section>
          `
        : html`
            <section class="github-pull-viewer-panel error-panel">
              ${header}
              <p class="surface-message">${state.error.message}</p>
            </section>
          `;
    }
    const pull = state.payload.pull;
    // Each block of GitHub's HTML is numbered in reading order so its Action
    // Hints keep their identity across a reread.
    let markdownIndex = 0;
    const markdownOrRaw = (
      bodyHtml: string | null,
      body: string,
      emptyText: string,
    ) =>
      bodyHtml?.trim()
        ? html`<caffold-github-markdown
            data-markdown-index=${markdownIndex++}
            .html=${bodyHtml}
          ></caffold-github-markdown>`
        : html`<article class="github-pull-raw-body">${
            body.trim() || emptyText
          }</article>`;
    const description = markdownOrRaw(
      pull.bodyHtml,
      pull.body,
      "No description.",
    );
    const comments = pull.conversationComments.map(
      (comment, index) => html`
        <li class="github-pull-comment">
          <div class="github-pull-comment-meta">
            ${comment.author ? html`<span>${comment.author}</span>` : nothing}
            ${
              comment.updatedAt
                ? html`<span>${comment.updatedAt}</span>`
                : nothing
            }
            ${
              comment.url
                ? html`<a
                    data-github-pull-comment-index=${index}
                    href=${comment.url}
                    target="_blank"
                    rel="noreferrer"
                  >GitHub</a>`
                : nothing
            }
          </div>
          ${markdownOrRaw(comment.bodyHtml, comment.body, "No comment body.")}
        </li>
      `,
    );
    const reviews = pull.reviewComments.map(
      (review) => html`
        <li class="github-pull-comment">
          <div class="github-pull-comment-meta">
            ${review.author ? html`<span>${review.author}</span>` : nothing}
            <span>${review.state}</span>
            ${
              review.submittedAt
                ? html`<span>${review.submittedAt}</span>`
                : nothing
            }
          </div>
          ${markdownOrRaw(review.bodyHtml, review.body, "No review body.")}
        </li>
      `,
    );
    const commits = repeat(
      pull.commitSummaries,
      (commit) => commit.sha,
      (commit, index) => {
        const byline = [commit.authorName, commit.committedAt]
          .filter(Boolean)
          .join(" · ");
        return html`
        <li class="github-pull-commit">
          <a
            data-github-pull-commit-index=${index}
            href=${commit.url}
            target="_blank"
            rel="noreferrer"
          >
            <span>${commit.shortSha}</span>
            <span>${commit.subject}</span>
          </a>
          ${byline ? html`<span>${byline}</span>` : nothing}
        </li>
      `;
      },
    );
    return html`
      <section class="github-pull-viewer-panel">
        <header>
          <div class="github-pull-viewer-title-row">
            <h2>${pull.title}</h2>
            <div class="github-pull-actions">
              <button
                type="button"
                class="github-pull-start-button"
                data-action="start-github-task"
                aria-label=${`Start Task for pull request #${pull.number}`}
                title="Start Task"
                @click=${this.startTask}
              >
                ${inlineIcon("Plus", "Start Task", "github-pull-start-icon")}
                <span>Start Task</span>
              </button>
              <button
                type="button"
                class="github-pull-files-button"
                data-action="open-github-pull-files"
                data-pull-number=${pull.number}
                aria-label=${`Open files for PR #${pull.number}`}
                @click=${this.openFiles}
              >
                ${inlineIcon("FileDiff", "Files", "github-pull-files-icon")}
                <span>${pull.changedFiles} files</span>
              </button>
              <a
                class="github-pull-link"
                href=${pull.url}
                target="_blank"
                rel="noreferrer"
              >GitHub</a>
            </div>
          </div>
          <div class="github-pull-viewer-meta">
            <span>#${pull.number}</span>
            <span>${pull.state}</span>
            ${pull.draft ? html`<span>Draft</span>` : nothing}
            ${pull.author ? html`<span>${pull.author}</span>` : nothing}
            <span>${pull.baseRefName}...${pull.headRefName}</span>
            <span>+${pull.additions} -${pull.deletions}</span>
          </div>
          ${
            pull.labels.length
              ? html`<div class="github-pull-viewer-labels">
                  ${pull.labels.map((label) => html`<span>${label}</span>`)}
                </div>`
              : nothing
          }
        </header>
        <div class="github-pull-viewer-scroll">
          <section class="github-pull-section github-pull-body-section">
            <h3>Description</h3>
            ${description}
          </section>
          <section class="github-pull-section">
            <h3>Conversation</h3>
            ${
              comments.length
                ? html`<ol class="github-pull-comments">${comments}</ol>`
                : html`<p class="github-pull-empty-note">No comments.</p>`
            }
          </section>
          <section class="github-pull-section">
            <h3>Reviews</h3>
            ${
              reviews.length
                ? html`<ol class="github-pull-comments">${reviews}</ol>`
                : html`<p
                    class="github-pull-empty-note"
                  >No review summaries.</p>`
            }
          </section>
          <section class="github-pull-section">
            <h3>Commits</h3>
            ${
              pull.commitSummaries.length
                ? html`<ol class="github-pull-commits">${commits}</ol>`
                : html`<p class="github-pull-empty-note">No commits.</p>`
            }
          </section>
        </div>
      </section>
    `;
  }

  setEmpty() {
    this.state = { status: "empty" };
  }

  setLoading(number: number) {
    this.state = { status: "loading", number };
  }

  setPull(payload: GitHubPull) {
    this.state = { status: "ready", payload };
  }

  setError(number: number | null, error: Error) {
    this.state = { status: "error", number, error };
  }

  actionHintScope({
    scopeId = "github:pull",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    const state = this.state;
    if (this.hidden || state.status !== "ready") {
      return emptyActionHintScope();
    }
    const pull = state.payload.pull;
    const number = `${pull.number}`;
    const prefix = `${scopeId}:${encodeURIComponent(number)}`;
    const isCurrentPull = () =>
      this.isConnected &&
      !this.hidden &&
      this.state.status === "ready" &&
      `${this.state.payload.pull.number}` === number;
    const isCurrentState = () =>
      this.isConnected && !this.hidden && this.state === state;
    const targets: ActionHintTarget[] = [
      {
        identity: "start-task",
        actionId: ACTION_HINT_ACTION.GITHUB_TASK_START,
        selector: START_BUTTON,
        fallbackLabel: `Start Task for pull request #${number}`,
        matchesControl: () => true,
      },
      {
        identity: "files",
        actionId: ACTION_HINT_ACTION.PULL_FILES,
        selector: FILES_BUTTON,
        fallbackLabel: `Open files for PR #${number}`,
        matchesControl: (control: HTMLButtonElement) =>
          `${control.dataset.pullNumber ?? ""}` === number,
      },
    ].flatMap((definition) => {
      const control = this.querySelector<HTMLButtonElement>(
        definition.selector,
      );
      if (
        !control ||
        control.disabled ||
        !definition.matchesControl(control) ||
        !hasActionHintLayoutBox(control)
      ) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${prefix}:${definition.identity}`,
          actionId: definition.actionId,
          label: control.getAttribute("aria-label") || definition.fallbackLabel,
          control,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            isCurrentPull() &&
            this.querySelector(definition.selector) === control &&
            definition.matchesControl(control) &&
            !control.disabled &&
            hasActionHintLayoutBox(control),
        }),
      ];
    });
    const headerLink = this.querySelector<HTMLAnchorElement>(GITHUB_LINK);
    if (
      headerLink &&
      headerLink.getAttribute("href") === pull.url &&
      hasActionHintLayoutBox(headerLink)
    ) {
      targets.push(
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${prefix}:github`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open pull request #${number} on GitHub in a new tab`,
          control: headerLink,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            isCurrentState() &&
            this.querySelector(GITHUB_LINK) === headerLink &&
            headerLink.getAttribute("href") === pull.url &&
            hasActionHintLayoutBox(headerLink),
        }),
      );
    }
    const scrollport = this.querySelector(SCROLL);
    if (!scrollport) {
      return {
        blocked: false,
        targets,
        mutationRoots: [this],
        scrollRoots: [],
      };
    }
    const scrollClipRoots = [this, scrollport, ...clipRoots];
    for (const [index, comment] of pull.conversationComments.entries()) {
      if (!comment.url) {
        continue;
      }
      const selector = `${SCROLL} a[data-github-pull-comment-index="${index}"][href]`;
      const link = this.querySelector<HTMLAnchorElement>(selector);
      if (
        !link ||
        link.getAttribute("href") !== comment.url ||
        !hasActionHintLayoutBox(link)
      ) {
        continue;
      }
      targets.push(
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${prefix}:comment:${index}`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open conversation comment ${index + 1} on GitHub in a new tab`,
          control: link,
          clipRoots: scrollClipRoots,
          isActionable: () =>
            isCurrentState() &&
            this.querySelector(selector) === link &&
            link.getAttribute("href") === comment.url &&
            hasActionHintLayoutBox(link),
        }),
      );
    }
    for (const [index, commit] of pull.commitSummaries.entries()) {
      const selector = `${SCROLL} a[data-github-pull-commit-index="${index}"][href]`;
      const link = this.querySelector<HTMLAnchorElement>(selector);
      if (
        !link ||
        link.getAttribute("href") !== commit.url ||
        !hasActionHintLayoutBox(link)
      ) {
        continue;
      }
      targets.push(
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${prefix}:commit:${encodeURIComponent(commit.sha)}`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open commit ${commit.shortSha} on GitHub in a new tab`,
          control: link,
          clipRoots: scrollClipRoots,
          isActionable: () =>
            isCurrentState() &&
            this.querySelector(selector) === link &&
            link.getAttribute("href") === commit.url &&
            hasActionHintLayoutBox(link),
        }),
      );
    }
    const markdownScopes = this.markdownBlocks().map(({ markdown, index }) =>
      markdown.actionHintScope({
        scopeId: `${prefix}:markdown:${index}`,
        clipRoots: scrollClipRoots,
        isCurrent: () =>
          isCurrentState() && this.markdownBlock(index) === markdown,
      }),
    );
    return mergeActionHintScopes(
      {
        blocked: false,
        targets,
        mutationRoots: [this],
        scrollRoots: [scrollport],
      },
      ...markdownScopes,
    );
  }

  scrollSurfaceScope({
    scopeId = "github:pull",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}) {
    const state = this.state;
    if (this.hidden || state.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const number = `${state.payload.pull.number}`;
    const scrollport = this.querySelector(SCROLL);
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    const isCurrentState = () =>
      this.isConnected && !this.hidden && this.state === state;
    const scrollClipRoots = [this, scrollport, ...clipRoots];
    const markdownScopes = this.markdownBlocks().map(({ markdown, index }) =>
      markdown.scrollSurfaceScope({
        scopeId: `${scopeId}:${encodeURIComponent(number)}:markdown:${index}`,
        label: `Pull request Markdown ${Number(index) + 1}`,
        clipRoots: scrollClipRoots,
        isCurrent: () =>
          isCurrentState() && this.markdownBlock(index) === markdown,
      }),
    );
    return mergeScrollSurfaceScopes(
      {
        blocked: false,
        surfaces: [
          {
            id: `${scopeId}:body:scroll`,
            label: "Pull request details",
            scrollport,
            clipRoots: scrollClipRoots,
            isEligible: () =>
              isCurrentState() &&
              this.querySelector(SCROLL) === scrollport &&
              hasScrollLayoutBox(this) &&
              hasScrollLayoutBox(scrollport),
          },
        ],
        mutationRoots: [this, scrollport],
        resizeElements: [this, scrollport],
        scrollRoots: [scrollport],
      },
      ...markdownScopes,
    );
  }

  private markdownBlocks() {
    return [
      ...this.querySelectorAll<CaffoldGithubMarkdown>(
        `${SCROLL} caffold-github-markdown[data-markdown-index]`,
      ),
    ].flatMap((markdown) => {
      const index = `${markdown.dataset.markdownIndex ?? ""}`;
      return index ? [{ markdown, index }] : [];
    });
  }

  private markdownBlock(index: string) {
    return this.querySelector(
      `${SCROLL} caffold-github-markdown[data-markdown-index="${index}"]`,
    );
  }

  private startTask(event: Event) {
    if (this.state.status !== "ready") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:start-github-task", {
        bubbles: true,
        composed: true,
        detail: {
          kind: "pull",
          payload: this.state.payload,
          opener: event.currentTarget,
        },
      }),
    );
  }

  private openFiles() {
    if (this.state.status !== "ready") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:open-github-pull-files", {
        bubbles: true,
        detail: { number: this.state.payload.pull.number },
      }),
    );
  }
}

customElements.define(
  "caffold-github-pull-detail-page",
  CaffoldGithubPullDetailPage,
);
