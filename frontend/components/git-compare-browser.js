import { getGitCompare, getGitCompareDiff, getGitRefs } from "../api.js";
import "./file-viewer.js";
import "./git-compare-browser/compare-tree.js";

const LOADING_DELAY_MS = 180;
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 180;
const VIEWER_MIN_WIDTH = 320;
const PANEL_MAX_RATIO = 0.7;

class CaffoldGitCompareBrowser extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-git-compare-tree></caffold-git-compare-tree>
      <div
        class="git-compare-panel-resizer"
        role="separator"
        aria-label="Resize review side panel"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
      <caffold-review-file-viewer refresh-action="refresh-git-review"></caffold-review-file-viewer>
    `;
    this.compareTree = this.querySelector("caffold-git-compare-tree");
    this.panelResizer = this.querySelector(".git-compare-panel-resizer");
    this.viewer = this.querySelector("caffold-review-file-viewer");
    this.viewer.setCloseLabel("Back to compare");
    this.refsRequestId ??= 0;
    this.compareRequestId ??= 0;
    this.diffRequestId ??= 0;
    this.compareScrollTop ??= 0;
    this.panelWidth ??= PANEL_DEFAULT_WIDTH;
    this.resizePointerId ??= null;
    this.setView(this.detailView ?? "list");
    this.applyPanelWidth(this.panelWidth);

    this.panelResizer.addEventListener("pointerdown", (event) => {
      this.startPanelResize(event);
    });
    this.panelResizer.addEventListener("pointermove", (event) => {
      this.movePanelResize(event);
    });
    this.panelResizer.addEventListener("pointerup", (event) => {
      this.endPanelResize(event);
    });
    this.panelResizer.addEventListener("pointercancel", (event) => {
      this.endPanelResize(event);
    });
    this.panelResizer.addEventListener("keydown", (event) => {
      this.adjustPanelWidthFromKeyboard(event);
    });
  }

  reset() {
    this.ensureRendered();
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

  stateSnapshot() {
    this.ensureRendered();
    return {
      currentPath: this.currentPath ?? "",
      repository: this.repository,
      refsPayload: this.refsPayload,
      compare: this.compare,
      baseRef: this.baseRef,
      headRef: this.headRef,
      selectedPath: this.compareTree.selectedPath ?? "",
      detailView: this.detailView,
      compareScrollTop: this.compareScrollTop ?? 0,
      panelWidth: this.panelWidth ?? PANEL_DEFAULT_WIDTH,
    };
  }

  restoreState(state) {
    if (!state) {
      return;
    }

    this.ensureRendered();
    this.refsRequestId += 1;
    this.compareRequestId += 1;
    this.diffRequestId += 1;
    this.pendingCompare = null;
    this.currentPath = state.currentPath ?? "";
    this.repository = state.repository ?? null;
    this.refsPayload = state.refsPayload ?? null;
    this.compare = state.compare ?? null;
    this.baseRef = state.baseRef ?? null;
    this.headRef = state.headRef ?? null;
    this.compareScrollTop = state.compareScrollTop ?? 0;
    this.applyPanelWidth(state.panelWidth ?? PANEL_DEFAULT_WIDTH);
    if (this.compare) {
      this.compareTree.setCompare(this.compare);
      this.compareTree.setSelectedPath(state.selectedPath ?? "");
    } else {
      this.compareTree.reset();
    }
    this.setView(state.detailView ?? "list");
    if (state.selectedPath && this.compare) {
      this.refreshSelectedDiff();
    }
    this.emitStateChange();
  }

  async openCompare(options = {}) {
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

  async loadRefsAndCompare() {
    if (!this.repository) {
      return null;
    }

    const requestId = ++this.refsRequestId;
    this.compareTree.setLoading(this.repository);
    this.emitStateChange();

    try {
      const refs = await getGitRefs(this.currentPath ?? "");
      if (requestId !== this.refsRequestId) {
        return null;
      }

      this.refsPayload = refs;
      this.repository = refs.repository;
      this.baseRef = chooseCompareRef(this.baseRef, refs.defaultBaseRef, refs.refs);
      this.headRef = chooseCompareRef(this.headRef, refs.defaultHeadRef, refs.refs);
      this.emitStateChange();
      return await this.loadCompare(this.baseRef, this.headRef);
    } catch (error) {
      if (requestId !== this.refsRequestId) {
        return null;
      }

      this.compareTree.setError(error, this.repository);
      this.emitStateChange();
      return null;
    }
  }

  async loadCompare(baseRef = this.baseRef, headRef = this.headRef) {
    if (!this.repository) {
      return null;
    }

    const requestKey = `${this.currentPath ?? ""}\u0000${baseRef ?? ""}\u0000${headRef ?? ""}`;
    if (this.pendingCompare?.key === requestKey) {
      return await this.pendingCompare.promise;
    }

    const requestId = ++this.compareRequestId;
    this.baseRef = baseRef ?? null;
    this.headRef = headRef ?? null;
    this.compareTree.setLoading(this.repository);
    this.emitStateChange();

    const promise = (async () => {
      const compare = await getGitCompare(this.currentPath ?? "", this.baseRef, this.headRef);
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

      this.compareTree.setError(error, this.repository);
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

  async changeRefs(baseRef, headRef) {
    if (!baseRef || !headRef || (baseRef === this.baseRef && headRef === this.headRef)) {
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

  async openDiff(path, status = "") {
    if (!path || !this.compare) {
      return null;
    }

    this.ensureRendered();
    const requestId = ++this.diffRequestId;
    this.rememberCompareScroll();
    this.compareTree.setSelectedPath(path);
    this.setView("viewer");
    const loadingTimer = this.showLoadingAfterDelay(`Compare diff ${path}`, requestId);

    try {
      const diff = await getGitCompareDiff(
        this.currentPath ?? "",
        this.compare.baseRef,
        this.compare.headRef,
        path,
      );
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setDiff({ ...diff, status });
      return diff;
    } catch (error) {
      if (requestId !== this.diffRequestId) {
        return null;
      }

      this.viewer.setError(path, error);
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
      const refs = await getGitRefs(this.currentPath ?? "");
      if (refsRequestId !== this.refsRequestId) {
        return null;
      }
      const baseRef = chooseCompareRef(this.baseRef, refs.defaultBaseRef, refs.refs);
      const headRef = chooseCompareRef(this.headRef, refs.defaultHeadRef, refs.refs);
      const compare = await getGitCompare(this.currentPath ?? "", baseRef, headRef);
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
        this.compareTree.setError(error, this.repository);
        this.emitStateChange();
      }
      return null;
    }
  }

  async refreshSelectedDiff() {
    const path = this.compareTree.selectedPath ?? "";
    if (!path || !this.compare) {
      return null;
    }
    const file = this.fileForPath(path);
    if (!file) {
      this.compareTree.setSelectedPath("");
      if (window.matchMedia("(max-width: 860px)").matches) {
        this.showList();
      } else {
        this.viewer.setNotice("This file is no longer part of the comparison.");
      }
      return null;
    }

    const requestId = ++this.diffRequestId;
    try {
      const diff = await getGitCompareDiff(
        this.currentPath ?? "",
        this.compare.baseRef,
        this.compare.headRef,
        path,
      );
      if (requestId !== this.diffRequestId || path !== this.compareTree.selectedPath) {
        return null;
      }
      this.viewer.setDiff({ ...diff, status: file.status ?? "" }, { preserveScroll: true });
      return diff;
    } catch (error) {
      if (requestId === this.diffRequestId) {
        this.viewer.setError(path, error);
      }
      return null;
    }
  }

  setContext({ path, repository, baseRef, headRef } = {}) {
    this.ensureRendered();
    const nextPath = path ?? this.currentPath ?? "";
    const nextRepository = repository ?? this.repository ?? null;
    const contextChanged =
      nextPath !== (this.currentPath ?? "") ||
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

  setLoading(repository) {
    this.ensureRendered();
    this.setContext({ repository });
    this.compareTree.setLoading(repository);
  }

  setCompare(comparePayload) {
    this.ensureRendered();
    this.compare = comparePayload;
    this.baseRef = comparePayload?.baseRef ?? this.baseRef ?? null;
    this.headRef = comparePayload?.headRef ?? this.headRef ?? null;
    this.repository = comparePayload?.repository ?? this.repository ?? null;
    this.compareTree.setCompare(comparePayload);
    this.emitStateChange();
  }

  setError(error, repository = null) {
    this.ensureRendered();
    this.compareTree.setError(error, repository);
  }

  setSelectedPath(path) {
    this.ensureRendered();
    if (!path) {
      this.diffRequestId += 1;
    }
    this.compareTree.setSelectedPath(path);
  }

  setEmpty() {
    this.ensureRendered();
    this.diffRequestId += 1;
    this.viewer.setEmpty();
  }

  showList() {
    this.ensureRendered();
    this.setView("list");
    this.restoreCompareScroll();
  }

  hasCompare(baseRef, headRef) {
    return (
      Boolean(this.compare) &&
      this.compare.baseRef === (baseRef || null) &&
      this.compare.headRef === (headRef || null)
    );
  }

  fileForPath(path) {
    return this.compare?.files?.find((entry) => entry.path === path) ?? null;
  }

  isFileViewer(target) {
    this.ensureRendered();
    return target === this.viewer;
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

  setView(view) {
    const nextView = view === "viewer" ? "viewer" : "list";
    const changed = this.detailView !== nextView || this.dataset.detailView !== nextView;
    this.detailView = nextView;
    this.dataset.detailView = this.detailView;
    if (changed) {
      this.emitStateChange();
    }
  }

  showLoadingAfterDelay(path, requestId) {
    return window.setTimeout(() => {
      if (requestId === this.diffRequestId) {
        this.viewer.setLoading(path);
      }
    }, LOADING_DELAY_MS);
  }

  rememberCompareScroll() {
    const scroller = this.querySelector(".compare-tree-list");
    if (!scroller) {
      return;
    }

    this.compareScrollTop = scroller.scrollTop;
  }

  restoreCompareScroll() {
    const top = this.compareScrollTop ?? 0;
    if (top <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scroller = this.querySelector(".compare-tree-list");
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

  startPanelResize(event) {
    if (!this.canResizePanel()) {
      return;
    }

    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.panelResizer.setPointerCapture(event.pointerId);
    this.classList.add("is-resizing-panel");
    this.updatePanelWidthFromPointer(event);
  }

  movePanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    this.updatePanelWidthFromPointer(event);
  }

  endPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    this.resizePointerId = null;
    this.classList.remove("is-resizing-panel");
    if (this.panelResizer.hasPointerCapture(event.pointerId)) {
      this.panelResizer.releasePointerCapture(event.pointerId);
    }
  }

  adjustPanelWidthFromKeyboard(event) {
    if (!this.canResizePanel()) {
      return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextWidth = this.panelWidth;
    if (event.key === "ArrowLeft") {
      nextWidth -= step;
    } else if (event.key === "ArrowRight") {
      nextWidth += step;
    } else if (event.key === "Home") {
      nextWidth = PANEL_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.panelMaxWidth();
    } else {
      return;
    }

    event.preventDefault();
    this.applyPanelWidth(nextWidth);
  }

  updatePanelWidthFromPointer(event) {
    const rect = this.getBoundingClientRect();
    this.applyPanelWidth(event.clientX - rect.left);
  }

  applyPanelWidth(width) {
    const nextWidth = this.clampPanelWidth(width);
    this.panelWidth = nextWidth;
    this.style.setProperty("--git-compare-panel-width", `${nextWidth}px`);
    this.panelResizer.setAttribute("aria-valuemin", `${PANEL_MIN_WIDTH}`);
    this.panelResizer.setAttribute("aria-valuemax", `${this.panelMaxWidth()}`);
    this.panelResizer.setAttribute("aria-valuenow", `${nextWidth}`);
  }

  clampPanelWidth(width) {
    return Math.min(Math.max(Math.round(width), PANEL_MIN_WIDTH), this.panelMaxWidth());
  }

  panelMaxWidth() {
    const width = this.getBoundingClientRect().width;
    if (!width) {
      return PANEL_DEFAULT_WIDTH;
    }

    const ratioMax = Math.round(width * PANEL_MAX_RATIO);
    const viewerMax = Math.max(PANEL_MIN_WIDTH, width - VIEWER_MIN_WIDTH);
    return Math.max(PANEL_MIN_WIDTH, Math.min(ratioMax, viewerMax));
  }

  canResizePanel() {
    return window.matchMedia("(min-width: 861px)").matches;
  }

  emitStateChange() {
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

function chooseCompareRef(preferredRef, fallbackRef, refs = []) {
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
