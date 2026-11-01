import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

import styles from "./runtime-restart-dialog.css.js";

export const RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:runtime-restart-confirmed";

@customElement("caffold-settings-runtime-restart-dialog")
export class CaffoldSettingsRuntimeRestartDialog extends CaffoldElement {
  static override styles = styles;

  @property() accessor agentName = "Claude";

  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  override render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "runtime-restart" })}
        closedby="any"
        aria-labelledby="runtime-dialog-title"
        aria-describedby="runtime-dialog-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="runtime-dialog-card">
          <h2 id="runtime-dialog-title">Restart ${this.agentName} runtime?</h2>
          <p id="runtime-dialog-description">
            This stops the ${this.agentName} runner and ends every running ${this.agentName} turn.
            Conversations resume from their files as their Tasks are opened.
          </p>
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
                id: "restart",
                label: `Restart ${this.agentName}`,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="restart"
            >Restart ${this.agentName}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  open() {
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
    if (this.dialog.value?.returnValue !== "restart") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-runtime-restart-dialog": CaffoldSettingsRuntimeRestartDialog;
  }
}
