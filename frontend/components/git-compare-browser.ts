import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import {
  type GitCompare,
  type GitCompareDiff,
  type GitRef,
  type GitRefs,
  type GitRepository,
  getGitCompare,
  getGitCompareDiff,
  getGitRefs,
} from "../api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "../scroll-scope.js";
import "./file-viewer.ts";
import type { CaffoldReviewFileViewer } from "./file-viewer.ts";
import { diffViewerPresentation } from "./file-viewer-presentation.ts";
import "./git-compare-tree.ts";
import type { CaffoldGitCompareTree } from "./git-compare-tree.ts";
import "./pane-resizer.ts";
import type { CaffoldPaneResizer } from "./pane-resizer.ts";
import { REVIEW_SINGLE_PANE_MEDIA_QUERY } from "./review-responsive.ts";

const LOADING_DELAY_MS = 180;

type DetailView = "list" | "viewer";

class CaffoldGitCompareBrowser extends LitElement {
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

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  render() {
    return html`
      <caffold-git-compare-tree></caffold-git-compare-tree>
      <caffold-pane-resizer
        storage-key="caffold:pane-width:git-compare"
        collapsed-storage-key="caffold:pane-collapsed:git-compare"
        aria-label="Resize review side panel"
        @caffold:pane-resize=${this.handlePanelResize}
      ></caffold-pane-resizer>
      <caffold-review-file-viewer
        refresh-action="refresh-git-review"
      ></caffold-review-file-viewer>
    `;
  }

  firstUpdated() {
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

  async changeRefs(baseRef: string | null, headRef: string | null) {
    if (
      !baseRef ||
      !headRef ||
      (baseRef === this.baseRef && headRef === this.headRef)
    ) {
      return this.compare;
    }

    this.baseRef = baseRef;
    this.headRef = headRef;
    this.compare = null;
    this.setSelectedPath("");
    this.showList();
    this.setEmpty();
    this.emitStateChange();
    return await this.loadCompare(baseRef, headRef);
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

  setLoading(repository: GitRepository | null) {
    this.setContext({ repository });
    this.compareTree.setLoading(repository);
  }

  setCompare(comparePayload: GitCompare) {
    this.compare = comparePayload;
    this.baseRef = comparePayload.baseRef ?? this.baseRef;
    this.headRef = comparePayload.headRef ?? this.headRef;
    this.repository = comparePayload.repository ?? this.repository;
    this.compareTree.setCompare(comparePayload);
    this.emitStateChange();
  }

  setError(error: Error, repository: GitRepository | null = null) {
    this.compareTree.setError(error, repository);
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

  hasCompare(baseRef: string | null, headRef: string | null) {
    return (
      this.compare !== null &&
      this.compare.baseRef === (baseRef || null) &&
      this.compare.headRef === (headRef || null)
    );
  }

  fileForPath(path: string) {
    return this.compare?.files?.find((entry) => entry.path === path) ?? null;
  }

  isFileViewer(target: EventTarget | null) {
    return target === this.viewer;
  }

  actionHintScope({
    scopeId = "",
    fileActionId = "",
    disclosureActionId = "",
    selectActionId = "",
    parentActionId = "",
    detailsActionId = "",
    refreshActionId = "",
    linkActionId = "",
    separatorActionId = "",
    clipRoots = [],
  }: Omit<ActionHintScopeOptions, "actionId"> & {
    fileActionId?: string;
    disclosureActionId?: string;
    selectActionId?: string;
    parentActionId?: string;
    detailsActionId?: string;
    refreshActionId?: string;
    linkActionId?: string;
    separatorActionId?: string;
  } = {}): ActionHintScope {
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const listActive =
      !this.sidePaneCollapsed() &&
      (this.detailView === "list" ||
        !window.matchMedia(REVIEW_SINGLE_PANE_MEDIA_QUERY).matches);
    const viewerActive = this.detailView === "viewer";
    const resizer = this.panelResizer;
    const separatorScope = hasActionHintLayoutBox(resizer)
      ? resizer.actionHintScope({
          scopeId,
          actionId: separatorActionId,
          clipRoots: [this, ...clipRoots],
          isCurrent: () =>
            this.isConnected && !this.hidden && this.panelResizer === resizer,
        })
      : null;
    return mergeActionHintScopes(
      listActive
        ? this.compareTree.actionHintScope({
            scopeId: `${scopeId}:compare`,
            actionId: fileActionId,
            disclosureActionId,
            selectActionId,
            clipRoots: [this, ...clipRoots],
          })
        : null,
      separatorScope,
      viewerActive
        ? this.viewer.actionHintScope({
            scopeId: `${scopeId}:viewer`,
            actionId: parentActionId,
            detailsActionId,
            refreshActionId,
            linkActionId,
            clipRoots: [this, ...clipRoots],
          })
        : null,
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    if (!scopeId || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const singlePane = window.matchMedia(
      REVIEW_SINGLE_PANE_MEDIA_QUERY,
    ).matches;
    const listActive =
      !this.sidePaneCollapsed() && (this.detailView === "list" || !singlePane);
    const viewerActive = this.detailView === "viewer";
    return mergeScrollSurfaceScopes(
      listActive && hasScrollLayoutBox(this.compareTree)
        ? this.compareTree.scrollSurfaceScope({
            scopeId: `${scopeId}:compare`,
            label: "Compared files",
            clipRoots: [this, ...clipRoots],
          })
        : null,
      viewerActive && hasScrollLayoutBox(this.viewer)
        ? this.viewer.scrollSurfaceScope({
            scopeId: `${scopeId}:viewer`,
            clipRoots: [this, ...clipRoots],
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

  compareSubtitle(fallback = "Branches") {
    if (!this.compare) {
      return fallback;
    }

    const count = this.compare.files?.length ?? 0;
    const countLabel = `${count} ${count === 1 ? "file" : "files"}`;
    if ((this.refsPayload?.refs ?? []).length > 0) {
      return countLabel;
    }

    return `${this.compare.baseRef}...${this.compare.headRef} · ${countLabel}`;
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
    return this.querySelector(
      ":scope > caffold-git-compare-tree",
    ) as CaffoldGitCompareTree;
  }

  private get panelResizer() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-pane-resizer",
    ) as CaffoldPaneResizer;
  }

  private get viewer() {
    this.performUpdate();
    return this.querySelector(
      ":scope > caffold-review-file-viewer",
    ) as CaffoldReviewFileViewer;
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

  private diffPresentation(
    path: string,
    status = "",
    diff: GitCompareDiff = {},
  ) {
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
    const scroller = this.querySelector(".file-tree-scroll");
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
      const scroller = this.querySelector(".file-tree-scroll");
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

  private handlePanelResize(event: CustomEvent<{ phase: string }>) {
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
      new CustomEvent("caffold:git-compare-state-change", {
        bubbles: true,
        detail: {
          detailView: this.detailView,
          refsPayload: this.refsPayload,
          baseRef: this.baseRef,
          headRef: this.headRef,
          compare: this.compare,
        },
      }),
    );
  }
}

customElements.define("caffold-git-compare-browser", CaffoldGitCompareBrowser);

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
