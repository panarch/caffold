import { renderInlineIcon, warmIcons } from "./icons.js";

class CodgerReviewWorkspace extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='close-review-workspace']");
      if (!button) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("codger:close-review-workspace", {
          bubbles: true,
        }),
      );
    });
    this.boundIconsReady = () => this.renderChrome();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <section
        class="review-workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Review workspace"
      >
        <header class="review-workspace-header">
          <button
            type="button"
            class="review-workspace-close"
            data-action="close-review-workspace"
            aria-label="Close review workspace"
            title="Close"
          ></button>
          <div class="review-workspace-title">
            <h2></h2>
            <span class="review-workspace-subtitle"></span>
          </div>
        </header>
        <div class="review-workspace-body">
          <div class="review-workspace-view workspace-mode-diff" hidden>
            <codger-changes-tree></codger-changes-tree>
            <codger-review-file-viewer></codger-review-file-viewer>
          </div>
          <div class="review-workspace-view workspace-mode-log" hidden>
            <codger-log-list></codger-log-list>
            <div class="log-review-detail">
              <codger-commit-changes-tree></codger-commit-changes-tree>
              <codger-review-file-viewer></codger-review-file-viewer>
            </div>
          </div>
        </div>
      </section>
    `;
    this.titleEl = this.querySelector(".review-workspace-title h2");
    this.subtitleEl = this.querySelector(".review-workspace-subtitle");
    this.closeButton = this.querySelector(".review-workspace-close");
    this.diffView = this.querySelector(".workspace-mode-diff");
    this.logView = this.querySelector(".workspace-mode-log");
    this.renderChrome();
  }

  open(mode, options = {}) {
    this.ensureRendered();
    this.hidden = false;
    this.mode = mode;
    this.dataset.workspaceMode = mode;
    this.workspaceTitle = options.title ?? workspaceTitle(mode);
    this.subtitle = options.subtitle ?? "";
    this.renderChrome();
    this.diffView.hidden = mode !== "diff";
    this.logView.hidden = mode !== "log";
  }

  close() {
    this.hidden = true;
    this.mode = null;
    this.dataset.workspaceMode = "";
    this.renderChrome();
  }

  updateDetails(options = {}) {
    this.workspaceTitle = options.title ?? this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitle = options.subtitle ?? this.subtitle ?? "";
    this.renderChrome();
  }

  renderChrome() {
    if (!this.rendered) {
      return;
    }

    this.titleEl.textContent = this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitleEl.textContent = this.subtitle ?? "";
    this.closeButton.innerHTML = renderInlineIcon("X", "Close", "review-workspace-close-icon");
  }
}

customElements.define("codger-review-workspace", CodgerReviewWorkspace);

function workspaceTitle(mode) {
  if (mode === "diff") {
    return "Diff";
  }

  if (mode === "log") {
    return "Log";
  }

  return "Review";
}
