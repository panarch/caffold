import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../../keyboard-navigation.js";
import "../../../../../keyboard-navigation/components/presentation.js";

export const CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:claude-runtime-restart-confirmed";

class CaffoldClaudeRuntimeRestartDialog extends HTMLElement {
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
      id: "claude-runtime-restart",
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
        id: `claude-runtime-restart:${value}`,
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
      new CustomEvent(CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="claude-runtime-dialog-title" aria-describedby="claude-runtime-dialog-description">
        <form method="dialog" class="claude-runtime-dialog-card">
          <h2 id="claude-runtime-dialog-title">Restart Claude runtime?</h2>
          <p id="claude-runtime-dialog-description">
            This stops the Claude runner and ends every running Claude turn.
            Conversations resume from their files as their Tasks are opened.
          </p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="restart">Restart Claude</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

customElements.define(
  "caffold-claude-runtime-restart-dialog",
  CaffoldClaudeRuntimeRestartDialog,
);
