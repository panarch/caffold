import { html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitHubPulls, GitHubStatus } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "#components/pagination.ts";
import type { CaffoldPagination } from "#components/pagination.ts";

const LOADING_PULLS = "Loading pull requests...";
const PULL_LIST = ":scope > .github-pulls-panel > .github-pulls-list";
const PULL_BUTTON = `${PULL_LIST} > .github-pull-row > button.github-pull-button`;

type PullsState =
  | { status: "idle" }
  | { status: "loading"; payload: GitHubPulls | null }
  | { status: "unavailable"; githubStatus: GitHubStatus | null }
  | { status: "ready"; payload: GitHubPulls }
  | { status: "error"; error: Error };

export class CaffoldGithubPullsListPage extends LitElement {
  static properties = {
    state: { state: true },
    selectedPullNumber: { state: true },
  };

  declare private state: PullsState;
  declare private selectedPullNumber: number | null;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.state = { status: "idle" };
    this.selectedPullNumber = null;
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
    if (state.status === "idle") {
      return html`
        <section class="github-pulls-panel">
          <ol class="github-pulls-list"></ol>
        </section>
      `;
    }
    if (state.status === "unavailable" || state.status === "error") {
      const message =
        state.status === "error"
          ? state.error.message
          : (state.githubStatus?.message ??
            "GitHub pull requests are unavailable.");
      return html`
        <section class="github-pulls-panel error-panel">
          <p class="surface-message">${message}</p>
        </section>
      `;
    }
    const payload = state.payload;
    const pullIcon = inlineIcon(
      "GitPullRequest",
      "Pull request",
      "github-pull-icon",
    );
    const pagination =
      payload && payload.totalPages > 1
        ? html`<caffold-pagination
            aria-label="Pull request pagination"
            page=${payload.page}
            total-pages=${payload.totalPages}
            ?has-previous=${payload.hasPrevious}
            ?has-next=${payload.hasNext}
            first-label="Newest pull request page"
            previous-label="Newer pull request page"
            next-label="Older pull request page"
            last-label="Oldest pull request page"
            @caffold:change-page=${this.changePage}
          ></caffold-pagination>`
        : nothing;
    if (state.status === "loading") {
      return html`
        <section class="github-pulls-panel loading-panel" aria-busy="true">
          <p class="surface-message">
            <caffold-loading-text>${LOADING_PULLS}</caffold-loading-text>
          </p>
          ${pagination}
        </section>
      `;
    }
    const rows = repeat(
      state.payload.pulls,
      (pull) => pull.number,
      (pull) => html`
        <li class="github-pull-row">
          <button
            type="button"
            class="github-pull-button"
            data-pull-number=${pull.number}
            aria-current=${
              pull.number === this.selectedPullNumber ? "true" : nothing
            }
            @click=${() => this.openPull(pull.number)}
          >
            <span class="github-pull-title">
              ${pullIcon}
              <span>${pull.title}</span>
            </span>
            <span class="github-pull-meta">
              #${pull.number}
              ${pull.author ? ` · ${pull.author}` : ""}
              · ${pull.comments ? `${pull.comments} comments` : "0 comments"}
              ${
                pull.draft
                  ? html`<span class="github-pull-draft">Draft</span>`
                  : nothing
              }
            </span>
            ${
              pull.labels.length
                ? html`<span class="github-pull-labels">
                    ${pull.labels
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
      <section class="github-pulls-panel">
        ${
          state.payload.pulls.length
            ? html`<ol class="github-pulls-list">${rows}</ol>`
            : html`<p class="surface-message">No pull requests.</p>`
        }
        ${pagination}
      </section>
    `;
  }

  // Another page loads under the pagination of the page it replaces.
  setLoading(
    previousPayload: GitHubPulls | null = null,
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

  setPulls(payload: GitHubPulls) {
    this.state = { status: "ready", payload };
  }

  setSelectedPull(number: number | null) {
    this.selectedPullNumber = number;
  }

  setError(error: Error) {
    this.state = { status: "error", error };
  }

  reset() {
    this.selectedPullNumber = null;
    this.state = { status: "idle" };
  }

  actionHintScope({
    scopeId = "github:pulls",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    if (this.hidden || this.state.status !== "ready") {
      return emptyActionHintScope();
    }
    const pulls = new Map(
      this.state.payload.pulls.map((pull) => [`${pull.number}`, pull]),
    );
    const scroller = this.querySelector(PULL_LIST);
    const rowClipRoots = [this, scroller, ...clipRoots].filter(
      (root): root is Element => root !== null,
    );
    const targets = [
      ...this.querySelectorAll<HTMLButtonElement>(
        `${PULL_BUTTON}[data-pull-number]`,
      ),
    ].flatMap((control) => {
      const number = `${control.dataset.pullNumber ?? ""}`;
      const pull = pulls.get(number);
      if (
        !number ||
        !pull ||
        control.disabled ||
        pull.number === this.selectedPullNumber
      ) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:pull:${number}`,
          actionId: ACTION_HINT_ACTION.PULL_OPEN,
          label: `Open pull request #${number}: ${pull.title || "(no title)"}`,
          control,
          clipRoots: rowClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.state.status === "ready" &&
            `${this.selectedPullNumber ?? ""}` !== number &&
            this.querySelector(
              `${PULL_BUTTON}[data-pull-number="${CSS.escape(number)}"]`,
            ) === control &&
            !control.disabled,
        }),
      ];
    });
    const pagination = this.querySelector<CaffoldPagination>(
      ":scope > .github-pulls-panel > caffold-pagination",
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
    scopeId = "github:pulls",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (this.hidden || this.state.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(PULL_LIST);
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label: "GitHub pull requests",
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.state.status === "ready" &&
            this.querySelector(PULL_LIST) === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private openPull(number: number) {
    this.dispatchEvent(
      new CustomEvent("caffold:open-github-pull", {
        bubbles: true,
        detail: { number },
      }),
    );
  }

  private changePage(event: CustomEvent<{ page: number }>) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:change-github-pulls-page", {
        bubbles: true,
        detail: { page: event.detail.page },
      }),
    );
  }
}

customElements.define(
  "caffold-github-pulls-list-page",
  CaffoldGithubPullsListPage,
);

function loadingPayload(payload: GitHubPulls | null, page: number | null) {
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
