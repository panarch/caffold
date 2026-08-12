import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { TASK_TRANSPORT_STATE } from "../runtime-state.js";

export const TASK_TRANSPORT_RETRY_EVENT = "caffold:task-transport-retry";

class CaffoldTaskTransportOverlay extends HTMLElement {
  static get observedAttributes() {
    return ["state", "message"];
  }

  connectedCallback() {
    this.boundClick ??= (event) => this.handleClick(event);
    this.boundIconsReady ??= () => this.render();
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.setAttribute("role", "status");
    this.render();
    warmIcons();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  attributeChangedCallback() {
    if (this.isConnected) {
      this.render();
    }
  }

  handleClick(event) {
    const retry = event.target instanceof Element
      ? event.target.closest("[data-task-transport-retry]")
      : null;
    if (!retry || !this.contains(retry)) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent(TASK_TRANSPORT_RETRY_EVENT, {
        bubbles: true,
        composed: true,
        detail: { state: this.state },
      }),
    );
  }

  render() {
    const state = this.state;
    if (
      state !== TASK_TRANSPORT_STATE.RECONNECTING &&
      state !== TASK_TRANSPORT_STATE.UNAVAILABLE
    ) {
      this.hidden = true;
      this.removeAttribute("data-transport-state");
      this.replaceChildren();
      return;
    }

    const retry = this.querySelector("[data-task-transport-retry]");
    const restoreRetryFocus = retry && document.activeElement === retry;
    const message = this.message || defaultMessage(state);
    const content = state === TASK_TRANSPORT_STATE.RECONNECTING
      ? '<span class="task-transport-spinner" aria-hidden="true"></span>'
      : renderInlineIcon(
          "TriangleAlert",
          "Caffold server unavailable",
          "task-transport-icon",
        );
    const nextHtml = `
      ${content}
      <span class="task-transport-message">${escapeHtml(message)}</span>
      ${
        state === TASK_TRANSPORT_STATE.UNAVAILABLE
          ? '<button type="button" class="task-transport-retry" data-task-transport-retry>Retry</button>'
          : ""
      }
    `;

    this.hidden = false;
    this.dataset.transportState = state;
    if (this.innerHTML.trim() !== nextHtml.trim()) {
      this.innerHTML = nextHtml;
      if (restoreRetryFocus) {
        queueMicrotask(() => {
          this.querySelector("[data-task-transport-retry]")?.focus({
            preventScroll: true,
          });
        });
      }
    }
  }

  get state() {
    return `${this.getAttribute("state") ?? ""}`;
  }

  get message() {
    return `${this.getAttribute("message") ?? ""}`;
  }
}

function defaultMessage(state) {
  return state === TASK_TRANSPORT_STATE.RECONNECTING
    ? "Reconnecting to Caffold server..."
    : "Caffold server unavailable.";
}

if (!customElements.get("caffold-task-transport-overlay")) {
  customElements.define(
    "caffold-task-transport-overlay",
    CaffoldTaskTransportOverlay,
  );
}
