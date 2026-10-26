import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.ts";
import { KeyboardContexts } from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";

export const CODEX_RESET_CREDIT_CONFIRMED_EVENT =
  "caffold:codex-reset-credit-confirmed";

type ResetCreditRequest = {
  creditId?: string | null;
  title?: string | null;
  expiry?: string | null;
  retry?: boolean;
};

export class CaffoldCodexResetCreditDialog extends LitElement {
  static properties = {
    request: { state: true },
  };

  declare private request: ResetCreditRequest;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  constructor() {
    super();
    this.request = {};
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    const { creditId, title, expiry, retry = false } = this.request;
    const heading = retry
      ? "Retry this reset request?"
      : "Use a Codex reset credit?";
    const description = retry
      ? "Caffold will retry the same request, so Codex will not spend another credit if it already completed."
      : "Codex will use one reset credit if an eligible rate-limit window can be reset. A used credit cannot be restored.";
    const selection = creditId
      ? `${title || "Rate-limit reset"}${expiry ? ` · expires ${expiry}` : " · expiration unknown"}`
      : "Codex will choose an available credit. Its expiration is not known in advance.";
    const action = retry ? "Retry request" : "Use reset credit";
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "codex-reset-credit" })}
        closedby="any"
        aria-labelledby="codex-reset-credit-dialog-title"
        aria-describedby="codex-reset-credit-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="codex-reset-credit-dialog-card">
          <h2 id="codex-reset-credit-dialog-title">${heading}</h2>
          <p id="codex-reset-credit-dialog-description">${description}</p>
          <p data-reset-selection>${selection}</p>
          <footer>
            <button
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="cancel"
              autofocus
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "use",
                label: action,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="use"
            >${action}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  open(request: ResetCreditRequest = {}) {
    this.request = request;
    this.performUpdate();
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.returnValue = "";
    dialog.showModal();
  }

  close() {
    this.dialog.value?.close();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  private handleClose() {
    if (this.dialog.value?.returnValue !== "use") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CODEX_RESET_CREDIT_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
        detail: { creditId: this.request.creditId ?? null },
      }),
    );
  }
}

customElements.define(
  "caffold-codex-reset-credit-dialog",
  CaffoldCodexResetCreditDialog,
);
