import { escapeHtml } from "../../../../../components/dom.js";
import { cleanLogicalPath } from "../../task-format.js";
import { taskThreadId } from "../../task-list-model.js";
import "./summary/git.js";
import "./summary/github.js";
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
      this.addEventListener(
        "caffold:task-detail-git-intent",
        this.boundGitIntent,
      );
      this.addEventListener(
        "caffold:task-detail-github-intent",
        this.boundGithubIntent,
      );
    }
    this.render();
  }

  disconnectedCallback() {
    if (this.listenersAttached) {
      this.listenersAttached = false;
      this.removeEventListener("click", this.boundClick);
      this.removeEventListener(
        "caffold:task-detail-info-intent",
        this.boundInfoIntent,
      );
      this.removeEventListener(
        "caffold:task-detail-git-intent",
        this.boundGitIntent,
      );
      this.removeEventListener(
        "caffold:task-detail-github-intent",
        this.boundGithubIntent,
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
    this.active = false;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
    this.boundInfoIntent = (event) => this.handleInfoIntent(event);
    this.boundGitIntent = (event) => this.handleGitIntent(event);
    this.boundGithubIntent = (event) => this.handleGithubIntent(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const previousThreadId = taskThreadId(this.snapshot.task);
    const task = snapshot.task ?? null;
    const nextThreadId = taskThreadId(task);
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

    if (
      nextThreadId &&
      previousThreadId === nextThreadId &&
      this.renderedThreadId === nextThreadId
    ) {
      this.patchSummary();
    } else {
      this.render();
    }
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
    this.taskInfo()?.deactivate();
    this.git()?.deactivate();
    this.github()?.deactivate();
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-summary-action]");
    if (!action || action.matches(":disabled")) {
      return;
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

  handleGitIntent(event) {
    if (event.target !== this.git()) {
      return;
    }
    event.stopPropagation();
    this.dispatchIntent({
      type: event.detail?.type,
      reviewKind: event.detail?.reviewKind ?? null,
    });
  }

  handleGithubIntent(event) {
    if (event.target !== this.github()) {
      return;
    }
    event.stopPropagation();
    this.dispatchIntent({
      type: event.detail?.type,
      reviewKind: event.detail?.reviewKind ?? null,
    });
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

  render() {
    this.ensureState();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      this.renderedThreadId = "";
      return;
    }

    this.innerHTML = `
      <div class="task-detail-heading">
        <h2>${escapeHtml(task.title)}</h2>
      </div>
      <div class="task-detail-right">
        <div class="task-detail-actions">
          ${this.renderTaskModeSwitch(task)}
          <caffold-task-detail-git></caffold-task-detail-git>
          <caffold-task-detail-github></caffold-task-detail-github>
        </div>
        <caffold-task-detail-info></caffold-task-detail-info>
      </div>
    `;
    this.renderedThreadId = taskThreadId(task);
    this.patchReviewView();
    this.syncGit();
    this.syncGithub();
    this.syncTaskInfo();
  }

  patchSummary() {
    const task = this.snapshot.task;
    if (!task || !this.taskInfo()) {
      this.render();
      return;
    }

    setText(this.querySelector(".task-detail-heading h2"), `${task.title ?? ""}`);
    this.patchTaskModeSwitch();
    this.syncGit();
    this.syncGithub();
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

  syncGit() {
    const available = Boolean(taskWorktreeRootPath(this.snapshot.task));
    this.git()?.setSnapshot({ available });
  }

  syncGithub() {
    const available = Boolean(taskWorktreeRootPath(this.snapshot.task));
    this.github()?.setSnapshot({ available });
  }

  taskInfo() {
    return this.querySelector("caffold-task-detail-info");
  }

  git() {
    return this.querySelector("caffold-task-detail-git");
  }

  github() {
    return this.querySelector("caffold-task-detail-github");
  }
}

if (!customElements.get("caffold-task-detail-summary")) {
  customElements.define(
    "caffold-task-detail-summary",
    CaffoldTaskDetailSummary,
  );
}

function normalizeReviewView(view) {
  return ["review", "git", "github"].includes(view) ? view : "conversation";
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
