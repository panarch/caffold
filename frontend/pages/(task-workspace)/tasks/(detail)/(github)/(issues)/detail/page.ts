import { html, LitElement, nothing } from "lit";
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
import type { GitHubIssue } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import "../../components/markdown.ts";
import type { CaffoldGithubMarkdown } from "../../components/markdown.ts";

const ACTIONS =
  ":scope > .github-issue-viewer-panel > header > .github-issue-viewer-title-row > .github-issue-actions";
const START_BUTTON = `${ACTIONS} > button.github-issue-start-button[data-action="start-github-task"]`;
const GITHUB_LINK = `${ACTIONS} > a.github-issue-link[href]`;
const BODY = ":scope > .github-issue-viewer-panel > .github-issue-body";

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
                class="github-issue-body"
                .html=${bodyHtml}
              ></caffold-github-markdown>`
            : html`<article
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
  }: ActionHintScopeOptions = {}) {
    const state = this.state;
    if (this.hidden || state.status !== "ready") {
      return emptyActionHintScope();
    }
    const issue = state.payload.issue;
    const number = `${issue.number}`;
    const isCurrentIssue = () =>
      this.isConnected &&
      !this.hidden &&
      this.state.status === "ready" &&
      `${this.state.payload.issue.number}` === number;
    const targets: ActionHintTarget[] = [];
    const start = this.querySelector<HTMLButtonElement>(START_BUTTON);
    if (start && !start.disabled && hasActionHintLayoutBox(start)) {
      targets.push(
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${encodeURIComponent(number)}:start-task`,
          actionId: ACTION_HINT_ACTION.GITHUB_TASK_START,
          label:
            start.getAttribute("aria-label") ||
            `Start Task for issue #${number}`,
          control: start,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            isCurrentIssue() &&
            this.querySelector(START_BUTTON) === start &&
            !start.disabled &&
            hasActionHintLayoutBox(start),
        }),
      );
    }
    const link = this.querySelector<HTMLAnchorElement>(GITHUB_LINK);
    if (
      link &&
      link.getAttribute("href") === issue.url &&
      hasActionHintLayoutBox(link)
    ) {
      targets.push(
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${encodeURIComponent(number)}:github`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: `Open issue #${number} on GitHub in a new tab`,
          control: link,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            isCurrentIssue() &&
            this.state.status === "ready" &&
            this.state.payload.issue.url === issue.url &&
            this.querySelector(GITHUB_LINK) === link &&
            link.getAttribute("href") === issue.url &&
            hasActionHintLayoutBox(link),
        }),
      );
    }
    const body = this.querySelector(
      BODY,
    ) as Partial<CaffoldGithubMarkdown> | null;
    return mergeActionHintScopes(
      { blocked: false, targets, mutationRoots: [this], scrollRoots: [] },
      body?.actionHintScope?.({
        scopeId: `${scopeId}:${encodeURIComponent(number)}:body`,
        clipRoots: [this, ...clipRoots],
        isCurrent: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(BODY) === body,
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "github:issue",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const state = this.state;
    if (this.hidden || state.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const body = this.querySelector<HTMLElement>(BODY);
    if (!body) {
      return emptyScrollSurfaceScope();
    }
    const isCurrent = () =>
      this.isConnected &&
      !this.hidden &&
      this.state === state &&
      this.querySelector(BODY) === body;
    const markdown = body as Partial<CaffoldGithubMarkdown>;
    if (typeof markdown.scrollSurfaceScope === "function") {
      return markdown.scrollSurfaceScope({
        scopeId: `${scopeId}:body`,
        label: "Issue description",
        clipRoots: [this, ...clipRoots],
        isCurrent,
      });
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:body:scroll`,
          label: "Issue description",
          scrollport: body,
          clipRoots: [this, body, ...clipRoots],
          isEligible: () =>
            isCurrent() && hasScrollLayoutBox(this) && hasScrollLayoutBox(body),
        },
      ],
      mutationRoots: [this, body],
      resizeElements: [this, body],
      scrollRoots: [body],
    };
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
