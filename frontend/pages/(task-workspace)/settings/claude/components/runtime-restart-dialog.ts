import { html, LitElement } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.ts";
import { KeyboardContexts } from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";

export const CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:claude-runtime-restart-confirmed";

export class CaffoldClaudeRuntimeRestartDialog extends LitElement {
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({ id: "claude-runtime-restart" })}
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
                label: "Restart Claude",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="restart"
            >Restart Claude</button>
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
