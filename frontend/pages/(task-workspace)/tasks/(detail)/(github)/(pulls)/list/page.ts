import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { GitHubPulls, GitHubStatus } from "#app/api.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "#components/pagination.js";
import type { ChangePageDetail } from "#components/pagination/components/button.js";
import type { CaffoldPagination } from "#components/pagination.js";

export interface OpenGithubPullDetail {
  number: number;
}

export interface ChangeGithubPullsPageDetail {
  page: number;
}

const LOADING_PULLS = "Loading pull requests...";

type PullsState =
  | { status: "idle" }
  | { status: "loading"; payload: GitHubPulls | null }
  | { status: "unavailable"; githubStatus: GitHubStatus | null }
  | { status: "ready"; payload: GitHubPulls }
  | { status: "error"; error: Error };

@customElement("caffold-github-pulls-list-page")
export class CaffoldGithubPullsListPage extends LitElement {
  @state()
  private accessor state: PullsState = { status: "idle" };
  @state()
  private accessor selectedPullNumber: number | null = null;

  private readonly list = new DrawnRef<HTMLOListElement>(this);
  private readonly pagination = new DrawnRef<CaffoldPagination>(this);
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.list.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly iconsReady = () => this.requestUpdate();

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
            ${drawn(this.pagination)}
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
            ${this.hints.button({
              id: `pull:${pull.number}`,
              label: `Open pull request #${pull.number}: ${
                pull.title || "(no title)"
              }`,
              action: ACTION_HINT_ACTION.PULL_OPEN,
              when: pull.number !== this.selectedPullNumber,
            })}
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
            ? html`<ol
                ${drawn(this.list)}
                ${this.surfaces.surface({
                  id: "scroll",
                  clipRoots: () => [this, this.list.value],
                })}
                class="github-pulls-list"
              >${rows}</ol>`
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
    scopeId = "github:pulls",
    label = "GitHub pull requests",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private openPull(number: number) {
    this.dispatchEvent(
      new CustomEvent<OpenGithubPullDetail>("caffold:open-github-pull", {
        bubbles: true,
        detail: { number },
      }),
    );
  }

  private changePage(event: CustomEvent<ChangePageDetail>) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<ChangeGithubPullsPageDetail>(
        "caffold:change-github-pulls-page",
        {
          bubbles: true,
          detail: { page: event.detail.page },
        },
      ),
    );
  }
}

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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-github-pulls-list-page": CaffoldGithubPullsListPage;
  }

  interface HTMLElementEventMap {
    "caffold:change-github-pulls-page": CustomEvent<ChangeGithubPullsPageDetail>;
    "caffold:open-github-pull": CustomEvent<OpenGithubPullDetail>;
  }
}
