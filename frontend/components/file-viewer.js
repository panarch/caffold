import { escapeHtml, formatBytes, formatModified } from "./dom.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "./file-viewer-presentation.js";
import { renderInlineIcon, warmIcons } from "./icons.js";
import { imageUrl } from "../api.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../keyboard-navigation.js";
import "../keyboard-navigation/components/presentation.js";
import "./code-viewer.js";
import "./diff-viewer.js";
import "./markdown-preview.js";

let viewerInstanceId = 0;

class CaffoldReviewFileViewer extends HTMLElement {
  connectedCallback() {
    this.ensureDetailsPopoverId();

    if (!this.initialized) {
      this.initialized = true;
      this.addEventListener("click", (event) => {
        const refreshButton = event.target.closest('button[data-action="refresh-viewer"]');
        if (refreshButton) {
          const refreshEventName = this.refreshEventName();
          if (refreshEventName) {
            this.dispatchEvent(new CustomEvent(refreshEventName, { bubbles: true }));
          }
          return;
        }
        const button = event.target.closest('button[data-action="close-browser-viewer"]');
        if (!button) {
          return;
        }

        this.dispatchEvent(
          new CustomEvent("caffold:close-file-viewer", {
            bubbles: true,
          }),
        );
      });
      this.boundIconsReady = () => this.patchViewerIcons();
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
      warmIcons();
    }

    if (!this.state) {
      this.setEmpty();
    }
  }

