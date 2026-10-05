import { renderInlineIcon, warmIcons } from "#components/icons.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";

const ICONS = {
  tasks: "ListTodo",
  notes: "NotebookText",
  settings: "Settings",
};

const MODES = ["tasks", "notes", "settings"];
const MODE_LABELS = { tasks: "Tasks", notes: "Notes", settings: "Settings" };

class CaffoldTaskWorkspaceNavigation extends HTMLElement {
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
    this.mode = "tasks";
    this.updateAvailable = false;
    this.reloadReady = false;
    this.innerHTML = `
      <nav class="task-workspace-navigation" aria-label="Workspace">
        <button type="button" data-workspace-mode="tasks">
          <span data-workspace-navigation-icon="tasks">
            ${renderInlineIcon("ListTodo", "", "task-workspace-navigation-icon")}
          </span>
          <span>Tasks</span>
        </button>
        <button type="button" data-workspace-mode="notes">
          <span data-workspace-navigation-icon="notes">
            ${renderInlineIcon("NotebookText", "", "task-workspace-navigation-icon")}
          </span>
          <span>Notes</span>
        </button>
        <button type="button" data-workspace-mode="settings">
          <span data-workspace-navigation-icon="settings">
            ${renderInlineIcon("Settings", "", "task-workspace-navigation-icon")}
          </span>
          <span>Settings</span>
        </button>
      </nav>
    `;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-workspace-mode]");
      if (!button || !this.contains(button)) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent("caffold:workspace-navigation-intent", {
          bubbles: true,
          detail: { mode: button.dataset.workspaceMode },
        }),
      );
    });
    this.renderIcons();
    this.setMode(this.mode);
    this.syncSettingsStatus();
  }

  setMode(mode) {
    this.ensureRendered();
    this.mode = MODES.includes(mode) ? mode : "tasks";
    this.querySelectorAll("button[data-workspace-mode]").forEach((button) => {
      button.toggleAttribute(
        "aria-current",
        button.dataset.workspaceMode === this.mode,
      );
    });
  }

  setCaffoldUpdate(snapshot) {
    this.ensureRendered();
    this.updateAvailable = snapshot?.status?.updateAvailable === true;
    this.syncSettingsStatus();
  }

  /** Whether this window has a new build ready to load. */
  setUpdateStatus(status) {
    this.ensureRendered();
    this.reloadReady = status?.preparedUpdate?.ready === true;
    this.syncSettingsStatus();
  }

  actionHintScope({ scopeId = "workspace", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const targets = MODES.flatMap((mode) => {
      const control = this.querySelector(
        `:scope > .task-workspace-navigation > button[data-workspace-mode="${mode}"]`,
      );
      if (!control || control.disabled || mode === this.mode) {
        return [];
      }
      const label = control.getAttribute("aria-label") ||
        `Open ${MODE_LABELS[mode]}`;
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:mode:${mode}`,
        actionId: ACTION_HINT_ACTION.WORKSPACE_SELECT,
        label,
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.mode !== mode &&
          this.querySelector(
            `:scope > .task-workspace-navigation > button[data-workspace-mode="${mode}"]`,
          ) === control &&
          !control.disabled,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  syncSettingsStatus() {
    const button = this.querySelector('button[data-workspace-mode="settings"]');
    if (!button) {
      return;
    }
    const notices = [
      this.updateAvailable && "Caffold update available",
      this.reloadReady && "reload to update",
    ].filter(Boolean);
    button.toggleAttribute("data-update-available", notices.length > 0);
    if (notices.length > 0) {
      button.setAttribute("aria-label", `Settings — ${notices.join(", ")}`);
    } else {
      button.removeAttribute("aria-label");
    }
  }

  renderIcons() {
    if (!this.rendered) {
      return;
    }
    for (const [mode, icon] of Object.entries(ICONS)) {
      const target = this.querySelector(
        `[data-workspace-navigation-icon="${mode}"]`,
      );
      if (target) {
        target.innerHTML = renderInlineIcon(
          icon,
          "",
          "task-workspace-navigation-icon",
        );
      }
    }
  }
}

customElements.define(
  "caffold-task-workspace-navigation",
  CaffoldTaskWorkspaceNavigation,
);
