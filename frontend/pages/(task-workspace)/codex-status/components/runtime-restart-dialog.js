import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../action-hints.js";
import { keyboardNavigationContext } from "../../keyboard-navigation-context.js";
import "../../components/keyboard-navigation-presentation.js";

export const CODEX_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:codex-runtime-restart-confirmed";

class CaffoldCodexRuntimeRestartDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
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
    if (!dialog || !hintDialog) {
      return [];
    }
    return [keyboardNavigationContext({
      id: "codex-runtime-restart",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    if (!dialog) {
      return emptyActionHintScope();
    }
    const targets = ["cancel", "restart"].flatMap((value) => {
      const control = dialog.querySelector(`button[value="${value}"]`);
      if (!control) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `codex-runtime-restart:${value}`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.textContent?.trim() || value,
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          dialog.querySelector(`button[value="${value}"]`) === control &&
          !control.disabled,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  open() {
    const dialog = this.dialog();
    dialog.returnValue = "";
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  close() {
    const dialog = this.dialog();
    if (dialog.open) {
      dialog.close();
    }
  }

  handleClose() {
    if (this.dialog().returnValue !== "restart") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CODEX_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="codex-runtime-dialog-title" aria-describedby="codex-runtime-dialog-description">
        <form method="dialog" class="codex-runtime-dialog-card">
          <h2 id="codex-runtime-dialog-title">Restart Codex runtime?</h2>
          <p id="codex-runtime-dialog-description">
            Wait for running Tasks and tests to finish. This restarts the shared Codex runtime Caffold is connected to and may interrupt active work here or in other connected Codex clients.
          </p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="restart">Restart Codex</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

customElements.define(
  "caffold-codex-runtime-restart-dialog",
  CaffoldCodexRuntimeRestartDialog,
);
