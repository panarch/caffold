import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type GitCommit,
  type GitDiff,
  type GitRepository,
  getGitCommit,
  getGitCommitDiff,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-viewer.js";
import type { CaffoldReviewFileViewer } from "#components/file-viewer.js";
import {
  diffViewerPresentation,
  type ViewerPresentation,
} from "#components/file-viewer-presentation.js";
import "#components/pane-resizer.js";
import type { CaffoldPaneResizer } from "#components/pane-resizer.js";
import { REVIEW_SINGLE_PANE_MEDIA_QUERY } from "#components/review-responsive.js";
import "./components/changes-tree.js";
import type { CaffoldCommitChangesTree } from "./components/changes-tree.js";

const LOADING_DELAY_MS = 180;

type DetailView = "list" | "viewer";

interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
}

interface CommitContext {
  currentPath?: string;
  repository?: GitRepository | null;
  sha?: string;
}

export class CaffoldGitLogCommitPage extends LitElement {
  // What the Log layout reads back.
  detailView: DetailView = "list";
  private currentPath = "";
  private repository: GitRepository | null = null;
  private commitPayload: GitCommit | null = null;
  private selectedCommitSummary: CommitSummary | null = null;
  private viewerPresentation: ViewerPresentation | null = null;
  private commitRequestId = 0;
  private fileRequestId = 0;
  private treeScrollTop = 0;
  private readonly filesList = new DrawnRef<CaffoldCommitChangesTree>(this);
  private readonly paneResizer = new DrawnRef<CaffoldPaneResizer>(this);
  private readonly viewer = new DrawnRef<CaffoldReviewFileViewer>(this);

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <caffold-commit-changes-tree
        ${drawn(this.filesList)}
      ></caffold-commit-changes-tree>
      <caffold-pane-resizer
        ${drawn(this.paneResizer)}
        storage-key="caffold:pane-width:git-log-commit"
        collapsed-storage-key="caffold:pane-collapsed:git-log-commit"
        aria-label="Resize review side panel"
        @caffold:pane-resize=${this.handlePanelResize}
      ></caffold-pane-resizer>
      <caffold-review-file-viewer
        ${drawn(this.viewer)}
        refresh-action="refresh-git-review"
      ></caffold-review-file-viewer>
    `;
  }

  firstUpdated() {
    this.fileViewer.setCloseLabel("Back to commit");
    this.applyPanelWidth();
  }

  reset() {
    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.commitPayload = null;
    this.selectedCommitSummary = null;
    this.viewerPresentation = null;
    this.treeScrollTop = 0;
    this.setDetailView("list");
    this.commitTree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  invalidateRequests() {
    this.commitRequestId += 1;
    this.fileRequestId += 1;
  }

  prepareForList() {
    this.commitRequestId += 1;
    this.fileRequestId += 1;
    this.selectedCommitSummary = null;
    this.viewerPresentation = null;
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  prepareRoute(options: CommitContext & { path?: string } = {}) {
    const sha = options.sha ?? "";
    if (!sha) {
      this.prepareForList();
      return;
    }
    this.currentPath = options.currentPath ?? this.currentPath;
    this.repository = options.repository ?? this.repository;
    this.selectedCommitSummary = {
      sha,
      shortSha: sha.slice(0, 7),
      subject:
        this.commitPayload?.commit.sha === sha
          ? this.commitPayload.commit.subject
          : "",
    };
    this.commitTree.setSelectedPath(options.path ?? "");
    if (this.repository) {
      this.commitTree.setLoading();
    }
    if (options.path) {
      this.setDetailView("viewer");
      this.viewerPresentation = this.diffPresentation(options.path, sha);
      this.fileViewer.setLoading(this.viewerPresentation);
    } else {
      this.setDetailView("list");
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();
  }

  async openCommit(
    options: CommitContext & {
      skipReload?: boolean;
      preserveViewer?: boolean;
    } = {},
  ) {
    const sha = options.sha ?? "";
    if (!sha) {
      return null;
    }
    this.currentPath = options.currentPath ?? this.currentPath;
    this.repository = options.repository ?? this.repository;
    if (!this.repository) {
      return null;
    }

    if (options.skipReload && this.commitPayload?.commit.sha === sha) {
      this.selectedCommitSummary = this.commitPayload.commit;
      this.commitTree.setCommit(this.commitPayload);
      this.setDetailView(options.preserveViewer ? this.detailView : "list");
      if (!options.preserveViewer) {
        this.commitTree.setSelectedPath("");
        this.viewerPresentation = null;
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return this.commitPayload;
    }

    const requestId = ++this.commitRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.selectedCommitSummary = {
      sha,
      shortSha: sha.slice(0, 7),
      subject: "",
    };
    this.setDetailView(options.preserveViewer ? "viewer" : "list");
    if (!options.preserveViewer) {
      this.commitTree.setSelectedPath("");
    }
    this.commitTree.setLoading();
    if (!options.preserveViewer) {
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();

    try {
      const commit = await getGitCommit(this.currentPath, sha);
      if (requestId !== this.commitRequestId) {
        return null;
      }
      this.commitPayload = commit;
      this.commitTree.setCommit(commit);
      this.selectedCommitSummary = commit.commit;
      if (!options.preserveViewer && viewerRequestId === this.fileRequestId) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return commit;
    } catch (error) {
      if (requestId !== this.commitRequestId) {
        return null;
      }
      this.commitTree.setError(error as Error);
      if (
        options.preserveViewer &&
        viewerRequestId === this.fileRequestId &&
        this.viewerPresentation
      ) {
        this.fileViewer.setError(this.viewerPresentation, error as Error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openDiff(
    options: {
      currentPath?: string;
      sha?: string;
      path?: string;
      status?: string;
    } = {},
  ) {
    const sha = options.sha ?? "";
    const path = options.path ?? "";
    if (!sha || !path) {
      return null;
    }
    this.currentPath = options.currentPath ?? this.currentPath;
    const requestId = ++this.fileRequestId;
    this.commitTree.setSelectedPath(path);
    this.treeScrollTop =
      this.commitTree.scroller()?.scrollTop ?? this.treeScrollTop;
    this.setDetailView("viewer");
    this.emitStateChange();
    const presentation = this.diffPresentation(path, sha, options.status);
    this.viewerPresentation = presentation;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(presentation);
      }
    }, LOADING_DELAY_MS);

    try {
      const diff = await getGitCommitDiff(this.currentPath, sha, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }
      const loadedPresentation = this.diffPresentation(
        path,
        sha,
        options.status,
        diff,
      );
      this.viewerPresentation = loadedPresentation;
      this.fileViewer.setDiff(
        { ...diff, status: options.status ?? "" },
        { presentation: loadedPresentation },
      );
      return diff;
    } catch (error) {
      if (requestId !== this.fileRequestId) {
        return null;
      }
      this.fileViewer.setError(presentation, error as Error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async refresh() {
    const sha = this.currentCommitSha();
    if (!sha || !this.repository) {
      return null;
    }
    const requestId = ++this.commitRequestId;
    try {
      const commit = await getGitCommit(this.currentPath, sha);
      if (requestId !== this.commitRequestId) {
        return null;
      }
      this.commitPayload = commit;
      this.selectedCommitSummary = commit.commit;
      this.commitTree.updateCommit(commit);
      await this.refreshSelectedDiff();
      this.emitStateChange();
      return commit;
    } catch (error) {
      if (requestId === this.commitRequestId) {
        this.commitTree.setError(error as Error);
        this.emitStateChange();
      }
      return null;
    }
  }

  currentCommitSha() {
    return (
      this.commitPayload?.commit.sha ?? this.selectedCommitSummary?.sha ?? ""
    );
  }

  findFile(path: string) {
    return (
      this.commitPayload?.files.find((entry) => entry.path === path) ?? null
    );
  }

  setSelectedPath(path: string | null | undefined) {
    this.commitTree.setSelectedPath(path ?? "");
  }

  deactivate() {
    this.fileViewer.deactivate();
  }

  commitSubtitle() {
    const shortSha = this.selectedCommitSummary?.shortSha ?? "";
    const subject = this.selectedCommitSummary?.subject ?? "";
    return [shortSha, subject].filter(Boolean).join(" ");
  }

  actionHintScope({
    scopeId = "git:commit",
    clipRoots = [],
  }: ActionHintPull = {}) {
    const sha = this.currentCommitSha();
    if (!sha || this.hidden) {
      return emptyActionHintScope();
    }
    const listActive =
      !this.sidePaneCollapsed() &&
      (this.detailView === "list" ||
        !window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches);
    const viewerActive = this.detailView === "viewer";
    const prefix = `${scopeId}:${encodeURIComponent(sha)}`;
    const resizer = this.panelResizer;
    const resizerScope = hasActionHintLayoutBox(resizer)
      ? resizer.actionHintScope({
          scopeId: `${prefix}:files`,
          actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
          clipRoots: [this, ...clipRoots],
        })
      : null;
    return mergeActionHintScopes(
      listActive
        ? this.commitTree.actionHintScope({
            scopeId: `${prefix}:files`,
            actions: {
              file: ACTION_HINT_ACTION.FILE_OPEN,
              disclosure: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            },
            clipRoots: [this, ...clipRoots],
          })
        : null,
      resizerScope,
      viewerActive
        ? this.fileViewer.actionHintScope({
            scopeId: `${prefix}:viewer`,
            actions: {
              parent: ACTION_HINT_ACTION.PARENT,
              details: ACTION_HINT_ACTION.FILE_DETAILS_OPEN,
              refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              link: ACTION_HINT_ACTION.LINK_OPEN,
            },
            clipRoots: [this, ...clipRoots],
          })
        : null,
    );
  }

  scrollSurfaceScope({
    scopeId = "git:commit",
    clipRoots = [],
  }: ScrollSurfacePull = {}) {
    const sha = this.currentCommitSha();
    if (!sha || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const listActive =
      !this.sidePaneCollapsed() &&
      (this.detailView === "list" ||
        !window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches);
    const viewerActive = this.detailView === "viewer";
    const prefix = `${scopeId}:${encodeURIComponent(sha)}`;
    return mergeScrollSurfaceScopes(
      listActive && hasScrollLayoutBox(this.commitTree)
        ? this.commitTree.scrollSurfaceScope({
            scopeId: `${prefix}:files`,
            label: "Commit files",
            clipRoots: [this, ...clipRoots],
          })
        : null,
      viewerActive && hasScrollLayoutBox(this.fileViewer)
        ? this.fileViewer.scrollSurfaceScope({
            scopeId: `${prefix}:viewer`,
            clipRoots: [this, ...clipRoots],
          })
        : null,
    );
  }

  keyboardNavigationContexts({ scopeId = "git:commit" } = {}) {
    const sha = this.currentCommitSha();
    return sha && !this.hidden && this.detailView === "viewer"
      ? this.fileViewer.keyboardNavigationContexts({
          scopeId: `${scopeId}:${encodeURIComponent(sha)}:viewer`,
        })
      : [];
  }

  setDetailView(view: DetailView) {
    if (view !== "viewer") {
      this.fileViewer.deactivate();
    }
    this.detailView = view;
    this.dataset.detailView = view;
    this.applySidePane();
  }

  /**
   * The commit's file tree the workspace's side pane toggle hides and shows.
   *
   * It collapses only while the viewer is showing a file, the same state in
   * which the single-pane layout shows the viewer instead of the tree.
   */
  sidePane() {
    return {
      label: "review side panel",
      beside: !window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches,
      collapsible: this.detailView === "viewer",
      collapsed: this.sidePaneCollapsed(),
      setCollapsed: (collapsed: boolean) => {
        this.panelResizer.setCollapsed(collapsed);
        this.applySidePane();
      },
    };
  }

  private async refreshSelectedDiff() {
    const path = this.commitTree.selectedPath;
    const sha = this.currentCommitSha();
    if (!path || !sha) {
      return null;
    }
    const file = this.findFile(path);
    if (!file) {
      this.commitTree.setSelectedPath("");
      if (window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches) {
        this.showFileList();
      } else {
        this.fileViewer.setNotice("This file is no longer part of the commit.");
      }
      return null;
    }
    const requestId = ++this.fileRequestId;
    const presentation = this.diffPresentation(path, sha, file.status);
    this.viewerPresentation = presentation;
    try {
      const diff = await getGitCommitDiff(this.currentPath, sha, path);
      if (
        requestId !== this.fileRequestId ||
        path !== this.commitTree.selectedPath
      ) {
        return null;
      }
      const loadedPresentation = this.diffPresentation(
        path,
        sha,
        file.status,
        diff,
      );
      this.viewerPresentation = loadedPresentation;
      this.fileViewer.setDiff(
        { ...diff, status: file.status },
        { preserveScroll: true, presentation: loadedPresentation },
      );
      return diff;
    } catch (error) {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setError(presentation, error as Error);
      }
      return null;
    }
  }

  // Back from a file on one pane, the tree returns to where it was left.
  private showFileList() {
    this.setDetailView("list");
    this.commitTree.setSelectedPath("");
    this.viewerPresentation = null;
    this.fileViewer.setEmpty();
    const top = this.treeScrollTop;
    if (top > 0) {
      window.requestAnimationFrame(() => {
        const scroller = this.commitTree.scroller();
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
    this.emitStateChange();
  }

  private diffPresentation(
    path: string,
    sha = this.currentCommitSha(),
    status = "",
    diff: GitDiff = {},
  ) {
    const file = this.findFile(path);
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? this.repository,
      path: diff.path ?? path,
      repoRelativePath: diff.repoRelativePath ?? file?.repoRelativePath,
      kind: diff.kind || (sha ? `commit ${sha.slice(0, 7)}` : ""),
      status: status || file?.status || "",
    });
  }

  private handlePanelResize(event: CustomEvent<{ phase: string }>) {
    event.stopPropagation();
    if (event.detail.phase === "start") {
      this.classList.add("is-resizing-panel");
    } else if (event.detail.phase === "end") {
      this.classList.remove("is-resizing-panel");
    } else if (event.detail.phase === "update") {
      this.applyPanelWidth();
    }
  }

  private applyPanelWidth() {
    this.style.setProperty(
      "--git-log-commit-panel-width",
      `${this.panelResizer.value}px`,
    );
  }

  private applySidePane() {
    this.toggleAttribute("data-side-pane-collapsed", this.sidePaneCollapsed());
    this.dispatchEvent(
      new CustomEvent("caffold:side-pane-change", { bubbles: true }),
    );
  }

  private sidePaneCollapsed() {
    return this.detailView === "viewer" && this.panelResizer.collapsed;
  }

  private emitStateChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:git-log-commit-state-change", { bubbles: true }),
    );
  }

  // The children are drawn the first time one is needed, which can be before
  // the page is in the document.
  private get commitTree() {
    this.performUpdate();
    return this.filesList.value as CaffoldCommitChangesTree;
  }

  private get panelResizer() {
    this.performUpdate();
    return this.paneResizer.value as CaffoldPaneResizer;
  }

  private get fileViewer() {
    this.performUpdate();
    return this.viewer.value as CaffoldReviewFileViewer;
  }
}

customElements.define("caffold-git-log-commit-page", CaffoldGitLogCommitPage);