  disconnectedCallback() {
    this.deactivate();
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  deactivate() {
    const popover = this.detailsPopover();
    if (!popover?.matches?.(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // A parent transition may already have detached the viewer.
    }
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(presentation) {
    this.state = { status: "loading", presentation };
    this.render();
  }

  setFile(file, options = {}) {
    const scroll = options.preserveScroll ? this.captureContentScroll() : null;
    this.state = {
      status: "file",
      file,
      presentation: sourceViewerPresentation(file),
    };
    this.render({ ...options, scroll });
  }

  setMarkdown(file, options = {}) {
    this.state = {
      status: "markdown",
      file,
      presentation: sourceViewerPresentation(file),
    };
    this.render({ ...options, markdownChanged: true });
  }

  setImage(image) {
    this.state = { status: "image", image };
    this.render();
  }

  setRefreshState(state) {
    this.refreshState = state;
    this.patchRefreshButton();
  }

  setDiff(diff, options = {}) {
    const scroll = options.preserveScroll ? this.captureContentScroll() : null;
    const { presentation = diffViewerPresentation(diff), ...viewerOptions } = options;
    this.state = {
      status: "diff",
      diff,
      presentation,
    };
    this.render({ ...viewerOptions, scroll });
  }

  setNotice(message, options = {}) {
    this.state = {
      status: "notice",
      message,
      actionLabel: options.actionLabel ?? "",
      action: options.action ?? "",
      title: options.title ?? "",
    };
    this.render();
  }

  setError(presentation, error) {
    this.state = { status: "error", presentation, error };
    this.render();
  }

  captureContentScroll() {
    const viewer = this.querySelector("caffold-code-viewer, caffold-diff-viewer");
    if (viewer) {
      return viewer.getScrollState?.() ?? null;
    }
    return this.querySelector("caffold-markdown-preview")
      ?.getScrollState?.() ?? null;
  }

  visibleLine() {
    const viewer = this.querySelector("caffold-code-viewer, caffold-diff-viewer");
    return viewer?.visibleLine?.() ?? null;
  }

  scrollToLine(line) {
    const viewer = this.querySelector("caffold-code-viewer, caffold-diff-viewer");
    return viewer?.scrollToLine?.(line) ?? false;
  }

  setCloseLabel(label) {
    this.closeLabel = label;
    if (this.state && this.state.status !== "empty") {
      this.render();
    }
  }

  setCloseMode(mode) {
    this.closeMode = mode === "back" ? "back" : "close";
    if (this.state && this.state.status !== "empty") {
      this.render();
    }
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    noticeActionId = "",
    detailsActionId = "",
    refreshActionId = "",
    linkActionId = "",
    clipRoots = [],
  } = {}) {
    const control = this.querySelector(
      ':scope > .viewer-panel > .viewer-header > .viewer-title-row > button.viewer-close-button[data-action="close-browser-viewer"]',
    );
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = [];
    const detailsControl = detailsActionId
      ? this.querySelector(
          ':scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-info-button',
        )
      : null;
    const detailsPopover = detailsActionId ? this.detailsPopover() : null;
    if (
      detailsActionId &&
      detailsControl &&
      detailsPopover &&
      this.hasDetailsMetadata(detailsPopover) &&
      !detailsControl.disabled
    ) {
      targets.push(buttonActionHintTarget({
        id: `${scopeId}:details:open`,
        actionId: detailsActionId,
        label: detailsControl.getAttribute("aria-label") || "Show file details",
        control: detailsControl,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(
            ':scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-info-button',
          ) === detailsControl &&
          this.detailsPopover() === detailsPopover &&
          detailsControl.getAttribute("popovertarget") === detailsPopover.id &&
          this.hasDetailsMetadata(detailsPopover) &&
          !detailsControl.disabled &&
          !detailsPopover.matches(":popover-open"),
      }));
    }
    if (actionId && control && !control.disabled) {
      targets.push(buttonActionHintTarget({
        id: `${scopeId}:close`,
        actionId,
        label: control.getAttribute("aria-label") || this.closeLabel || "Back to files",
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(
            ':scope > .viewer-panel > .viewer-header > .viewer-title-row > button.viewer-close-button[data-action="close-browser-viewer"]',
          ) === control &&
          !control.disabled,
      }));
    }
    const refreshControl = refreshActionId
      ? this.querySelector(
          ':scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-refresh-button[data-action="refresh-viewer"]',
        )
      : null;
    if (refreshControl && !refreshControl.disabled) {
      targets.push(buttonActionHintTarget({
        id: `${scopeId}:refresh`,
        actionId: refreshActionId,
        label: refreshControl.getAttribute("aria-label") || "Refresh file",
        control: refreshControl,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(
            ':scope > .viewer-panel > .viewer-header > .viewer-title-row .viewer-refresh-button[data-action="refresh-viewer"]',
          ) === refreshControl &&
          !refreshControl.disabled,
      }));
    }
    const noticeControl = noticeActionId
      ? this.querySelector(
          ':scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="view-source"], :scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="view-preview"]',
        )
      : null;
    const noticeAction = `${noticeControl?.dataset?.action ?? ""}`;
    if (
      noticeControl &&
      !noticeControl.disabled &&
      ["view-source", "view-preview"].includes(noticeAction)
    ) {
      targets.push(buttonActionHintTarget({
        id: `${scopeId}:notice:${noticeAction}`,
        actionId: noticeActionId,
        label: noticeControl.getAttribute("aria-label") ||
          noticeControl.textContent?.trim() ||
          (noticeAction === "view-preview" ? "View preview" : "View source"),
        control: noticeControl,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(
            `:scope > .viewer-panel.notice-panel > .viewer-notice-content > button[data-action="${noticeAction}"]`,
          ) === noticeControl &&
          !noticeControl.disabled,
      }));
    }
    const ownScope = {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
    const state = this.state;
    if (state?.status !== "markdown") {
      return ownScope;
    }
    const preview = this.querySelector(
      ":scope > .markdown-panel > caffold-markdown-preview",
    );
    return mergeActionHintScopes(
      ownScope,
      preview?.actionHintScope?.({
        scopeId: `${scopeId}:preview`,
        linkActionId,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isCurrent: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          this.querySelector(
            ":scope > .markdown-panel > caffold-markdown-preview",
          ) === preview,
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "File",
    clipRoots = [],
  } = {}) {
    const state = this.state;
    if (!scopeId || !state || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const childOptions = (kind, childLabel) => ({
      scopeId: `${scopeId}:${kind}`,
      label: childLabel,
      clipRoots: [this, ...clipRoots],
      isCurrent: () =>
        this.isConnected &&
        !this.hidden &&
        this.state === state,
    });
    if (state.status === "file") {
      return this.querySelector(":scope > .file-panel > caffold-code-viewer")
        ?.scrollSurfaceScope(childOptions(
          "source",
          `${state.presentation?.title || label} source`,
        )) ?? emptyScrollSurfaceScope();
    }
    if (state.status === "diff") {
      return this.querySelector(":scope > .diff-panel > caffold-diff-viewer")
        ?.scrollSurfaceScope(childOptions(
          "diff",
          `${state.presentation?.title || label} diff`,
        )) ?? emptyScrollSurfaceScope();
    }
    if (state.status === "markdown") {
      return this.querySelector(
        ":scope > .markdown-panel > caffold-markdown-preview",
      )?.scrollSurfaceScope(childOptions(
        "preview",
        `${state.presentation?.title || label} preview`,
      )) ?? emptyScrollSurfaceScope();
    }
    if (state.status === "image") {
      const scrollport = this.querySelector(
        ":scope > .image-panel > .image-stage",
      );
      return this.ownScrollSurfaceScope({
        scopeId: `${scopeId}:image`,
        label: `${state.image?.name || label} image`,
        state,
        scrollport,
        currentScrollport: () => this.querySelector(
          ":scope > .image-panel > .image-stage",
        ),
        axes: ["vertical", "horizontal"],
        clipRoots,
      });
    }
    if (state.status === "notice") {
      const scrollport = this.querySelector(
        ":scope > .notice-panel > .viewer-notice-content",
      );
      return this.ownScrollSurfaceScope({
        scopeId: `${scopeId}:notice`,
        label: `${state.title || label} notice`,
        state,
        scrollport,
        currentScrollport: () => this.querySelector(
          ":scope > .notice-panel > .viewer-notice-content",
        ),
        clipRoots,
      });
    }
    return emptyScrollSurfaceScope();
  }

  ownScrollSurfaceScope({
    scopeId,
    label,
    state,
    scrollport,
    currentScrollport,
    axes,
    clipRoots = [],
  }) {
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        ...(axes ? { axes } : {}),
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.state === state &&
          currentScrollport() === scrollport &&
          scrollport.isConnected &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this, scrollport],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  keyboardNavigationContexts({ scopeId = "" } = {}) {
    const popover = this.detailsPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (
      !scopeId ||
      this.hidden ||
      !popover ||
      !this.hasDetailsMetadata(popover) ||
      !dialog ||
      !hud ||
      !selector
    ) {
      return [];
    }
    const contextId = `${scopeId}:details`;
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: emptyActionHintScope(),
      },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "File details",
          popover,
          isCurrent: () =>
            this.isConnected &&
            !this.hidden &&
            this.detailsPopover() === popover &&
            this.hasDetailsMetadata(popover),
        }),
      },
    })];
  }

  ensureDetailsPopoverId() {
    if (!this.detailsPopoverId) {
      viewerInstanceId += 1;
      this.detailsPopoverId = `caffold-viewer-details-${viewerInstanceId}`;
    }
  }

  render(options = {}) {
    this.deactivate();
    if (!this.state || this.state.status === "empty") {
      this.innerHTML = `
        <section class="viewer-panel empty-panel">
          <p>Select a file to inspect it.</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="viewer-panel" aria-busy="true">
          ${this.renderPresentationHeader(this.state.presentation)}
          <p class="surface-message">Loading file...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="viewer-panel error-panel">
          ${this.renderPresentationHeader(this.state.presentation)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "notice") {
      const content = `
        <div class="viewer-notice-content">
          <p>${escapeHtml(this.state.message)}</p>
          ${
            this.state.actionLabel && this.state.action
              ? `<button type="button" class="task-secondary-button" data-action="${escapeHtml(this.state.action)}">${escapeHtml(this.state.actionLabel)}</button>`
              : ""
          }
        </div>
      `;
      this.innerHTML = `
        <section class="viewer-panel notice-panel${this.state.title ? "" : " empty-panel"}">
          ${this.state.title ? this.renderBasicHeader(this.state.title) : ""}
          ${content}
        </section>
      `;
      return;
    }

    if (this.state.status === "diff") {
      this.renderDiff(options);
      return;
    }

    if (this.state.status === "image") {
      this.renderImage();
      return;
    }

    if (this.state.status === "markdown") {
      this.renderMarkdown(options);
      return;
    }

    const { file, presentation } = this.state;
    this.innerHTML = `
      <section class="viewer-panel file-panel">
        ${this.renderPresentationHeader(presentation)}
        <caffold-code-viewer></caffold-code-viewer>
      </section>
    `;

    this.querySelector("caffold-code-viewer").setFile(file, options);
  }

  renderMarkdown(options = {}) {
    const { file, presentation } = this.state;
    const { markdownChanged = false, ...previewOptions } = options;
    const panel = this.querySelector(":scope > .markdown-panel");
    const preview = panel?.querySelector(
      ":scope > caffold-markdown-preview",
    );
    if (panel && preview) {
      this.replacePresentationHeader(panel, presentation);
      if (markdownChanged) {
        preview.setMarkdown(file.content, previewOptions);
      }
      return;
    }

    this.innerHTML = `
      <section class="viewer-panel file-panel markdown-panel">
        ${this.renderPresentationHeader(presentation)}
        <caffold-markdown-preview></caffold-markdown-preview>
      </section>
    `;
    this.querySelector("caffold-markdown-preview")
      ?.setMarkdown(file.content, previewOptions);
  }

  replacePresentationHeader(panel, presentation) {
    this.deactivate();
    const template = document.createElement("template");
    template.innerHTML = this.renderPresentationHeader(presentation);
    panel.querySelector(":scope > header")?.replaceWith(
      template.content.firstElementChild,
    );
  }

  renderImage() {
    const { image } = this.state;
    const metadata = [
      { field: "path", label: "Path", value: image.path },
      image.size === null || image.size === undefined
        ? null
        : { field: "size", label: "Size", value: formatBytes(image.size) },
      image.modifiedMs === null || image.modifiedMs === undefined
        ? null
        : {
            field: "modified",
            label: "Modified",
            value: formatModified(image.modifiedMs) || "Unknown",
          },
      { field: "type", label: "Type", value: image.imageType },
    ].filter(Boolean);

    this.innerHTML = `
      <section class="viewer-panel image-panel">
        ${this.renderHeader(image.name, metadata)}
        <div class="image-stage">
          <img
            class="image-preview"
            src="${escapeHtml(imageUrlWithRevision(image.path, image.revision))}"
            alt="${escapeHtml(image.name)}"
          >
        </div>
      </section>
    `;

    this.querySelector(".image-preview").addEventListener("error", () => {
      this.setError(
        sourceViewerPresentation(image),
        new Error("Image preview failed to load."),
      );
    });
  }

  renderDiff(options = {}) {
    const { diff, presentation } = this.state;

    this.innerHTML = `
      <section class="viewer-panel file-panel diff-panel">
        ${this.renderPresentationHeader(presentation)}
        <caffold-diff-viewer></caffold-diff-viewer>
      </section>
    `;

    this.querySelector("caffold-diff-viewer").setDiff(diff, options);
  }

  renderHeader(title, metadata, options = {}) {
    this.ensureDetailsPopoverId();
    const popoverId = this.detailsPopoverId;
    const subtitle = options.subtitle ?? "";
    const lineStats = options.lineStats ?? null;

    return `
      <header class="viewer-header">
        <div class="viewer-title-row">
          ${this.renderCloseButton()}
          <div class="viewer-title-block">
            <h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
            ${
              subtitle || lineStats
                ? `<div class="viewer-subtitle-row">
                    ${subtitle ? `<span class="viewer-subtitle">${escapeHtml(subtitle)}</span>` : ""}
                    ${this.renderLineStats(lineStats)}
                  </div>`
                : ""
            }
          </div>
          <div class="viewer-actions">
            ${this.renderRefreshButton()}
            <button
              type="button"
              class="viewer-info-button"
              popovertarget="${popoverId}"
              aria-label="${escapeHtml(`Show details for ${title}`)}"
              title="Show details"
            >
              ${renderInlineIcon("Info", "Details", "viewer-info-icon")}
            </button>
          </div>
        </div>
        <div
          id="${popoverId}"
          class="viewer-meta-popover"
          popover="auto"
          aria-label="File details"
        >
          <dl>
            ${metadata
              .map(
                (item) => `
                  <div data-field="${escapeHtml(item.field)}">
                    <dt>${escapeHtml(item.label)}</dt>
                    <dd>${escapeHtml(item.value)}</dd>
                  </div>
                `,
              )
              .join("")}
          </dl>
          <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
        </div>
      </header>
    `;
  }

  renderPresentationHeader(presentation) {
    const title = presentation?.title || "File";
    const subtitle = presentation?.subtitle ?? "";
    const metadata = presentation?.metadata ?? [];
    const lineStats = presentation?.lineStats ?? null;
    if (!subtitle && !lineStats && metadata.length === 0) {
      return this.renderBasicHeader(title);
    }

    return this.renderHeader(
      title,
      metadata,
      { subtitle, lineStats },
    );
  }

  renderLineStats(lineStats) {
    if (
      !Number.isFinite(lineStats?.additions) ||
      !Number.isFinite(lineStats?.deletions)
    ) {
      return "";
    }

    const additions = new Intl.NumberFormat("en-US").format(lineStats.additions);
    const deletions = new Intl.NumberFormat("en-US").format(lineStats.deletions);
    return `
      <span class="viewer-line-stats" aria-label="${escapeHtml(
        `${additions} additions and ${deletions} deletions`,
      )}">
        <span class="is-addition" aria-hidden="true">+${escapeHtml(additions)}</span>
        <span class="is-deletion" aria-hidden="true">-${escapeHtml(deletions)}</span>
      </span>
    `;
  }

  renderBasicHeader(title) {
    return `
      <header class="viewer-header">
        <div class="viewer-title-row">
          ${this.renderCloseButton()}
          <div class="viewer-title-block">
            <h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
          </div>
          <div class="viewer-actions">${this.renderRefreshButton()}</div>
        </div>
      </header>
    `;
  }

  renderCloseButton() {
    const label = this.closeLabel ?? "Back to files";
    const mode = this.closeMode ?? "close";
    const icon = mode === "back" ? "ArrowLeft" : "X";

    return `
      <button
        type="button"
        class="viewer-close-button"
        data-action="close-browser-viewer"
        data-close-mode="${mode}"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
      >
        ${renderInlineIcon(icon, label, "viewer-close-icon")}
      </button>
    `;
  }

  renderRefreshButton() {
    if (!this.refreshEventName()) {
      return "";
    }
    const refreshing = this.refreshState === "refreshing";
    const unavailable = this.refreshState === "unavailable";
    const title = unavailable
      ? "Live updates unavailable. Refresh manually."
      : "Refresh file";
    return `
      <button
        type="button"
        class="viewer-refresh-button${refreshing ? " is-refreshing" : ""}${unavailable ? " is-unavailable" : ""}"
        data-action="refresh-viewer"
        aria-label="${escapeHtml(title)}"
        title="${escapeHtml(title)}"
      >
        ${renderInlineIcon("RefreshCw", "Refresh file", "viewer-refresh-icon")}
      </button>
    `;
  }

  refreshEventName() {
    const action = this.getAttribute("refresh-action");
    return action ? `caffold:${action}` : "";
  }

  patchRefreshButton() {
    const button = this.querySelector(".viewer-refresh-button");
    if (!button) {
      return;
    }
    const refreshing = this.refreshState === "refreshing";
    const unavailable = this.refreshState === "unavailable";
    const title = unavailable
      ? "Live updates unavailable. Refresh manually."
      : "Refresh file";
    button.classList.toggle("is-refreshing", refreshing);
    button.classList.toggle("is-unavailable", unavailable);
    button.setAttribute("aria-label", title);
    button.title = title;
  }

  detailsPopover() {
    return this.querySelector(
      `:scope > .viewer-panel > .viewer-header > #${this.detailsPopoverId}`,
    );
  }

  hasDetailsMetadata(popover = this.detailsPopover()) {
    return Boolean(popover?.querySelector(":scope > dl > div"));
  }

  patchViewerIcons() {
    patchInlineIcon(
      this.querySelector(".viewer-close-button"),
      this.closeMode === "back" ? "ArrowLeft" : "X",
      this.closeLabel ?? "Back to files",
      "viewer-close-icon",
    );
    patchInlineIcon(
      this.querySelector(".viewer-refresh-button"),
      "RefreshCw",
      "Refresh file",
      "viewer-refresh-icon",
    );
    patchInlineIcon(
      this.querySelector(".viewer-info-button"),
      "Info",
      "Details",
      "viewer-info-icon",
    );
  }
}

function patchInlineIcon(button, name, label, className) {
  if (!button || button.querySelector(`:scope > .${className}`)) {
    return;
  }
  const markup = renderInlineIcon(name, label, className);
  if (button.innerHTML !== markup) {
    button.innerHTML = markup;
  }
}

customElements.define("caffold-review-file-viewer", CaffoldReviewFileViewer);

function imageUrlWithRevision(path, revision) {
  const url = new URL(imageUrl(path));
  if (revision !== undefined && revision !== null) {
    url.searchParams.set("revision", `${revision}`);
  }
  return url.toString();
}
