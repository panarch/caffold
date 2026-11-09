import { html } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type GitCommit,
  type GitDiff,
  type GitDiffVersions,
  type GitRepository,
  getGitCommit,
  getGitCommitDiff,
  getGitCommitDiffVersions,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import {
  type ChangeRepresentation,
  changeRepresentationChoices,
  changeRepresentationFor,
} from "#components/dom.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-viewer.js";
import type {
  AdjacentFile,
  CaffoldReviewFileViewer,
  FileViewerChangeIntentDetail,
  FileViewerOpenAdjacentDetail,
} from "#components/file-viewer.js";
import {
  diffViewerPresentation,
  type ViewerPresentation,
} from "#components/file-viewer-presentation.js";
import "#components/split-view.js";
import type { CaffoldSplitView } from "#components/split-view.js";
import "./components/changes-tree.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldCommitChangesTree } from "./components/changes-tree.js";

import styles from "./page.css.js";

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

@customElement("caffold-git-log-commit-page")
export class CaffoldGitLogCommitPage extends CaffoldElement {
  static override styles = styles;

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
  // How the last file's change was shown; the next file opens the same way
  // when it can.
  private changeView: ChangeRepresentation = "diff";
  private readonly filesList = new DrawnRef<CaffoldCommitChangesTree>(this);
  private readonly splitView = new DrawnRef<CaffoldSplitView>(this);
  private readonly viewer = new DrawnRef<CaffoldReviewFileViewer>(this);

  override render() {
    return html`
      <caffold-split-view
        ${drawn(this.splitView)}
        storage-key="caffold:pane-width:git-log-commit"
        collapsed-storage-key="caffold:pane-collapsed:git-log-commit"
        resizer-label="Resize review side panel"
        pane-label="review side panel"
      >
        <caffold-commit-changes-tree
          ${drawn(this.filesList)}
          slot="list"
        ></caffold-commit-changes-tree>
        <caffold-review-file-viewer
          ${drawn(this.viewer)}
          slot="detail"
          refresh-action="refresh-git-review"
          @caffold:file-viewer-change-intent=${this.chooseChange}
          @caffold:file-viewer-open-adjacent=${this.openAdjacent}
        ></caffold-review-file-viewer>
      </caffold-split-view>
    `;
  }

  override firstUpdated() {
    this.fileViewer.setCloseLabel("Back to commit");
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
    this.split.closeDrawer();
    this.emitStateChange();
    const presentation = this.diffPresentation(path, sha, options.status);
    this.viewerPresentation = presentation;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(presentation);
      }
    }, LOADING_DELAY_MS);

    try {
      return await this.loadChange(
        path,
        sha,
        options.status ?? "",
        () => requestId === this.fileRequestId,
      );
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
    this.split.closeDrawer();
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
    const split = this.split;
    const listActive = split.listShown();
    const viewerActive = this.detailView === "viewer" && split.detailShown();
    const prefix = `${scopeId}:${encodeURIComponent(sha)}`;
    const resizerScope = split.actionHintScope({
      scopeId: `${prefix}:files`,
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this, ...clipRoots],
    });
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
              axis: ACTION_HINT_ACTION.REVIEW_AXIS,
              button: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
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
    const split = this.split;
    const listActive = split.listShown();
    const viewerActive = this.detailView === "viewer" && split.detailShown();
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
    return sha &&
      !this.hidden &&
      this.detailView === "viewer" &&
      this.split.detailShown()
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
    this.split.setDetailOpen(view === "viewer");
  }

  // The commit's file tree the workspace's side pane toggle hides and shows.
  sidePane() {
    return this.split.sidePane();
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
      if (this.split.showsOnePane()) {
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
      return await this.loadChange(
        path,
        sha,
        file.status,
        () =>
          requestId === this.fileRequestId &&
          path === this.commitTree.selectedPath,
        { preserveScroll: true },
      );
    } catch (error) {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setError(presentation, error as Error);
      }
      return null;
    }
  }

  // Reads the file's change in the representation it opens in and shows it,
  // unless `current` says a newer request took over meanwhile.
  private async loadChange(
    path: string,
    sha: string,
    status: string,
    current: () => boolean,
    { preserveScroll = false }: { preserveScroll?: boolean } = {},
  ) {
    this.changeView = changeRepresentationFor(path, this.changeView);
    this.fileViewer.setChangeChoices(
      changeRepresentationChoices(path, this.changeView),
    );
    if (this.changeView === "visual") {
      const versions = await getGitCommitDiffVersions(
        this.currentPath,
        sha,
        path,
      );
      if (!current()) {
        return null;
      }
      const presentation = this.diffPresentation(path, sha, status, versions);
      this.viewerPresentation = presentation;
      this.fileViewer.setVisual(versions, { presentation });
      return versions;
    }
    const diff = await getGitCommitDiff(this.currentPath, sha, path);
    if (!current()) {
      return null;
    }
    const presentation = this.diffPresentation(path, sha, status, diff);
    this.viewerPresentation = presentation;
    this.fileViewer.setDiff(
      { ...diff, status },
      { preserveScroll, presentation },
    );
    return diff;
  }

  private chooseChange(event: CustomEvent<FileViewerChangeIntentDetail>) {
    const representation = event.detail?.representation;
    if (
      (representation === "diff" || representation === "visual") &&
      representation !== this.changeView
    ) {
      this.changeView = representation;
      void this.refreshSelectedDiff();
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
    diff: GitDiff | GitDiffVersions = {},
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

  // A file the person goes to from the end of another opens as a choice in
  // the tree does.
  private openAdjacent(event: CustomEvent<FileViewerOpenAdjacentDetail>) {
    event.stopPropagation();
    this.commitTree.openPath(event.detail.path);
  }

  // The open file ends with the commit's files before and after it, in the
  // tree's order.
  private patchAdjacentFiles() {
    const path =
      this.detailView === "viewer" ? this.commitTree.selectedPath : "";
    const order = path ? this.commitTree.changedPathsInOrder() : [];
    const index = order.indexOf(path);
    const describe = (candidate: string | undefined): AdjacentFile | null => {
      const file = candidate ? this.findFile(candidate) : null;
      if (!file) {
        return null;
      }
      const shown = file.repoRelativePath || file.path;
      const slash = shown.lastIndexOf("/");
      return {
        path: file.path,
        name: shown.slice(slash + 1),
        folder: slash > 0 ? shown.slice(0, slash) : "",
      };
    };
    this.fileViewer.setAdjacentFiles({
      previous: index > 0 ? describe(order[index - 1]) : null,
      next: index >= 0 ? describe(order[index + 1]) : null,
    });
  }

  private emitStateChange() {
    this.patchAdjacentFiles();
    this.split.setListName(
      "Changes",
      this.commitPayload?.files?.length ?? null,
    );
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

  private get split() {
    this.performUpdate();
    return this.splitView.value as CaffoldSplitView;
  }

  private get fileViewer() {
    this.performUpdate();
    return this.viewer.value as CaffoldReviewFileViewer;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-git-log-commit-page": CaffoldGitLogCommitPage;
  }
}
