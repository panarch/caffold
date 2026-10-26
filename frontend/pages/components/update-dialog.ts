import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "../../action-hints.ts";
import { DrawnRef, drawn } from "../../components/drawn-refs.ts";
import { KeyboardContexts } from "../../keyboard-navigation.ts";
import "../../keyboard-navigation/components/presentation.ts";

export const CAFFOLD_UPDATE_LATER_EVENT = "caffold:update-later";
export const CAFFOLD_UPDATE_RELOAD_EVENT = "caffold:update-reload";

export class CaffoldUpdateDialog extends LitElement {
  private ownerClosed = false;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

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
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "app:update" })}
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
            <button
              ${this.hints.button({
                id: "later",
                label: "Later",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="later"
              autofocus
            >Later</button>
            <button
              ${this.hints.button({
                id: "reload",
                label: "Reload",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="reload"
            >Reload</button>
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
    const dialog = this.dialog.value;
    if (!dialog?.open) {
      return;
    }
    this.ownerClosed = true;
    dialog.close();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  private handleClose() {
    if (this.ownerClosed) {
      this.ownerClosed = false;
      return;
    }
    const type =
      this.dialog.value?.returnValue === "reload"
        ? CAFFOLD_UPDATE_RELOAD_EVENT
        : CAFFOLD_UPDATE_LATER_EVENT;
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true }),
    );
  }
}

customElements.define("caffold-update-dialog", CaffoldUpdateDialog);
