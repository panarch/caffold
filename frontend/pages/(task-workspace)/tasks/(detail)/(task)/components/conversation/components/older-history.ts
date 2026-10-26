import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
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
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

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
                    ${this.hints.button({
                      id: "retry",
                      label: "Retry loading older messages",
                      action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      when: this.active && !this.loading,
                    })}
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
              ${this.hints.button({
                id: "load",
                label: "Load older messages",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                when: this.active && this.hasOlder,
              })}
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

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private canRequest() {
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
    if (!this.canRequest()) {
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
}

customElements.define("caffold-task-older-history", CaffoldTaskOlderHistory);
