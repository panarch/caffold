import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

class CodgerHeaderActions extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='toggle-git-mode']");
      if (!button) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("codger:toggle-git-mode", {
          bubbles: true,
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();

    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  set gitStatus(value) {
    this.gitStatusValue = value ?? null;
    this.render();
  }

  get gitStatus() {
    return this.gitStatusValue ?? null;
  }

  render() {
    this.innerHTML = `
      <div class="header-actions" aria-label="Review actions">
        ${this.renderGitToggle()}
      </div>
    `;
  }

  renderGitToggle() {
    const gitStatus = this.gitStatus;
    if (!gitStatus) {
      return "";
    }

    const count = gitStatus.count;
    const countLabel = count === null || count === undefined ? "" : `${count}`;
    const className = ["header-action-button", gitStatus.active ? "is-active" : ""]
      .filter(Boolean)
      .join(" ");
    const actionLabel = gitStatus.active ? "Show files" : "Show changes";
    const countAria =
      count === null || count === undefined
        ? ""
        : `, ${count} changed ${count === 1 ? "file" : "files"}`;

    return `
      <button
        type="button"
        class="${escapeHtml(className)}"
        data-action="toggle-git-mode"
        title="${escapeHtml(actionLabel)}"
        aria-label="${escapeHtml(`${actionLabel}${countAria}`)}"
        aria-pressed="${gitStatus.active ? "true" : "false"}"
      >
        ${renderInlineIcon("FileDiff", actionLabel, "header-action-icon")}
        <span class="header-action-label">Diff</span>
        ${
          countLabel.trim()
            ? `<span class="header-action-count">${escapeHtml(countLabel.trim())}</span>`
            : ""
        }
      </button>
    `;
  }
}

customElements.define("codger-header-actions", CodgerHeaderActions);
