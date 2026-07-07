import "./tasks/page.js";

class CaffoldCodexWorkspace extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <button
        type="button"
        class="codex-workspace-close"
        aria-label="Close Codex workspace"
        title="Close Codex workspace"
      >
        <span aria-hidden="true">&times;</span>
      </button>
      <caffold-tasks-page></caffold-tasks-page>
    `;
    this.querySelector(".codex-workspace-close").addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:close-codex-workspace", {
          bubbles: true,
        }),
      );
    });
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.tasksPage.ensureRendered();
  }

  prepareRoute(route) {
    this.ensureRendered();
    this.tasksPage.prepareRoute(route);
  }

  async openRoute(route, options = {}) {
    this.ensureRendered();
    return await this.tasksPage.openRoute(route, options);
  }
}

customElements.define("caffold-codex-workspace", CaffoldCodexWorkspace);
