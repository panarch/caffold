import { html } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type GitHubPullFileDiff,
  type GitHubPullFiles,
  type GitRepository,
  getGitHubPullFile,
  getGitHubPullFiles,
} from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/file-viewer.js";
import type {
  AdjacentFile,
  CaffoldReviewFileViewer,
  FileViewerOpenAdjacentDetail,
} from "#components/file-viewer.js";
import {
  diffViewerPresentation,
  type ViewerPresentation,
} from "#components/file-viewer-presentation.js";
import "#components/split-view.js";
import type { CaffoldSplitView } from "#components/split-view.js";
import "./components/tree.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldGithubPullFilesTree } from "./components/tree.js";

import styles from "./page.css.js";

const LOADING_DELAY_MS = 180;

type DetailView = "list" | "viewer";

@customElement("caffold-github-pull-files-page")
export class CaffoldGithubPullFilesPage extends CaffoldElement {
  static override styles = styles;

  // What the Pull Requests layout reads back.
  detailView: DetailView = "list";
  private currentPath = "";
  private repository: GitRepository | null = null;
  private pullFiles: GitHubPullFiles | null = null;
  private pullNumber: number | null = null;
  private viewerPresentation: ViewerPresentation | null = null;
  private filesRequestId = 0;
  private fileRequestId = 0;
  private treeScrollTop = 0;
  private readonly filesList = new DrawnRef<CaffoldGithubPullFilesTree>(this);
  private readonly splitView = new DrawnRef<CaffoldSplitView>(this);
  private readonly viewer = new DrawnRef<CaffoldReviewFileViewer>(this);

  override render() {
    return html`
      <caffold-split-view
        ${drawn(this.splitView)}
        storage-key="caffold:pane-width:github-pull-files"
        collapsed-storage-key="caffold:pane-collapsed:github-pull-files"
        resizer-label="Resize review side panel"
        pane-label="review side panel"
      >
        <caffold-github-pull-files-tree
          ${drawn(this.filesList)}
          slot="list"
        ></caffold-github-pull-files-tree>
        <caffold-review-file-viewer
          ${drawn(this.viewer)}
          slot="detail"
          @caffold:file-viewer-open-adjacent=${this.openAdjacent}
        ></caffold-review-file-viewer>
      </caffold-split-view>
    `;
  }

  override firstUpdated() {
    this.fileViewer.setCloseLabel("Back to PR files");
  }

  reset() {
    this.filesRequestId += 1;
    this.fileRequestId += 1;
    this.pullFiles = null;
    this.pullNumber = null;
    this.viewerPresentation = null;
    this.treeScrollTop = 0;
    this.setView("list");
    this.tree.reset();
    this.fileViewer.setEmpty();
    this.emitStateChange();
  }

  invalidateRequests() {
    this.filesRequestId += 1;
    this.fileRequestId += 1;
  }

  setContext({
    path,
    repository,
  }: {
    path?: string;
    repository?: GitRepository | null;
  } = {}) {
    const nextPath = path ?? this.currentPath;
    const nextRepository = repository ?? this.repository;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath;
    this.currentPath = nextPath;
    this.repository = nextRepository;
    if (contextChanged) {
      this.filesRequestId += 1;
      this.fileRequestId += 1;
      this.pullFiles = null;
      this.pullNumber = null;
      this.viewerPresentation = null;
      this.treeScrollTop = 0;
      this.setView("list");
      this.tree.reset();
      this.fileViewer.setEmpty();
    }
  }

  // The pull request's file tree the workspace's side pane toggle hides and
  // shows.
  sidePane() {
    return this.split.sidePane();
  }

  deactivate() {
    this.fileViewer.deactivate();
    this.split.closeDrawer();
  }

  // `preserveView` keeps an open file on screen while the list changes.
  setError(error: Error, { preserveView = false } = {}) {
    if (!preserveView) {
      this.setView("list");
    }
    this.tree.setError(error);
  }

