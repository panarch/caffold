import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { GitLog } from "#app/api.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import "#components/pagination.js";
import type { CaffoldPagination } from "#components/pagination.js";

type LogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; log: GitLog }
  | { status: "error"; error: Error };

@customElement("caffold-git-log-list-page")
export class CaffoldGitLogListPage extends LitElement {
  @state()
  private accessor state: LogState = { status: "idle" };
  @state()
  private accessor expandedShas: ReadonlySet<string> = new Set();

  // A new log starts at its top; a refreshed one keeps its place.
  private scrollToTop = false;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly list = new DrawnRef<HTMLOListElement>(this);
  private readonly pagination = new DrawnRef<CaffoldPagination>(this);
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.list.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);

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
                  ${this.hints.disclosure({
                    id: `commit-body:${encodeURIComponent(commit.sha)}`,
                    label: `${verb} commit body for ${commit.shortSha}`,
                    action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                  })}
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
            ${this.hints.button({
              id: `commit:${encodeURIComponent(commit.sha)}`,
              label: `${openLabel} ${commit.subject}`,
              action: ACTION_HINT_ACTION.COMMIT_OPEN,
            })}
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
            ? html`<ol
                ${drawn(this.list)}
                ${this.surfaces.surface({
                  id: "scroll",
                  clipRoots: () => [this, this.list.value],
                })}
                class="log-list"
              >${entries}</ol>`
            : html`<p class="surface-message">No commits.</p>`
        }
        ${
          log.totalPages > 1
            ? html`<caffold-pagination
                ${drawn(this.pagination)}
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

  override updated(changed: PropertyValues) {
    if (!changed.has("state") || !this.scrollToTop) {
      return;
    }
    this.scrollToTop = false;
    const scroller = this.list.value;
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
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId, clipRoots });
    return mergeActionHintScopes(
      own,
      this.pagination.value?.actionHintScope({
        scopeId: `${scopeId}:pagination`,
        actionId: ACTION_HINT_ACTION.PAGE,
        clipRoots: [this, ...clipRoots],
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "git:log",
    label = "Git log",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-git-log-list-page": CaffoldGitLogListPage;
  }
}
