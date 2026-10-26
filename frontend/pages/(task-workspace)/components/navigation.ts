import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import type { CaffoldUpdateSnapshot } from "../settings/about/page.ts";

type WorkspaceMode = "tasks" | "notes" | "settings";

const MODES: readonly { mode: WorkspaceMode; label: string; icon: string }[] = [
  { mode: "tasks", label: "Tasks", icon: "ListTodo" },
  { mode: "notes", label: "Notes", icon: "NotebookText" },
  { mode: "settings", label: "Settings", icon: "Settings" },
];

/**
 * The workspace's Tasks, Notes, and Settings buttons, with the one shown
 * marked current and Settings marked while an update waits.
 *
 * The workspace hands it the mode and update state and reads its Action
 * Hints right after, so it draws at once.
 */
export class CaffoldTaskWorkspaceNavigation extends LitElement {
  private mode: WorkspaceMode = "tasks";
  private updateAvailable = false;
  private reloadReady = false;
  private readonly iconsReady = () => this.requestUpdate();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setMode(mode: string | null | undefined) {
    this.mode = MODES.find((entry) => entry.mode === mode)?.mode ?? "tasks";
    this.draw();
  }

  setCaffoldUpdate(snapshot: CaffoldUpdateSnapshot | null | undefined) {
    this.updateAvailable = snapshot?.status?.updateAvailable === true;
    this.draw();
  }

  /** Whether this window has a new build ready to load. */
  setUpdateStatus(
    status: { preparedUpdate?: { ready?: boolean } | null } | null | undefined,
  ) {
    this.reloadReady = status?.preparedUpdate?.ready === true;
    this.draw();
  }

  actionHintScope({
    scopeId = "workspace",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const targets = MODES.flatMap(({ mode, label }) => {
      const control = this.modeButton(mode);
      if (!control || control.disabled || mode === this.mode) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:mode:${mode}`,
          actionId: ACTION_HINT_ACTION.WORKSPACE_SELECT,
          label: control.getAttribute("aria-label") || `Open ${label}`,
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.mode !== mode &&
            this.modeButton(mode) === control &&
            !control.disabled,
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  render() {
    const notices = [
      this.updateAvailable && "Caffold update available",
      this.reloadReady && "reload to update",
    ].filter(Boolean);
    return html`
      <nav class="task-workspace-navigation" aria-label="Workspace">
        ${MODES.map(
          ({ mode, label, icon }) => html`<button
            type="button"
            data-workspace-mode=${mode}
            ?aria-current=${mode === this.mode}
            ?data-update-available=${mode === "settings" && notices.length > 0}
            aria-label=${
              mode === "settings" && notices.length > 0
                ? `Settings — ${notices.join(", ")}`
                : nothing
            }
            @click=${this.select}
          >
            <span data-workspace-navigation-icon=${mode}>${inlineIcon(
              icon,
              "",
              "task-workspace-navigation-icon",
            )}</span>
            <span>${label}</span>
          </button>`,
        )}
      </nav>
    `;
  }

  private select(event: Event) {
    const button = event.currentTarget as HTMLButtonElement;
    this.dispatchEvent(
      new CustomEvent("caffold:workspace-navigation-intent", {
        bubbles: true,
        detail: { mode: button.dataset.workspaceMode },
      }),
    );
  }

  private modeButton(mode: WorkspaceMode) {
    return this.querySelector<HTMLButtonElement>(
      `:scope > .task-workspace-navigation > button[data-workspace-mode="${mode}"]`,
    );
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define(
  "caffold-task-workspace-navigation",
  CaffoldTaskWorkspaceNavigation,
);
