import { renderInlineIcon, warmIcons } from "../../../components/icons.js";

const REVIEW_PANEL_DEFAULT_WIDTH = 320;
const REVIEW_PANEL_MIN_WIDTH = 180;
const REVIEW_PANEL_VIEWER_MIN_WIDTH = 320;
const REVIEW_PANEL_MAX_RATIO = 0.7;
const REVIEW_DIFF_RESIZE_QUERY = "(min-width: 861px)";
const REVIEW_LOG_RESIZE_QUERY = "(min-width: 1101px)";

class CaffoldReviewWorkspace extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.reviewPanelWidth = REVIEW_PANEL_DEFAULT_WIDTH;
    this.resizePointerId = null;
    this.resizeTarget = null;
    this.resizeHandle = null;
    this.applyReviewPanelWidth(this.reviewPanelWidth);
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      if (button.dataset.action === "back-review-workspace") {
        this.dispatchEvent(
          new CustomEvent("caffold:back-review-workspace", {
            bubbles: true,
          }),
        );
        return;
      }

      if (button.dataset.action !== "close-review-workspace") {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:close-review-workspace", {
          bubbles: true,
        }),
      );
    });
    this.addEventListener("change", (event) => {
      const select = event.target.closest("select[data-compare-ref]");
      if (!select) {
        return;
      }

      const baseRef = this.querySelector('select[data-compare-ref="base"]')?.value ?? "";
      const headRef = this.querySelector('select[data-compare-ref="head"]')?.value ?? "";
      this.dispatchEvent(
        new CustomEvent("caffold:change-compare-refs", {
          bubbles: true,
          detail: { baseRef, headRef },
        }),
      );
    });
    this.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".review-panel-resizer");
      if (handle) {
        this.startReviewPanelResize(event, handle);
      }
    });
    this.addEventListener("pointermove", (event) => {
      this.moveReviewPanelResize(event);
    });
    this.addEventListener("pointerup", (event) => {
      this.endReviewPanelResize(event);
    });
    this.addEventListener("pointercancel", (event) => {
      this.endReviewPanelResize(event);
    });
    this.addEventListener("keydown", (event) => {
      const handle = event.target.closest(".review-panel-resizer");
      if (handle) {
        this.adjustReviewPanelWidthFromKeyboard(event, handle);
      }
    });
    this.boundIconsReady = () => this.renderChrome();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.reviewPanelWidth ??= REVIEW_PANEL_DEFAULT_WIDTH;
    this.rendered = true;
    this.innerHTML = `
      <section
        class="review-workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Review workspace"
      >
        <header class="review-workspace-header">
          <div class="review-workspace-nav">
            <button
              type="button"
              class="review-workspace-back"
              data-action="back-review-workspace"
              aria-label="Back to log"
              title="Back"
              hidden
            ></button>
            <button
              type="button"
              class="review-workspace-close"
              data-action="close-review-workspace"
              aria-label="Close review workspace"
              title="Close"
            ></button>
          </div>
          <div class="review-workspace-title">
            <h2></h2>
            <div class="review-workspace-controls" hidden></div>
            <span class="review-workspace-subtitle"></span>
          </div>
        </header>
        <div class="review-workspace-body">
          <div class="review-workspace-view workspace-mode-git" hidden>
            <caffold-git-review-layout></caffold-git-review-layout>
          </div>
          <div class="review-workspace-view workspace-mode-issues" hidden>
            <caffold-github-issues-layout></caffold-github-issues-layout>
          </div>
          <div class="review-workspace-view workspace-mode-pulls" hidden>
            <caffold-github-pulls-layout></caffold-github-pulls-layout>
          </div>
        </div>
      </section>
    `;
    this.titleWrapper = this.querySelector(".review-workspace-title");
    this.titleEl = this.querySelector(".review-workspace-title h2");
    this.controlsEl = this.querySelector(".review-workspace-controls");
    this.subtitleEl = this.querySelector(".review-workspace-subtitle");
    this.backButton = this.querySelector(".review-workspace-back");
    this.closeButton = this.querySelector(".review-workspace-close");
    this.gitView = this.querySelector(".workspace-mode-git");
    this.gitLayout = this.querySelector("caffold-git-review-layout");
    this.gitLayout.ensureRendered();
    this.issuesView = this.querySelector(".workspace-mode-issues");
    this.issuesLayout = this.querySelector("caffold-github-issues-layout");
    this.issuesLayout.ensureRendered();
    this.pullsView = this.querySelector(".workspace-mode-pulls");
    this.pullsLayout = this.querySelector("caffold-github-pulls-layout");
    this.pullsLayout.ensureRendered();
    this.pullFilesView = this.querySelector("caffold-github-pull-files-page");
    this.renderChrome();
  }

  open(mode, options = {}) {
    this.ensureRendered();
    this.hidden = false;
    this.mode = mode;
    this.dataset.workspaceMode = mode;
    this.workspaceTitle = options.title ?? workspaceTitle(mode);
    this.subtitle = options.subtitle ?? "";
    this.controlsHtml = options.controlsHtml ?? "";
    this.backVisible = Boolean(options.backVisible);
    this.backLabel = options.backLabel ?? "Back";
    this.renderChrome();
    this.gitView.hidden = mode !== "git";
    this.issuesView.hidden = mode !== "issues";
    this.pullsView.hidden = mode !== "pulls";
    this.updateMobileDetailState();
  }

  close() {
    this.hidden = true;
    this.mode = null;
    this.dataset.workspaceMode = "";
    this.backVisible = false;
    this.controlsHtml = "";
    this.renderChrome();
  }

  updateDetails(options = {}) {
    this.workspaceTitle = options.title ?? this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitle = options.subtitle ?? this.subtitle ?? "";
    if (options.backVisible !== undefined) {
      this.backVisible = Boolean(options.backVisible);
    }
    this.controlsHtml = options.controlsHtml ?? "";
    this.backLabel = options.backLabel ?? this.backLabel ?? "Back";
    this.renderChrome();
  }

  setGitView() {
    this.ensureRendered();
    this.updateMobileDetailState();
  }

  setIssuesView(view) {
    this.ensureRendered();
    const nextView = view === "detail" ? "detail" : "list";
    this.issuesView.dataset.issuesView = nextView;
    this.issuesLayout.setView(nextView);
    this.updateMobileDetailState();
  }

  setPullsView(view) {
    this.ensureRendered();
    const nextView = normalizePullsView(view);
    this.pullsView.dataset.pullsView = nextView;
    this.pullsLayout.setView(nextView);
    this.updateMobileDetailState();
  }

  setPullFilesView(view) {
    this.ensureRendered();
    this.pullFilesView.dataset.detailView = normalizeDetailView(view);
    this.updateMobileDetailState();
  }

  renderChrome() {
    if (!this.rendered) {
      return;
    }

    this.titleEl.textContent = this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitleEl.textContent = this.subtitle ?? "";
    const controlsHtml = this.controlsHtml ?? "";
    this.controlsEl.innerHTML = controlsHtml;
    this.controlsEl.hidden = controlsHtml.length === 0;
    this.titleWrapper.classList.toggle("has-controls", controlsHtml.length > 0);
    this.backButton.hidden = !this.backVisible;
    this.backButton.setAttribute("aria-label", this.backLabel ?? "Back");
    this.backButton.setAttribute("title", this.backLabel ?? "Back");
    this.backButton.innerHTML = renderInlineIcon(
      "ArrowLeft",
      this.backLabel ?? "Back",
      "review-workspace-back-icon",
    );
    this.closeButton.innerHTML = renderInlineIcon("X", "Close", "review-workspace-close-icon");
    this.updateReviewPanelResizeAttributes();
  }

  startReviewPanelResize(event, handle) {
    const target = handle.dataset.resizeTarget;
    if (!this.canResizeReviewPanel(target)) {
      return;
    }

    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.resizeTarget = target;
    this.resizeHandle = handle;
    handle.setPointerCapture(event.pointerId);
    this.classList.add("is-resizing-review-panel");
    this.updateReviewPanelWidthFromPointer(event);
  }

  moveReviewPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    this.updateReviewPanelWidthFromPointer(event);
  }

  endReviewPanelResize(event) {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    const handle = this.resizeHandle;
    this.resizePointerId = null;
    this.resizeTarget = null;
    this.resizeHandle = null;
    this.classList.remove("is-resizing-review-panel");
    if (handle?.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  adjustReviewPanelWidthFromKeyboard(event, handle) {
    const target = handle.dataset.resizeTarget;
    if (!this.canResizeReviewPanel(target)) {
      return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextWidth = this.reviewPanelWidth;

    if (event.key === "ArrowLeft") {
      nextWidth -= step;
    } else if (event.key === "ArrowRight") {
      nextWidth += step;
    } else if (event.key === "Home") {
      nextWidth = REVIEW_PANEL_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.reviewPanelMaxWidth(target);
    } else {
      return;
    }

    event.preventDefault();
    this.applyReviewPanelWidth(nextWidth, target);
  }

  updateReviewPanelWidthFromPointer(event) {
    const panel = this.reviewPanelForTarget(this.resizeTarget);
    if (!panel) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    this.applyReviewPanelWidth(event.clientX - rect.left, this.resizeTarget);
  }

  applyReviewPanelWidth(width, target = null) {
    const nextWidth = target ? this.clampReviewPanelWidth(width, target) : Math.round(width);
    this.reviewPanelWidth = nextWidth;
    this.style.setProperty("--review-left-panel-width", `${nextWidth}px`);
    this.updateReviewPanelResizeAttributes();
  }

  clampReviewPanelWidth(width, target) {
    return Math.min(
      Math.max(Math.round(width), REVIEW_PANEL_MIN_WIDTH),
      this.reviewPanelMaxWidth(target),
    );
  }

  reviewPanelMaxWidth(target) {
    const panel = this.reviewPanelForTarget(target);
    const panelWidth = panel?.getBoundingClientRect().width ?? REVIEW_PANEL_DEFAULT_WIDTH;
    const ratioMax = Math.round(panelWidth * REVIEW_PANEL_MAX_RATIO);
    const viewerMax = Math.max(REVIEW_PANEL_MIN_WIDTH, panelWidth - REVIEW_PANEL_VIEWER_MIN_WIDTH);
    return Math.max(REVIEW_PANEL_MIN_WIDTH, Math.min(ratioMax, viewerMax));
  }

  canResizeReviewPanel(target) {
    const panel = this.reviewPanelForTarget(target);
    if (!panel || panel.getClientRects().length === 0) {
      return false;
    }

    if (target === "log") {
      return window.matchMedia(REVIEW_LOG_RESIZE_QUERY).matches;
    }

    if (target === "pulls") {
      return window.matchMedia(REVIEW_DIFF_RESIZE_QUERY).matches;
    }

    return (
      (target === "diff" || target === "compare") &&
      window.matchMedia(REVIEW_DIFF_RESIZE_QUERY).matches
    );
  }

  reviewPanelForTarget(target) {
    if (target === "log") {
      return this.gitLayout.reviewPanelForTarget(target);
    }

    if (target === "diff") {
      return this.gitLayout.reviewPanelForTarget(target);
    }

    if (target === "compare") {
      return this.gitLayout.reviewPanelForTarget(target);
    }

    if (target === "pulls") {
      return this.querySelector("caffold-github-pull-files-page");
    }

    return null;
  }

  updateReviewPanelResizeAttributes() {
    const handles = this.querySelectorAll(".review-panel-resizer");
    for (const handle of handles) {
      const target = handle.dataset.resizeTarget;
      handle.setAttribute("aria-valuemin", `${REVIEW_PANEL_MIN_WIDTH}`);
      handle.setAttribute("aria-valuemax", `${this.reviewPanelMaxWidth(target)}`);
      handle.setAttribute("aria-valuenow", `${this.reviewPanelWidth}`);
    }
  }

  updateMobileDetailState() {
    if (!this.rendered) {
      return;
    }

    const detailOpen =
      (this.mode === "git" && this.gitLayout.isMobileDetailOpen()) ||
      (this.mode === "issues" && this.issuesLayout.dataset.issuesView === "detail") ||
      (this.mode === "pulls" &&
        (this.pullsLayout.dataset.pullsView === "detail" ||
          (this.pullsLayout.dataset.pullsView === "files" &&
            this.pullFilesView.dataset.detailView === "viewer")));

    this.dataset.mobileDetail = detailOpen ? "true" : "false";
  }
}

customElements.define("caffold-review-workspace", CaffoldReviewWorkspace);

function workspaceTitle(mode) {
  if (mode === "git") {
    return "Git";
  }

  if (mode === "issues") {
    return "Issues";
  }

  if (mode === "pulls") {
    return "Pull Requests";
  }

  return "Review";
}

function normalizeDetailView(view) {
  return view === "viewer" ? "viewer" : "list";
}

function normalizePullsView(view) {
  return view === "detail" || view === "files" ? view : "list";
}