  async openFiles(
    number: number,
    {
      preserveViewer = false,
      skipReload = false,
    }: { preserveViewer?: boolean; skipReload?: boolean } = {},
  ) {
    if (!this.repository || !Number.isFinite(number)) {
      return null;
    }
    const requestId = ++this.filesRequestId;
    const viewerRequestId = ++this.fileRequestId;
    this.pullNumber = number;
    this.setView(preserveViewer ? "viewer" : "list");
    if (!skipReload) {
      this.tree.setLoading();
    }
    if (!preserveViewer && viewerRequestId === this.fileRequestId) {
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();
    if (skipReload) {
      return this.pullFiles;
    }

    try {
      const files = await getGitHubPullFiles(this.currentPath, number);
      if (requestId !== this.filesRequestId) {
        return null;
      }
      this.pullFiles = files;
      if (!preserveViewer) {
        this.setView("list");
      }
      this.tree.setFiles(files);
      if (viewerRequestId === this.fileRequestId && !preserveViewer) {
        this.fileViewer.setEmpty();
      }
      this.emitStateChange();
      return files;
    } catch (error) {
      if (requestId !== this.filesRequestId) {
        return null;
      }
      this.setError(error as Error, { preserveView: preserveViewer });
      if (
        preserveViewer &&
        viewerRequestId === this.fileRequestId &&
        this.viewerPresentation
      ) {
        this.fileViewer.setError(this.viewerPresentation, error as Error);
      }
      this.emitStateChange();
      return null;
    }
  }

  async openFile(path: string, status = "") {
    const number = this.currentPullNumber();
    if (!number || !path) {
      return null;
    }
    const requestId = ++this.fileRequestId;
    this.tree.setSelectedPath(path);
    this.treeScrollTop = this.tree.scroller()?.scrollTop ?? this.treeScrollTop;
    this.setView("viewer");
    this.split.closeDrawer();
    this.emitStateChange();
    const presentation = this.diffPresentation(path, status);
    this.viewerPresentation = presentation;
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.fileRequestId) {
        this.fileViewer.setLoading(presentation);
      }
    }, LOADING_DELAY_MS);

    try {
      const diff = await getGitHubPullFile(this.currentPath, number, path);
      if (requestId !== this.fileRequestId) {
        return null;
      }
      const loadedPresentation = this.diffPresentation(
        path,
        status,
        number,
        diff,
      );
      this.viewerPresentation = loadedPresentation;
      if (diff.diffUnavailable) {
        this.fileViewer.setError(
          loadedPresentation,
          new Error(diff.message ?? "Diff unavailable."),
        );
      } else {
        this.fileViewer.setDiff(
          { diff: diff.diff, status },
          { presentation: loadedPresentation },
        );
      }
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

  // Back from a file on one pane, the tree returns to where it was left.
  showList() {
    this.fileRequestId += 1;
    this.setView("list");
    this.tree.setSelectedPath("");
    this.viewerPresentation = null;
    this.fileViewer.setEmpty();
    const top = this.treeScrollTop;
    if (top > 0) {
      window.requestAnimationFrame(() => {
        const scroller = this.tree.scroller();
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

  prepareRoute(number: number, { path = "" }: { path?: string } = {}) {
    if (!Number.isFinite(number)) {
      this.reset();
      return;
    }
    this.pullNumber = number;
    if (path) {
      this.tree.setSelectedPath(path);
      this.setView("viewer");
      this.viewerPresentation = this.diffPresentation(path, "", number);
      this.fileViewer.setLoading(this.viewerPresentation);
    } else {
      this.tree.setSelectedPath("");
      this.setView("list");
      this.viewerPresentation = null;
      this.fileViewer.setEmpty();
    }
    this.emitStateChange();
  }

  clearViewer() {
    this.fileRequestId += 1;
    this.viewerPresentation = null;
    this.fileViewer.setEmpty();
  }

  canReuseFiles(number: number) {
    return this.pullFiles?.number === number;
  }

  findFile(path: string) {
    return this.pullFiles?.files.find((entry) => entry.path === path) ?? null;
  }

  currentPullNumber() {
    return this.pullNumber ?? this.pullFiles?.number ?? null;
  }

  actionHintScope({
    scopeId = "github:pull-files",
    clipRoots = [],
  }: ActionHintPull = {}) {
    const number = this.currentPullNumber();
    if (!number || this.hidden) {
      return emptyActionHintScope();
    }
    const split = this.split;
    const listActive = split.listShown();
    const viewerActive = this.detailView === "viewer" && split.detailShown();
    const prefix = `${scopeId}:${number}`;
    const resizerScope = split.actionHintScope({
      scopeId: `${prefix}:files`,
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      clipRoots: [this, ...clipRoots],
    });
    return mergeActionHintScopes(
      listActive
        ? this.tree.actionHintScope({
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
    scopeId = "github:pull-files",
    clipRoots = [],
  }: ScrollSurfacePull = {}) {
    const number = this.currentPullNumber();
    if (!number || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const split = this.split;
    const listActive = split.listShown();
    const viewerActive = this.detailView === "viewer" && split.detailShown();
    const prefix = `${scopeId}:${number}`;
    return mergeScrollSurfaceScopes(
      listActive && hasScrollLayoutBox(this.tree)
        ? this.tree.scrollSurfaceScope({
            scopeId: `${prefix}:files`,
            label: "Pull request files",
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

  keyboardNavigationContexts({ scopeId = "github:pull-files" } = {}) {
    const number = this.currentPullNumber();
    return number &&
      !this.hidden &&
      this.detailView === "viewer" &&
      this.split.detailShown()
      ? this.fileViewer.keyboardNavigationContexts({
          scopeId: `${scopeId}:${number}:viewer`,
        })
      : [];
  }

  private setView(view: DetailView) {
    if (view !== "viewer") {
      this.fileViewer.deactivate();
    }
    this.detailView = view;
    this.dataset.detailView = view;
    this.split.setDetailOpen(view === "viewer");
  }

  private diffPresentation(
    path: string,
    status = "",
    number = this.currentPullNumber(),
    diff: Partial<GitHubPullFileDiff> = {},
  ) {
    const file = this.findFile(path);
    const fileStatsAvailable =
      file !== null &&
      (file.patchAvailable || file.additions > 0 || file.deletions > 0);
    return diffViewerPresentation({
      repository: diff.repository ?? this.repository,
      path: diff.path ?? path,
      repoRelativePath: diff.repoRelativePath ?? file?.repoRelativePath,
      kind: diff.kind || (number !== null ? `PR #${number}` : ""),
      status: status || file?.status || "",
      additions: Object.hasOwn(diff, "additions")
        ? (diff.additions ?? undefined)
        : fileStatsAvailable
          ? file.additions
          : undefined,
      deletions: Object.hasOwn(diff, "deletions")
        ? (diff.deletions ?? undefined)
        : fileStatsAvailable
          ? file.deletions
          : undefined,
    });
  }

  // A file the person goes to from the end of another opens as a choice in
  // the tree does.
  private openAdjacent(event: CustomEvent<FileViewerOpenAdjacentDetail>) {
    event.stopPropagation();
    this.tree.openPath(event.detail.path);
  }

  // The open file ends with the pull request's files before and after it,
  // in the tree's order.
  private patchAdjacentFiles() {
    const path = this.detailView === "viewer" ? this.tree.selectedPath : "";
    const order = path ? this.tree.changedPathsInOrder() : [];
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
    this.split.setListName("Changes", this.pullFiles?.files?.length ?? null);
    this.dispatchEvent(
      new CustomEvent("caffold:github-pull-files-state-change", {
        bubbles: true,
      }),
    );
  }

  // The children are drawn the first time one is needed, which can be before
  // the page is in the document.
  private get tree() {
    this.performUpdate();
    return this.filesList.value as CaffoldGithubPullFilesTree;
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
    "caffold-github-pull-files-page": CaffoldGithubPullFilesPage;
  }
}
