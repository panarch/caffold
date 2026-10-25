import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitHubIssues, GitHubStatus } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "#components/loading-text.ts";
import "#components/pagination.ts";
import type { CaffoldPagination } from "#components/pagination.ts";

const ISSUE_LIST = ":scope > .github-issues-panel > .github-issues-list";
const ISSUE_BUTTON = `${ISSUE_LIST} > .github-issue-row > button.github-issue-button`;

type IssuesState =
  | { status: "idle" }
  | { status: "loading"; payload: GitHubIssues | null }
  | { status: "unavailable"; githubStatus: GitHubStatus | null }
  | { status: "ready"; payload: GitHubIssues }
  | { status: "error"; error: Error };

export class CaffoldGithubIssuesListPage extends LitElement {
  static properties = {
    state: { state: true },
    selectedIssueNumber: { state: true },
  };

  declare private state: IssuesState;
  declare private selectedIssueNumber: number | null;

  constructor() {
    super();
    this.state = { status: "idle" };
    this.selectedIssueNumber = null;
  }

  createRenderRoot() {
    return this;
  }

  render() {
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
            ? html`<ol class="github-issues-list">${rows}</ol>`
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
  }: ActionHintScopeOptions = {}) {
    if (this.hidden || this.state.status !== "ready") {
      return emptyActionHintScope();
    }
    const issues = new Map(
      this.state.payload.issues.map((issue) => [`${issue.number}`, issue]),
    );
    const scroller = this.querySelector(ISSUE_LIST);
    const rowClipRoots = [this, scroller, ...clipRoots].filter(
      (root): root is Element => root !== null,
    );
    const targets = [
      ...this.querySelectorAll<HTMLButtonElement>(
        `${ISSUE_BUTTON}[data-issue-number]`,
      ),
    ].flatMap((control) => {
      const number = `${control.dataset.issueNumber ?? ""}`;
      const issue = issues.get(number);
      if (
        !number ||
        !issue ||
        control.disabled ||
        issue.number === this.selectedIssueNumber
      ) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:issue:${number}`,
          actionId: ACTION_HINT_ACTION.ISSUE_OPEN,
          label: `Open issue #${number}: ${issue.title || "(no title)"}`,
          control,
          clipRoots: rowClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.state.status === "ready" &&
            `${this.selectedIssueNumber ?? ""}` !== number &&
            this.querySelector(
              `${ISSUE_BUTTON}[data-issue-number="${CSS.escape(number)}"]`,
            ) === control &&
            !control.disabled,
        }),
      ];
    });
    const pagination = this.querySelector<CaffoldPagination>(
      ":scope > .github-issues-panel > caffold-pagination",
    );
    return mergeActionHintScopes(
      {
        blocked: false,
        targets,
        mutationRoots: [this],
        scrollRoots: scroller ? [scroller] : [],
      },
      pagination?.actionHintScope({
        scopeId: `${scopeId}:pagination`,
        actionId: ACTION_HINT_ACTION.PAGE,
        clipRoots: [this, ...clipRoots],
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "github:issues",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (this.hidden || this.state.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(ISSUE_LIST);
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label: "GitHub issues",
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.state.status === "ready" &&
            this.querySelector(ISSUE_LIST) === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
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

customElements.define(
  "caffold-github-issues-list-page",
  CaffoldGithubIssuesListPage,
);

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
