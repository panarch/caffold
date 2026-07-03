import { getGitHubIssue, getGitHubIssues } from "../../../../../api.js";
import "./list/page.js";
import "./detail/page.js";

const GITHUB_ISSUES_PER_PAGE = 50;
const LOADING_DELAY_MS = 180;

class CaffoldGithubIssuesLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (!this.dataset.issuesView) {
      this.setView("list");
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-github-issues-list-page></caffold-github-issues-list-page>
      <caffold-github-issue-detail-page></caffold-github-issue-detail-page>
    `;
    this.listPage = this.querySelector("caffold-github-issues-list-page");
    this.detailPage = this.querySelector("caffold-github-issue-detail-page");
    this.issueListRequestId ??= 0;
    this.issueDetailRequestId ??= 0;
    this.page ??= 1;
    this.view ??= "list";
  }

  setView(view) {
    this.ensureRendered();
    this.view = view === "detail" ? "detail" : "list";
    this.dataset.issuesView = this.view;
  }

  reset() {
    this.ensureRendered();
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

  async openList(options = {}) {
    this.setContext(options);
    this.page = normalizePage(options.page ?? this.page);
    this.selectedIssueSummary = null;
    this.setView("list");
    this.listPage.setSelectedIssue(null);
    this.detailPage.setEmpty();
    this.emitStateChange();

    if (options.skipReload) {
      return null;
    }

    if (!this.githubStatus) {
      this.listPage.setLoading(null);
      return null;
    }

    if (!this.issuesAvailable()) {
      this.listPage.setUnavailable(this.githubStatus);
      return null;
    }

    return await this.loadIssues(this.page);
  }

  async setGithubStatus(status) {
    this.githubStatus = status ?? null;
    if (!this.githubStatus) {
      return null;
    }

    if (!this.issuesAvailable()) {
      this.issueListRequestId += 1;
      this.issueDetailRequestId += 1;
      this.listPage.setUnavailable(this.githubStatus);
      this.detailPage.setEmpty();
      this.emitStateChange();
      return null;
    }

    if (this.view === "list" && !this.issues) {
      return await this.loadIssues(this.page);
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
    return await this.loadIssues(nextPage);
  }

  async openIssue(number) {
    const issueNumber = Number.parseInt(`${number ?? ""}`, 10);
    if (!this.repository || !Number.isFinite(issueNumber)) {
      return null;
    }

    const requestId = ++this.issueDetailRequestId;
    this.selectedIssueSummary =
      this.issues?.issues?.find((issue) => issue.number === issueNumber) ?? {
        number: issueNumber,
      };
    this.setView("detail");
    this.listPage.setSelectedIssue(issueNumber);
    this.detailPage.setLoading(issueNumber);
    this.emitStateChange();

    try {
      const issue = await getGitHubIssue(this.currentPath, issueNumber);
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

      this.detailPage.setError(issueNumber, error);
      this.emitStateChange();
      return null;
    }
  }

  backToList() {
    if (this.view !== "detail") {
      return false;
    }

    this.issueDetailRequestId += 1;
    this.selectedIssueSummary = null;
    this.setView("list");
    this.listPage.setSelectedIssue(null);
    this.detailPage.setEmpty();
    this.emitStateChange();
    return true;
  }

  setLoading() {
    this.ensureRendered();
    this.listPage.setLoading(this.githubStatus, this.issues, this.page);
  }

  canReuseRoute(page) {
    return Boolean(this.issues) && normalizePage(page ?? this.page) === this.page;
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

    const number = issue.number === undefined ? "" : `#${issue.number}`;
    const title = issue.title ?? "";
    return [number, title].filter(Boolean).join(" ");
  }

  setContext({ path, repository, githubStatus }) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.githubStatus = githubStatus ?? this.githubStatus ?? null;

    if (contextChanged) {
      this.issueListRequestId += 1;
      this.issueDetailRequestId += 1;
      this.issues = null;
      this.selectedIssueSummary = null;
    }
  }

  async loadIssues(page = this.page) {
    if (!this.repository || !this.issuesAvailable()) {
      return null;
    }

    const nextPage = normalizePage(page);
    const requestId = ++this.issueListRequestId;
    const loadingTimer = this.showLoadingAfterDelay(requestId);

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

      this.listPage.setError(error, this.githubStatus);
      this.detailPage.setEmpty();
      this.emitStateChange();
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  showLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.issueListRequestId) {
        this.setLoading();
      }
    }, LOADING_DELAY_MS);
  }

  issuesAvailable() {
    return Boolean(this.githubStatus?.github && this.githubStatus?.issuesAvailable);
  }

  emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:github-issues-state-change", {
        bubbles: true,
        detail: {
          view: this.view,
          page: this.page,
        },
      }),
    );
  }
}

customElements.define("caffold-github-issues-layout", CaffoldGithubIssuesLayout);

function normalizePage(page) {
  const value = Number.parseInt(`${page ?? 1}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
