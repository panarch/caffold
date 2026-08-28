import { escapeHtml, formatBytes, formatModified } from "./dom.js";
import {
  diffViewerPresentation,
  sourceViewerPresentation,
} from "./file-viewer-presentation.js";
import { renderInlineIcon, warmIcons } from "./icons.js";
import { imageUrl } from "../api.js";
import "./code-viewer.js";
import "./diff-viewer.js";
import "./file-viewer/components/markdown-preview.js";

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
      this.boundIconsReady = () => this.render();
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
      warmIcons();
    }

    if (!this.state) {
      this.setEmpty();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
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
    return this.querySelector("caffold-review-markdown-preview")
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

  ensureDetailsPopoverId() {
    if (!this.detailsPopoverId) {
      viewerInstanceId += 1;
      this.detailsPopoverId = `caffold-viewer-details-${viewerInstanceId}`;
    }
  }

  render(options = {}) {
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
      ":scope > caffold-review-markdown-preview",
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
        <caffold-review-markdown-preview></caffold-review-markdown-preview>
      </section>
    `;
    this.querySelector("caffold-review-markdown-preview")
      ?.setMarkdown(file.content, previewOptions);
  }

  replacePresentationHeader(panel, presentation) {
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
}

customElements.define("caffold-review-file-viewer", CaffoldReviewFileViewer);

function imageUrlWithRevision(path, revision) {
  const url = new URL(imageUrl(path));
  if (revision !== undefined && revision !== null) {
    url.searchParams.set("revision", `${revision}`);
  }
  return url.toString();
}
