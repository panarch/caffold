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
    this.closeButton = this.querySelector(".codex-workspace-close");
    this.closeButton.addEventListener("click", () => {
      if (this.tasksPage?.closeActiveSubview?.()) {
        this.updateCloseButton();
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:close-codex-workspace", {
          bubbles: true,
        }),
      );
    });
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.tasksPage.ensureRendered();
    this.addEventListener("caffold:task-detail-view-change", () => this.updateCloseButton());
    this.updateCloseButton();
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.tasksPage.prepareRoute(route, options);
    this.updateCloseButton();
  }

  async openRoute(route, options = {}) {
    this.ensureRendered();
    const result = await this.tasksPage.openRoute(route, options);
    this.updateCloseButton();
    return result;
  }

  updateCloseButton() {
    if (!this.closeButton) {
      return;
    }

    const isTaskSubview =
      this.tasksPage?.taskDetailView &&
      this.tasksPage.taskDetailView !== "conversation";
    const label = isTaskSubview ? "Back to task" : "Close Codex workspace";
    this.closeButton.setAttribute("aria-label", label);
    this.closeButton.setAttribute("title", label);
  }
}

customElements.define("caffold-codex-workspace", CaffoldCodexWorkspace);
