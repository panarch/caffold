import { getGitHubStatus } from "../../../../../api.js";
import { escapeHtml } from "../../../../../components/dom.js";
import { cleanLogicalPath, shortId } from "../../task-format.js";
import {
  taskThreadId,
  taskWorktreeLabel,
} from "../../task-list-model.js";
import "./summary/info.js";

class CaffoldTaskDetailSummary extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
      this.addEventListener(
        "caffold:task-detail-info-intent",
        this.boundInfoIntent,
      );
    }
    this.render();
    this.ensureGithubStatus();
  }

  disconnectedCallback() {
    if (this.listenersAttached) {
      this.listenersAttached = false;
      this.removeEventListener("click", this.boundClick);
      this.removeEventListener(
        "caffold:task-detail-info-intent",
        this.boundInfoIntent,
      );
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
      reviewScope: "working",
      reviewBaseRef: "",
      contextPath: ".",
      archiveState: { loading: false, error: null },
    };
    this.renderedThreadId = "";
    this.githubStatus = null;
    this.githubStatusPath = "";
    this.githubStatusState = "idle";
    this.githubStatusRequestId = 0;
    this.active = false;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
    this.boundInfoIntent = (event) => this.handleInfoIntent(event);
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
      reviewScope: normalizeReviewScope(snapshot.reviewScope),
      reviewBaseRef: `${snapshot.reviewBaseRef ?? ""}`,
      contextPath: `${snapshot.contextPath ?? "."}`,
      archiveState: {
        loading: Boolean(snapshot.archiveState?.loading),
        error: snapshot.archiveState?.error ?? null,
      },
    };
    this.active = true;

    if (!nextRootPath) {
      this.resetGithubStatus();
    } else if (this.githubStatusPath !== nextRootPath) {
      this.resetGithubStatus(nextRootPath);
    }

    if (
      nextThreadId &&
      previousThreadId === nextThreadId &&
      this.renderedThreadId === nextThreadId
    ) {
      this.patchSummary();
    } else {
      this.render();
    }
    this.ensureGithubStatus();
  }

  setReviewView(view) {
    this.ensureState();
    const reviewView = normalizeReviewView(view);
    if (reviewView === this.snapshot.reviewView) {
      return;
    }
    this.snapshot = { ...this.snapshot, reviewView };
    this.patchReviewView();
  }

  deactivate() {
    this.ensureState();
    this.active = false;
    this.githubStatusRequestId += 1;
    if (this.githubStatusState === "loading") {
      this.githubStatusState = "idle";
    }
    this.taskInfo()?.deactivate();
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
    this.dispatchIntent({
      type: action.dataset.summaryAction,
      reviewKind: action.dataset.reviewKind ?? null,
      reviewScope: action.dataset.reviewScope ?? null,
    });
  }

  handleInfoIntent(event) {
    if (
      event.target !== this.taskInfo() ||
      event.detail?.type !== "archive"
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchIntent({ type: "archive" });
  }

  dispatchIntent(detail) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-summary-intent", {
        bubbles: true,
        composed: true,
        detail,
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
    if (!this.active || !this.isConnected || !rootPath) {
      return;
    }
    if (this.githubStatusPath !== rootPath) {
      this.resetGithubStatus(rootPath);
    }
    if (this.githubStatusState !== "idle") {
      return;
    }
    this.beginGithubStatus(rootPath);
    this.patchReviewControls();
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
      this.patchReviewControls();
    } catch (error) {
      if (!this.acceptGithubStatus(requestId, rootPath)) {
        return;
      }
      this.githubStatus = { message: error.message };
      this.githubStatusState = "error";
      this.patchReviewControls();
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

  render() {
    this.ensureState();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      this.renderedThreadId = "";
      return;
    }

    const worktreeLabel = taskWorktreeLabel(task);
    this.innerHTML = `
      <div class="task-detail-heading">
        <h2>${escapeHtml(task.title)}</h2>
        <p class="task-detail-meta">
          <span data-summary-field="thread-short">Thread ${escapeHtml(shortId(task.threadId ?? task.id))}</span>
          <span data-summary-field="worktree-label" ${worktreeLabel ? "" : "hidden"}>${escapeHtml(worktreeLabel)}</span>
        </p>
      </div>
      <div class="task-detail-right">
        <div class="task-detail-actions">
          ${this.renderTaskModeSwitch(task)}
          ${this.renderReviewMenus(task)}
        </div>
        <caffold-task-detail-info></caffold-task-detail-info>
      </div>
    `;
    this.renderedThreadId = taskThreadId(task);
    this.patchReviewView();
    this.syncTaskInfo();
  }

  patchSummary() {
    const task = this.snapshot.task;
    if (!task || !this.taskInfo()) {
      this.render();
      return;
    }

    setText(this.querySelector(".task-detail-heading h2"), `${task.title ?? ""}`);
    setText(
      this.querySelector('[data-summary-field="thread-short"]'),
      `Thread ${shortId(task.threadId ?? task.id)}`,
    );
    const worktreeLabel = taskWorktreeLabel(task);
    const label = this.querySelector('[data-summary-field="worktree-label"]');
    setText(label, worktreeLabel);
    if (label) {
      label.hidden = !worktreeLabel;
    }
    this.patchTaskModeSwitch();
    this.patchReviewControls();
    this.syncTaskInfo();
  }

  patchReviewView() {
    for (const button of this.querySelectorAll("[data-summary-mode]")) {
      const pressed = button.dataset.reviewScope
        ? this.snapshot.reviewView === "review" &&
          button.dataset.reviewScope === this.snapshot.reviewScope
        : button.dataset.summaryMode === this.snapshot.reviewView;
      button.setAttribute(
        "aria-pressed",
        pressed ? "true" : "false",
      );
    }
  }

  renderTaskModeSwitch(task) {
    if (!taskWorktreeRootPath(task)) {
      return `<div class="task-mode-switch" data-summary-key="files" role="group" aria-label="Task view">
        <button type="button" data-summary-action="open-conversation" data-summary-mode="conversation"><span>Conversation</span></button>
        <button type="button" data-summary-action="open-review" data-summary-mode="review"><span>Review</span></button>
      </div>`;
    }
    const baseRef = this.reviewBaseRef();
    return `<div class="task-mode-switch" data-summary-key="git" role="group" aria-label="Task view">
      <button type="button" data-summary-action="open-conversation" data-summary-mode="conversation"><span>Conversation</span></button>
      <button type="button" data-summary-action="open-review-scope" data-summary-mode="review" data-review-scope="working"><span>Working Tree</span></button>
      <button type="button" data-summary-action="open-review-scope" data-summary-mode="review" data-review-scope="branch" title="Compare with ${escapeHtml(baseRef || "the default branch")}"><span data-summary-field="review-branch-label">Branch</span></button>
    </div>`;
  }

  patchTaskModeSwitch() {
    const task = this.snapshot.task;
    const current = this.querySelector(".task-mode-switch");
    if (!task || !current) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = this.renderTaskModeSwitch(task).trim();
    const next = template.content.firstElementChild;
    if (current.dataset.summaryKey !== next?.dataset.summaryKey) {
      current.replaceWith(next);
    } else if (current.dataset.summaryKey === "git") {
      const branch = current.querySelector('[data-review-scope="branch"]');
      const baseRef = this.reviewBaseRef();
      if (branch) {
        branch.title = `Compare with ${baseRef || "the default branch"}`;
        setText(branch.querySelector('[data-summary-field="review-branch-label"]'), "Branch");
      }
    }
    this.patchReviewView();
  }

  reviewBaseRef() {
    return this.snapshot.reviewBaseRef || "";
  }

  syncTaskInfo() {
    this.taskInfo()?.setSnapshot({
      task: this.snapshot.task,
      transportState: this.snapshot.transportState,
      contextPath: this.snapshot.contextPath,
      archiveState: this.snapshot.archiveState,
    });
  }

  renderReviewMenus(task) {
    return `${this.renderGitControl(task)}${this.renderGithubControl(task)}`;
  }

  renderGitControl(task) {
    if (!taskWorktreeRootPath(task)) {
      return `<button type="button" class="task-brand-button" data-summary-review-control="git" data-summary-key="disabled" disabled title="Git and GitHub are unavailable outside a Git worktree">
        <img src="/assets/brand/git-logomark-light.svg" alt="">
        <span class="sr-only">Git unavailable</span>
      </button>`;
    }
    return `<details class="task-review-menu" data-review-menu="git" data-summary-review-control="git" data-summary-key="enabled">
      <summary class="task-brand-button" title="Open Git workspace" aria-label="Open Git workspace">
        <img src="/assets/brand/git-logomark-light.svg" alt="">
      </summary>
      <div class="task-review-menu-popover" role="menu" aria-label="Git workspace">
        <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="diff">Working Tree</button>
        <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="compare">Compare</button>
        <button type="button" role="menuitem" data-summary-action="open-git-tool" data-review-kind="log">Log</button>
      </div>
    </details>`;
  }

  renderGithubControl(task) {
    const rootPath = taskWorktreeRootPath(task);
    if (!rootPath) {
      return `<button type="button" class="task-brand-button" data-summary-review-control="github" data-summary-key="disabled:no-worktree" disabled title="Git and GitHub are unavailable outside a Git worktree">
        <img src="/assets/brand/github-invertocat-light.svg" alt="">
        <span class="sr-only">GitHub unavailable</span>
      </button>`;
    }

    const github = this.githubMenuState(rootPath);
    if (github.enabled) {
      const key = `enabled:${github.pulls}:${github.issues}`;
      return `<details class="task-review-menu" data-review-menu="github" data-summary-review-control="github" data-summary-key="${key}">
        <summary class="task-brand-button" title="Open GitHub workspace" aria-label="Open GitHub workspace">
          <img src="/assets/brand/github-invertocat-light.svg" alt="">
        </summary>
        <div class="task-review-menu-popover" role="menu" aria-label="GitHub workspace">
          <button type="button" role="menuitem" data-summary-action="open-github-tool" data-review-kind="pulls" ${github.pulls ? "" : "disabled"}>Pull Requests</button>
          <button type="button" role="menuitem" data-summary-action="open-github-tool" data-review-kind="issues" ${github.issues ? "" : "disabled"}>Issues</button>
        </div>
      </details>`;
    }

    const key = github.loading ? "loading" : `disabled:${github.message}`;
    return `<button type="button" class="task-brand-button${github.loading ? " is-loading" : ""}" data-summary-review-control="github" data-summary-key="${escapeHtml(key)}" disabled title="${escapeHtml(github.message)}">
      <img src="/assets/brand/github-invertocat-light.svg" alt="">
      <span class="sr-only">${escapeHtml(github.message)}</span>
    </button>`;
  }

  patchReviewControls() {
    const task = this.snapshot.task;
    const actions = this.querySelector(".task-detail-actions");
    if (!task || !actions) {
      return;
    }

    for (const [kind, markup] of [
      ["git", this.renderGitControl(task)],
      ["github", this.renderGithubControl(task)],
    ]) {
      const template = document.createElement("template");
      template.innerHTML = markup.trim();
      const nextControl = template.content.firstElementChild;
      const currentControl = actions.querySelector(
        `[data-summary-review-control="${kind}"]`,
      );
      if (
        currentControl?.dataset.summaryKey === nextControl?.dataset.summaryKey
      ) {
        continue;
      }
      if (currentControl) {
        currentControl.replaceWith(nextControl);
      } else {
        const previous =
          kind === "github"
            ? actions.querySelector('[data-summary-review-control="git"]')
            : actions.querySelector(".task-mode-switch");
        previous?.after(nextControl);
      }
    }
  }

  taskInfo() {
    return this.querySelector("caffold-task-detail-info");
  }
}

if (!customElements.get("caffold-task-detail-summary")) {
  customElements.define(
    "caffold-task-detail-summary",
    CaffoldTaskDetailSummary,
  );
}

function normalizeReviewView(view) {
  return view === "review" ? "review" : "conversation";
}

function normalizeReviewScope(scope) {
  return scope === "branch" ? "branch" : "working";
}

function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function setText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
