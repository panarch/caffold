import { fetchGitRemote, getGitLog } from "../../../../../../api.js";
import "./commit/page.js";
import "./list/page.js";
import { emptyActionHintScope } from "../../../../action-hints.js";

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
    this.fetchState ??= { status: "idle" };
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
    this.invalidateRequests();
    this.clearFetchState();
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

  invalidateRequests() {
    this.ensureRendered();
    this.logRequestId += 1;
    this.fetchState = transitionFetchState(this.fetchState, { type: "cancel" });
    this.commitPage.invalidateRequests();
  }

  clearFetchState() {
    this.fetchState = transitionFetchState(this.fetchState, { type: "clear" });
  }

  async fetchRemote() {
    if (!this.repository) {
      return null;
    }

    const pending = transitionFetchState(this.fetchState, { type: "start" });
    if (pending === this.fetchState) {
      return null;
    }
    this.fetchState = pending;
    this.emitStateChange();
    try {
      const result = await fetchGitRemote(this.currentPath);
      if (!this.settleFetch(pending, { type: "resolve", result })) {
        return null;
      }
      return result;
    } catch (error) {
      this.settleFetch(pending, { type: "reject", error });
      return null;
    }
  }

  settleFetch(pending, event) {
    const next = transitionFetchState(this.fetchState, { ...event, pending });
    if (next === this.fetchState) {
      return false;
    }

    this.fetchState = next;
    this.emitStateChange();
    return true;
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
    if (nextPage === this.loadedPage()) {
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

  prepareRoute(route) {
    this.ensureRendered();
    this.page = normalizePage(route?.page ?? this.page);
    if (route?.sha) {
      this.setView("detail");
      this.commitPage.prepareRoute({
        currentPath: this.currentPath,
        repository: this.repository,
        sha: route.sha,
        path: route.path,
      });
      this.detailView = this.commitPage.detailView;
    } else {
      this.setView("list");
      this.setDetailView("list");
      this.commitPage.prepareForList();
    }
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
      nextRepository?.rootPath !== this.repository?.rootPath ||
      nextRepository?.branch !== this.repository?.branch;

    this.currentPath = nextPath;
    this.repository = nextRepository;

    if (contextChanged) {
      this.logRequestId += 1;
      this.clearFetchState();
      this.log = null;
      this.commitPage.reset();
    }
  }

  async loadLog(page = this.page, options = {}) {
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

      const branchChanged = log.repository?.branch !== this.repository?.branch;
      this.page = log.page ?? nextPage;
      this.repository = log.repository;
      if (branchChanged) {
        this.clearFetchState();
      }
      this.log = log;
      if (options.preserveState) {
        this.list.updateLog(log);
      } else {
        this.list.setLog(log);
      }
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

  async refresh() {
    if (this.view === "detail") {
      return await this.commitPage.refresh();
    }
    return await this.loadLog(this.page, { preserveState: true });
  }

  canReuseRoute(page, sha) {
    if (!sha) {
      return Boolean(this.log) && normalizePage(page ?? 1) === this.loadedPage();
    }

    return this.commitPage.canReuse(sha);
  }

  loadedPage() {
    return normalizePage(this.log?.page ?? 1);
  }

  currentCommitSha() {
    return this.commitPage.currentCommitSha();
  }

  actionHintScope({ scopeId = "git:log", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (this.hidden) {
      return emptyActionHintScope();
    }
    return this.view === "detail"
      ? this.commitPage.actionHintScope({
          scopeId: `${scopeId}:commit`,
          clipRoots: [this, ...clipRoots],
        })
      : this.list.actionHintScope({
          scopeId: `${scopeId}:list:${this.page}`,
          clipRoots: [this, ...clipRoots],
        });
  }

  keyboardNavigationContexts({ scopeId = "git:log" } = {}) {
    this.ensureRendered();
    return !this.hidden && this.view === "detail"
      ? this.commitPage.keyboardNavigationContexts({
          scopeId: `${scopeId}:commit`,
        })
      : [];
  }

  deactivate() {
    this.ensureRendered();
    this.commitPage.deactivate();
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

  logSubtitleParts() {
    const repository = this.log?.repository ?? this.repository;
    if (!repository) {
      return { branch: "", relationship: "", count: "" };
    }
    const count = this.log?.totalCommits;
    const countLabel = count === undefined
      ? ""
      : `${count} ${count === 1 ? "commit" : "commits"}`;
    return {
      branch: repository.branch ?? "HEAD",
      relationship: fetchRelationship(this.fetchState),
      count: countLabel,
    };
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

function fetchRelationship(state) {
  if (state?.status === "error") {
    return "Remote unavailable";
  }
  const result = state?.status === "ready"
    ? state.result
    : state?.status === "fetching" && state.previous?.status === "ready"
      ? state.previous.result
      : null;
  if (!result) {
    return "";
  }

  const branch = result.branch || "remote default";
  const ahead = Number(result.ahead ?? 0);
  const behind = Number(result.behind ?? 0);
  if (ahead === 0 && behind === 0) {
    return `Up to date with ${branch}`;
  }
  if (ahead > 0 && behind > 0) {
    return `${ahead} ahead, ${behind} behind ${branch}`;
  }
  if (ahead > 0) {
    return `${ahead} ahead of ${branch}`;
  }
  return `${behind} behind ${branch}`;
}

function transitionFetchState(state, event) {
  const current = state ?? { status: "idle" };
  if (event.type === "clear") {
    return { status: "idle" };
  }
  if (event.type === "cancel") {
    return current.status === "fetching"
      ? current.previous ?? { status: "idle" }
      : current;
  }
  if (event.type === "start") {
    return current.status === "fetching"
      ? current
      : {
          status: "fetching",
          previous: current.status === "ready" ? current : null,
        };
  }
  if (current !== event.pending || current.status !== "fetching") {
    return current;
  }
  if (event.type === "resolve") {
    return { status: "ready", result: event.result };
  }
  if (event.type === "reject") {
    return { status: "error", error: event.error };
  }
  return current;
}
