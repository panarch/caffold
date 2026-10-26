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

export const CODEX_RUNTIME_UPDATE_CONFIRMED_EVENT =
  "caffold:codex-runtime-update-confirmed";

export class CaffoldCodexRuntimeUpdateDialog extends LitElement {
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
        aria-labelledby="codex-update-dialog-title"
        aria-describedby="codex-update-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="codex-update-dialog-card">
          <h2 id="codex-update-dialog-title">Update Codex?</h2>
          <p id="codex-update-dialog-description">
            Wait for running Tasks and tests to finish. Caffold runs the
            official Codex updater. When the installed version changes, Codex
            restarts the shared runtime Caffold is connected to, and work still
            running after its shutdown grace period (60 seconds by default)
            stops here and in other connected Codex clients.
          </p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="update">Update Codex</button>
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
        id: "codex-runtime-update",
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
    const targets = ["cancel", "update"].flatMap((value) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `button[value="${value}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `codex-runtime-update:${value}`,
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
    if (this.dialog?.returnValue !== "update") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CODEX_RUNTIME_UPDATE_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define(
  "caffold-codex-runtime-update-dialog",
  CaffoldCodexRuntimeUpdateDialog,
);
