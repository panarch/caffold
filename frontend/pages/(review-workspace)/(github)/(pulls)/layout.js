import {
  getGitHubPull,
  getGitHubPullFile,
  getGitHubPullFiles,
  getGitHubPulls,
} from "../../../../api.js";
import "./list/page.js";
import "./detail/page.js";
import "./files/page.js";

const GITHUB_PULLS_PER_PAGE = 50;
const LOADING_DELAY_MS = 180;

class CaffoldGithubPullsLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (!this.dataset.pullsView) {
      this.setView("list");
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-github-pulls-list-page></caffold-github-pulls-list-page>
      <caffold-github-pull-detail-page></caffold-github-pull-detail-page>
      <caffold-github-pull-files-page></caffold-github-pull-files-page>
    `;
    this.listPage = this.querySelector("caffold-github-pulls-list-page");
    this.detailPage = this.querySelector("caffold-github-pull-detail-page");
    this.filesPage = this.querySelector("caffold-github-pull-files-page");
    this.filesPage.ensureRendered();
    this.fileViewer = this.filesPage.querySelector("caffold-review-file-viewer");
    this.fileViewer.setCloseLabel("Back to PR files");
    this.pullListRequestId ??= 0;
    this.pullDetailRequestId ??= 0;
    this.pullFilesRequestId ??= 0;
    this.pullFileRequestId ??= 0;
    this.page ??= 1;
    this.view ??= "list";
    this.filesView ??= "list";
    this.scrollPositions ??= {};
  }

  setView(view) {
    this.ensureRendered();
    this.view = normalizePullsView(view);
    this.dataset.pullsView = this.view;
  }

  setFilesView(view) {
    this.ensureRendered();
    this.filesView = normalizeDetailView(view);
    this.filesPage.dataset.detailView = this.filesView;
  }

  reset() {
    this.ensureRendered();
    this.pullListRequestId += 1;
    this.pullDetailRequestId += 1;
    this.pullFilesRequestId += 1;
    this.pullFileRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.githubStatus = null;
    this.pulls = null;
    this.pullFiles = null;
    this.page = 1;
    this.selectedPullSummary = null;
    this.setView("list");
    this.setFilesView("list");
    this.listPage.reset();
    this.detailPage.setEmpty();
    this.filesPage.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  async openList(options = {}) {
    this.setContext(options);
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary = null;
    this.setView("list");
    this.setFilesView("list");
    this.listPage.setSelectedPull(null);
    this.detailPage.setEmpty();
    this.filesPage.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();

    if (options.skipReload) {
      return this.pulls;
    }

    if (!this.githubStatus) {
      this.listPage.setLoading(null);
      return null;
    }

    if (!this.pullsAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }

    return await this.loadPulls(this.page);
  }

  async setGithubStatus(status) {
    this.githubStatus = status ?? null;
    if (!this.githubStatus) {
      return null;
    }

    if (!this.pullsAvailable()) {
      this.pullListRequestId += 1;
      this.pullDetailRequestId += 1;
      this.pullFilesRequestId += 1;
      this.pullFileRequestId += 1;
      this.listPage.setUnavailable(this.githubStatus);
      this.detailPage.setEmpty();
      this.filesPage.setError(
        new Error(this.githubStatus.message ?? "GitHub pull requests are unavailable."),
        this.repository,
      );
      this.fileViewer.setEmpty();
      this.emitStateChange();
      return null;
    }

    if (this.view === "list" && !this.pulls) {
      return await this.loadPulls(this.page);
    }

    this.emitStateChange();
    return null;
  }

  async changePage(page) {
    if (this.view !== "list") {
      return null;
    }

    const nextPage = normalizePage(page);
    if (nextPage === this.page) {
      return null;
    }

    this.page = nextPage;
    return await this.loadPulls(nextPage);
  }

  async openPull(number, options = {}) {
    const pullNumber = Number.parseInt(`${number ?? ""}`, 10);
    if (!this.repository || !Number.isFinite(pullNumber)) {
      return null;
    }

    if (!this.pullsAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }

    const requestId = ++this.pullDetailRequestId;
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary =
      this.pulls?.pulls?.find((pull) => pull.number === pullNumber) ?? {
        number: pullNumber,
      };
    this.setView("detail");
    this.setFilesView("list");
    this.listPage.setSelectedPull(pullNumber);
    this.detailPage.setLoading(pullNumber);
    this.filesPage.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();

    try {
      const pull = await getGitHubPull(this.currentPath, pullNumber);
      if (requestId !== this.pullDetailRequestId) {
        return null;
      }

      this.detailPage.setPull(pull);
      this.selectedPullSummary = pull.pull;
      this.emitStateChange();
      return pull;
    } catch (error) {
      if (requestId !== this.pullDetailRequestId) {
        return null;
      }

      this.detailPage.setError(pullNumber, error);
      this.emitStateChange();
      return null;
    }
  }

  async openFiles(number, options = {}) {
    const pullNumber = Number.parseInt(`${number ?? ""}`, 10);
    if (!this.repository || !Number.isFinite(pullNumber)) {
      return null;
    }

    if (!this.pullsAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }

    const requestId = ++this.pullFilesRequestId;
    const viewerRequestId = ++this.pullFileRequestId;
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary =
      this.selectedPullSummary?.number === pullNumber
        ? this.selectedPullSummary
        : (this.pulls?.pulls?.find((pull) => pull.number === pullNumber) ?? {
            number: pullNumber,
          });
    this.setView("files");
    this.setFilesView("list");
    this.listPage.setSelectedPull(pullNumber);
    if (!options.skipReload) {
      this.filesPage.setLoading(this.repository, pullNumber);
    }
    if (!options.preserveViewer && viewerRequestId === this.pullFileRequestId) {
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();

    if (options.skipReload) {
      return this.pullFiles;
    }

    try {
      const files = await getGitHubPullFiles(this.currentPath, pullNumber);
      if (requestId !== this.pullFilesRequestId) {
        return null;
      }

      this.pullFiles = files;
      this.filesPage.setFiles(files);
      if (viewerRequestId === this.pullFileRequestId && !options.preserveViewer) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return files;
    } catch (error) {
      if (requestId !== this.pullFilesRequestId) {
        return null;
      }

      this.filesPage.setError(error, this.repository);
      if (viewerRequestId === this.pullFileRequestId) {
        this.fileViewer.setError(`PR #${pullNumber}`, error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openFile(path, status = "") {
    const number = this.currentPullNumber();
    if (!number || !path) {
      return null;
    }

