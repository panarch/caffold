import { getGitLog } from "../../../../api.js";
import "./commit/page.js";
import "./list/page.js";

const LOADING_DELAY_MS = 180;

class CaffoldGitLogLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-git-log-list-page></caffold-git-log-list-page>
      <caffold-git-log-commit-page></caffold-git-log-commit-page>
    `;
    this.list = this.querySelector("caffold-git-log-list-page");
    this.commitPage = this.querySelector("caffold-git-log-commit-page");
    this.logRequestId ??= 0;
    this.page ??= 1;
    this.view ??= "list";
    this.detailView ??= "list";
    this.commitPage.addEventListener("caffold:git-log-commit-state-change", () => {
      this.detailView = this.commitPage.detailView;
      this.emitStateChange();
    });
  }

  reset() {
    this.ensureRendered();
    this.logRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.log = null;
    this.page = 1;
    this.setView("list");
    this.setDetailView("list");
    this.list.reset();
    this.commitPage.reset();
    this.emitStateChange();
  }

  async openList(options = {}) {
    this.setContext(options);
    if (!options.skipReload) {
      this.page = normalizePage(options.page ?? this.page);
    }
    this.setView("list");
    this.setDetailView("list");
    this.commitPage.prepareForList();
    this.emitStateChange();

    if (options.skipReload) {
      return this.log;
    }

    return await this.loadLog(this.page);
  }

  async changePage(page) {
    if (this.view !== "list") {
      return null;
    }

    const nextPage = normalizePage(page);
    if (nextPage === this.page) {
      return null;
    }

    return await this.loadLog(nextPage);
  }

  async openCommit(sha, options = {}) {
    this.setContext(options);
    if (!sha || !this.repository) {
      return null;
    }

    this.page = normalizePage(options.page ?? this.page);
    this.setView("detail");
    const commit = await this.commitPage.openCommit({
      currentPath: this.currentPath,
      repository: this.repository,
      sha,
      page: this.page,
      skipReload: options.skipReload,
      preserveViewer: options.preserveViewer,
    });
    this.detailView = this.commitPage.detailView;
    this.emitStateChange();
    return commit;
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return null;
    }

    this.setView("detail");
    const diff = await this.commitPage.openDiff({
      currentPath: this.currentPath,
      sha,
      path,
      status,
    });
    this.detailView = this.commitPage.detailView;
    this.emitStateChange();
    return diff;
  }

  showCommitFileList() {
    this.commitPage.showFileList();
    this.detailView = this.commitPage.detailView;
    this.emitStateChange();
  }

  backToList() {
    if (this.view === "list") {
      return false;
    }

    this.setView("list");
    this.setDetailView("list");
    this.commitPage.prepareForList();
    this.emitStateChange();
    return true;
  }

  setContext({ path, repository }) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;

    if (contextChanged) {
      this.logRequestId += 1;
      this.log = null;
      this.commitPage.reset();
    }
  }

  async loadLog(page = this.page) {
    if (!this.repository) {
      return null;
    }

    const nextPage = normalizePage(page);
    const requestId = ++this.logRequestId;
    const loadingTimer = this.showLogLoadingAfterDelay(requestId);

    try {
      const log = await getGitLog(this.currentPath, nextPage);
      if (requestId !== this.logRequestId) {
        return null;
      }

      this.page = log.page ?? nextPage;
      this.repository = log.repository;
      this.log = log;
      this.list.setLog(log);
      this.emitStateChange();
      return log;
    } catch (error) {
      if (requestId !== this.logRequestId) {
        return null;
      }

      this.list.setError(error, this.repository);
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  canReuseRoute(page, sha) {
    if (!sha) {
      return Boolean(this.log) && normalizePage(page ?? this.page) === this.page;
    }

    return this.commitPage.canReuse(sha);
  }

  findCommitFile(path) {
    return this.commitPage.findFile(path);
  }

  setSelectedPath(path) {
    this.commitPage.setSelectedPath(path);
  }

  isFileViewer(target) {
    return this.commitPage.isFileViewer(target);
  }

  commitSubtitle() {
    return this.commitPage.commitSubtitle();
  }

  setView(view) {
    this.ensureRendered();
    this.view = view === "detail" ? "detail" : "list";
    this.dataset.logView = this.view;
  }

  setDetailView(view) {
    this.ensureRendered();
    this.commitPage.setDetailView(view);
    this.detailView = this.commitPage.detailView;
  }

  showLogLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.logRequestId) {
        this.list.setLoading(this.repository);
      }
    }, LOADING_DELAY_MS);
  }

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:git-log-state-change", {
        bubbles: true,
        detail: {
          view: this.view,
          detailView: this.detailView,
          page: this.page,
        },
      }),
    );
  }
}

customElements.define("caffold-git-log-layout", CaffoldGitLogLayout);

function normalizePage(page) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
