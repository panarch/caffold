import { html, LitElement } from "lit";
import {
  type ActionHintScopeOptions,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import {
  fetchGitRemote,
  type GitFetchResult,
  type GitLog,
  type GitRepository,
  getGitLog,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "./commit/page.ts";
import type { CaffoldGitLogCommitPage } from "./commit/page.ts";
import "./list/page.ts";
import type { CaffoldGitLogListPage } from "./list/page.ts";

const LOADING_DELAY_MS = 180;

type LogView = "list" | "detail";

type ReadyFetch = { status: "ready"; result: GitFetchResult };

// How far fetching the remote default branch has come. A fetch in flight
// keeps the result it would replace so the header can still name it.
export type FetchState =
  | { status: "idle" }
  | { status: "fetching"; previous: ReadyFetch | null }
  | ReadyFetch
  | { status: "error"; error: Error };

type FetchEvent =
  | { type: "clear" }
  | { type: "cancel" }
  | { type: "start" }
  | { type: "resolve"; pending: FetchState; result: GitFetchResult }
  | { type: "reject"; pending: FetchState; error: Error };

export class CaffoldGitLogLayout extends LitElement {
  // What the Git layout reads back.
  repository: GitRepository | null = null;
  fetchState: FetchState = { status: "idle" };
  page = 1;
  view: LogView = "list";
  detailView: "list" | "viewer" = "list";
  private currentPath = "";
  private log: GitLog | null = null;
  private logRequestId = 0;

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <caffold-git-log-list-page></caffold-git-log-list-page>
      <caffold-git-log-commit-page
        @caffold:git-log-commit-state-change=${this.followCommitPage}
      ></caffold-git-log-commit-page>
    `;
  }

  reset() {
    this.invalidateRequests();
    this.fetchState = transitionFetchState(this.fetchState, { type: "clear" });
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
    this.logRequestId += 1;
    this.fetchState = transitionFetchState(this.fetchState, { type: "cancel" });
    this.commitPage.invalidateRequests();
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
      if (!this.settleFetch({ type: "resolve", pending, result })) {
        return null;
      }
      return result;
    } catch (error) {
      this.settleFetch({ type: "reject", pending, error: error as Error });
      return null;
    }
  }

  async openList(
    options: {
      path?: string;
      repository?: GitRepository | null;
      page?: number;
      skipReload?: boolean;
    } = {},
  ) {
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

  async openCommit(
    sha: string,
    options: {
      path?: string;
      repository?: GitRepository | null;
      page?: number;
      skipReload?: boolean;
      preserveViewer?: boolean;
    } = {},
  ) {
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
      skipReload: options.skipReload,
      preserveViewer: options.preserveViewer,
    });
    this.detailView = this.commitPage.detailView;
    this.emitStateChange();
    return commit;
  }

  async openCommitDiff(sha: string, path: string, status = "") {
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

  prepareRoute(route: { page?: number; sha?: string; path?: string } | null) {
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

  setContext({
    path,
    repository,
  }: {
    path?: string;
    repository?: GitRepository | null;
  }) {
    const nextPath = path ?? this.currentPath;
    const nextRepository = repository ?? this.repository;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath ||
      nextRepository?.branch !== this.repository?.branch;
    this.currentPath = nextPath;
    this.repository = nextRepository;
    if (contextChanged) {
      this.logRequestId += 1;
      this.fetchState = transitionFetchState(this.fetchState, {
        type: "clear",
      });
      this.log = null;
      this.commitPage.reset();
    }
  }

  async refresh() {
    if (this.view === "detail") {
      return await this.commitPage.refresh();
    }
    return await this.loadLog(this.page, { preserveState: true });
  }

  currentCommitSha() {
    return this.commitPage.currentCommitSha();
  }

  sidePane() {
    return !this.hidden && this.view === "detail"
      ? this.commitPage.sidePane()
      : null;
  }

  actionHintScope({
    scopeId = "git:log",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
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

  scrollSurfaceScope({
    scopeId = "git:log",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}) {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return this.view === "detail"
      ? this.commitPage.scrollSurfaceScope({
          scopeId: `${scopeId}:commit`,
          clipRoots: [this, ...clipRoots],
        })
      : this.list.scrollSurfaceScope({
          scopeId: `${scopeId}:list:${this.page}`,
          clipRoots: [this, ...clipRoots],
        });
  }

  keyboardNavigationContexts({ scopeId = "git:log" } = {}) {
    return !this.hidden && this.view === "detail"
      ? this.commitPage.keyboardNavigationContexts({
          scopeId: `${scopeId}:commit`,
        })
      : [];
  }

  deactivate() {
    this.commitPage.deactivate();
  }

  findCommitFile(path: string) {
    return this.commitPage.findFile(path);
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
    return {
      branch: repository.branch ?? "HEAD",
      relationship: fetchRelationship(this.fetchState),
      count:
        count === undefined
          ? ""
          : `${count} ${count === 1 ? "commit" : "commits"}`,
    };
  }

  private followCommitPage(event: Event) {
    event.stopPropagation();
    this.detailView = this.commitPage.detailView;
    this.emitStateChange();
  }

  private settleFetch(event: FetchEvent) {
    const next = transitionFetchState(this.fetchState, event);
    if (next === this.fetchState) {
      return false;
    }
    this.fetchState = next;
    this.emitStateChange();
    return true;
  }

  private async loadLog(
    page = this.page,
    { preserveState = false }: { preserveState?: boolean } = {},
  ) {
    if (!this.repository) {
      return null;
    }
    const nextPage = normalizePage(page);
    const requestId = ++this.logRequestId;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.logRequestId) {
        this.list.setLoading();
      }
    }, LOADING_DELAY_MS);

    try {
      const log = await getGitLog(this.currentPath, nextPage);
      if (requestId !== this.logRequestId) {
        return null;
      }
      const branchChanged = log.repository?.branch !== this.repository?.branch;
      this.page = log.page ?? nextPage;
      this.repository = log.repository;
      if (branchChanged) {
        this.fetchState = transitionFetchState(this.fetchState, {
          type: "clear",
        });
      }
      this.log = log;
      if (preserveState) {
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
      this.list.setError(error as Error);
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  private setView(view: LogView) {
    this.view = view;
    this.dataset.logView = view;
  }

  private setDetailView(view: "list" | "viewer") {
    this.commitPage.setDetailView(view);
    this.detailView = this.commitPage.detailView;
  }

  private emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:git-log-state-change", { bubbles: true }),
    );
  }

  // The pages are drawn the first time one is needed, which can be before
  // the layout is in the document.
  private get list() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-git-log-list-page",
    ) as CaffoldGitLogListPage;
  }

  private get commitPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-git-log-commit-page",
    ) as CaffoldGitLogCommitPage;
  }
}

customElements.define("caffold-git-log-layout", CaffoldGitLogLayout);

function normalizePage(page: number | string | null | undefined) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function fetchRelationship(state: FetchState) {
  if (state.status === "error") {
    return "Remote unavailable";
  }
  const result =
    state.status === "ready"
      ? state.result
      : state.status === "fetching"
        ? (state.previous?.result ?? null)
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

function transitionFetchState(
  current: FetchState,
  event: FetchEvent,
): FetchState {
  if (event.type === "clear") {
    return { status: "idle" };
  }
  if (event.type === "cancel") {
    return current.status === "fetching"
      ? (current.previous ?? { status: "idle" })
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
  return event.type === "resolve"
    ? { status: "ready", result: event.result }
    : { status: "error", error: event.error };
}
