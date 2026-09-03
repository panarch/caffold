import { escapeHtml } from "../../../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../../../components/icons.js";
import "../../../../../../../components/pagination.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  disclosureActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../../../../scroll-scope.js";

class CaffoldGitLogListPage extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      if (button.dataset.action === "toggle-commit-body") {
        this.toggleCommitBody(button.dataset.commitSha);
        return;
      }

      if (button.dataset.action !== "open-commit") {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:open-git-commit", {
          bubbles: true,
          detail: {
            sha: button.dataset.commitSha,
          },
        }),
      );
    });
    this.addEventListener("caffold:change-page", (event) => {
      event.stopPropagation();
      this.changePage(event.detail.page);
    });

    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    this.expandedShas ??= new Set();
    if (!this.state) {
      this.reset();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setLoading(repository) {
    this.state = { status: "loading", repository };
    this.render();
  }

  setLog(log) {
    this.expandedShas = new Set();
    this.state = { status: "ready", log };
    this.render();
  }

  updateLog(log) {
    const scroller = this.querySelector(".log-list");
    const scroll = scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
    const shas = new Set((log.commits ?? []).map((commit) => commit.sha));
    this.expandedShas = new Set(
      Array.from(this.expandedShas ?? []).filter((sha) => shas.has(sha)),
    );
    this.state = { status: "ready", log };
    this.render();
    if (scroll) {
      requestAnimationFrame(() => {
        const nextScroller = this.querySelector(".log-list");
        if (nextScroller) {
          nextScroller.scrollTop = scroll.top;
          nextScroller.scrollLeft = scroll.left;
        }
      });
    }
  }

  setError(error, repository = null) {
    this.state = { status: "error", error, repository };
    this.render();
  }

  reset() {
    this.expandedShas = new Set();
    this.state = { status: "idle" };
    this.render();
  }

  changePage(pageValue) {
    const page = Number.parseInt(pageValue ?? "", 10);
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

  toggleCommitBody(sha) {
    if (!sha) {
      return;
    }

    const commit = this.findCommit(sha);
    const body = commit?.body?.trim() ?? "";
    if (!commit || body.length === 0) {
      return;
    }

    const expanded = !this.expandedShas.has(sha);
    if (expanded) {
      this.expandedShas.add(sha);
    } else {
      this.expandedShas.delete(sha);
    }

    this.patchCommitBody(commit, expanded);
  }

  findCommit(sha) {
    return (this.state?.log?.commits ?? []).find((commit) => commit.sha === sha);
  }

  actionHintScope({ scopeId = "git:log", clipRoots = [] } = {}) {
    if (this.hidden || this.state?.status !== "ready") {
      return emptyActionHintScope();
    }
    const scroller = this.querySelector(
      ":scope > .log-list-panel > .log-list",
    );
    const listClipRoots = [this, scroller, ...clipRoots].filter(Boolean);
    const targets = [...this.querySelectorAll(
      ':scope > .log-list-panel > .log-list > .log-entry > button[data-action="open-commit"][data-commit-sha]',
    )].flatMap((control) => {
      const sha = `${control.dataset.commitSha ?? ""}`;
      if (!sha || control.disabled) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:commit:${encodeURIComponent(sha)}`,
        actionId: ACTION_HINT_ACTION.COMMIT_OPEN,
        label: control.getAttribute("aria-label") || `Open commit ${sha.slice(0, 7)}`,
        control,
        clipRoots: listClipRoots,
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          this.querySelector(
            `:scope > .log-list-panel > .log-list > .log-entry > button[data-action="open-commit"][data-commit-sha="${CSS.escape(sha)}"]`,
          ) === control &&
          !control.disabled,
      })];
    });
    for (const control of this.querySelectorAll(
      ':scope > .log-list-panel > .log-list > .log-entry > button[data-action="toggle-commit-body"][data-commit-sha]',
    )) {
      const sha = `${control.dataset.commitSha ?? ""}`;
      if (!sha || control.disabled) {
        continue;
      }
      targets.push(disclosureActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:commit-body:${encodeURIComponent(sha)}`,
        actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
        label: control.getAttribute("aria-label") || "Expand commit body",
        control,
        clipRoots: listClipRoots,
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          this.querySelector(
            `:scope > .log-list-panel > .log-list > .log-entry > button[data-action="toggle-commit-body"][data-commit-sha="${CSS.escape(sha)}"]`,
          ) === control &&
          !control.disabled,
      }));
    }
    const pagination = this.querySelector(
      ":scope > .log-list-panel > caffold-pagination",
    );
    return mergeActionHintScopes(
      {
        targets,
        mutationRoots: [this],
        scrollRoots: [scroller].filter(Boolean),
      },
      pagination?.actionHintScope({
        scopeId: `${scopeId}:pagination`,
        actionId: ACTION_HINT_ACTION.PAGE,
        clipRoots: [this, ...clipRoots],
      }),
    );
  }

  scrollSurfaceScope({ scopeId = "git:log", clipRoots = [] } = {}) {
    if (this.hidden || this.state?.status !== "ready") {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(
      ":scope > .log-list-panel > .log-list",
    );
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label: "Git log",
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.state?.status === "ready" &&
          this.querySelector(":scope > .log-list-panel > .log-list") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  patchCommitBody(commit, expanded) {
    const entry = this.querySelector(`.log-entry[data-commit-sha="${CSS.escape(commit.sha)}"]`);
    if (!entry) {
      return;
    }

    const toggle = entry.querySelector("button[data-action='toggle-commit-body']");
    if (toggle) {
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute("aria-label", commitBodyToggleLabel(commit, expanded));
    }

    const body = entry.querySelector(".log-body");
    if (expanded) {
      if (!body) {
        entry.insertAdjacentHTML("beforeend", renderCommitBody(commit.body?.trim() ?? ""));
      }
      return;
    }

    body?.remove();
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="log-list-panel">
          <ol class="log-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="log-list-panel" aria-busy="true">
          <p class="surface-message">Loading log...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="log-list-panel error-panel">
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const commits = this.state.log.commits ?? [];
    this.innerHTML = `
      <section class="log-list-panel">
        ${
          commits.length === 0
            ? `<p class="surface-message">No commits.</p>`
            : `<ol class="log-list">${commits.map((commit) => this.renderCommit(commit)).join("")}</ol>`
        }
        ${this.renderPagination(this.state.log)}
      </section>
    `;
  }

  renderPagination(log) {
    const page = log.page ?? 1;
    const totalPages = log.totalPages ?? 0;
    if (totalPages <= 1) {
      return "";
    }

    return `
      <caffold-pagination
        aria-label="Log pagination"
        page="${escapeHtml(`${page}`)}"
        total-pages="${escapeHtml(`${totalPages}`)}"
        ${log.hasPrevious ? "has-previous" : ""}
        ${log.hasNext ? "has-next" : ""}
        first-label="Newest page"
        previous-label="Newer page"
        next-label="Older page"
        last-label="Oldest page"
      ></caffold-pagination>
    `;
  }

  renderCommit(commit) {
    const body = commit.body?.trim() ?? "";
    const expanded = body.length > 0 && this.expandedShas.has(commit.sha);
    const date = formatCommitDate(commit.authorTimeMs);
    const author = commit.authorName || commit.authorEmail || "";
    const meta = [commit.shortSha, author, date].filter(Boolean).join(" ");
    const summary = `
      <span class="log-subject">${escapeHtml(commit.subject || "(no subject)")}</span>
      <span class="log-meta">${escapeHtml(meta)}</span>
    `;

    return `
      <li
        class="log-entry"
        data-commit-sha="${escapeHtml(commit.sha)}"
      >
        ${
          body.length > 0
            ? `<button
                type="button"
                class="log-summary log-summary-toggle"
                data-action="toggle-commit-body"
                data-commit-sha="${escapeHtml(commit.sha)}"
                aria-expanded="${expanded ? "true" : "false"}"
                aria-label="${escapeHtml(commitBodyToggleLabel(commit, expanded))}"
                title="${escapeHtml(commit.subject)}"
              >
                ${summary}
              </button>`
            : `<div class="log-summary" title="${escapeHtml(commit.subject)}">
                ${summary}
              </div>`
        }
        <button
          type="button"
          class="log-review-button"
          data-action="open-commit"
          data-commit-sha="${escapeHtml(commit.sha)}"
          aria-label="${escapeHtml(`Open commit diff for ${commit.shortSha} ${commit.subject}`)}"
          title="${escapeHtml(`Open commit diff for ${commit.shortSha}`)}"
        >
          ${renderInlineIcon("FileDiff", "Diff", "log-review-icon")}
          <span class="log-review-label">Diff</span>
        </button>
        ${
          expanded
            ? renderCommitBody(body)
            : ""
        }
      </li>
    `;
  }
}

customElements.define("caffold-git-log-list-page", CaffoldGitLogListPage);

function formatCommitDate(ms) {
  if (!ms) {
    return "";
  }

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function commitBodyToggleLabel(commit, expanded) {
  return `${expanded ? "Collapse" : "Expand"} commit body for ${commit.shortSha}`;
}

function renderCommitBody(body) {
  return `<p class="log-body">${escapeHtml(body)}</p>`;
}
