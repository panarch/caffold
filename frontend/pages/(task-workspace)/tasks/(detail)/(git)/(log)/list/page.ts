import { html, LitElement, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  disclosureActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { GitLog } from "#app/api.js";
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

const LOG_LIST = ":scope > .log-list-panel > .log-list";
const OPEN_COMMIT = `${LOG_LIST} > .log-entry > button[data-action="open-commit"]`;
const TOGGLE_COMMIT_BODY = `${LOG_LIST} > .log-entry > button[data-action="toggle-commit-body"]`;

type LogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; log: GitLog }
  | { status: "error"; error: Error };

export class CaffoldGitLogListPage extends LitElement {
  static properties = {
    state: { state: true },
    expandedShas: { state: true },
  };

  declare private state: LogState;
  declare private expandedShas: ReadonlySet<string>;
  // A new log starts at its top; a refreshed one keeps its place.
  private scrollToTop = false;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.state = { status: "idle" };
    this.expandedShas = new Set();
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
        <section class="log-list-panel">
          <ol class="log-list"></ol>
        </section>
      `;
    }
    if (state.status === "loading") {
      return html`
        <section class="log-list-panel" aria-busy="true">
          <p class="surface-message">
            <caffold-loading-text>Loading log...</caffold-loading-text>
          </p>
        </section>
      `;
    }
    if (state.status === "error") {
      return html`
        <section class="log-list-panel error-panel">
          <p class="surface-message">${state.error.message}</p>
        </section>
      `;
    }
    const log = state.log;
    const entries = repeat(
      log.commits,
      (commit) => commit.sha,
      (commit) => {
        const body = commit.body?.trim() ?? "";
        const expanded = body.length > 0 && this.expandedShas.has(commit.sha);
        const author = commit.authorName || commit.authorEmail || "";
        const meta = [commit.shortSha, author, formatDate(commit.authorTimeMs)]
          .filter(Boolean)
          .join(" ");
        const verb = expanded ? "Collapse" : "Expand";
        const openLabel = `Open commit diff for ${commit.shortSha}`;
        const summary = html`
        <span class="log-subject">${commit.subject || "(no subject)"}</span>
        <span class="log-meta">${meta}</span>
      `;
        return html`
        <li class="log-entry" data-commit-sha=${commit.sha}>
          ${
            body
              ? html`<button
                  type="button"
                  class="log-summary log-summary-toggle"
                  data-action="toggle-commit-body"
                  data-commit-sha=${commit.sha}
                  aria-expanded=${expanded ? "true" : "false"}
                  aria-label=${`${verb} commit body for ${commit.shortSha}`}
                  title=${commit.subject}
                  @click=${() => this.toggleCommitBody(commit.sha)}
                >${summary}</button>`
              : html`<div class="log-summary" title=${commit.subject}>
                  ${summary}
                </div>`
          }
          <button
            type="button"
            class="log-review-button"
            data-action="open-commit"
            data-commit-sha=${commit.sha}
            aria-label=${`${openLabel} ${commit.subject}`}
            title=${openLabel}
            @click=${() => this.openCommit(commit.sha)}
          >
            ${inlineIcon("FileDiff", "Diff", "log-review-icon")}
            <span class="log-review-label">Diff</span>
          </button>
          ${expanded ? html`<p class="log-body">${body}</p>` : nothing}
        </li>
      `;
      },
    );
    return html`
      <section class="log-list-panel">
        ${
          log.commits.length
            ? html`<ol class="log-list">${entries}</ol>`
            : html`<p class="surface-message">No commits.</p>`
        }
        ${
          log.totalPages > 1
            ? html`<caffold-pagination
                aria-label="Log pagination"
                page=${log.page}
                total-pages=${log.totalPages}
                ?has-previous=${log.hasPrevious}
                ?has-next=${log.hasNext}
                first-label="Newest page"
                previous-label="Newer page"
                next-label="Older page"
                last-label="Oldest page"
                @caffold:change-page=${this.changePage}
              ></caffold-pagination>`
            : nothing
        }
      </section>
    `;
  }

  updated(changed: PropertyValues) {
    if (!changed.has("state") || !this.scrollToTop) {
      return;
    }
    this.scrollToTop = false;
    const scroller = this.querySelector(LOG_LIST);
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  }

  setLoading() {
    this.state = { status: "loading" };
  }

  setLog(log: GitLog) {
    this.expandedShas = new Set();
    this.scrollToTop = true;
    this.state = { status: "ready", log };
  }

  updateLog(log: GitLog) {
    const shas = new Set(log.commits.map((commit) => commit.sha));
    this.expandedShas = new Set(
      [...this.expandedShas].filter((sha) => shas.has(sha)),
    );
    this.state = { status: "ready", log };
  }

  setError(error: Error) {
    this.state = { status: "error", error };
  }

  reset() {
    this.expandedShas = new Set();
    this.state = { status: "idle" };
  }

  actionHintScope({
    scopeId = "git:log",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    if (this.hidden || this.state.status !== "ready") {
      return emptyActionHintScope();
    }
    const scroller = this.querySelector(LOG_LIST);
    const listClipRoots = [this, scroller, ...clipRoots].filter(
      (root): root is Element => root !== null,
    );
    const isCurrent = (
      selector: string,
      sha: string,
      control: HTMLButtonElement,
    ) =>
      this.isConnected &&
      !this.hidden &&
      this.state.status === "ready" &&
      this.querySelector(
        `${selector}[data-commit-sha="${CSS.escape(sha)}"]`,
      ) === control &&
      !control.disabled;
    const targets = [
      ...this.querySelectorAll<HTMLButtonElement>(
        `${OPEN_COMMIT}[data-commit-sha]`,
      ),
    ].flatMap((control) => {
      const sha = `${control.dataset.commitSha ?? ""}`;
      if (!sha || control.disabled) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:commit:${encodeURIComponent(sha)}`,
          actionId: ACTION_HINT_ACTION.COMMIT_OPEN,
          label:
            control.getAttribute("aria-label") ||
            `Open commit ${sha.slice(0, 7)}`,
          control,
          clipRoots: listClipRoots,
          isActionable: () => isCurrent(OPEN_COMMIT, sha, control),
        }),
      ];
    });
    for (const control of this.querySelectorAll<HTMLButtonElement>(
      `${TOGGLE_COMMIT_BODY}[data-commit-sha]`,
    )) {
      const sha = `${control.dataset.commitSha ?? ""}`;
      if (!sha || control.disabled) {
        continue;
      }
      targets.push(
        disclosureActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:commit-body:${encodeURIComponent(sha)}`,
          actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          label: control.getAttribute("aria-label") || "Expand commit body",
          control,
          clipRoots: listClipRoots,
          isActionable: () => isCurrent(TOGGLE_COMMIT_BODY, sha, control),
        }),
      );
    }
    const pagination = this.querySelector<CaffoldPagination>(
      ":scope > .log-list-panel > caffold-pagination",
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
    scopeId = "git:log",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (this.hidden || this.state.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(LOG_LIST);
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label: "Git log",
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.state.status === "ready" &&
            this.querySelector(LOG_LIST) === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private changePage(event: CustomEvent<{ page?: number | string }>) {
    event.stopPropagation();
    const page = Number.parseInt(`${event.detail.page ?? ""}`, 10);
    if (!Number.isFinite(page) || page < 1) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:change-log-page", {
        bubbles: true,
        detail: { page },
      }),
    );
  }

  private toggleCommitBody(sha: string) {
    const expanded = new Set(this.expandedShas);
    if (!expanded.delete(sha)) {
      expanded.add(sha);
    }
    this.expandedShas = expanded;
  }

  private openCommit(sha: string) {
    this.dispatchEvent(
      new CustomEvent("caffold:open-git-commit", {
        bubbles: true,
        detail: { sha },
      }),
    );
  }
}

customElements.define("caffold-git-log-list-page", CaffoldGitLogListPage);

function formatDate(ms: number) {
  if (!ms) {
    return "";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}
