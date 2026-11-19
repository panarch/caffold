import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { type CopilotStatus, getCopilotStatus } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "../components/detail-list.js";
import "../components/refresh-button.js";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.js";

import styles from "./page.css.js";

@customElement("caffold-settings-copilot-page")
export class CaffoldSettingsCopilotPage extends CaffoldElement {
  static override styles = styles;

  @state() private accessor status: CopilotStatus | null = null;
  @state() private accessor loading = false;
  @state() private accessor error = "";

  private active = false;
  private read: AbortController | null = null;

  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly refreshButton = new DrawnRef<CaffoldSettingsRefreshButton>(
    this,
  );
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);

  activate() {
    if (this.active) {
      return;
    }

    this.active = true;
    void this.reconcile();
  }

  deactivate() {
    this.active = false;
    this.read?.abort();
    this.read = null;
    this.loading = false;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  async reconcile() {
    if (!this.active || document.visibilityState === "hidden") {
      return;
    }

    this.read?.abort();
    const read = new AbortController();
    this.read = read;
    this.loading = true;
    this.error = "";

    try {
      const status = await getCopilotStatus(read.signal);
      if (this.read === read) {
        this.status = status;
      }
    } catch (error) {
      if (this.read === read) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not read Copilot status.";
      }
    } finally {
      if (this.read === read) {
        this.loading = false;
      }
    }
  }

  override render() {
    const status = this.status;
    const installation = status?.installation;
    const version =
      installation?.version ??
      (installation?.state === "notInstalled"
        ? "Not installed"
        : "Unavailable");
    const account = status?.authenticated
      ? (status.login ?? "Signed in")
      : status?.authenticated === false
        ? "Signed out"
        : "Unavailable";
    const models =
      status?.authenticated && !status.error
        ? status.models.map((model) => model.displayName).join(", ") || "None"
        : "Unavailable";
    const error = this.error || status?.error;

    const rows = [
      {
        key: "version",
        label: "CLI version",
        value: status ? version : undefined,
      },
      {
        key: "protocol",
        label: "SDK protocol",
        value: status ? (status.protocolVersion ?? "Unavailable") : undefined,
      },
      {
        key: "account",
        label: "GitHub account",
        value: status ? account : undefined,
      },
      {
        key: "models",
        label: "Available models",
        value: status ? models : undefined,
      },
    ];

    return html`
      <div
        class="settings-content-scroll"
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
      >
        <div class="settings-content-section">
          <header>
            <p>Uses the GitHub account signed in to Copilot CLI on this server.</p>
            <caffold-settings-refresh-button
              ${drawn(this.refreshButton)}
              .refreshing=${this.loading}
              @caffold:settings-refresh-intent=${this.reconcile}
            ></caffold-settings-refresh-button>
          </header>

          <section aria-label="Copilot CLI">
            <caffold-settings-detail-list .rows=${rows}></caffold-settings-detail-list>
          </section>
          ${error ? html`<p role="status">${error}</p>` : nothing}
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:copilot",
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId });
    return mergeActionHintScopes(
      own,
      this.refreshButton.value?.actionHintScope({
        scopeId,
        clipRoots: [
          this,
          this.scrollport.value as HTMLDivElement,
          ...(pull.clipRoots ?? []),
        ],
      }),
    );
  }

  scrollSurfaceScope({
    scopeId = "settings:copilot",
    label = "GitHub Copilot settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-copilot-page": CaffoldSettingsCopilotPage;
  }
}
