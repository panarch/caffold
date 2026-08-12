export const CODEX_RUNTIME_RESTART_CONFIRMED_EVENT =
  "caffold:codex-runtime-restart-confirmed";

class CaffoldCodexRuntimeRestartDialog extends HTMLElement {
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
      new CustomEvent(CODEX_RUNTIME_RESTART_CONFIRMED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="codex-runtime-dialog-title" aria-describedby="codex-runtime-dialog-description">
        <form method="dialog" class="codex-runtime-dialog-card">
          <h2 id="codex-runtime-dialog-title">Restart Codex runtime?</h2>
          <p id="codex-runtime-dialog-description">
            This restarts the shared Codex app-server and interrupts active work in Caffold and other Codex clients.
          </p>
          <footer>
            <button type="submit" value="cancel" autofocus>Cancel</button>
            <button type="submit" value="restart">Restart Codex</button>
          </footer>
        </form>
      </dialog>
    `;
  }
}

customElements.define(
  "caffold-codex-runtime-restart-dialog",
  CaffoldCodexRuntimeRestartDialog,
);
