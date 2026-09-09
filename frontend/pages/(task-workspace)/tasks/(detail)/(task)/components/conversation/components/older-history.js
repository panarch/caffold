import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../../../../../action-hints.js";

// Conversation supplies request state; this child owns its presentation and
// controls. Loading and retry intents never start a request here.
class CaffoldTaskOlderHistory extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.snapshot) return;
    this.snapshot = { threadId: "", hasOlder: false, loading: false, error: null };
    this.active = true;
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const next = {
      threadId: `${snapshot.threadId ?? ""}`,
      hasOlder: Boolean(snapshot.hasOlder),
      loading: Boolean(snapshot.loading),
      error: snapshot.error ? `${snapshot.error.message ?? ""}` : null,
    };
    if (Object.keys(next).every((key) => this.snapshot[key] === next[key])) {
      return false;
    }
    this.snapshot = next;
    this.render();
    return true;
  }

  setActive(active) {
    this.ensureState();
    this.active = Boolean(active);
  }

  handleClick(event) {
    const control = this.button();
    if (
      !control ||
      event.target.closest?.("button") !== control ||
      !this.isActionable()
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("caffold:task-older-history-intent", {
      bubbles: true,
      composed: true,
      detail: {
        threadId: this.snapshot.threadId,
        retry: this.snapshot.error !== null,
      },
    }));
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const control = this.button();
    if (!scopeId || !control || !this.isActionable() || !hasActionHintLayoutBox(control)) {
      return emptyActionHintScope();
    }
    const snapshot = this.snapshot;
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:${snapshot.error !== null ? "retry" : "load"}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.textContent.trim(),
        control,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.snapshot === snapshot &&
          this.button() === control &&
          this.isActionable() &&
          hasActionHintLayoutBox(control),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  isActionable() {
    return this.isConnected && this.active && !this.hidden &&
      Boolean(this.snapshot.threadId) && this.snapshot.hasOlder &&
      !this.snapshot.loading;
  }

  button() {
    return this.querySelector(".task-load-older button");
  }

  render() {
    const { threadId, hasOlder, loading, error } = this.snapshot;
    this.hidden = !threadId || (!hasOlder && !loading);
    if (this.hidden) {
      this.innerHTML = "";
      return;
    }
    this.innerHTML = `<div class="task-load-older">
      ${error !== null
        ? `<div class="task-history-error" role="alert">
            <span>Older messages are temporarily unavailable.</span>
            <span class="task-older-history-error-message">${escapeHtml(error)}</span>
            <button type="button">Retry loading older messages</button>
          </div>`
        : loading
          ? `<div class="task-older-history-loading" role="status">
              <span class="task-older-history-spinner" aria-hidden="true"></span>
              <span>Loading older messages...</span>
            </div>`
          : `<button type="button">Load older messages</button>`}
    </div>`;
  }
}

if (!customElements.get("caffold-task-older-history")) {
  customElements.define("caffold-task-older-history", CaffoldTaskOlderHistory);
}
