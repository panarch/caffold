import { html, LitElement } from "lit";
import {
  type ActionHintScopeOptions,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import {
  type GitHubPulls,
  type GitHubStatus,
  type GitRepository,
  getGitHubPull,
  getGitHubPulls,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "./detail/page.ts";
import type { CaffoldGithubPullDetailPage } from "./detail/page.ts";
import "./files/page.ts";
import type { CaffoldGithubPullFilesPage } from "./files/page.ts";
import "./list/page.ts";
import type { CaffoldGithubPullsListPage } from "./list/page.ts";

const GITHUB_PULLS_PER_PAGE = 50;
const LOADING_DELAY_MS = 180;

type PullsView = "list" | "detail" | "files";

interface GithubContext {
  path?: string;
  repository?: GitRepository | null;
  githubStatus?: GitHubStatus | null;
}

export class CaffoldGithubPullsLayout extends LitElement {
  // What the GitHub layout reads back.
  page = 1;
  view: PullsView = "list";
  private currentPath = "";
  private repository: GitRepository | null = null;
  private githubStatus: GitHubStatus | null = null;
  private pulls: GitHubPulls | null = null;
  private selectedPullSummary: { number: number; title?: string } | null = null;
  private pullListRequestId = 0;
  private pullDetailRequestId = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this.dataset.pullsView) {
      this.setView("list");
    }
  }

  render() {
    return html`
      <caffold-github-pulls-list-page></caffold-github-pulls-list-page>
      <caffold-github-pull-detail-page></caffold-github-pull-detail-page>
      <caffold-github-pull-files-page
        @caffold:github-pull-files-state-change=${this.followFilesPage}
      ></caffold-github-pull-files-page>
    `;
  }

  get filesView() {
    return this.filesPage.detailView;
  }

  reset() {
    this.pullListRequestId += 1;
    this.pullDetailRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.githubStatus = null;
    this.pulls = null;
    this.page = 1;
    this.selectedPullSummary = null;
    this.setView("list");
    this.listPage.reset();
    this.detailPage.setEmpty();
    this.filesPage.reset();
    this.emitStateChange();
  }

  invalidateRequests() {
    this.pullListRequestId += 1;
    this.pullDetailRequestId += 1;
    this.filesPage.invalidateRequests();
  }

  async openList(
    options: GithubContext & { page?: number; skipReload?: boolean } = {},
  ) {
    this.setContext(options);
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary = null;
    this.setView("list");
    this.listPage.setSelectedPull(null);
    this.detailPage.setEmpty();
    this.filesPage.reset();
    this.emitStateChange();
    if (options.skipReload) {
      if (this.pulls) {
        this.listPage.setPulls(this.pulls);
      }
      return this.pulls;
    }
    if (!this.githubStatus) {
      this.listPage.setLoading();
      return null;
    }
    if (!this.pullsAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }
    return await this.loadPulls(this.page);
  }

  setGithubStatus(status: GitHubStatus | null) {
    this.githubStatus = status;
    if (this.githubStatus && !this.pullsAvailable()) {
      this.pullListRequestId += 1;
      this.pullDetailRequestId += 1;
      const error = new Error(
        this.githubStatus.message ?? "GitHub pull requests are unavailable.",
      );
      if (this.view === "detail") {
        this.detailPage.setError(this.currentPullNumber(), error);
      } else if (this.view === "files") {
        this.filesPage.setError(error, {
          preserveView: this.filesPage.detailView === "viewer",
        });
      } else {
        this.listPage.setUnavailable(this.githubStatus);
        this.detailPage.setEmpty();
        this.filesPage.setError(error);
        this.filesPage.clearViewer();
      }
    }
    this.emitStateChange();
  }

  async openPull(number: number, options: { page?: number } = {}) {
    if (!this.repository || !Number.isFinite(number)) {
      return null;
    }
    if (!this.pullsAvailable()) {
      this.selectedPullSummary = { number };
      this.setView("detail");
      this.listPage.setSelectedPull(number);
      this.detailPage.setError(
        number,
        new Error(
          this.githubStatus?.message ?? "GitHub pull requests are unavailable.",
        ),
      );
      this.emitStateChange();
      return null;
    }
    const requestId = ++this.pullDetailRequestId;
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary = this.pullSummary(number);
    this.setView("detail");
    this.listPage.setSelectedPull(number);
    this.detailPage.setLoading(number);
    this.filesPage.reset();
    this.emitStateChange();
    try {
      const pull = await getGitHubPull(this.currentPath, number);
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
      this.detailPage.setError(number, error as Error);
      this.emitStateChange();
      return null;
    }
  }

  async openFiles(
    number: number,
    options: {
      page?: number;
      preserveViewer?: boolean;
      skipReload?: boolean;
    } = {},
  ) {
    if (!this.repository || !Number.isFinite(number)) {
      return null;
    }
    if (!this.pullsAvailable()) {
      this.selectedPullSummary = { number };
      this.setView("files");
      this.listPage.setSelectedPull(number);
      this.filesPage.setError(
        new Error(
          this.githubStatus?.message ?? "GitHub pull requests are unavailable.",
        ),
        { preserveView: Boolean(options.preserveViewer) },
      );
      this.emitStateChange();
      return null;
    }
    this.page = normalizePage(options.page ?? this.page);
    this.selectedPullSummary =
      this.selectedPullSummary?.number === number
        ? this.selectedPullSummary
        : this.pullSummary(number);
    this.setView("files");
    this.listPage.setSelectedPull(number);
    this.filesPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    this.emitStateChange();
    return await this.filesPage.openFiles(number, options);
  }

  async openFile(path: string, status = "") {
    const number = this.currentPullNumber();
    if (!number || !path) {
      return null;
    }
    this.setView("files");
    this.filesPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    this.emitStateChange();
    return await this.filesPage.openFile(path, status);
  }

  showFilesList() {
    this.filesPage.showList();
    this.emitStateChange();
  }

  prepareRoute(
    route: {
      page?: number;
      number?: number | null;
      files?: boolean;
      path?: string;
    } | null,
  ) {
    this.page = normalizePage(route?.page ?? this.page);
    if (!route?.number) {
      const keepCurrentContext = Boolean(route && this.repository);
      this.selectedPullSummary = null;
      this.setView("list");
      this.listPage.setSelectedPull(null);
      this.listPage.setLoading(
        keepCurrentContext ? this.pulls : null,
        this.page,
      );
      this.detailPage.setEmpty();
      this.filesPage.reset();
      this.emitStateChange();
      return;
    }
    this.selectedPullSummary = this.pullSummary(route.number);
    this.listPage.setSelectedPull(route.number);
    if (route.files) {
      this.setView("files");
      this.detailPage.setEmpty();
      this.filesPage.prepareRoute(route.number, { path: route.path });
    } else {
      this.setView("detail");
      this.detailPage.setLoading(route.number);
      this.filesPage.reset();
    }
    this.emitStateChange();
  }

  setContext(options: GithubContext = {}) {
    const nextPath = options.path ?? this.currentPath;
    const nextRepository = options.repository ?? this.repository;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath;
    this.currentPath = nextPath;
    this.repository = nextRepository;
    if (Object.hasOwn(options, "githubStatus")) {
      this.githubStatus = options.githubStatus ?? null;
    }
    this.filesPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    if (contextChanged) {
      this.pullListRequestId += 1;
      this.pullDetailRequestId += 1;
      this.pulls = null;
      this.selectedPullSummary = null;
    }
  }

  canReuseFiles(number: number) {
    return this.filesPage.canReuseFiles(number);
  }

  findFile(path: string) {
    return this.filesPage.findFile(path);
  }

  currentPullNumber() {
    return (
      this.selectedPullSummary?.number ?? this.filesPage.currentPullNumber()
    );
  }

  sidePane() {
    return !this.hidden && this.view === "files"
      ? this.filesPage.sidePane()
      : null;
  }

  actionHintScope({
    scopeId = "github:pulls",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const options = { clipRoots: [this, ...clipRoots] };
    return this.view === "detail"
      ? this.detailPage.actionHintScope({
          ...options,
          scopeId: `${scopeId}:detail`,
        })
      : this.view === "files"
        ? this.filesPage.actionHintScope({
            ...options,
            scopeId: `${scopeId}:files`,
          })
        : this.listPage.actionHintScope({
            ...options,
            scopeId: `${scopeId}:page:${this.page}`,
          });
  }

  scrollSurfaceScope({
    scopeId = "github:pulls",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}) {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const options = { clipRoots: [this, ...clipRoots] };
    return this.view === "detail"
      ? this.detailPage.scrollSurfaceScope({
          ...options,
          scopeId: `${scopeId}:detail`,
        })
      : this.view === "files"
        ? this.filesPage.scrollSurfaceScope({
            ...options,
            scopeId: `${scopeId}:files`,
          })
        : this.listPage.scrollSurfaceScope({
            ...options,
            scopeId: `${scopeId}:page:${this.page}`,
          });
  }

  keyboardNavigationContexts({ scopeId = "github:pulls" } = {}) {
    return !this.hidden && this.view === "files"
      ? this.filesPage.keyboardNavigationContexts({
          scopeId: `${scopeId}:files`,
        })
      : [];
  }

  deactivate() {
    this.filesPage.deactivate();
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
    return [`#${pull.number}`, pull.title ?? ""].filter(Boolean).join(" ");
  }

  private followFilesPage() {
    this.emitStateChange();
  }

  private async loadPulls(page: number) {
    if (!this.repository || !this.pullsAvailable()) {
      return null;
    }
    const nextPage = normalizePage(page);
    const requestId = ++this.pullListRequestId;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.pullListRequestId) {
        this.listPage.setLoading(this.pulls, this.page);
      }
    }, LOADING_DELAY_MS);
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
      }
      this.emitStateChange();
      return pulls;
    } catch (error) {
      if (requestId !== this.pullListRequestId) {
        return null;
      }
      this.listPage.setError(error as Error);
      this.detailPage.setEmpty();
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  private pullSummary(number: number) {
    return (
      this.pulls?.pulls.find((pull) => pull.number === number) ?? { number }
    );
  }

  private pullsAvailable() {
    return Boolean(
      this.githubStatus?.github && this.githubStatus.pullsAvailable,
    );
  }

  private setView(view: PullsView) {
    this.view = view;
    this.dataset.pullsView = view;
  }

  private emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:github-pulls-state-change", { bubbles: true }),
    );
  }

  // The pages are drawn the first time one is needed, which can be before
  // the layout is in the document.
  private get listPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-github-pulls-list-page",
    ) as CaffoldGithubPullsListPage;
  }

  private get detailPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-github-pull-detail-page",
    ) as CaffoldGithubPullDetailPage;
  }

  private get filesPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-github-pull-files-page",
    ) as CaffoldGithubPullFilesPage;
  }
}

customElements.define("caffold-github-pulls-layout", CaffoldGithubPullsLayout);

function normalizePage(page: number | string | null | undefined) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
