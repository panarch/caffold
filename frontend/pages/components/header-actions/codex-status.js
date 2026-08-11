import { escapeHtml } from "../../../components/dom.js";
import {
  codexState,
  formatCodexAccount,
  sameCodexStatus,
} from "./codex-status-model.js";

class CaffoldCodexHeaderAction extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.render();
  }

  set status(value) {
    const nextValue = value ?? null;
    if (sameCodexStatus(this.statusValue, nextValue)) {
      return;
    }
    this.statusValue = nextValue;
    this.render();
  }

  get status() {
    return this.statusValue ?? null;
  }

  render() {
    const state = codexState(this.status);
    const title = state === "pending"
      ? "Checking Codex app-server status"
      : state === "available"
        ? `Codex app-server connected, ${formatCodexAccount(this.status)}`
        : `Codex app-server unavailable${this.status?.message ? `, ${this.status.message}` : ""}`;

    this.innerHTML = `
      <div class="header-action-group">
        <button
          type="button"
          class="header-action-group-button"
          data-action="open-codex-settings"
          data-state="${escapeHtml(state)}"
          title="${escapeHtml(title)}"
          aria-label="${escapeHtml(title)}"
        >
          <span
            class="header-action-icon header-action-brand-icon"
            data-brand="codex"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    `;
  }
}

customElements.define("caffold-codex-header-action", CaffoldCodexHeaderAction);

export { sameCodexStatus } from "./codex-status-model.js";
