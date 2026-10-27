import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

export const CODEX_RUNTIME_UPDATE_CONFIRMED_EVENT =
  "caffold:codex-runtime-update-confirmed";

@customElement("caffold-codex-runtime-update-dialog")
export class CaffoldCodexRuntimeUpdateDialog extends LitElement {
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "codex-runtime-update" })}
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
                id: "update",
                label: "Update Codex",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="update"
            >Update Codex</button>
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
    if (this.dialog.value?.returnValue !== "update") {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-codex-runtime-update-dialog": CaffoldCodexRuntimeUpdateDialog;
  }
}
