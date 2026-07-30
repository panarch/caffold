import { getGitStatus } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import "../../../../components/file-browser.js";
import "../../../../components/git-compare-browser.js";
import "../../../../components/git-diff-browser.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { createRefreshCoordinator, subscribeToWatch } from "../../../../watch.js";
import { latestTaskRelatedWorktreePaths } from "../conversation-render.js";
import { cleanLogicalPath, shortId } from "../task-format.js";
import { taskThreadId, taskWorktreeRootName } from "../task-list-model.js";

class CaffoldTaskReview extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (!this.globalListenersAttached) {
      this.globalListenersAttached = true;
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    this.active = true;
    this.syncActiveView();
  }

  disconnectedCallback() {
    this.deactivate();
    if (this.globalListenersAttached) {
      this.globalListenersAttached = false;
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.active = true;
    this.view = "conversation";
    this.diffMode = "working";
    this.task = null;
    this.events = [];
    this.contextKey = "";
    this.diffStatus = null;
    this.diffError = null;
    this.diffRequestId = 0;
    this.diffWatchUnsubscribe = null;
    this.diffWatchPath = "";
    this.diffWatchUnavailable = false;
    this.diffRefreshState = "idle";
    this.compareOpenPromise = null;
    this.globalListenersAttached = false;
    this.refreshCoordinatorGeneration = 0;
    this.resetRefreshCoordinators();
    this.boundIconsReady = () => this.patchRefreshIcon();
    warmIcons();

    this.innerHTML = `
      <section class="task-files-view" aria-label="Task files">
        <header class="task-files-header">
          <div>
            <h3>Files</h3>
            <p></p>
          </div>
        </header>
        <caffold-file-browser></caffold-file-browser>
      </section>
      <section
        class="task-diff-view"
        data-task-diff-mode="working"
        aria-label="Task worktree review"
      >
        <header class="task-diff-header">
          <div class="task-diff-heading">
            <h3>Diff</h3>
            <p class="task-diff-subtitle"></p>
          </div>
          <div class="task-diff-controls">
            <div class="task-diff-mode-switch" role="group" aria-label="Diff mode">
              <button
                type="button"
                data-task-review-action="select-diff-mode"
                data-diff-mode="working"
                aria-pressed="true"
              >Working Tree</button>
              <button
                type="button"
                data-task-review-action="select-diff-mode"
                data-diff-mode="branch"
                aria-pressed="false"
              >Branch</button>
            </div>
            <div class="task-compare-controls" aria-label="Branch comparison">
              <label>
                <span>Base</span>
                <select data-task-compare-base disabled>
                  <option value="">Loading refs...</option>
                </select>
              </label>
              <span class="task-compare-separator" aria-hidden="true">...</span>
              <span class="task-compare-head-label">Head</span>
              <span class="task-compare-head" data-task-compare-head></span>
            </div>
            <button
              type="button"
              class="task-icon-button"
              data-task-review-action="refresh"
              aria-label="Refresh task diff"
              title="Refresh task diff"
            >
              ${renderInlineIcon("RefreshCw", "Refresh task diff", "task-refresh-icon")}
            </button>
          </div>
        </header>
        <div class="task-diff-panel" data-task-diff-panel="working">
          <caffold-git-diff-browser></caffold-git-diff-browser>
        </div>
        <div class="task-diff-panel" data-task-diff-panel="branch">
          <caffold-git-compare-browser></caffold-git-compare-browser>
        </div>
      </section>
    `;

    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("change", (event) => this.handleChange(event));
    this.addEventListener("caffold:refresh-git-review", (event) => {
      event.stopPropagation();
      this.requestReviewRefresh();
    });
    this.addEventListener("caffold:open-git-diff", (event) => {
      const browser = closestElement(event.target, "caffold-git-diff-browser");
      if (!browser || browser !== this.diffBrowser()) {
        return;
      }
      event.stopPropagation();
      browser.openDiff(event.detail.path, event.detail.kind, event.detail.status);
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      const browser = closestElement(event.target, "caffold-git-compare-browser");
      if (!browser || browser !== this.compareBrowser()) {
        return;
      }
      event.stopPropagation();
      browser.openDiff(event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:git-compare-state-change", (event) => {
      const browser = closestElement(event.target, "caffold-git-compare-browser");
      if (!browser || browser !== this.compareBrowser()) {
        return;
      }
      event.stopPropagation();
      this.patchDiffHeader();
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      const browser = closestElement(
        event.target,
        "caffold-git-diff-browser, caffold-git-compare-browser",
      );
      if (!browser || !this.contains(browser)) {
        return;
      }
      event.stopPropagation();
      browser.showList();
    });
    this.setAttribute("data-review-view", this.view);
  }

  setTaskContext({ task = null, events = [] } = {}) {
    this.ensureRendered();
    const nextKey = reviewContextKey(task);
    const contextChanged = nextKey !== this.contextKey;
    if (contextChanged) {
      this.resetContext();
      this.contextKey = nextKey;
    }
    this.active = true;
    this.task = task;
    this.events = Array.isArray(events) ? events : [];
    this.patchTaskContext();
    this.syncActiveView();
    if (contextChanged) {
      this.dispatchViewChange();
    }
  }

  openFiles() {
    if (!this.task) {
      return false;
    }
    this.setView("files");
    return true;
  }

  openDiff() {
    if (!this.task?.worktree) {
      return false;
    }
    this.setView("diff");
    return true;
  }

  close() {
    if (this.view === "conversation") {
      return false;
    }
    this.setView("conversation");
    return true;
  }

  refresh() {
    if (this.view === "files") {
      return this.fileBrowser()?.requestRefresh({
        allDirectories: true,
        file: true,
      });
    }
    if (this.view === "diff") {
      return this.requestReviewRefresh();
    }
    return null;
  }

  deactivate() {
    this.ensureRendered();
    this.active = false;
    this.diffRequestId += 1;
    this.unsubscribeDiffWatch();
    this.fileBrowser()?.setWatchActive(false);
  }

  resetContext() {
    this.diffRequestId += 1;
    this.resetRefreshCoordinators();
    this.unsubscribeDiffWatch();
    this.fileBrowser()?.setWatchActive(false);
    this.diffBrowser()?.reset();
    this.compareBrowser()?.reset();
    this.diffStatus = null;
    this.diffError = null;
    this.diffMode = "working";
    this.compareOpenPromise = null;
    this.view = "conversation";
    this.setAttribute("data-review-view", this.view);
    this.patchDiffHeader();
  }

  resetRefreshCoordinators() {
    const generation = ++this.refreshCoordinatorGeneration;
    const setState = (state) => {
      if (generation === this.refreshCoordinatorGeneration) {
        this.setDiffRefreshState(state);
      }
    };
    this.diffRefreshCoordinator = createRefreshCoordinator(
      () => this.refreshTaskDiff(),
      setState,
    );
    this.compareRefreshCoordinator = createRefreshCoordinator(
      () => this.refreshTaskCompare(),
      setState,
    );
  }

  setView(view) {
    const nextView =
      view === "files" || (view === "diff" && this.task?.worktree)
        ? view
        : "conversation";
    if (this.view === nextView) {
      this.syncActiveView();
      return;
    }
    this.view = nextView;
    this.setAttribute("data-review-view", nextView);
    this.syncActiveView();
    this.dispatchViewChange();
  }

  setDiffMode(mode) {
    const nextMode = mode === "branch" ? "branch" : "working";
    if (this.diffMode === nextMode) {
      return;
    }
    this.diffMode = nextMode;
    this.patchDiffHeader();
    if (nextMode === "branch") {
      this.syncCompareBrowser();
    } else {
      this.syncDiffBrowser();
    }
  }

  syncActiveView() {
    const filesActive = this.active && this.view === "files";
    const diffActive = this.active && this.view === "diff";
    this.fileBrowser()?.setWatchActive(filesActive);
    if (filesActive) {
      this.syncFileBrowser();
    }
    if (diffActive) {
      this.syncDiffBrowser();
      if (this.diffMode === "branch") {
        this.syncCompareBrowser();
      }
    } else {
      this.diffRequestId += 1;
      this.unsubscribeDiffWatch();
    }
  }

  syncFileBrowser() {
    const browser = this.fileBrowser();
    const targetPath = taskFilesRootPath(this.task);
    if (!browser || !targetPath) {
      return;
    }
    browser.ensureRendered();
    browser.setStorageKey(null);
    if (!browser.hasLoadedDirectory(targetPath)) {
      browser.loadDirectory(targetPath, { allowFailure: true });
    }
  }

  syncDiffBrowser() {
    if (!this.active || this.view !== "diff") {
      this.unsubscribeDiffWatch();
      return;
    }
    const rootPath = taskWorktreeRootPath(this.task);
    const browser = this.diffBrowser();
    if (!rootPath || !browser) {
      this.unsubscribeDiffWatch();
      return;
    }

    browser.ensureRendered();
    browser.setContext({ path: rootPath, repository: this.diffStatus?.repository });
    browser.setTaskRelatedPaths(
      latestTaskRelatedWorktreePaths(this.events, this.task),
    );
    if (this.diffStatus?.repository?.rootPath === rootPath) {
      browser.setStatus(this.diffStatus, { preserveState: true });
    } else if (this.diffError) {
      browser.setError(this.diffError);
    } else {
      browser.setLoading({
        rootPath,
        branch: this.task?.worktree?.branch ?? null,
        dirty: false,
      });
      this.requestTaskDiffRefresh();
    }
    browser.viewer.setRefreshState(this.diffViewerRefreshState());
    this.subscribeDiffWatch(rootPath);
  }

  syncCompareBrowser() {
    if (
      !this.active ||
      this.view !== "diff" ||
      this.diffMode !== "branch"
    ) {
      return;
    }
    const rootPath = taskWorktreeRootPath(this.task);
    const browser = this.compareBrowser();
    if (!rootPath || !browser) {
      return;
    }

    browser.ensureRendered();
    const headRef = taskCompareHeadRef(this.task);
    const repository = this.diffStatus?.repository ?? {
      rootPath,
      branch: this.task?.worktree?.branch ?? null,
    };
    browser.setContext({ path: rootPath, repository, headRef });
    if (browser.refsPayload || this.compareOpenPromise) {
      this.patchDiffHeader();
      return;
    }
    const opening = browser.openCompare({
      path: rootPath,
      repository,
      headRef,
      preserveViewer: false,
    });
    this.compareOpenPromise = opening;
    Promise.resolve(opening).finally(() => {
      if (this.compareOpenPromise === opening) {
        this.compareOpenPromise = null;
        this.patchDiffHeader();
      }
    });
  }

  async changeCompareBase(baseRef) {
    const browser = this.compareBrowser();
    if (!browser || !baseRef) {
      return;
    }
    await browser.changeRefs(baseRef, taskCompareHeadRef(this.task));
  }

  requestTaskDiffRefresh() {
    return this.diffRefreshCoordinator.request();
  }

  requestReviewRefresh() {
    return this.diffMode === "branch"
      ? this.compareRefreshCoordinator.request()
      : this.requestTaskDiffRefresh();
  }

  async refreshTaskDiff() {
    const rootPath = taskWorktreeRootPath(this.task);
    if (!rootPath || !this.active || this.view !== "diff") {
      return null;
    }

    const requestId = ++this.diffRequestId;
    try {
      const status = await getGitStatus(rootPath);
      if (
        requestId !== this.diffRequestId ||
        !this.active ||
        this.view !== "diff" ||
        rootPath !== taskWorktreeRootPath(this.task)
      ) {
        return null;
      }
      this.diffStatus = status;
      this.diffError = null;
      const browser = this.diffBrowser();
      if (browser) {
        browser.setContext({ path: rootPath, repository: status.repository });
        browser.setStatus(status, { preserveState: true });
        browser.setTaskRelatedPaths(
          latestTaskRelatedWorktreePaths(this.events, this.task),
        );
        await browser.refreshSelectedDiff(status);
      }
      if (this.diffMode === "branch") {
        this.syncCompareBrowser();
      }
      this.patchDiffHeader();
      return status;
    } catch (error) {
      if (requestId !== this.diffRequestId) {
        return null;
      }
      this.diffError = error;
      this.diffBrowser()?.setError(error);
      this.patchDiffHeader();
      throw error;
    }
  }

  async refreshTaskCompare() {
    if (
      !this.active ||
      this.view !== "diff" ||
      this.diffMode !== "branch"
    ) {
      return null;
    }
    const browser = this.compareBrowser();
    if (!browser) {
      return null;
    }
    if (!browser.refsPayload) {
      this.syncCompareBrowser();
      return this.compareOpenPromise;
    }
    return await browser.refresh();
  }

  subscribeDiffWatch(rootPath) {
    if (
      !this.active ||
      this.view !== "diff" ||
      !rootPath ||
      (this.diffWatchPath === rootPath && this.diffWatchUnsubscribe)
    ) {
      return;
    }
    this.unsubscribeDiffWatch();
    this.diffWatchPath = rootPath;
    this.diffWatchUnsubscribe = subscribeToWatch(rootPath, {
      onReady: ({ recovered }) => {
        if (rootPath !== this.diffWatchPath) {
          return;
        }
        this.diffWatchUnavailable = false;
        this.patchDiffRefreshState();
        if (recovered) {
          this.requestTaskDiffRefresh();
        }
      },
      onChange: (change) => {
        if (rootPath !== this.diffWatchPath) {
          return;
        }
        if (change.gitStatusChanged || change.overflow) {
          this.requestTaskDiffRefresh();
        }
        if (
          (change.gitRefsChanged || change.overflow) &&
          this.diffMode === "branch"
        ) {
          this.compareRefreshCoordinator.request();
        }
      },
      onError: () => {
        if (rootPath !== this.diffWatchPath) {
          return;
        }
        this.diffWatchUnavailable = true;
        this.patchDiffRefreshState();
      },
    });
  }

  unsubscribeDiffWatch() {
    this.diffWatchUnsubscribe?.();
    this.diffWatchUnsubscribe = null;
    this.diffWatchPath = "";
    this.diffWatchUnavailable = false;
  }

  setDiffRefreshState(state) {
    this.diffRefreshState = state;
    this.patchDiffRefreshState();
  }

  diffViewerRefreshState() {
    return this.diffWatchUnavailable
      ? "unavailable"
      : this.diffRefreshState === "refreshing"
        ? "refreshing"
        : "idle";
  }

  patchTaskContext() {
    const label = this.task?.worktree
      ? `${taskWorktreeRootName(this.task)} · ${taskWorktreeRef(this.task)}`
      : this.task?.cwdPath || this.task?.cwd || "Current directory";
    const fileLabel = this.querySelector(".task-files-header p");
    if (fileLabel) {
      fileLabel.textContent = label;
    }
    this.patchDiffHeader();
  }

  patchDiffRefreshState() {
    const panel = this.diffMode === "branch" ? "branch" : "working";
    this.querySelector(
      `.task-diff-panel[data-task-diff-panel="${panel}"] caffold-review-file-viewer`,
    )?.setRefreshState(this.diffViewerRefreshState());
    const button = this.querySelector(
      '.task-diff-header [data-task-review-action="refresh"]',
    );
    if (!button) {
      return;
    }
    button.classList.toggle("is-refreshing", this.diffRefreshState === "refreshing");
    button.classList.toggle("is-unavailable", this.diffWatchUnavailable);
    const label = this.diffWatchUnavailable
      ? "Live updates unavailable. Refresh manually."
      : this.reviewRefreshLabel();
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  patchDiffHeader() {
    const view = this.querySelector(".task-diff-view");
    if (!view) {
      return;
    }
    view.dataset.taskDiffMode = this.diffMode;
    for (const button of view.querySelectorAll("button[data-diff-mode]")) {
      button.setAttribute(
        "aria-pressed",
        button.dataset.diffMode === this.diffMode ? "true" : "false",
      );
    }
    const subtitle = view.querySelector(".task-diff-subtitle");
    if (subtitle) {
      subtitle.textContent = this.diffSubtitle();
    }
    const compareBrowser = this.compareBrowser();
    const baseSelect = view.querySelector("select[data-task-compare-base]");
    if (baseSelect) {
      const refs = compareBrowser?.refsPayload?.refs ?? [];
      baseSelect.innerHTML = refs.length
        ? renderCompareRefOptions(refs, compareBrowser.baseRef)
        : `<option value="">Loading refs...</option>`;
      baseSelect.disabled = refs.length === 0;
      if (compareBrowser?.baseRef) {
        baseSelect.value = compareBrowser.baseRef;
      }
    }
    const head = view.querySelector("[data-task-compare-head]");
    if (head) {
      head.textContent = taskCompareHeadRef(this.task);
      head.title = taskCompareHeadRef(this.task);
    }
    this.patchDiffRefreshState();
  }

  patchRefreshIcon() {
    const button = this.querySelector(
      '.task-diff-header [data-task-review-action="refresh"]',
    );
    if (button) {
      button.innerHTML = renderInlineIcon(
        "RefreshCw",
        this.reviewRefreshLabel(),
        "task-refresh-icon",
      );
    }
  }

  diffSubtitle() {
    if (this.diffMode === "branch") {
      const compare = this.compareBrowser()?.compare;
      if (!compare) {
        return `${taskCompareHeadRef(this.task)} · Loading comparison`;
      }
      const count = compare.files?.length ?? 0;
      return `${compare.baseRef}...${compare.headRef} · ${count} ${count === 1 ? "file" : "files"} · +${compare.additions} -${compare.deletions}`;
    }
    const count = this.diffStatus?.files?.length ?? 0;
    const stats = this.diffStatus
      ? `${count} ${count === 1 ? "file" : "files"} · +${this.diffStatus.additions} -${this.diffStatus.deletions}`
      : "Loading changes";
    return `${taskWorktreeRef(this.task)} · ${stats}`;
  }

  reviewRefreshLabel() {
    return this.diffMode === "branch"
      ? "Refresh branch comparison"
      : "Refresh task diff";
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-task-review-action]");
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    if (action.dataset.taskReviewAction === "select-diff-mode") {
      this.setDiffMode(action.dataset.diffMode);
    } else if (action.dataset.taskReviewAction === "refresh") {
      this.requestReviewRefresh();
    }
  }

  handleChange(event) {
    const select = closestElement(event.target, "select[data-task-compare-base]");
    if (!select || !this.contains(select)) {
      return;
    }
    event.stopPropagation();
    this.changeCompareBase(select.value);
  }

  dispatchViewChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:task-review-view-change", {
        bubbles: true,
        composed: true,
        detail: { view: this.view },
      }),
    );
  }

  fileBrowser() {
    return this.querySelector(".task-files-view caffold-file-browser");
  }

  diffBrowser() {
    return this.querySelector(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-git-diff-browser',
    );
  }

  compareBrowser() {
    return this.querySelector(
      '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
    );
  }
}

if (!customElements.get("caffold-task-review")) {
  customElements.define("caffold-task-review", CaffoldTaskReview);
}

function reviewContextKey(task) {
  if (!task) {
    return "";
  }
  return [
    taskThreadId(task),
    taskWorktreeRootPath(task),
    taskFilesRootPath(task),
  ].join("\u0000");
}

function taskFilesRootPath(task) {
  const path = `${
    task?.worktree?.rootPath || task?.cwdPath || task?.cwd || ""
  }`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function taskWorktreeRef(task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  return branch || shortId(task?.worktree?.headSha ?? "");
}

function taskCompareHeadRef(task) {
  return task?.worktree?.branch || "HEAD";
}

function renderCompareRefOptions(refs, selectedRef) {
  return refs
    .map((ref) => {
      const name = `${ref?.name ?? ""}`;
      if (!name) {
        return "";
      }
      const selected = name === selectedRef ? " selected" : "";
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    })
    .join("");
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
