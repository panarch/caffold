import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import "#components/loading-text.ts";

// `retry` says the request follows a failed one.
export interface OlderHistoryIntentDetail {
  threadId: string;
  retry: boolean;
}

// The row above a conversation's earliest message. The conversation supplies
// whether older messages exist and how reading them is going; this row owns
// its controls, and loading or retrying never starts a request here.
export class CaffoldTaskOlderHistory extends LitElement {
  static properties = {
    threadId: { attribute: false },
    hasOlder: { attribute: false },
    loading: { attribute: false },
    error: { attribute: false },
    active: { attribute: false },
  };

  declare threadId: string;
  declare hasOlder: boolean;
  declare loading: boolean;
  // Why older messages could not be read, or `null` when nothing failed.
  declare error: string | null;
  declare active: boolean;

  constructor() {
    super();
    this.threadId = "";
    this.hasOlder = false;
    this.loading = false;
    this.error = null;
    this.active = true;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    if (this.empty) {
      return nothing;
    }
    return html`<div class="task-load-older">${
      this.error !== null
        ? html`<div class="task-history-error" role="alert">
            <span>Older messages are temporarily unavailable.</span>
            <span class="task-older-history-error-message">${this.error}</span>
            ${
              this.hasOlder
                ? html`<button
                    type="button"
                    @click=${this.request}
                  >Retry loading older messages</button>`
                : nothing
            }
          </div>`
        : this.loading
          ? html`<caffold-loading-text
              class="task-older-history-loading"
            >Loading older messages...</caffold-loading-text>`
          : html`<button
              type="button"
              @click=${this.request}
            >Load older messages</button>`
    }</div>`;
  }

  updated() {
    const hidden = this.empty;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const control = this.button;
    if (
      !scopeId ||
      !control ||
      !this.isActionable() ||
      !hasActionHintLayoutBox(control)
    ) {
      return emptyActionHintScope();
    }
    const { threadId } = this;
    const retry = this.error !== null;
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${retry ? "retry" : "load"}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: (control.textContent ?? "").trim(),
          control,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.threadId === threadId &&
            (this.error !== null) === retry &&
            this.button === control &&
            this.isActionable() &&
            hasActionHintLayoutBox(control),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  isActionable() {
    return (
      this.isConnected &&
      this.active &&
      !this.hidden &&
      Boolean(this.threadId) &&
      this.hasOlder &&
      !this.loading
    );
  }

  private request(event: Event) {
    if (!this.isActionable()) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<OlderHistoryIntentDetail>(
        "caffold:task-older-history-intent",
        {
          bubbles: true,
          composed: true,
          detail: { threadId: this.threadId, retry: this.error !== null },
        },
      ),
    );
  }

  private get empty() {
    return (
      !this.threadId || (!this.hasOlder && !this.loading && this.error === null)
    );
  }

  private get button() {
    return this.querySelector<HTMLButtonElement>(".task-load-older button");
  }
}

customElements.define("caffold-task-older-history", CaffoldTaskOlderHistory);
