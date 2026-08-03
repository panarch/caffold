import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import "./tasks/page.js";

class CaffoldCodexWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.updateCloseIcon();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
    void warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
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
        aria-label="Back to tasks"
        title="Back to tasks"
      >
        ${renderInlineIcon("X", "Close", "codex-workspace-close-icon")}
      </button>
      <caffold-tasks-page></caffold-tasks-page>
    `;
    this.closeButton = this.querySelector(".codex-workspace-close");
    this.updateCloseIcon();
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
    this.updateCloseButton();
  }

  updateCloseIcon() {
    if (!this.closeButton) {
      return;
    }
    this.closeButton.innerHTML = renderInlineIcon(
      "X",
      "Close",
      "codex-workspace-close-icon",
    );
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.route = route;
    this.tasksPage.prepareRoute(route, options);
    this.updateCloseButton();
  }

  async openRoute(route, options = {}) {
    this.ensureRendered();
    this.route = route;
    const result = await this.tasksPage.openRoute(route, options);
    this.updateCloseButton();
    return result;
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.tasksPage.selectedTaskContextPath();
  }

  updateCloseButton() {
    if (!this.closeButton) {
      return;
    }

    const isTaskSubview =
      this.tasksPage?.taskDetailView &&
      this.tasksPage.taskDetailView !== "conversation";
    const isGlobalTasksHome = Boolean(
      this.route?.kind === "tasks" &&
        !this.route.new &&
        !this.route.threadId,
    );
    this.closeButton.hidden = isGlobalTasksHome;
    this.toggleAttribute("data-workspace-close-visible", !isGlobalTasksHome);
    const label = isTaskSubview ? "Back to task" : "Back to tasks";
    this.closeButton.setAttribute("aria-label", label);
    this.closeButton.setAttribute("title", label);
  }
}

customElements.define("caffold-codex-workspace", CaffoldCodexWorkspace);
