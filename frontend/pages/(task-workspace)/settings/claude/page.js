export const CLAUDE_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-claude-runtime-restart";

class CaffoldSettingsClaudePage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.restartState = "idle";
    this.restartMessage = "";
    this.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="open-claude-restart"]')) {
        this.dispatchEvent(
          new CustomEvent(CLAUDE_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
        );
      }
    });
    this.render();
  }

  setRestartState(value) {
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (this.initialized) {
      this.render();
    }
  }

  render() {
    if (!this.pageMounted) {
      this.pageMounted = true;
      this.innerHTML = `
        <div class="settings-content-scroll">
          <div class="settings-content-section">
            <header>
              <p>The runner that holds Claude sessions for this server.</p>
            </header>
            <section class="settings-runtime-control" aria-labelledby="settings-claude-runtime-title">
              <div>
                <h3 id="settings-claude-runtime-title">Runtime</h3>
                <p data-runtime-summary>
                  Restarting stops the runner and every Claude session it holds,
                  the way an application update does. Conversations resume from
                  their files as their Tasks are opened.
                </p>
              </div>
              <button type="button" data-action="open-claude-restart">Restart runtime</button>
            </section>
            <p class="settings-runtime-message" role="status" hidden></p>
          </div>
        </div>
      `;
    }

    const restarting = this.restartState === "restarting";
    const restart = this.querySelector('[data-action="open-claude-restart"]');
    restart.disabled = restarting;
    restart.textContent = restarting ? "Restarting\u2026" : "Restart runtime";
    const message = this.querySelector(".settings-runtime-message");
    message.hidden = !this.restartMessage;
    message.dataset.state = this.restartState;
    message.textContent = this.restartMessage;
  }
}

customElements.define("caffold-settings-claude-page", CaffoldSettingsClaudePage);
