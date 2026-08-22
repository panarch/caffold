export const CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:claude-runtime-restart-confirmed";

class CaffoldClaudeRuntimeRestartDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  open() {
    const dialog = this.dialog();
    dialog.returnValue = "";
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  close() {
    const dialog = this.dialog();
    if (dialog.open) {
      dialog.close();
    }
  }

  handleClose() {
    if (this.dialog().returnValue !== "restart") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="claude-runtime-dialog-title" aria-describedby="claude-runtime-dialog-description">
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
      </dialog>
    `;
  }
}

customElements.define(
  "caffold-claude-runtime-restart-dialog",
  CaffoldClaudeRuntimeRestartDialog,
);
