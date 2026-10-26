import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.ts";
import { KeyboardContexts } from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";

export const CODEX_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:codex-runtime-restart-confirmed";

export class CaffoldCodexRuntimeRestartDialog extends LitElement {
  private readonly hints = new ActionHints(this, () => this.performUpdate());
  private readonly keyboard = new KeyboardContexts(this, () =>
    this.performUpdate(),
  );
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
        ${this.keyboard.modal({ id: "codex-runtime-restart" })}
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
                label: "Restart Codex",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="restart"
            >Restart Codex</button>
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
