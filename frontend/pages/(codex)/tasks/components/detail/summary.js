import { getGitHubStatus } from "../../../../../api.js";
import { escapeHtml } from "../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../components/icons.js";
import {
  formatTaskStatus,
  isTaskTransportStale,
} from "../../runtime-state.js";
import { cleanLogicalPath, shortId } from "../../task-format.js";
import {
  taskThreadId,
  taskWorktreeLabel,
} from "../../task-list-model.js";
import { renderTaskStatusChip } from "../task-status.js";

class CaffoldTaskDetailSummary extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    this.render();
    this.ensureGithubStatus();
  }

  disconnectedCallback() {
    if (this.listenersAttached) {
      this.listenersAttached = false;
      this.removeEventListener("click", this.boundClick);
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    this.deactivate();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      task: null,
      transportState: "idle",
      reviewView: "conversation",
      contextPath: ".",
    };
    this.githubStatus = null;
    this.githubStatusPath = "";
    this.githubStatusState = "idle";
    this.githubStatusRequestId = 0;
    this.active = false;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.render();
    warmIcons();
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const previousThreadId = taskThreadId(this.snapshot.task);
    const task = snapshot.task ?? null;
    const nextThreadId = taskThreadId(task);
    const nextRootPath = taskWorktreeRootPath(task);
    this.snapshot = {
      task,
      transportState: snapshot.transportState ?? "idle",
      reviewView: normalizeReviewView(snapshot.reviewView),
      contextPath: `${snapshot.contextPath ?? "."}`,
    };
    this.active = true;

    if (!nextRootPath) {
      this.resetGithubStatus();
    } else if (this.githubStatusPath !== nextRootPath) {
      this.resetGithubStatus(nextRootPath);
    }

    this.render({ preserveDisclosure: previousThreadId === nextThreadId });
    this.ensureGithubStatus();
  }

  setReviewView(view) {
    this.ensureState();
    const reviewView = normalizeReviewView(view);
    if (reviewView === this.snapshot.reviewView) {
      return;
    }
    this.snapshot = { ...this.snapshot, reviewView };
    this.querySelector('[data-summary-action="toggle-files"]')?.setAttribute(
      "aria-pressed",
      reviewView === "files" ? "true" : "false",
    );
    this.querySelector('[data-summary-action="open-diff"]')?.setAttribute(
      "aria-pressed",
      reviewView === "diff" ? "true" : "false",
    );
  }

  deactivate() {
    this.ensureState();
    this.active = false;
    this.githubStatusRequestId += 1;
    if (this.githubStatusState === "loading") {
      this.githubStatusState = "idle";
    }
  }

  handleClick(event) {
    const reviewMenu = closestElement(event.target, ".task-review-menu");
    for (const menu of this.querySelectorAll(".task-review-menu[open]")) {
      if (menu !== reviewMenu) {
        menu.removeAttribute("open");
      }
    }

    const action = closestElement(event.target, "[data-summary-action]");
    if (!action || action.matches(":disabled")) {
      return;
    }
    if (
      action.dataset.summaryAction === "open-git-tool" ||
      action.dataset.summaryAction === "open-github-tool"
    ) {
      action.closest("details")?.removeAttribute("open");
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-summary-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: action.dataset.summaryAction,
          reviewKind: action.dataset.reviewKind ?? null,
        },
      }),
    );
  }

  beginGithubStatus(rootPath) {
    this.githubStatusRequestId += 1;
    this.githubStatus = null;
    this.githubStatusPath = rootPath;
    this.githubStatusState = "loading";
  }

  resetGithubStatus(rootPath = "") {
    this.githubStatusRequestId += 1;
    this.githubStatus = null;
    this.githubStatusPath = rootPath;
    this.githubStatusState = "idle";
  }

  ensureGithubStatus() {
    const rootPath = taskWorktreeRootPath(this.snapshot.task);
    if (
      !this.active ||
      !this.isConnected ||
      !rootPath
    ) {
      return;
    }
    if (this.githubStatusPath !== rootPath) {
      this.resetGithubStatus(rootPath);
    }
    if (this.githubStatusState !== "idle") {
      return;
    }
    this.beginGithubStatus(rootPath);
    this.render();
    void this.loadGithubStatus(rootPath);
  }

  async loadGithubStatus(rootPath) {
    const requestId = this.githubStatusRequestId;
    try {
      const status = await getGitHubStatus(rootPath);
      if (!this.acceptGithubStatus(requestId, rootPath)) {
        return;
      }
      this.githubStatus = status;
      this.githubStatusState = "ready";
      this.render();
    } catch (error) {
      if (!this.acceptGithubStatus(requestId, rootPath)) {
        return;
      }
      this.githubStatus = { message: error.message };
      this.githubStatusState = "error";
      this.render();
    }
  }

  acceptGithubStatus(requestId, rootPath) {
    return (
      this.active &&
      this.isConnected &&
      requestId === this.githubStatusRequestId &&
      rootPath === taskWorktreeRootPath(this.snapshot.task)
    );
  }

  githubMenuState(rootPath) {
    if (
      this.githubStatusPath !== rootPath ||
      ["idle", "loading"].includes(this.githubStatusState)
    ) {
      return {
        enabled: false,
        loading: true,
        issues: false,
        pulls: false,
        message: "Checking GitHub availability",
      };
    }

    const issues = Boolean(this.githubStatus?.issuesAvailable);
    const pulls = Boolean(this.githubStatus?.pullsAvailable);
    return {
      enabled: Boolean(this.githubStatus?.github) && (issues || pulls),
      loading: false,
      issues,
      pulls,
      message:
        this.githubStatus?.message ||
        (this.githubStatus?.github
          ? "GitHub CLI authentication is required"
          : "No GitHub remote detected"),
    };
  }

  render(options = {}) {
    this.ensureState();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      return;
    }

    const disclosure = options.preserveDisclosure === false
      ? { menu: null, info: false }
      : this.captureDisclosure();
    const status = renderTaskStatusChip(task, "task-detail-status", {
      label: false,
      transportState: this.snapshot.transportState,
    });
    const statusLabel = formatTaskStatus(task, this.snapshot.transportState);
    const canOpenDiff = Boolean(task.worktree);
    const worktreeLabel = taskWorktreeLabel(task);
    const transportBlocked = isTaskTransportStale(
      this.snapshot.transportState,
    );

    this.innerHTML = `
      <div class="task-detail-heading">
        <h2>${escapeHtml(task.title)}</h2>
        <p class="task-detail-meta">
          <span>Thread ${escapeHtml(shortId(task.threadId ?? task.id))}</span>
          ${worktreeLabel ? `<span>${escapeHtml(worktreeLabel)}</span>` : ""}
        </p>
      </div>
      <div class="task-detail-right">
        <div class="task-detail-actions">
          <button
            type="button"
            class="task-secondary-button"
            data-summary-action="toggle-files"
            aria-pressed="${this.snapshot.reviewView === "files" ? "true" : "false"}"
          >
            ${renderInlineIcon("Folder", "Files", "task-action-icon")}
            <span class="task-action-label">Files</span>
          </button>
          <button
            type="button"
            class="task-secondary-button"
            data-summary-action="open-diff"
            aria-pressed="${this.snapshot.reviewView === "diff" ? "true" : "false"}"
            ${canOpenDiff ? "" : "disabled"}
            title="${canOpenDiff ? "Open worktree diff" : "Diff is unavailable outside a Git worktree"}"
          >
            ${renderInlineIcon("FileDiff", "Open diff", "task-action-icon")}
            <span class="task-action-label">Open Diff</span>
          </button>
          ${this.renderReviewMenus(task)}
          ${
            task.activeTurn?.id
              ? `<button type="button" class="task-secondary-button" data-summary-action="interrupt" ${transportBlocked ? 'disabled title="Caffold server connection is unavailable."' : ""}>
                  ${renderInlineIcon("Square", "Interrupt", "task-action-icon")}
                  <span class="task-action-label">Interrupt</span>
                </button>`
              : ""
          }
        </div>
        <button
          type="button"
          class="task-detail-info-button"
          popovertarget="task-detail-info"
          aria-label="Task details, ${escapeHtml(statusLabel)}"
          title="Status: ${escapeHtml(statusLabel)}"
        >
          ${status || renderInlineIcon("Info", "Task details", "task-action-icon")}
        </button>
      </div>
      <div
        id="task-detail-info"
        class="task-detail-popover"
        popover="auto"
        aria-label="Task details"
      >
        <dl>
          <div>
            <dt>Status</dt>
            <dd>${escapeHtml(statusLabel)}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd>${escapeHtml(task.threadId ?? task.id)}</dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd>${escapeHtml(task.cwdPath || task.cwd || this.snapshot.contextPath)}</dd>
          </div>
          ${
            task.worktree
              ? `<div>
                  <dt>Worktree</dt>
                  <dd>${escapeHtml(task.worktree.rootPath)}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>${escapeHtml(taskWorktreeRef(task))}</dd>
                </div>`
              : ""
          }
          ${
            canOpenDiff
              ? ""
              : `<div>
                  <dt>Diff review</dt>
                  <dd>Unavailable outside a Git worktree.</dd>
                </div>`
          }
        </dl>
      </div>
    `;
    this.restoreDisclosure(disclosure);
  }

  renderReviewMenus(task) {
    const rootPath = taskWorktreeRootPath(task);
    if (!rootPath) {
      return `
        <button type="button" class="task-brand-button" disabled title="Git and GitHub are unavailable outside a Git worktree">
          <img src="/assets/brand/git-logomark-light.svg" alt="">
          <span class="sr-only">Git unavailable</span>
        </button>
        <button type="button" class="task-brand-button" disabled title="Git and GitHub are unavailable outside a Git worktree">
          <img src="/assets/brand/github-invertocat-light.svg" alt="">
          <span class="sr-only">GitHub unavailable</span>
        </button>
      `;
    }

    const github = this.githubMenuState(rootPath);
    return `
      <details class="task-review-menu" data-review-menu="git">
        <summary class="task-brand-button" title="Open Git workspace" aria-label="Open Git workspace">
          <img src="/assets/brand/git-logomark-light.svg" alt="">
        </summary>
        <div class="task-review-menu-popover" role="menu" aria-label="Git workspace">
          <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="diff">Working Tree</button>
          <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="compare">Compare</button>
          <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="log">Log</button>
        </div>
      </details>
      ${
        github.enabled
          ? `<details class="task-review-menu" data-review-menu="github">
              <summary class="task-brand-button" title="Open GitHub workspace" aria-label="Open GitHub workspace">
                <img src="/assets/brand/github-invertocat-light.svg" alt="">
              </summary>
              <div class="task-review-menu-popover" role="menu" aria-label="GitHub workspace">
                <button type="button" role="menuitem" data-summary-action="open-github-tool" data-review-kind="pulls" ${github.pulls ? "" : "disabled"}>Pull Requests</button>
                <button type="button" role="menuitem" data-summary-action="open-github-tool" data-review-kind="issues" ${github.issues ? "" : "disabled"}>Issues</button>
              </div>
            </details>`
          : `<button type="button" class="task-brand-button${github.loading ? " is-loading" : ""}" disabled title="${escapeHtml(github.message)}">
              <img src="/assets/brand/github-invertocat-light.svg" alt="">
              <span class="sr-only">${escapeHtml(github.message)}</span>
            </button>`
      }
    `;
  }

  captureDisclosure() {
    return {
      menu:
        this.querySelector(".task-review-menu[open]")?.dataset.reviewMenu ?? null,
      info: Boolean(
        this.querySelector(".task-detail-popover")?.matches(":popover-open"),
      ),
    };
  }

  restoreDisclosure(disclosure) {
    if (disclosure.menu) {
      this.querySelector(
        `.task-review-menu[data-review-menu="${CSS.escape(disclosure.menu)}"]`,
      )?.setAttribute("open", "");
    }
    if (disclosure.info) {
      try {
        this.querySelector(".task-detail-popover")?.showPopover();
      } catch {
        // The host may have been detached between snapshot and render.
      }
    }
  }
}

if (!customElements.get("caffold-task-detail-summary")) {
  customElements.define(
    "caffold-task-detail-summary",
    CaffoldTaskDetailSummary,
  );
}

function normalizeReviewView(view) {
  return view === "files" || view === "diff" ? view : "conversation";
}

function taskWorktreeRef(task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  return branch || shortId(task?.worktree?.headSha ?? "");
}

function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
