import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { GitHubIssues, GitHubStatus } from "#app/api.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import "#components/pagination.js";
import type { CaffoldPagination } from "#components/pagination.js";

type IssuesState =
  | { status: "idle" }
  | { status: "loading"; payload: GitHubIssues | null }
  | { status: "unavailable"; githubStatus: GitHubStatus | null }
  | { status: "ready"; payload: GitHubIssues }
  | { status: "error"; error: Error };

@customElement("caffold-github-issues-list-page")
export class CaffoldGithubIssuesListPage extends LitElement {
  @state()
  private accessor state: IssuesState = { status: "idle" };
  @state()
  private accessor selectedIssueNumber: number | null = null;

  private readonly list = new DrawnRef<HTMLOListElement>(this);
  private readonly pagination = new DrawnRef<CaffoldPagination>(this);
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.list.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    const state = this.state;
    if (state.status === "idle") {
      return html`
        <section class="github-issues-panel">
          <ol class="github-issues-list"></ol>
        </section>
      `;
    }
    if (state.status === "unavailable" || state.status === "error") {
      const message =
        state.status === "error"
          ? state.error.message
          : (state.githubStatus?.message ?? "GitHub issues are unavailable.");
      return html`
        <section class="github-issues-panel error-panel">
          <p class="surface-message">${message}</p>
        </section>
      `;
    }
    const payload = state.payload;
    const pagination =
      payload && payload.totalPages > 1
        ? html`<caffold-pagination
            ${drawn(this.pagination)}
            aria-label="Issue pagination"
            page=${payload.page}
            total-pages=${payload.totalPages}
            ?has-previous=${payload.hasPrevious}
            ?has-next=${payload.hasNext}
            first-label="Newest issue page"
            previous-label="Newer issue page"
            next-label="Older issue page"
            last-label="Oldest issue page"
            @caffold:change-page=${this.changePage}
          ></caffold-pagination>`
        : nothing;
    if (state.status === "loading") {
      return html`
        <section class="github-issues-panel loading-panel" aria-busy="true">
          <p class="surface-message">
            <caffold-loading-text>Loading issues...</caffold-loading-text>
          </p>
          ${pagination}
        </section>
      `;
    }
    const rows = repeat(
      state.payload.issues,
      (issue) => issue.number,
      (issue) => html`
        <li class="github-issue-row">
          <button
            ${this.hints.button({
              id: `issue:${issue.number}`,
              label: `Open issue #${issue.number}: ${
                issue.title || "(no title)"
              }`,
              action: ACTION_HINT_ACTION.ISSUE_OPEN,
              when: issue.number !== this.selectedIssueNumber,
            })}
            type="button"
            class="github-issue-button"
            data-issue-number=${issue.number}
            aria-current=${
              issue.number === this.selectedIssueNumber ? "true" : nothing
            }
            @click=${() => this.openIssue(issue.number)}
          >
            <span class="github-issue-title">${issue.title}</span>
            <span class="github-issue-meta">
              #${issue.number}
              ${issue.author ? ` · ${issue.author}` : ""}
              · ${issue.comments ? `${issue.comments} comments` : "0 comments"}
            </span>
            ${
              issue.labels.length
                ? html`<span class="github-issue-labels">
                    ${issue.labels
                      .slice(0, 3)
                      .map((label) => html`<span>${label}</span>`)}
                  </span>`
                : nothing
            }
          </button>
        </li>
      `,
    );
    return html`
      <section class="github-issues-panel">
        ${
          state.payload.issues.length
            ? html`<ol
                ${drawn(this.list)}
                ${this.surfaces.surface({
                  id: "scroll",
                  clipRoots: () => [this, this.list.value],
                })}
                class="github-issues-list"
              >${rows}</ol>`
            : html`<p class="surface-message">No issues.</p>`
        }
        ${pagination}
      </section>
    `;
  }

  // Another page loads under the pagination of the page it replaces.
  setLoading(
    previousPayload: GitHubIssues | null = null,
    page: number | null = null,
  ) {
    const payload =
      previousPayload ??
      (this.state.status === "loading" || this.state.status === "ready"
        ? this.state.payload
        : null);
    this.state = { status: "loading", payload: loadingPayload(payload, page) };
  }

  setUnavailable(githubStatus: GitHubStatus | null) {
    this.state = { status: "unavailable", githubStatus };
  }

  setIssues(payload: GitHubIssues) {
    this.state = { status: "ready", payload };
  }

  setSelectedIssue(number: number | null) {
    this.selectedIssueNumber = number;
  }

  setError(error: Error) {
    this.state = { status: "error", error };
  }

  reset() {
    this.selectedIssueNumber = null;
    this.state = { status: "idle" };
  }

  actionHintScope({
    scopeId = "github:issues",
    clipRoots = [],
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    return mergeActionHintScopes(
      own,
      this.state.status === "ready"
        ? this.pagination.value?.actionHintScope({
            scopeId: `${scopeId}:pagination`,
            actionId: ACTION_HINT_ACTION.PAGE,
            clipRoots: [this, ...clipRoots],
          })
        : null,
    );
  }

  scrollSurfaceScope({
    scopeId = "github:issues",
    label = "GitHub issues",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private openIssue(number: number) {
    this.dispatchEvent(
      new CustomEvent("caffold:open-github-issue", {
        bubbles: true,
        detail: { number },
      }),
    );
  }

  private changePage(event: CustomEvent<{ page: number }>) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:change-github-issues-page", {
        bubbles: true,
        detail: { page: event.detail.page },
      }),
    );
  }
}

function loadingPayload(payload: GitHubIssues | null, page: number | null) {
  if (!payload) {
    return null;
  }
  const targetPage = Number.parseInt(`${page ?? payload.page ?? 1}`, 10);
  const nextPage =
    Number.isFinite(targetPage) && targetPage > 0 ? targetPage : 1;
  return {
    ...payload,
    page: nextPage,
    hasPrevious: nextPage > 1,
    hasNext:
      payload.totalPages > 0 ? nextPage < payload.totalPages : payload.hasNext,
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-github-issues-list-page": CaffoldGithubIssuesListPage;
  }
}
