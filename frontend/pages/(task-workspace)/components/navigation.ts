import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import type { CaffoldUpdateSnapshot } from "../settings/about/page.js";

type WorkspaceMode = "tasks" | "notes" | "settings";

const MODES: readonly { mode: WorkspaceMode; label: string; icon: string }[] = [
  { mode: "tasks", label: "Tasks", icon: "ListTodo" },
  { mode: "notes", label: "Notes", icon: "NotebookText" },
  { mode: "settings", label: "Settings", icon: "Settings" },
];

/**
 * The workspace's Tasks, Notes, and Settings buttons, with the one shown
 * marked current and Settings marked while an update waits.
 */
@customElement("caffold-task-workspace-navigation")
export class CaffoldTaskWorkspaceNavigation extends LitElement {
  @state()
  private accessor mode: WorkspaceMode = "tasks";
  @state()
  private accessor updateAvailable = false;
  @state()
  private accessor reloadReady = false;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setMode(mode: string | null | undefined) {
    this.mode = MODES.find((entry) => entry.mode === mode)?.mode ?? "tasks";
  }

  setCaffoldUpdate(snapshot: CaffoldUpdateSnapshot | null | undefined) {
    this.updateAvailable = snapshot?.status?.updateAvailable === true;
  }

  /** Whether this window has a new build ready to load. */
  setUpdateStatus(
    status: { preparedUpdate?: { ready?: boolean } | null } | null | undefined,
  ) {
    this.reloadReady = status?.preparedUpdate?.ready === true;
  }

  actionHintScope({ scopeId = "workspace", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  override render() {
    const notices = [
      this.updateAvailable && "Caffold update available",
      this.reloadReady && "reload to update",
    ].filter(Boolean);
    return html`
      <nav class="task-workspace-navigation" aria-label="Workspace">
        ${MODES.map(({ mode, label, icon }) => {
          const notice =
            mode === "settings" && notices.length > 0
              ? `Settings — ${notices.join(", ")}`
              : "";
          return html`<button
            ${this.hints.button({
              id: `mode:${mode}`,
              label: notice || `Open ${label}`,
              action: ACTION_HINT_ACTION.WORKSPACE_SELECT,
              when: mode !== this.mode,
            })}
            type="button"
            data-workspace-mode=${mode}
            ?aria-current=${mode === this.mode}
            ?data-update-available=${Boolean(notice)}
            aria-label=${notice || nothing}
            @click=${this.select}
          >
            <span data-workspace-navigation-icon=${mode}>${inlineIcon(
              icon,
              "",
              "task-workspace-navigation-icon",
            )}</span>
            <span>${label}</span>
          </button>`;
        })}
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
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-workspace-navigation": CaffoldTaskWorkspaceNavigation;
  }
}
