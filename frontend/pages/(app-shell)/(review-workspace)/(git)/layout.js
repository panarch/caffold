import { escapeHtml } from "../../../../components/dom.js";
import "./compare/page.js";
import "./diff/page.js";
import "./(log)/layout.js";

class CaffoldGitReviewLayout extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <div class="git-review-view git-mode-diff" hidden>
        <caffold-git-diff-page></caffold-git-diff-page>
      </div>
      <div class="git-review-view git-mode-compare" hidden>
        <caffold-git-compare-page></caffold-git-compare-page>
      </div>
      <div class="git-review-view git-mode-log" hidden>
        <caffold-git-log-layout></caffold-git-log-layout>
      </div>
    `;
    this.diffView = this.querySelector(".git-mode-diff");
    this.compareView = this.querySelector(".git-mode-compare");
    this.logView = this.querySelector(".git-mode-log");
    this.diffPage = this.querySelector("caffold-git-diff-page");
    this.comparePage = this.querySelector("caffold-git-compare-page");
    this.logLayout = this.querySelector("caffold-git-log-layout");
    this.diffPage.ensureRendered();
    this.comparePage.ensureRendered();
    this.logLayout.ensureRendered();
    this.mode ??= null;
    this.currentPath ??= "";
    this.repository ??= null;
    this.gitStatus ??= null;
    this.diffPage.addEventListener("caffold:git-diff-state-change", () => {
      this.emitStateChange();
    });
    this.comparePage.addEventListener("caffold:git-compare-state-change", () => {
      if (this.comparePage.repository) {
        this.repository = this.comparePage.repository;
      }
      this.emitStateChange();
    });
    this.logLayout.addEventListener("caffold:git-log-state-change", () => {
      this.emitStateChange();
    });
    this.updateVisibleMode();
  }

  reset() {
    this.ensureRendered();
    this.mode = null;
    this.currentPath = "";
    this.repository = null;
    this.gitStatus = null;
    this.diffPage.reset();
    this.comparePage.reset();
    this.logLayout.reset();
    this.updateVisibleMode();
    this.emitStateChange();
  }

  setContext({ path, repository } = {}) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;
    this.diffPage.setContext({ path: this.currentPath, repository: this.repository });
    this.comparePage.setContext({ path: this.currentPath, repository: this.repository });
    this.logLayout.setContext({ path: this.currentPath, repository: this.repository });

    if (contextChanged) {
      this.gitStatus = null;
      if (this.repository) {
        this.diffPage.setLoading(this.repository);
      }
    }
  }

  setGitStatus(status) {
    this.ensureRendered();
    this.gitStatus = status ?? null;
    if (status?.repository) {
      this.repository = status.repository;
      this.diffPage.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.comparePage.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.logLayout.setContext({
        path: this.currentPath,
        repository: status.repository,
      });
      this.diffPage.setStatus(status);
    } else if (this.repository) {
      this.diffPage.setLoading(this.repository);
    }
    this.emitStateChange();
  }

  setGitStatusError(error) {
    this.ensureRendered();
    this.diffPage.setError(error, this.repository);
    this.emitStateChange();
  }

  openDiffWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("diff");
    this.diffPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    this.diffPage.showList();
    if (!this.gitStatus) {
      this.diffPage.setLoading(this.repository);
    }
    if (!options.preserveViewer) {
      this.diffPage.setEmpty();
    }
    this.emitStateChange();
    return this.gitStatus;
  }

  async openDiff(path, kind, status = "") {
    if (!path) {
      return null;
    }

    this.setMode("diff");
    this.logLayout.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.diffPage.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const diff = await this.diffPage.openDiff(path, kind, status);
    this.emitStateChange();
    return diff;
  }

  async openCompareWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("compare");
    this.comparePage.setContext({
      path: this.currentPath,
      repository: this.repository,
      baseRef: options.baseRef,
      headRef: options.headRef,
    });
    const compare = await this.comparePage.openCompare({
      path: this.currentPath,
      repository: this.repository,
      baseRef: options.baseRef,
      headRef: options.headRef,
      preserveViewer: options.preserveViewer,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return compare;
  }

  async openCompareDiff(path, status = "") {
    if (!path || !this.comparePage.compare) {
      return null;
    }

    this.setMode("compare");
    this.diffPage.setSelectedPath("");
    this.logLayout.setSelectedPath("");
    const diff = await this.comparePage.openDiff(path, status);
    this.emitStateChange();
    return diff;
  }

  changeCompareRefs(baseRef, headRef) {
    if (this.mode !== "compare") {
      return null;
    }

    return this.comparePage.changeRefs(baseRef, headRef);
  }

  async openLogWorkspace(options = {}) {
    if (!this.repository) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setView("list");
    this.comparePage.setView("list");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const log = await this.logLayout.openList({
      path: this.currentPath,
      repository: this.repository,
      page: options.page ?? 1,
      skipReload: options.skipReload,
    });
    this.emitStateChange();
    return log;
  }

  changeLogPage(page) {
    if (this.mode !== "log") {
      return null;
    }

    return this.logLayout.changePage(page);
  }

  async openCommit(sha, options = {}) {
    if (!sha || !this.repository) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const commit = await this.logLayout.openCommit(sha, options);
    this.emitStateChange();
    return commit;
  }

  async openCommitDiff(sha, path, status = "") {
    if (!sha || !path) {
      return null;
    }

    this.setMode("log");
    this.diffPage.setSelectedPath("");
    this.comparePage.setSelectedPath("");
    this.logLayout.setContext({
      path: this.currentPath,
      repository: this.repository,
    });
    const diff = await this.logLayout.openCommitDiff(sha, path, status);
    this.emitStateChange();
    return diff;
  }

  back() {
    if (this.mode === "log" && this.logLayout.backToList()) {
      this.emitStateChange();
      return true;
    }

    return false;
  }

  showDiffList() {
    this.diffPage.showList();
    this.emitStateChange();
  }

  showCompareList() {
    this.comparePage.showList();
    this.emitStateChange();
  }

  showCommitFileList() {
    this.logLayout.showCommitFileList();
  }

  showFileListForTarget(target) {
    if (this.diffPage.isFileViewer(target)) {
      this.showDiffList();
      return "diff";
    }

    if (this.comparePage.isFileViewer(target)) {
      this.showCompareList();
      return "compare";
    }

    if (this.logLayout.isFileViewer(target)) {
      this.showCommitFileList();
      return "log";
    }

    return null;
  }

  setSelectedPath(path) {
    this.diffPage.setSelectedPath(path);
    this.logLayout.setSelectedPath(path);
    this.comparePage.setSelectedPath(path);
  }

  setView(view) {
    if (view !== "list") {
      return;
    }

    this.diffPage.setView("list");
    this.comparePage.setView("list");
    this.logLayout.backToList();
    this.emitStateChange();
  }

  canReuseDiffRoute(_route) {
    return this.mode === "diff" && Boolean(this.repository) && Boolean(this.gitStatus);
  }

  canReuseCompareRoute(route) {
    const routeBaseRef = route.baseRef || null;
    const routeHeadRef = route.headRef || null;
    return (
      this.mode === "compare" &&
      Boolean(this.repository) &&
      this.comparePage.hasCompare(routeBaseRef, routeHeadRef)
    );
  }

  canReuseLogRoute(route) {
    return this.mode === "log" && this.logLayout.canReuseRoute(route.page, route.sha);
  }

  findDiffFile(path) {
    return this.gitStatus?.files?.find((entry) => entry.path === path) ?? null;
  }

  findCompareFile(path) {
    return this.comparePage.fileForPath(path);
  }

  findCommitFile(path) {
    return this.logLayout.findCommitFile(path);
  }

  reviewPanelForTarget(target) {
    if (target === "log") {
      return this.querySelector("caffold-git-log-commit-page");
    }

    if (target === "diff") {
      return this.diffPage;
    }

    if (target === "compare") {
      return this.comparePage;
    }

    return null;
  }

  isMobileDetailOpen() {
    return (
      (this.mode === "diff" && this.diffPage.dataset.detailView === "viewer") ||
      (this.mode === "compare" && this.comparePage.dataset.detailView === "viewer") ||
      (this.mode === "log" &&
        this.logLayout.dataset.logView === "detail" &&
        this.logLayout.detailView === "viewer")
    );
  }

  details(workspaceSubtitle) {
    if (this.mode === "diff") {
      return {
        title: "Diff",
        subtitle: workspaceSubtitle("Working tree"),
        backVisible: false,
      };
    }

    if (this.mode === "compare") {
      return {
        title: "Compare",
        subtitle: this.comparePage.compareSubtitle(workspaceSubtitle("Branches")),
        backVisible: false,
        controlsHtml: this.renderCompareControls(),
      };
    }

    if (this.mode === "log" && this.logLayout.view === "detail") {
      return {
        title: "Commit",
        subtitle: this.logLayout.commitSubtitle(),
        backVisible: true,
        backLabel: "Back to log",
      };
    }

    if (this.mode === "log") {
      return {
        title: "Log",
        subtitle: workspaceSubtitle("History"),
        backVisible: false,
      };
    }

    return {
      title: "Git",
      subtitle: "",
      backVisible: false,
    };
  }

  renderCompareControls() {
    const refs = this.comparePage.refsPayload?.refs ?? [];
    if (refs.length === 0) {
      return "";
    }

    return `
      <div class="review-compare-ref-controls" aria-label="Compare refs">
        <label for="caffold-compare-base-ref">Base</label>
        <select
          id="caffold-compare-base-ref"
          data-compare-ref="base"
          aria-label="Base ref"
          title="${escapeHtml(this.comparePage.baseRef ?? "")}"
        >
          ${renderRefOptions(refs, this.comparePage.baseRef)}
        </select>
        <span class="review-compare-ref-separator" aria-hidden="true">...</span>
        <label for="caffold-compare-head-ref">Head</label>
        <select
          id="caffold-compare-head-ref"
          data-compare-ref="head"
          aria-label="Head ref"
          title="${escapeHtml(this.comparePage.headRef ?? "")}"
        >
          ${renderRefOptions(refs, this.comparePage.headRef)}
        </select>
      </div>
    `;
  }

  get compareBaseRef() {
    return this.comparePage.baseRef ?? "";
  }

  get compareHeadRef() {
    return this.comparePage.headRef ?? "";
  }

  get logPage() {
    return this.logLayout.page;
  }

  get activeMode() {
    return this.mode;
  }

  setMode(mode) {
    const nextMode = normalizeGitMode(mode);
    if (this.mode === nextMode) {
      return;
    }

    this.mode = nextMode;
    this.updateVisibleMode();
  }

  updateVisibleMode() {
    this.dataset.gitMode = this.mode ?? "";
    if (this.diffView) {
      this.diffView.hidden = this.mode !== "diff";
      this.diffView.dataset.detailView = this.diffPage.detailView;
    }
    if (this.compareView) {
      this.compareView.hidden = this.mode !== "compare";
      this.compareView.dataset.detailView = this.comparePage.detailView;
    }
    if (this.logView) {
      this.logView.hidden = this.mode !== "log";
      this.logView.dataset.logView = this.logLayout.view;
    }
  }

  emitStateChange() {
    this.updateVisibleMode();
    this.dispatchEvent(
      new CustomEvent("caffold:git-review-state-change", {
        bubbles: true,
        detail: {
          mode: this.mode,
          detailOpen: this.isMobileDetailOpen(),
        },
      }),
    );
  }
}

customElements.define("caffold-git-review-layout", CaffoldGitReviewLayout);

function normalizeGitMode(mode) {
  return mode === "compare" || mode === "log" ? mode : "diff";
}

function renderRefOptions(refs, selectedRef) {
  let lastKind = null;
  let html = "";

  for (const ref of refs) {
    if (ref.kind !== lastKind) {
      if (lastKind) {
        html += "</optgroup>";
      }
      lastKind = ref.kind;
      html += `<optgroup label="${escapeHtml(refKindLabel(ref.kind))}">`;
    }

    html += `
      <option value="${escapeHtml(ref.name)}" ${ref.name === selectedRef ? "selected" : ""}>
        ${escapeHtml(ref.name)}
      </option>
    `;
  }

  return lastKind ? `${html}</optgroup>` : html;
}

function refKindLabel(kind) {
  if (kind === "head") {
    return "Current";
  }

  return kind === "remote" ? "Remote" : "Local";
}
