import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { type ActionHintPull, mergeActionHintScopes } from "../action-hints.js";
import {
  type GitCompare,
  type GitDiff,
  type GitRef,
  type GitRefs,
  type GitRepository,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
} from "../api.js";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
} from "../scroll-scope.js";
import "./file-viewer.js";
import type { CaffoldReviewFileViewer } from "./file-viewer.js";
import { diffViewerPresentation } from "./file-viewer-presentation.js";
import "./git-compare-tree.js";
import type { CaffoldGitCompareTree } from "./git-compare-tree.js";
import "./pane-resizer.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import type { CaffoldPaneResizer, PaneResizeDetail } from "./pane-resizer.js";
import { REVIEW_SINGLE_PANE_MEDIA_QUERY } from "./review-responsive.js";

export interface GitCompareStateChangeDetail {
  detailView: DetailView;
  refsPayload: GitRefs | null;
  baseRef: string | null;
  headRef: string | null;
  compare: GitCompare | null;
}

const LOADING_DELAY_MS = 180;

type DetailView = "list" | "viewer";

@customElement("caffold-git-compare-browser")
export class CaffoldGitCompareBrowser extends LitElement {
  // What the Compare page reads back.
  repository: GitRepository | null = null;
  refsPayload: GitRefs | null = null;
  compare: GitCompare | null = null;
  baseRef: string | null = null;
  headRef: string | null = null;
  detailView: DetailView = "list";
  private currentPath = "";
  private pendingCompare: {
    key: string;
    promise: Promise<GitCompare | null>;
  } | null = null;
  private refsRequestId = 0;
  private compareRequestId = 0;
  private diffRequestId = 0;
  private compareScrollTop = 0;
  private readonly tree = new DrawnRef<CaffoldGitCompareTree>(this);
  private readonly resizer = new DrawnRef<CaffoldPaneResizer>(this);
  private readonly fileViewer = new DrawnRef<CaffoldReviewFileViewer>(this);

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  override render() {
    return html`
      <caffold-git-compare-tree ${drawn(this.tree)}></caffold-git-compare-tree>
      <caffold-pane-resizer
        ${drawn(this.resizer)}
        storage-key="caffold:pane-width:git-compare"
        collapsed-storage-key="caffold:pane-collapsed:git-compare"
        aria-label="Resize review side panel"
        @caffold:pane-resize=${this.handlePanelResize}
      ></caffold-pane-resizer>
      <caffold-review-file-viewer
        ${drawn(this.fileViewer)}
        refresh-action="refresh-git-review"
      ></caffold-review-file-viewer>
    `;
  }

  override firstUpdated() {
    this.viewer.setCloseLabel("Back to compare");
    this.setView(this.detailView);
    this.applyPanelWidth();
  }

  deactivate() {
    this.viewer.deactivate();
  }

  reset() {
    this.refsRequestId += 1;
    this.compareRequestId += 1;
    this.diffRequestId += 1;
    this.currentPath = "";
    this.repository = null;
    this.refsPayload = null;
    this.compare = null;
    this.pendingCompare = null;
    this.baseRef = null;
    this.headRef = null;
    this.compareScrollTop = 0;
    this.compareTree.reset();
    this.viewer.setEmpty();
    this.setView("list");
    this.emitStateChange();
  }

  invalidateRequests() {
    this.refsRequestId += 1;
    this.compareRequestId += 1;
    this.diffRequestId += 1;
    this.pendingCompare = null;
  }

  async openCompare(
    options: {
      path?: string;
      repository?: GitRepository | null;
      baseRef?: string | null;
      headRef?: string | null;
      preserveViewer?: boolean;
      skipReload?: boolean;
    } = {},
  ) {
    this.setContext(options);
    if (options.preserveViewer) {
      this.setView("viewer");
    } else {
      this.showList();
      this.setEmpty();
    }
    this.emitStateChange();

    if (options.skipReload) {
      return this.compare;
    }

    if (!this.refsPayload) {
      return await this.loadRefsAndCompare();
    }

    if (
      !this.compare ||
      this.compare.baseRef !== this.baseRef ||
      this.compare.headRef !== this.headRef
    ) {
      return await this.loadCompare(this.baseRef, this.headRef);
    }

    this.compareTree.setCompare(this.compare);
    return this.compare;
  }

