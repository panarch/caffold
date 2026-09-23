import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";

export const CODEX_RESET_CREDIT_CONFIRMED_EVENT =
  "caffold:codex-reset-credit-confirmed";

class CaffoldCodexResetCreditDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    if (!dialog || !hintDialog) return [];
    return [keyboardNavigationContext({
      id: "codex-reset-credit",
      kind: "modal",
      root: dialog,
      actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    if (!dialog) return emptyActionHintScope();
    const targets = ["cancel", "use"].flatMap((value) => {
      const control = dialog.querySelector(`button[value="${value}"]`);
      if (!control) return [];
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `codex-reset-credit:${value}`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.textContent?.trim() || value,
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected && this.dialog() === dialog && dialog.open &&
          dialog.querySelector(`button[value="${value}"]`) === control &&
          !control.disabled,
      })];
    });
    return { blocked: false, targets, mutationRoots: [this], scrollRoots: [] };
  }

  open({ creditId = null, title = null, expiry = null, retry = false } = {}) {
    this.creditId = creditId;
    const dialog = this.dialog();
    dialog.returnValue = "";
    dialog.querySelector("h2").textContent = retry
      ? "Retry this reset request?"
      : "Use a Codex reset credit?";
    const description = dialog.querySelector("[data-reset-description]");
    description.textContent = retry
      ? "Caffold will retry the same request, so Codex will not spend another credit if it already completed."
      : "Codex will use one reset credit if an eligible rate-limit window can be reset. A used credit cannot be restored.";
    const selection = dialog.querySelector("[data-reset-selection]");
    selection.textContent = creditId
      ? `${title || "Rate-limit reset"}${expiry ? ` · expires ${expiry}` : " · expiration unknown"}`
      : "Codex will choose an available credit. Its expiration is not known in advance.";
    dialog.querySelector('button[value="use"]').textContent = retry
      ? "Retry request"
      : "Use reset credit";
    if (!dialog.open) dialog.showModal();
  }

  close() {
    const dialog = this.dialog();
    if (dialog.open) dialog.close();
  }

  handleClose() {
    if (this.dialog().returnValue !== "use") return;
    this.dispatchEvent(new CustomEvent(CODEX_RESET_CREDIT_CONFIRMED_EVENT, {
      bubbles: true,
      composed: true,
      detail: { creditId: this.creditId ?? null },
    }));
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="codex-reset-credit-dialog-title" aria-describedby="codex-reset-credit-dialog-description">
        <form method="dialog" class="codex-reset-credit-dialog-card">
          <h2 id="codex-reset-credit-dialog-title"></h2>
          <p id="codex-reset-credit-dialog-description" data-reset-description></p>
          <p data-reset-selection></p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="use">Use reset credit</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

customElements.define("caffold-codex-reset-credit-dialog", CaffoldCodexResetCreditDialog);