    const requestId = ++this.pullFileRequestId;
    this.filesPage.setSelectedPath(path);
    this.rememberScroller("pull-files", this.filesPage, ".github-pull-files-list");
    this.setView("files");
    this.setFilesView("viewer");
    this.emitStateChange();
    const loadingTimer = this.showFileLoadingAfterDelay(path, requestId);

    try {
      const diff = await getGitHubPullFile(this.currentPath, number, path);
      if (requestId !== this.pullFileRequestId) {
        return null;
      }

      if (diff.diffUnavailable) {
        this.fileViewer.setError(path, new Error(diff.message ?? "Diff unavailable."));
      } else {
        this.fileViewer.setDiff({ ...diff, status });
      }
      return diff;
    } catch (error) {
      if (requestId !== this.pullFileRequestId) {
        return null;
      }

      this.fileViewer.setError(path, error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showFilesList() {
    this.setFilesView("list");
    this.filesPage.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.restoreScroller("pull-files", this.filesPage, ".github-pull-files-list");
    this.emitStateChange();
  }

  back() {
    if (this.view === "detail") {
      this.pullDetailRequestId += 1;
      this.selectedPullSummary = null;
      this.setView("list");
      this.setFilesView("list");
      this.listPage.setSelectedPull(null);
      this.detailPage.setEmpty();
      this.emitStateChange();
      return true;
    }

    if (this.view === "files") {
      if (this.filesView === "viewer") {
        this.pullFileRequestId += 1;
        this.showFilesList();
        return true;
      }

      this.pullFilesRequestId += 1;
      this.setView("detail");
      this.setFilesView("list");
      this.filesPage.reset();
      this.fileViewer.setEmpty();
      this.emitStateChange();
      return true;
    }

    return false;
  }

  backToList() {
    if (this.view === "list") {
      return false;
    }

    this.pullDetailRequestId += 1;
    this.pullFilesRequestId += 1;
    this.pullFileRequestId += 1;
    this.selectedPullSummary = null;
    this.setView("list");
    this.setFilesView("list");
    this.listPage.setSelectedPull(null);
    this.detailPage.setEmpty();
    this.filesPage.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
    return true;
  }

  setContext(options = {}) {
    this.ensureRendered();
    const { path, repository, githubStatus } = options;
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.githubStatus = Object.prototype.hasOwnProperty.call(options, "githubStatus")
      ? githubStatus
      : (this.githubStatus ?? null);

    if (contextChanged) {
      this.pullListRequestId += 1;
      this.pullDetailRequestId += 1;
      this.pullFilesRequestId += 1;
      this.pullFileRequestId += 1;
      this.pulls = null;
      this.pullFiles = null;
      this.selectedPullSummary = null;
      this.scrollPositions = {};
    }
  }

  async loadPulls(page = this.page) {
    if (!this.repository || !this.pullsAvailable()) {
      return null;
    }

    const nextPage = normalizePage(page);
    const requestId = ++this.pullListRequestId;
    const loadingTimer = this.showPullsLoadingAfterDelay(requestId);

    try {
      const pulls = await getGitHubPulls(
        this.currentPath,
        "open",
        nextPage,
        GITHUB_PULLS_PER_PAGE,
      );
      if (requestId !== this.pullListRequestId) {
        return null;
      }

      this.page = pulls.page ?? nextPage;
      this.pulls = pulls;
      this.listPage.setPulls(pulls);
      if (this.view === "list") {
        this.selectedPullSummary = null;
        this.detailPage.setEmpty();
        this.filesPage.reset();
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return pulls;
    } catch (error) {
      if (requestId !== this.pullListRequestId) {
        return null;
      }

      this.listPage.setError(error, this.githubStatus);
      this.detailPage.setEmpty();
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  pullsAvailable() {
    return Boolean(this.githubStatus?.github && this.githubStatus?.pullsAvailable);
  }

  canReuseList(page) {
    return Boolean(this.pulls) && normalizePage(page ?? this.page) === this.page;
  }

  canReuseFiles(number) {
    return this.pullFiles?.number === Number.parseInt(`${number ?? ""}`, 10);
  }

  findFile(path) {
    return this.pullFiles?.files?.find((entry) => entry.path === path) ?? null;
  }

  currentPullNumber() {
    return this.selectedPullSummary?.number ?? this.pullFiles?.number ?? null;
  }

  isFileViewer(target) {
    return target === this.fileViewer;
  }

  pullsSubtitle() {
    if (!this.githubStatus?.github) {
      return "GitHub";
    }

    const count = this.pulls?.totalPulls;
    const countLabel = count === undefined ? "" : ` · ${count} PRs`;
    return `${this.githubStatus.github.nameWithOwner}${countLabel}`;
  }

  pullSubtitle() {
    const pull = this.selectedPullSummary;
    if (!pull) {
      return "";
    }

    const number = pull.number === undefined ? "" : `#${pull.number}`;
    const title = pull.title ?? "";
    return [number, title].filter(Boolean).join(" ");
  }

  rememberScroller(key, host, selector) {
    const scroller = host?.querySelector(selector);
    if (!scroller) {
      return;
    }

    this.scrollPositions[key] = scroller.scrollTop;
  }

  restoreScroller(key, host, selector) {
    const top = this.scrollPositions[key] ?? 0;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = host?.querySelector(selector);
      if (!scroller) {
        return;
      }

      scroller.scrollTop = top;
      window.requestAnimationFrame(() => {
        if (scroller.scrollTop < top - 32) {
          scroller.scrollTop = top;
        }
      });
    });
  }

  showPullsLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.pullListRequestId) {
        this.listPage.setLoading(this.githubStatus, this.pulls, this.page);
      }
    }, LOADING_DELAY_MS);
  }

  showFileLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.pullFileRequestId) {
        this.fileViewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:github-pulls-state-change", {
        bubbles: true,
        detail: {
          view: this.view,
          filesView: this.filesView,
          page: this.page,
        },
      }),
    );
  }
}

customElements.define("caffold-github-pulls-layout", CaffoldGithubPullsLayout);

function normalizePullsView(view) {
  return view === "detail" || view === "files" ? view : "list";
}

function normalizeDetailView(view) {
  return view === "viewer" ? "viewer" : "list";
}

function normalizePage(page) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
