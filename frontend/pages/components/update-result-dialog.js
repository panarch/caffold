import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../action-hints.js";
import { keyboardNavigationContext } from "../../keyboard-navigation.js";
import "../../keyboard-navigation/components/presentation.js";

/**
 * Tells this browser that an update of Caffold did not stick. It only
 * informs, so its one button closes it.
 */
class CaffoldUpdateResultDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.render();
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  /** Shows what happened to the attempt, which must have failed. */
  open(attempt) {
    const notice = updateResultNotice(attempt);
    if (!notice) {
      return;
    }
    this.querySelector("#caffold-update-result-title").textContent = notice.title;
    this.querySelector("#caffold-update-result-description").textContent =
      notice.description;
    const dialog = this.dialog();
    if (!dialog.open) {
      dialog.showModal();
    }
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
      id: "app:update-result",
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
    const control = dialog?.querySelector('button[value="ok"]');
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: "app:update-result:ok",
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.textContent?.trim() || "OK",
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          dialog.querySelector('button[value="ok"]') === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="caffold-update-result-title" aria-describedby="caffold-update-result-description">
        <form method="dialog" class="update-result-dialog-card">
          <h2 id="caffold-update-result-title"></h2>
          <p id="caffold-update-result-description"></p>
          <footer>
            <button type="submit" value="ok" autofocus>OK</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

/**
 * The title and sentence for an attempt that ended with Caffold not updated
 * and not running as planned. Other outcomes are told elsewhere.
 */
export function updateResultNotice(attempt) {
  const from = `${attempt?.fromVersion ?? ""}`;
  const reason = `${attempt?.reason ?? ""}`;
  const details = "See Settings → About Caffold for details.";
  if (attempt?.outcome === "rolledBack") {
    return {
      title: "Caffold update was rolled back",
      description: `${reason}, so Caffold ${from} was restored. ${details}`,
    };
  }
  if (attempt?.outcome === "restoreFailed") {
    return {
      title: "Caffold update failed",
      description: `${reason}. ${details}`,
    };
  }
  return null;
}

customElements.define("caffold-update-result-dialog", CaffoldUpdateResultDialog);
