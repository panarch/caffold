import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { GitHubPull } from "#app/api.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "../../components/markdown.js";
import type { CaffoldGithubMarkdown } from "../../components/markdown.js";

type PullState =
  | { status: "empty" }
  | { status: "loading"; number: number }
  | { status: "ready"; payload: GitHubPull }
  | { status: "error"; number: number | null; error: Error };

@customElement("caffold-github-pull-detail-page")
export class CaffoldGithubPullDetailPage extends LitElement {
  @state()
  private accessor state: PullState = { status: "empty" };

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly details = new DrawnRef<HTMLDivElement>(this);
  // The Markdown blocks by the order they are drawn in.
  private readonly markdowns = new DrawnRefs<CaffoldGithubMarkdown>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
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
    const prefix = encodeURIComponent(pull.number);
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
            ${drawn(this.markdowns.of(`${markdownIndex}`))}
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
                    ${this.hints.link({
                      id: `${prefix}:comment:${index}`,
                      label: `Open conversation comment ${
                        index + 1
                      } on GitHub in a new tab`,
                      action: ACTION_HINT_ACTION.LINK_OPEN,
                      clipRoots: () => [this.details.value],
                    })}
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
            ${this.hints.link({
              id: `${prefix}:commit:${encodeURIComponent(commit.sha)}`,
              label: `Open commit ${commit.shortSha} on GitHub in a new tab`,
              action: ACTION_HINT_ACTION.LINK_OPEN,
              clipRoots: () => [this.details.value],
            })}
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
                ${this.hints.button({
                  id: `${prefix}:start-task`,
                  label: `Start Task for pull request #${pull.number}`,
                  action: ACTION_HINT_ACTION.GITHUB_TASK_START,
                })}
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
                ${this.hints.button({
                  id: `${prefix}:files`,
                  label: `Open files for PR #${pull.number}`,
                  action: ACTION_HINT_ACTION.PULL_FILES,
                })}
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
                ${this.hints.link({
                  id: `${prefix}:github`,
                  label: `Open pull request #${pull.number} on GitHub in a new tab`,
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
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
        <div
          ${drawn(this.details)}
          ${this.surfaces.surface({
            id: "body:scroll",
            clipRoots: () => [this, this.details.value],
          })}
          class="github-pull-viewer-scroll"
        >
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
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    const prefix = `${scopeId}:${encodeURIComponent(this.pullNumber())}`;
    const scrollClipRoots = [this, this.details.value, ...clipRoots].filter(
      (root): root is Element => root != null,
    );
    return mergeActionHintScopes(
      own,
      ...this.markdownBlocks().map((markdown, index) =>
        markdown.actionHintScope({
          scopeId: `${prefix}:markdown:${index}`,
          clipRoots: scrollClipRoots,
        }),
      ),
    );
  }

  scrollSurfaceScope({
    scopeId = "github:pull",
    clipRoots = [],
    ...pull
  }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({
      ...pull,
      scopeId,
      label: "Pull request details",
      clipRoots,
    });
    const prefix = `${scopeId}:${encodeURIComponent(this.pullNumber())}`;
    const scrollClipRoots = [this, this.details.value, ...clipRoots].filter(
      (root): root is Element => root != null,
    );
    return mergeScrollSurfaceScopes(
      own,
      ...this.markdownBlocks().map((markdown, index) =>
        markdown.scrollSurfaceScope({
          scopeId: `${prefix}:markdown:${index}`,
          label: `Pull request Markdown ${index + 1}`,
          clipRoots: scrollClipRoots,
        }),
      ),
    );
  }

  private pullNumber() {
    return this.state.status === "ready"
      ? `${this.state.payload.pull.number}`
      : "";
  }

  // The Markdown blocks drawn now, in their order.
  private markdownBlocks() {
    const blocks: CaffoldGithubMarkdown[] = [];
    for (
      let markdown = this.markdowns.get("0");
      markdown;
      markdown = this.markdowns.get(`${blocks.length}`)
    ) {
      blocks.push(markdown);
    }
    return blocks;
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-github-pull-detail-page": CaffoldGithubPullDetailPage;
  }
}
