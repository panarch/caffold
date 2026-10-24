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

export const CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:claude-runtime-restart-confirmed";

class CaffoldClaudeRuntimeRestartDialog extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <dialog
        closedby="any"
        aria-labelledby="claude-runtime-dialog-title"
        aria-describedby="claude-runtime-dialog-description"
        @close=${this.handleClose}
      >
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
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  async open() {
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
        id: "claude-runtime-restart",
        kind: "modal",
        root: dialog,
        actionHints: {
          dialog: hintDialog,
          scope: this.actionHintScope(),
        },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const targets = ["cancel", "restart"].flatMap((value) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `button[value="${value}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `claude-runtime-restart:${value}`,
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
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }

  private handleClose() {
    if (this.dialog?.returnValue !== "restart") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define(
  "caffold-claude-runtime-restart-dialog",
  CaffoldClaudeRuntimeRestartDialog,
);
