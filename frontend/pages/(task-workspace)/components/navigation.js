import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import {
  codexState,
  formatCodexReadiness,
} from "../codex-status.js";
import { emptyActionHintScope } from "../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../action-hints.js";

const ICONS = {
  tasks: "ListTodo",
  settings: "Settings",
};

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
    this.codexStatusSnapshotValue = null;
    this.innerHTML = `
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
    this.syncCodexStatus();
  }

  setMode(mode) {
    this.ensureRendered();
    this.mode = mode === "settings" ? "settings" : "tasks";
    this.querySelectorAll("button[data-workspace-mode]").forEach((button) => {
      button.toggleAttribute(
        "aria-current",
        button.dataset.workspaceMode === this.mode,
      );
    });
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureRendered();
    this.codexStatusSnapshotValue = snapshot ?? null;
    this.syncCodexStatus();
  }

  actionHintScope({ scopeId = "workspace", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const targets = ["tasks", "settings"].flatMap((mode) => {
      const control = this.querySelector(
        `:scope > .task-workspace-navigation > button[data-workspace-mode="${mode}"]`,
      );
      if (!control || control.disabled || mode === this.mode) {
        return [];
      }
      const label = control.getAttribute("aria-label") ||
        `Open ${mode === "tasks" ? "Tasks" : "Settings"}`;
      return [{
        id: `${scopeId}:mode:${mode}`,
        actionId: ACTION_HINT_ACTION.WORKSPACE_SELECT,
        label,
        controlKind: "button",
        control,
        anchor: control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.mode !== mode &&
          this.querySelector(
            `:scope > .task-workspace-navigation > button[data-workspace-mode="${mode}"]`,
          ) === control &&
          !control.disabled,
        activate: () => {
          control.focus({ preventScroll: true });
          control.click();
        },
      }];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  syncCodexStatus() {
    const button = this.querySelector('button[data-workspace-mode="settings"]');
    if (!button) {
      return;
    }
    const state = codexState(this.codexStatusSnapshotValue);
    const readiness = formatCodexReadiness(this.codexStatusSnapshotValue);
    const label = state === "available"
      ? "Settings — Codex ready"
      : state === "pending"
        ? "Settings — checking Codex readiness"
        : `Settings — Codex ${readiness.toLowerCase()}`;
    button.dataset.codexState = state;
    button.title = label;
    button.setAttribute("aria-label", label);
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
