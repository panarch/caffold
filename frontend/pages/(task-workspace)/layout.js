import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import { routeTarget } from "../../navigation-routes.js";
import "./tasks/page.js";
import "./settings/layout.js";

class CaffoldTaskWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderIcons();
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
    this.lastTaskRoute = { kind: "tasks" };
    this.innerHTML = `
      <button
        type="button"
        class="task-workspace-close"
        aria-label="Back to tasks"
        title="Back to tasks"
      >
        ${renderInlineIcon("X", "Close", "task-workspace-close-icon")}
      </button>
      <caffold-tasks-page></caffold-tasks-page>
      <caffold-settings-workspace hidden></caffold-settings-workspace>
      <nav class="task-workspace-navigation" aria-label="Workspace">
        <button type="button" data-workspace-mode="tasks">
          <span data-workspace-navigation-icon="tasks">
            ${renderInlineIcon("ListTodo", "", "task-workspace-navigation-icon")}
          </span>
          <span>Tasks</span>
        </button>
        <button type="button" data-workspace-mode="settings">
          <span data-workspace-navigation-icon="settings">
            ${renderInlineIcon("Settings", "", "task-workspace-navigation-icon")}
          </span>
          <span>Settings</span>
        </button>
      </nav>
    `;
    this.closeButton = this.querySelector(".task-workspace-close");
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.settingsWorkspace = this.querySelector("caffold-settings-workspace");
    this.tasksPage.ensureRendered();
    this.settingsWorkspace.ensureRendered();
    this.renderIcons();

    this.closeButton.addEventListener("click", () => {
      if (this.tasksPage?.closeActiveSubview?.()) {
        this.updateChrome();
        return;
      }
      this.dispatchEvent(
        new CustomEvent("caffold:close-task-workspace", { bubbles: true }),
      );
    });
    this.querySelector(".task-workspace-navigation").addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("button[data-workspace-mode]");
        if (!button) {
          return;
        }
        const route = button.dataset.workspaceMode === "tasks"
          ? this.lastTaskRoute
          : { kind: "settings", section: "" };
        this.dispatchEvent(
          new CustomEvent("caffold:request-workspace-route", {
            bubbles: true,
            detail: { route: { ...route } },
          }),
        );
      },
    );
    this.updateChrome();
  }

  renderIcons() {
    if (this.closeButton) {
      this.closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close",
        "task-workspace-close-icon",
      );
    }
    const icons = {
      tasks: "ListTodo",
      settings: "Settings",
    };
    for (const [mode, name] of Object.entries(icons)) {
      const target = this.querySelector(`[data-workspace-navigation-icon="${mode}"]`);
      if (target) {
        target.innerHTML = renderInlineIcon(
          name,
          "",
          "task-workspace-navigation-icon",
        );
      }
    }
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.route = route;
    this.mode = route?.kind === "settings" ? "settings" : "tasks";
    if (this.mode === "tasks") {
      this.lastTaskRoute = { ...route };
      this.tasksPage.prepareRoute(route, options);
    } else {
      this.settingsWorkspace.prepareRoute(route);
    }
    this.tasksPage.hidden = this.mode !== "tasks";
    this.settingsWorkspace.hidden = this.mode !== "settings";
    this.updateChrome();
  }

  async openRoute(route, options = {}) {
    this.prepareRoute(route, options);
    if (this.mode === "settings") {
      return null;
    }
    const result = await this.tasksPage.openRoute(route, options);
    this.updateChrome();
    return result;
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.tasksPage.selectedTaskContextPath();
  }

  setCodexStatus(status) {
    this.ensureRendered();
    this.settingsWorkspace.setCodexStatus(status);
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.settingsWorkspace.setBuildStatus(health);
  }

  updateChrome() {
    if (!this.closeButton) {
      return;
    }
    const taskRoute = this.mode === "tasks" ? this.route : null;
    const target = taskRoute ? routeTarget(taskRoute) : null;
    const isTaskSubview =
      this.tasksPage?.taskDetailView &&
      this.tasksPage.taskDetailView !== "conversation";
    const isGlobalTasksHome = target === "home";
    const isTaskConversation = target === "detail" && !isTaskSubview;
    const showClose = Boolean(taskRoute && !isGlobalTasksHome);

    this.closeButton.hidden = !showClose;
    this.toggleAttribute("data-workspace-close-visible", showClose);
    this.toggleAttribute(
      "data-workspace-close-responsive",
      isTaskConversation || target === "new",
    );
    this.toggleAttribute(
      "data-hide-navigation",
      Boolean(taskRoute && isTaskSubview),
    );
    this.toggleAttribute(
      "data-hide-navigation-on-compact",
      Boolean(taskRoute && (target === "detail" || isTaskSubview)),
    );
    this.dataset.workspaceMode = this.mode ?? "tasks";

    const label = isTaskSubview ? "Back to task" : "Back to tasks";
    this.closeButton.setAttribute("aria-label", label);
    this.closeButton.setAttribute("title", label);
    this.querySelectorAll("[data-workspace-mode]").forEach((button) => {
      const active = button.dataset.workspaceMode === this.mode;
      button.toggleAttribute("aria-current", active);
    });
  }
}

customElements.define("caffold-task-workspace", CaffoldTaskWorkspace);
