import { escapeHtml } from "../../../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../../../components/icons.js";
import "../../components/markdown.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../../../../scroll-scope.js";

class CaffoldGithubIssueDetailPage extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }
        if (
          button.dataset.action === "start-github-task" &&
          this.state?.status === "ready"
        ) {
          this.dispatchEvent(
            new CustomEvent("caffold:start-github-task", {
              bubbles: true,
              composed: true,
              detail: {
                kind: "issue",
                payload: this.state.payload,
                opener: button,
              },
            }),
          );
        }
      });
      this.boundIconsReady = () => this.render();
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
      warmIcons();
    }

    if (!this.state) {
      this.setEmpty();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(number) {
    this.state = { status: "loading", number };
    this.render();
  }

  setIssue(payload) {
    this.state = { status: "ready", payload };
    this.render();
  }

  setError(number, error) {
    this.state = { status: "error", number, error };
    this.render();
  }

  actionHintScope({ scopeId = "github:issue", clipRoots = [] } = {}) {
    const state = this.state;
    const issue = state?.payload?.issue;
    const number = `${issue?.number ?? ""}`;
    if (
      this.hidden ||
      this.state?.status !== "ready" ||
      !number
    ) {
      return emptyActionHintScope();
    }
    const targets = [];
    const startSelector =
      ':scope > .github-issue-viewer-panel > header > .github-issue-viewer-title-row > .github-issue-actions > button.github-issue-start-button[data-action="start-github-task"]';
    const start = this.querySelector(startSelector);
    if (
      start &&
      !start.disabled &&
      hasActionHintLayoutBox(start)
    ) {
      targets.push(buttonActionHintTarget({
        id: `${scopeId}:${encodeURIComponent(number)}:start-task`,
        actionId: ACTION_HINT_ACTION.GITHUB_TASK_START,
        label: start.getAttribute("aria-label") ||
          `Start Task for issue #${number}`,
        control: start,
        clipRoots: [this, ...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          `${this.state?.payload?.issue?.number ?? ""}` === number &&
          this.querySelector(startSelector) === start &&
          !start.disabled &&
          hasActionHintLayoutBox(start),
      }));
    }
    const linkSelector =
      ":scope > .github-issue-viewer-panel > header > .github-issue-viewer-title-row > .github-issue-actions > a.github-issue-link[href]";
    const link = this.querySelector(linkSelector);
    if (
      link &&
      link.getAttribute("href") === issue.url &&
      hasActionHintLayoutBox(link)
    ) {
      targets.push(linkActionHintTarget({
        id: `${scopeId}:${encodeURIComponent(number)}:github`,
        actionId: ACTION_HINT_ACTION.LINK_OPEN,
        label: `Open issue #${number} on GitHub in a new tab`,
        control: link,
        clipRoots: [this, ...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          `${this.state?.payload?.issue?.number ?? ""}` === number &&
          this.state?.payload?.issue?.url === issue.url &&
          this.querySelector(linkSelector) === link &&
          link.getAttribute("href") === issue.url &&
          hasActionHintLayoutBox(link),
      }));
    }
    const ownScope = {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
    const body = this.querySelector(
      ":scope > .github-issue-viewer-panel > .github-issue-body",
    );
    return mergeActionHintScopes(
      ownScope,
      body?.actionHintScope?.({
        scopeId: `${scopeId}:${encodeURIComponent(number)}:body`,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isCurrent: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(
            ":scope > .github-issue-viewer-panel > .github-issue-body",
          ) === body,
      }),
    );
  }

  scrollSurfaceScope({ scopeId = "github:issue", clipRoots = [] } = {}) {
    const state = this.state;
    if (this.hidden || state?.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const body = this.querySelector(
      ":scope > .github-issue-viewer-panel > .github-issue-body",
    );
    if (!body) {
      return emptyScrollSurfaceScope();
    }
    const isCurrent = () =>
      this.isConnected &&
      !this.hidden &&
      this.state === state &&
      this.querySelector(
        ":scope > .github-issue-viewer-panel > .github-issue-body",
      ) === body;
    if (typeof body.scrollSurfaceScope === "function") {
      return body.scrollSurfaceScope({
        scopeId: `${scopeId}:body`,
        label: "Issue description",
        clipRoots: [this, ...clipRoots],
        isCurrent,
      });
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:body:scroll`,
        label: "Issue description",
        scrollport: body,
        clipRoots: [this, body, ...clipRoots].filter(Boolean),
        isEligible: () =>
          isCurrent() &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(body) &&
          hasVerticalScrollOverflow(body),
      }],
      mutationRoots: [this, body],
      resizeElements: [this, body],
      scrollRoots: [body],
    };
  }

  render() {
    if (!this.state || this.state.status === "empty") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel">
          <p class="surface-message">Select an issue to inspect it.</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel" aria-busy="true">
          ${this.renderBasicHeader(`Issue #${this.state.number}`)}
          <p class="surface-message">Loading issue #${escapeHtml(`${this.state.number}`)}...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-issue-viewer-panel error-panel">
          ${this.renderBasicHeader(`Issue #${this.state.number}`)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const issue = this.state.payload.issue;
    const bodyHtml = issue.bodyHtml?.trim();
    this.innerHTML = `
      <section class="github-issue-viewer-panel">
        <header>
          <div class="github-issue-viewer-title-row">
            <h2>${escapeHtml(issue.title)}</h2>
            <div class="github-issue-actions">
              <button
                type="button"
                class="github-issue-start-button"
                data-action="start-github-task"
                aria-label="Start Task for issue #${escapeHtml(`${issue.number}`)}"
                title="Start Task"
              >
                ${renderInlineIcon("Plus", "Start Task", "github-issue-start-icon")}
                <span class="github-issue-start-label">Start Task</span>
              </button>
              <a
                class="github-issue-link"
                href="${escapeHtml(issue.url)}"
                target="_blank"
                rel="noreferrer"
              >GitHub</a>
            </div>
          </div>
          <div class="github-issue-viewer-meta">
            <span>#${escapeHtml(`${issue.number}`)}</span>
            <span>${escapeHtml(issue.state)}</span>
            ${issue.author ? `<span>${escapeHtml(issue.author)}</span>` : ""}
            <span>${escapeHtml(`${issue.comments} comments`)}</span>
          </div>
          ${this.renderLabels(issue.labels ?? [])}
        </header>
        ${this.renderBody(issue, bodyHtml)}
      </section>
    `;

    if (bodyHtml) {
      this.querySelector("caffold-github-markdown")?.setHtml(bodyHtml);
    }
  }

  renderLabels(labels) {
    if (!labels.length) {
      return "";
    }

    return `
      <div class="github-issue-viewer-labels">
        ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
      </div>
    `;
  }

  renderBasicHeader(title) {
    return `
      <header>
        <div class="github-issue-viewer-title-row">
          <h2>${escapeHtml(title)}</h2>
        </div>
      </header>
    `;
  }

  renderBody(issue, bodyHtml) {
    if (bodyHtml) {
      return `<caffold-github-markdown class="github-issue-body"></caffold-github-markdown>`;
    }

    return `
      <article class="github-issue-body github-issue-raw-body">
        ${escapeHtml(issue.body?.trim() || "No description.")}
      </article>
    `;
  }
}

customElements.define("caffold-github-issue-detail-page", CaffoldGithubIssueDetailPage);