  async openDiff(path: string, status = "") {
    if (!path || !this.compare) {
      return null;
    }

    const requestId = ++this.diffRequestId;
    this.rememberCompareScroll();
    this.compareTree.setSelectedPath(path);
    this.setView("viewer");
    const presentation = this.diffPresentation(path, status);
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.diffRequestId) {
        this.viewer.setLoading(presentation);
      }
    }, LOADING_DELAY_MS);

    try {
      const diff = await getGitCompareDiff(
        this.currentPath,
        this.compare.baseRef,
        this.compare.headRef,
        path,
      );
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setDiff(
        { ...diff, status },
        { presentation: this.diffPresentation(path, status, diff) },
      );
      return diff;
    } catch (error) {
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setError(presentation, error as Error);
      return null;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async refresh() {
    if (!this.repository) {
      return null;
    }
    const refsRequestId = ++this.refsRequestId;
    const compareRequestId = ++this.compareRequestId;
    this.pendingCompare = null;

    try {
      const refs = await getGitRefs(this.currentPath);
      if (refsRequestId !== this.refsRequestId) {
        return null;
      }
      const baseRef = chooseCompareRef(
        this.baseRef,
        refs.defaultBaseRef,
        refs.refs,
      );
      const headRef = chooseCompareRef(
        this.headRef,
        refs.defaultHeadRef,
        refs.refs,
      );
      const compare = await getGitCompare(this.currentPath, baseRef, headRef);
      if (compareRequestId !== this.compareRequestId) {
        return null;
      }

      this.refsPayload = refs;
      this.baseRef = compare.baseRef;
      this.headRef = compare.headRef;
      this.compare = compare;
      this.repository = compare.repository;
      this.compareTree.updateCompare(compare);
      await this.refreshSelectedDiff();
      this.emitStateChange();
      return compare;
    } catch (error) {
      if (
        refsRequestId === this.refsRequestId &&
        compareRequestId === this.compareRequestId
      ) {
        this.compareTree.setError(error as Error, this.repository);
        this.emitStateChange();
      }
      return null;
    }
  }

  setContext({
    path,
    repository,
    baseRef,
    headRef,
  }: {
    path?: string;
    repository?: GitRepository | null;
    baseRef?: string | null;
    headRef?: string | null;
  } = {}) {
    const nextPath = path ?? this.currentPath;
    const nextRepository = repository ?? this.repository;
    const contextChanged =
      nextPath !== this.currentPath ||
      nextRepository?.rootPath !== this.repository?.rootPath;

    this.currentPath = nextPath;
    this.repository = nextRepository;

    if (contextChanged) {
      this.refsRequestId += 1;
      this.compareRequestId += 1;
      this.diffRequestId += 1;
      this.refsPayload = null;
      this.compare = null;
      this.pendingCompare = null;
      this.baseRef = null;
      this.headRef = null;
      this.compareScrollTop = 0;
      this.compareTree.reset();
      this.viewer.setEmpty();
      this.setView("list");
    }

    if (baseRef !== undefined) {
      this.baseRef = baseRef || null;
    }
    if (headRef !== undefined) {
      this.headRef = headRef || null;
    }
  }

  setSelectedPath(path: string | null | undefined) {
    if (!path) {
      this.diffRequestId += 1;
    }
    this.compareTree.setSelectedPath(path);
  }

  setEmpty() {
    this.diffRequestId += 1;
    this.viewer.setEmpty();
  }

  showList() {
    this.setView("list");
    this.restoreCompareScroll();
  }

  fileForPath(path: string) {
    return this.compare?.files?.find((entry) => entry.path === path) ?? null;
  }

  // `actions` names what each kind of control does: `file`, `disclosure`,
  // and `select` in the compared files, `separator` on the resizer, and
  // `parent`, `details`, `refresh`, and `link` in the viewer.
  actionHintScope(pull: ActionHintPull = {}) {
    const listActive =
      !this.sidePaneCollapsed() &&
      (this.detailView === "list" ||
        !window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches);
    const clipRoots = [this, ...(pull.clipRoots ?? [])];
    return mergeActionHintScopes(
      listActive
        ? this.compareTree.actionHintScope({
            ...pull,
            scopeId: `${pull.scopeId}:compare`,
            clipRoots,
          })
        : null,
      this.panelResizer.actionHintScope({
        scopeId: pull.scopeId,
        actionId: pull.actions?.separator,
        clipRoots,
      }),
      this.detailView === "viewer"
        ? this.viewer.actionHintScope({
            ...pull,
            scopeId: `${pull.scopeId}:viewer`,
            clipRoots,
          })
        : null,
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    const singlePane = window.matchMedia(
      REVIEW_SINGLE_PANE_MEDIA_QUERY,
    ).matches;
    const listActive =
      !this.sidePaneCollapsed() && (this.detailView === "list" || !singlePane);
    const clipRoots = [this, ...(pull.clipRoots ?? [])];
    return mergeScrollSurfaceScopes(
      listActive
        ? this.compareTree.scrollSurfaceScope({
            ...pull,
            scopeId: `${pull.scopeId}:compare`,
            label: "Compared files",
            clipRoots,
          })
        : null,
      this.detailView === "viewer"
        ? this.viewer.scrollSurfaceScope({
            ...pull,
            scopeId: `${pull.scopeId}:viewer`,
            clipRoots,
          })
        : null,
    );
  }

  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    return scopeId && !this.hidden && this.detailView === "viewer"
      ? this.viewer.keyboardNavigationContexts({
          scopeId: `${scopeId}:viewer`,
        })
      : [];
  }

  setView(view: string) {
    const nextView = view === "viewer" ? "viewer" : "list";
    if (nextView !== "viewer") {
      this.viewer.deactivate();
    }
    const changed =
      this.detailView !== nextView || this.dataset.detailView !== nextView;
    this.detailView = nextView;
    this.dataset.detailView = this.detailView;
    this.applySidePane();
    if (changed) {
      this.emitStateChange();
    }
  }

  /**
   * The compared-files tree the workspace's side pane toggle hides and shows.
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

  // The children are drawn the first time one is needed, which can be before
  // the browser is in the document.
  private get compareTree() {
    this.performUpdate();
    return this.tree.value as CaffoldGitCompareTree;
  }

  private get panelResizer() {
    this.performUpdate();
    return this.resizer.value as CaffoldPaneResizer;
  }

  private get viewer() {
    this.performUpdate();
    return this.fileViewer.value as CaffoldReviewFileViewer;
  }

  private async loadRefsAndCompare() {
    if (!this.repository) {
      return null;
    }

    const requestId = ++this.refsRequestId;
    this.compareTree.setLoading(this.repository);
    this.emitStateChange();

    try {
      const refs = await getGitRefs(this.currentPath);
      if (requestId !== this.refsRequestId) {
        return null;
      }

      this.refsPayload = refs;
      this.repository = refs.repository;
      this.baseRef = chooseCompareRef(
        this.baseRef,
        refs.defaultBaseRef,
        refs.refs,
      );
      this.headRef = chooseCompareRef(
        this.headRef,
        refs.defaultHeadRef,
        refs.refs,
      );
      this.emitStateChange();
      return await this.loadCompare(this.baseRef, this.headRef);
    } catch (error) {
      if (requestId !== this.refsRequestId) {
        return null;
      }

      this.compareTree.setError(error as Error, this.repository);
      this.emitStateChange();
      return null;
    }
  }

  private async loadCompare(
    baseRef: string | null = this.baseRef,
    headRef: string | null = this.headRef,
  ) {
    if (!this.repository) {
      return null;
    }

    const requestKey = `${this.currentPath}\u0000${baseRef ?? ""}\u0000${headRef ?? ""}`;
    if (this.pendingCompare?.key === requestKey) {
      return await this.pendingCompare.promise;
    }

    const requestId = ++this.compareRequestId;
    this.baseRef = baseRef ?? null;
    this.headRef = headRef ?? null;
    this.compareTree.setLoading(this.repository);
    this.emitStateChange();

    const promise = (async () => {
      const compare = await getGitCompare(
        this.currentPath,
        this.baseRef,
        this.headRef,
      );
      if (requestId !== this.compareRequestId) {
        return null;
      }

      this.baseRef = compare.baseRef;
      this.headRef = compare.headRef;
      this.compare = compare;
      this.repository = compare.repository;
      this.compareTree.setCompare(compare);
      this.emitStateChange();
      return compare;
    })();

    this.pendingCompare = { key: requestKey, promise };

    try {
      return await promise;
    } catch (error) {
      if (requestId !== this.compareRequestId) {
        return null;
      }

      this.compareTree.setError(error as Error, this.repository);
      this.emitStateChange();
      return null;
    } finally {
      if (
        this.pendingCompare?.key === requestKey &&
        this.pendingCompare.promise === promise
      ) {
        this.pendingCompare = null;
      }
    }
  }

  private async refreshSelectedDiff() {
    const path = this.compareTree.selectedPath;
    if (!path || !this.compare) {
      return null;
    }
    const file = this.fileForPath(path);
    if (!file) {
      this.compareTree.setSelectedPath("");
      if (window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches) {
        this.showList();
      } else {
        this.viewer.setNotice("This file is no longer part of the comparison.");
      }
      return null;
    }

    const requestId = ++this.diffRequestId;
    try {
      const diff = await getGitCompareDiff(
        this.currentPath,
        this.compare.baseRef,
        this.compare.headRef,
        path,
      );
      if (
        requestId !== this.diffRequestId ||
        path !== this.compareTree.selectedPath
      ) {
        return null;
      }
      const presentation = this.diffPresentation(path, file.status ?? "", diff);
      this.viewer.setDiff(
        { ...diff, status: file.status ?? "" },
        { preserveScroll: true, presentation },
      );
      return diff;
    } catch (error) {
      if (requestId === this.diffRequestId) {
        this.viewer.setError(
          this.diffPresentation(path, file.status ?? ""),
          error as Error,
        );
      }
      return null;
    }
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

  private diffPresentation(path: string, status = "", diff: GitDiff = {}) {
    const file = this.fileForPath(path);
    return diffViewerPresentation({
      ...diff,
      repository: diff.repository ?? this.repository,
      path: diff.path ?? path,
      repoRelativePath: diff.repoRelativePath ?? file?.repoRelativePath,
      kind:
        diff.kind ||
        (this.compare?.baseRef && this.compare?.headRef
          ? `${this.compare.baseRef}...${this.compare.headRef}`
          : ""),
      status: status || file?.status || "",
    });
  }

  private rememberCompareScroll() {
    const scroller = this.compareTree.listScroller();
    if (!scroller) {
      return;
    }

    this.compareScrollTop = scroller.scrollTop;
  }

  private restoreCompareScroll() {
    const top = this.compareScrollTop;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = this.compareTree.listScroller();
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

  private handlePanelResize(event: CustomEvent<PaneResizeDetail>) {
    event.stopPropagation();
    if (event.detail.phase === "start") {
      this.classList.add("is-resizing-panel");
      return;
    }
    if (event.detail.phase === "end") {
      this.classList.remove("is-resizing-panel");
      return;
    }
    if (event.detail.phase === "update") {
      this.applyPanelWidth();
    }
  }

  private applyPanelWidth() {
    this.style.setProperty(
      "--git-compare-panel-width",
      `${this.panelResizer.value}px`,
    );
  }

  private emitStateChange() {
    this.dispatchEvent(
      new CustomEvent<GitCompareStateChangeDetail>(
        "caffold:git-compare-state-change",
        {
          bubbles: true,
          detail: {
            detailView: this.detailView,
            refsPayload: this.refsPayload,
            baseRef: this.baseRef,
            headRef: this.headRef,
            compare: this.compare,
          },
        },
      ),
    );
  }
}

function chooseCompareRef(
  preferredRef: string | null,
  fallbackRef: string | null | undefined,
  refs: GitRef[] = [],
) {
  if (
    preferredRef &&
    (preferredRef === "HEAD" || refs.some((ref) => ref.name === preferredRef))
  ) {
    return preferredRef;
  }

  if (fallbackRef && refs.some((ref) => ref.name === fallbackRef)) {
    return fallbackRef;
  }

  return refs[0]?.name ?? fallbackRef ?? preferredRef ?? null;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-git-compare-browser": CaffoldGitCompareBrowser;
  }

  interface HTMLElementEventMap {
    "caffold:git-compare-state-change": CustomEvent<GitCompareStateChangeDetail>;
  }
}
