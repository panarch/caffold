import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import type { GitHubIssue } from "#app/api.ts";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "../../components/markdown.ts";
import type { CaffoldGithubMarkdown } from "../../components/markdown.ts";

type IssueState =
  | { status: "empty" }
  | { status: "loading"; number: number }
  | { status: "ready"; payload: GitHubIssue }
  | { status: "error"; number: number | null; error: Error };

export class CaffoldGithubIssueDetailPage extends LitElement {
  static properties = {
    state: { state: true },
  };

  declare private state: IssueState;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly markdown = new DrawnRef<CaffoldGithubMarkdown>(this);
  private readonly rawBody = new DrawnRef<HTMLElement>(this);

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
        <section class="github-issue-viewer-panel">
          <p class="surface-message">Select an issue to inspect it.</p>
        </section>
      `;
    }
    if (state.status !== "ready") {
      const header = html`
        <header>
          <div class="github-issue-viewer-title-row">
            <h2>Issue #${state.number}</h2>
          </div>
        </header>
      `;
      const loadingLabel = `Loading issue #${state.number}...`;
      return state.status === "loading"
        ? html`
            <section
              class="github-issue-viewer-panel loading-panel"
              aria-busy="true"
            >
              ${header}
              <p class="surface-message">
                <caffold-loading-text>${loadingLabel}</caffold-loading-text>
              </p>
            </section>
          `
        : html`
            <section class="github-issue-viewer-panel error-panel">
              ${header}
              <p class="surface-message">${state.error.message}</p>
            </section>
          `;
    }
    const issue = state.payload.issue;
    const bodyHtml = issue.bodyHtml?.trim();
    return html`
      <section class="github-issue-viewer-panel">
        <header>
          <div class="github-issue-viewer-title-row">
            <h2>${issue.title}</h2>
            <div class="github-issue-actions">
              <button
                ${this.hints.button({
                  id: `${encodeURIComponent(issue.number)}:start-task`,
                  label: `Start Task for issue #${issue.number}`,
                  action: ACTION_HINT_ACTION.GITHUB_TASK_START,
                })}
                type="button"
                class="github-issue-start-button"
                data-action="start-github-task"
                aria-label=${`Start Task for issue #${issue.number}`}
                title="Start Task"
                @click=${this.startTask}
              >
                ${inlineIcon("Plus", "Start Task", "github-issue-start-icon")}
                <span class="github-issue-start-label">Start Task</span>
              </button>
              <a
                ${this.hints.link({
                  id: `${encodeURIComponent(issue.number)}:github`,
                  label: `Open issue #${issue.number} on GitHub in a new tab`,
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
                class="github-issue-link"
                href=${issue.url}
                target="_blank"
                rel="noreferrer"
              >GitHub</a>
            </div>
          </div>
          <div class="github-issue-viewer-meta">
            <span>#${issue.number}</span>
            <span>${issue.state}</span>
            ${issue.author ? html`<span>${issue.author}</span>` : nothing}
            <span>${issue.comments} comments</span>
          </div>
          ${
            issue.labels.length
              ? html`<div class="github-issue-viewer-labels">
                  ${issue.labels.map((label) => html`<span>${label}</span>`)}
                </div>`
              : nothing
          }
        </header>
        ${
          bodyHtml
            ? html`<caffold-github-markdown
                ${drawn(this.markdown)}
                class="github-issue-body"
                .html=${bodyHtml}
              ></caffold-github-markdown>`
            : html`<article
                ${drawn(this.rawBody)}
                ${this.surfaces.surface({
                  id: "body:scroll",
                  clipRoots: () => [this, this.rawBody.value],
                })}
                class="github-issue-body github-issue-raw-body"
              >${issue.body?.trim() || "No description."}</article>`
        }
      </section>
    `;
  }

  setEmpty() {
    this.state = { status: "empty" };
  }

  setLoading(number: number) {
    this.state = { status: "loading", number };
  }

  setIssue(payload: GitHubIssue) {
    this.state = { status: "ready", payload };
  }

  setError(number: number | null, error: Error) {
    this.state = { status: "error", number, error };
  }

  actionHintScope({
    scopeId = "github:issue",
    clipRoots = [],
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    const number =
      this.state.status === "ready" ? `${this.state.payload.issue.number}` : "";
    return mergeActionHintScopes(
      own,
      this.markdown.value?.actionHintScope({
        scopeId: `${scopeId}:${encodeURIComponent(number)}:body`,
        clipRoots: [this, ...clipRoots],
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "github:issue",
    clipRoots = [],
    ...pull
  }: ScrollSurfacePull = {}) {
    const label = "Issue description";
    const own = this.surfaces.scope({ ...pull, scopeId, label, clipRoots });
    return mergeScrollSurfaceScopes(
      own,
      this.markdown.value?.scrollSurfaceScope({
        scopeId: `${scopeId}:body`,
        label,
        clipRoots: [this, ...clipRoots],
      }),
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
          kind: "issue",
          payload: this.state.payload,
          opener: event.currentTarget,
        },
      }),
    );
  }
}

customElements.define(
  "caffold-github-issue-detail-page",
  CaffoldGithubIssueDetailPage,
);
