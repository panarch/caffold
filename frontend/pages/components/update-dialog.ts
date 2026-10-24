import { html, LitElement } from "lit";
import type { ActionHintScope } from "../../action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../action-hints.js";
import { keyboardNavigationContext } from "../../keyboard-navigation.js";
import "../../keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "../../keyboard-navigation/components/presentation.js";

export const CAFFOLD_UPDATE_LATER_EVENT = "caffold:update-later";
export const CAFFOLD_UPDATE_RELOAD_EVENT = "caffold:update-reload";

class CaffoldUpdateDialog extends LitElement {
  private ownerClosed = false;

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <dialog
        closedby="any"
        aria-labelledby="caffold-update-dialog-title"
        aria-describedby="caffold-update-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="update-dialog-card">
          <h2 id="caffold-update-dialog-title">Caffold update ready</h2>
          <p id="caffold-update-dialog-description">
            The new build is ready.<br>
            Reload now to use it, or keep using the current build.
          </p>
          <footer>
            <button type="submit" value="later" autofocus>Later</button>
            <button type="submit" value="reload">Reload</button>
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
    const dialog = this.dialog;
    if (!dialog?.open) {
      return;
    }
    this.ownerClosed = true;
    dialog.close();
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
        id: "app:update",
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
    const targets = ["later", "reload"].flatMap((value) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `button[value="${value}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `app:update:${value}`,
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
    if (this.ownerClosed) {
      this.ownerClosed = false;
      return;
    }
    const type =
      this.dialog?.returnValue === "reload"
        ? CAFFOLD_UPDATE_RELOAD_EVENT
        : CAFFOLD_UPDATE_LATER_EVENT;
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true }),
    );
  }
}

customElements.define("caffold-update-dialog", CaffoldUpdateDialog);
