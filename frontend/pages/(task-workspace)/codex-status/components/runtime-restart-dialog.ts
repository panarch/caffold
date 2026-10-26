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

export const CODEX_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:codex-runtime-restart-confirmed";

export class CaffoldCodexRuntimeRestartDialog extends LitElement {
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
    return html`
      <dialog
        closedby="any"
        aria-labelledby="codex-runtime-dialog-title"
        aria-describedby="codex-runtime-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="codex-runtime-dialog-card">
          <h2 id="codex-runtime-dialog-title">Restart Codex runtime?</h2>
          <p id="codex-runtime-dialog-description">
            Wait for running Tasks and tests to finish. This restarts the shared
            Codex runtime Caffold is connected to and may interrupt active work
            here or in other connected Codex clients.
          </p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="restart">Restart Codex</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  open() {
    const dialog = this.dialog;
    if (!dialog || dialog.open) {
      return;
    }
    dialog.returnValue = "";
    dialog.showModal();
  }

  close() {
    this.dialog?.close();
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const hintDialog = dialog
      ?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      )
      ?.actionHintDialog();
    if (!dialog || !hintDialog) {
      return [];
    }
    return [
      keyboardNavigationContext({
        id: "codex-runtime-restart",
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
          id: `codex-runtime-restart:${value}`,
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
      new CustomEvent(CODEX_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define(
  "caffold-codex-runtime-restart-dialog",
  CaffoldCodexRuntimeRestartDialog,
);
