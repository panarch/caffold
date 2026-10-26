import { html, LitElement } from "lit";
import {
  type ActionHintScopeOptions,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import {
  type GitHubIssues,
  type GitHubStatus,
  type GitRepository,
  getGitHubIssue,
  getGitHubIssues,
} from "#app/api.ts";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "./detail/page.ts";
import type { CaffoldGithubIssueDetailPage } from "./detail/page.ts";
import "./list/page.ts";
import type { CaffoldGithubIssuesListPage } from "./list/page.ts";

const GITHUB_ISSUES_PER_PAGE = 50;
const LOADING_DELAY_MS = 180;

type IssuesView = "list" | "detail";

// What Issues knows about the open GitHub repository.
interface GithubContext {
  path?: string;
  repository?: GitRepository | null;
  githubStatus?: GitHubStatus | null;
}

export class CaffoldGithubIssuesLayout extends LitElement {
  // What the GitHub layout reads back.
  page = 1;
  view: IssuesView = "list";
  private currentPath = "";
  private repository: GitRepository | null = null;
  private githubStatus: GitHubStatus | null = null;
  private issues: GitHubIssues | null = null;
  private selectedIssueSummary: { number: number; title?: string } | null =
    null;
  private issueListRequestId = 0;
  private issueDetailRequestId = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this.dataset.issuesView) {
      this.setView("list");
    }
  }

  render() {
    return html`
      <caffold-github-issues-list-page></caffold-github-issues-list-page>
      <caffold-github-issue-detail-page></caffold-github-issue-detail-page>
    `;
  }

  reset() {
    this.issueListRequestId += 1;
    this.issueDetailRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.githubStatus = null;
    this.issues = null;
    this.page = 1;
    this.selectedIssueSummary = null;
    this.setView("list");
    this.listPage.reset();
    this.detailPage.setEmpty();
    this.emitStateChange();
  }

  invalidateRequests() {
    this.issueListRequestId += 1;
    this.issueDetailRequestId += 1;
  }

  async openList(
    options: GithubContext & { page?: number; skipReload?: boolean } = {},
  ) {
    this.setContext(options);
    this.page = normalizePage(options.page ?? this.page);
    this.selectedIssueSummary = null;
    this.setView("list");
    this.listPage.setSelectedIssue(null);
    this.detailPage.setEmpty();
    this.emitStateChange();
    if (options.skipReload) {
      if (this.issues) {
        this.listPage.setIssues(this.issues);
      }
      return this.issues;
    }
    if (!this.githubStatus) {
      this.listPage.setLoading();
      return null;
    }
    if (!this.issuesAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }
    return await this.loadIssues(this.page);
  }

  setGithubStatus(status: GitHubStatus | null) {
    this.githubStatus = status;
    if (this.githubStatus && !this.issuesAvailable()) {
      this.issueListRequestId += 1;
      this.issueDetailRequestId += 1;
      if (this.view === "detail") {
        this.detailPage.setError(
          this.selectedIssueSummary?.number ?? null,
          new Error(
            this.githubStatus.message ?? "GitHub issues are unavailable.",
          ),
        );
      } else {
        this.listPage.setUnavailable(this.githubStatus);
        this.detailPage.setEmpty();
      }
    }
    this.emitStateChange();
  }

  prepareRoute(route: { page?: number; number?: number | null } | null) {
    this.page = normalizePage(route?.page ?? this.page);
    if (route?.number) {
      this.selectedIssueSummary = this.issueSummary(route.number);
      this.setView("detail");
      this.listPage.setSelectedIssue(route.number);
      this.detailPage.setLoading(route.number);
    } else {
      const keepCurrentContext = Boolean(route && this.repository);
      this.selectedIssueSummary = null;
      this.setView("list");
      this.listPage.setSelectedIssue(null);
      this.listPage.setLoading(
        keepCurrentContext ? this.issues : null,
        this.page,
      );
      this.detailPage.setEmpty();
    }
    this.emitStateChange();
  }

  async openIssue(number: number, options: { page?: number } = {}) {
    if (!this.repository || !Number.isFinite(number)) {
      return null;
    }
    this.page = normalizePage(options.page ?? this.page);
    const requestId = ++this.issueDetailRequestId;
    this.selectedIssueSummary = this.issueSummary(number);
    this.setView("detail");
    this.listPage.setSelectedIssue(number);
    this.detailPage.setLoading(number);
    this.emitStateChange();
    if (!this.issuesAvailable()) {
      this.detailPage.setError(
        number,
        new Error(
          this.githubStatus?.message ?? "GitHub issues are unavailable.",
        ),
      );
      this.emitStateChange();
      return null;
    }
    try {
      const issue = await getGitHubIssue(this.currentPath, number);
      if (requestId !== this.issueDetailRequestId) {
        return null;
      }
      this.detailPage.setIssue(issue);
      this.selectedIssueSummary = issue.issue;
      this.emitStateChange();
      return issue;
    } catch (error) {
      if (requestId !== this.issueDetailRequestId) {
        return null;
      }
      this.detailPage.setError(number, error as Error);
      this.emitStateChange();
      return null;
    }
  }

  issuesSubtitle() {
    if (!this.githubStatus?.github) {
      return "GitHub";
    }
    const count = this.issues?.totalIssues;
    const countLabel = count === undefined ? "" : ` · ${count} issues`;
    return `${this.githubStatus.github.nameWithOwner}${countLabel}`;
  }

  issueSubtitle() {
    const issue = this.selectedIssueSummary;
    if (!issue) {
      return "";
    }
    return [`#${issue.number}`, issue.title ?? ""].filter(Boolean).join(" ");
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
    if (contextChanged) {
      this.issueListRequestId += 1;
      this.issueDetailRequestId += 1;
      this.issues = null;
      this.selectedIssueSummary = null;
    }
  }

  actionHintScope({
    scopeId = "github:issues",
    clipRoots = [],
  }: ActionHintScopeOptions = {}) {
    if (this.hidden) {
      return emptyActionHintScope();
    }
    return this.view === "detail"
      ? this.detailPage.actionHintScope({
          scopeId: `${scopeId}:detail`,
          clipRoots: [this, ...clipRoots],
        })
      : this.listPage.actionHintScope({
          scopeId: `${scopeId}:page:${this.page}`,
          clipRoots: [this, ...clipRoots],
        });
  }

  scrollSurfaceScope({
    scopeId = "github:issues",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}) {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return this.view === "detail"
      ? this.detailPage.scrollSurfaceScope({
          scopeId: `${scopeId}:detail`,
          clipRoots: [this, ...clipRoots],
        })
      : this.listPage.scrollSurfaceScope({
          scopeId: `${scopeId}:page:${this.page}`,
          clipRoots: [this, ...clipRoots],
        });
  }

  private async loadIssues(page: number) {
    if (!this.repository || !this.issuesAvailable()) {
      return null;
    }
    const nextPage = normalizePage(page);
    const requestId = ++this.issueListRequestId;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.issueListRequestId) {
        this.listPage.setLoading(this.issues, this.page);
      }
    }, LOADING_DELAY_MS);
    try {
      const issues = await getGitHubIssues(
        this.currentPath,
        "open",
        nextPage,
        GITHUB_ISSUES_PER_PAGE,
      );
      if (requestId !== this.issueListRequestId) {
        return null;
      }
      this.page = issues.page ?? nextPage;
      this.issues = issues;
      this.listPage.setIssues(issues);
      if (this.view === "list") {
        this.selectedIssueSummary = null;
        this.detailPage.setEmpty();
      }
      this.emitStateChange();
      return issues;
    } catch (error) {
      if (requestId !== this.issueListRequestId) {
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

  private issueSummary(number: number) {
    return (
      this.issues?.issues.find((issue) => issue.number === number) ?? {
        number,
      }
    );
  }

  private issuesAvailable() {
    return Boolean(
      this.githubStatus?.github && this.githubStatus.issuesAvailable,
    );
  }

  private setView(view: IssuesView) {
    this.view = view;
    this.dataset.issuesView = view;
  }

  private emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:github-issues-state-change", { bubbles: true }),
    );
  }

  // The pages are drawn the first time one is needed, which can be before
  // the layout is in the document.
  private get listPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-github-issues-list-page",
    ) as CaffoldGithubIssuesListPage;
  }

  private get detailPage() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-github-issue-detail-page",
    ) as CaffoldGithubIssueDetailPage;
  }
}

customElements.define(
  "caffold-github-issues-layout",
  CaffoldGithubIssuesLayout,
);

function normalizePage(page: number | string | null | undefined) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
