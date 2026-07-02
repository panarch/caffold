import { escapeHtml, formatBytes, formatModified, languageLabel } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";
import { imageUrl } from "../api.js";
import "./code-viewer.js";
import "./diff-viewer.js";

let viewerInstanceId = 0;

class CodgerFileViewer extends HTMLElement {
  connectedCallback() {
    this.ensureDetailsPopoverId();

    if (!this.initialized) {
      this.initialized = true;
      this.addEventListener("click", (event) => {
        const button = event.target.closest('button[data-action="close-browser-viewer"]');
        if (!button) {
          return;
        }

        this.dispatchEvent(
          new CustomEvent("codger:close-file-viewer", {
            bubbles: true,
          }),
        );
      });
      this.boundIconsReady = () => this.render();
      window.addEventListener("codger:icons-ready", this.boundIconsReady);
      warmIcons();
    }

    if (!this.state) {
      this.setEmpty();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(path) {
    this.state = { status: "loading", path };
    this.render();
  }

  setFile(file) {
    this.state = { status: "file", file };
    this.render();
  }

  setImage(image) {
    this.state = { status: "image", image };
    this.render();
  }

  setDiff(diff) {
    this.state = { status: "diff", diff };
    this.render();
  }

  setError(path, error) {
    this.state = { status: "error", path, error };
    this.render();
  }

  setCloseLabel(label) {
    this.closeLabel = label;
    if (this.state && this.state.status !== "empty") {
      this.render();
    }
  }

  ensureDetailsPopoverId() {
    if (!this.detailsPopoverId) {
      viewerInstanceId += 1;
      this.detailsPopoverId = `codger-viewer-details-${viewerInstanceId}`;
    }
  }

  render() {
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
          ${this.renderBasicHeader(this.state.path)}
          <p class="surface-message">Loading file...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="viewer-panel error-panel">
          ${this.renderBasicHeader(this.state.path || "File")}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "diff") {
      this.renderDiff();
      return;
    }

    if (this.state.status === "image") {
      this.renderImage();
      return;
    }

    const { file } = this.state;
    const language = languageLabel(file.languageHint);
    this.innerHTML = `
      <section class="viewer-panel file-panel">
        ${this.renderHeader(file.name, [
          { field: "path", label: "Path", value: file.path },
          { field: "size", label: "Size", value: formatBytes(file.size) },
          {
            field: "modified",
            label: "Modified",
            value: formatModified(file.modifiedMs) || "Unknown",
          },
          { field: "language", label: "Language", value: language },
        ])}
        <codger-code-viewer></codger-code-viewer>
      </section>
    `;

    this.querySelector("codger-code-viewer").setFile(file);
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
            src="${escapeHtml(imageUrl(image.path))}"
            alt="${escapeHtml(image.name)}"
          >
        </div>
      </section>
    `;

    this.querySelector(".image-preview").addEventListener("error", () => {
      this.setError(image.path, new Error("Image preview failed to load."));
    });
  }

  renderDiff() {
    const { diff } = this.state;

    this.innerHTML = `
      <section class="viewer-panel file-panel diff-panel">
        ${this.renderHeader(diff.repoRelativePath, [
          { field: "path", label: "Path", value: diff.path },
          { field: "kind", label: "Diff", value: diff.kind },
          { field: "repository", label: "Repository", value: diff.repository.rootPath || "/" },
        ], {
          subtitle: diffSubtitle(diff),
        })}
        <codger-diff-viewer></codger-diff-viewer>
      </section>
    `;

    this.querySelector("codger-diff-viewer").setDiff(diff);
  }

  renderHeader(title, metadata, options = {}) {
    this.ensureDetailsPopoverId();
    const popoverId = this.detailsPopoverId;
    const subtitle = options.subtitle ?? "";

    return `
      <header class="viewer-header">
        <div class="viewer-title-row">
          ${this.renderCloseButton()}
          <div class="viewer-title-block">
            <h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
            ${
              subtitle
                ? `<span class="viewer-subtitle">${escapeHtml(subtitle)}</span>`
                : ""
            }
          </div>
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

  renderBasicHeader(title) {
    return `
      <header class="viewer-header">
        <div class="viewer-title-row">
          ${this.renderCloseButton()}
          <div class="viewer-title-block">
            <h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
          </div>
        </div>
      </header>
    `;
  }

  renderCloseButton() {
    const label = this.closeLabel ?? "Back to files";

    return `
      <button
        type="button"
        class="viewer-close-button"
        data-action="close-browser-viewer"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
      >
        ${renderInlineIcon("X", label, "viewer-close-icon")}
      </button>
    `;
  }
}

customElements.define("codger-file-viewer", CodgerFileViewer);
customElements.define(
  "codger-review-file-viewer",
  class CodgerReviewFileViewer extends CodgerFileViewer {},
);

function diffSubtitle(diff) {
  return [diffStatusLabel(diff.status), diffKindLabel(diff.kind)]
    .filter(Boolean)
    .join(" · ");
}

function diffKindLabel(kind) {
  if (!kind) {
    return "";
  }

  if (kind.startsWith("commit ")) {
    return `Commit ${kind.slice("commit ".length)}`;
  }

  const labels = {
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
  };

  return labels[kind] ?? kind;
}

function diffStatusLabel(status) {
  if (!status) {
    return "";
  }

  const code = String(status).trim() === "??"
    ? "??"
    : Array.from(String(status)).find((character) => character !== " ");

  if (code === "??") {
    return "Added";
  }

  const labels = {
    A: "Added",
    C: "Copied",
    D: "Deleted",
    M: "Modified",
    R: "Renamed",
    T: "Type changed",
    U: "Unmerged",
  };

  return labels[code] ?? String(status).trim();
}
