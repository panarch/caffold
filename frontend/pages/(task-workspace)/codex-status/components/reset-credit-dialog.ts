import { html, LitElement } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";

export const CODEX_RESET_CREDIT_CONFIRMED_EVENT =
  "caffold:codex-reset-credit-confirmed";

type ResetCreditRequest = {
  creditId?: string | null;
  title?: string | null;
  expiry?: string | null;
  retry?: boolean;
};

class CaffoldCodexResetCreditDialog extends LitElement {
  static properties = {
    request: { state: true },
  };

  declare private request: ResetCreditRequest;

  constructor() {
    super();
    this.request = {};
  }

  createRenderRoot() {
    return this;
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
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="use">${action}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  async open(request: ResetCreditRequest = {}) {
    this.request = request;
    await this.updateComplete;
    const dialog = this.dialog;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.returnValue = "";
    dialog.showModal();
  }

  async close() {
    await this.updateComplete;
    this.dialog?.close();
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const hintDialog = dialog
      ?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      )
      ?.actionHintDialog?.();
    if (!dialog || !hintDialog) {
      return [];
    }
    return [
      keyboardNavigationContext({
        id: "codex-reset-credit",
        kind: "modal",
        root: dialog,
        actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const targets = ["cancel", "use"].flatMap((value) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `button[value="${value}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `codex-reset-credit:${value}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || value,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            dialog.querySelector(`button[value="${value}"]`) === control &&
            !control.disabled,
        }),
      ];
    });
    return { blocked: false, targets, mutationRoots: [this], scrollRoots: [] };
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }

  private handleClose() {
    if (this.dialog?.returnValue !== "use") {
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
