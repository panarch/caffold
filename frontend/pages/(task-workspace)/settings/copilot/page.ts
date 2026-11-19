import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type CopilotStatus,
  getCopilotRuntime,
  getCopilotStatus,
  restartCopilotRuntime,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "../components/detail-list.js";
import type { SettingsDetailRow } from "../components/detail-list.js";
import "../components/refresh-button.js";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.js";
import {
  type CaffoldSettingsRuntime,
  runnerStatusRows,
} from "../components/runtime.js";
import { quotaRow } from "./usage.js";

import styles from "./page.css.js";

// A confirmed restart continues when Settings is hidden and can be rejoined on return.
type Control = "inactive" | "ready" | "restarting" | "restartingWhileAway";
type Intent = "activate" | "deactivate" | "restart" | "settle";
const transitions: Record<Control, Partial<Record<Intent, Control>>> = {
  inactive: { activate: "ready" },
  ready: { deactivate: "inactive", restart: "restarting" },
  restarting: { deactivate: "restartingWhileAway", settle: "ready" },
  restartingWhileAway: { activate: "restarting", settle: "inactive" },
};

@customElement("caffold-settings-copilot-page")
export class CaffoldSettingsCopilotPage extends CaffoldElement {
  static override styles = styles;

  @state() private accessor status: CopilotStatus | null = null;
  @state() private accessor loading = false;
  @state() private accessor error = "";

  @state() private accessor control: Control = "inactive";
  @state() private accessor restartMessage = "";
  private poll: ReturnType<typeof setTimeout> | null = null;
  private readonly runtime = new DrawnRef<CaffoldSettingsRuntime>(this);
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
    if (this.transition("activate") && this.control === "ready") {
      void this.reconcile();
    }
  }

  deactivate() {
    if (this.transition("deactivate")) {
      this.cancelRead();
      this.runtime.value?.close();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  async reconcile() {
    if (this.control !== "ready" || document.visibilityState === "hidden") {
      return;
    }

    this.cancelRead();
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
        this.status = null;
        this.error =
          error instanceof Error
            ? error.message
            : "Could not read Copilot status.";
      }
    } finally {
      if (this.read === read) {
        this.read = null;
        this.loading = false;
        this.pollDuringRestart();
      }
    }
  }

  private async restart() {
    if (
      !this.status?.runtime ||
      this.status.runtime.restarting ||
      !this.transition("restart")
    ) {
      return;
    }

    this.cancelRead();
    this.restartMessage = "";
    this.error = "";
    try {
      this.status = await restartCopilotRuntime();
      this.restartMessage = "Copilot runner restarted.";
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : "Could not restart the Copilot runtime.";
    } finally {
      this.transition("settle");
      this.pollDuringRestart();
    }
  }

  private transition(intent: Intent) {
    const next = transitions[this.control][intent];
    if (!next) return false;
    this.control = next;
    return true;
  }

  private pollDuringRestart() {
    if (this.control === "ready" && this.status?.runtime?.restarting) {
      this.poll = setTimeout(() => void this.readRuntime(), 1000);
    }
  }

  private async readRuntime() {
    if (
      !this.status ||
      this.control !== "ready" ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const read = new AbortController();
    this.read = read;
    try {
      const runtime = await getCopilotRuntime(read.signal);
      if (this.read === read) {
        this.status = { ...this.status, runtime };
        this.error = "";
      }
    } catch (error) {
      if (this.read === read) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not read the Copilot runner.";
      }
    } finally {
      if (this.read === read) {
        this.read = null;
        this.pollDuringRestart();
      }
    }
  }

  private cancelRead() {
    if (this.poll !== null) clearTimeout(this.poll);
    this.poll = null;
    this.read?.abort();
    this.read = null;
    this.loading = false;
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
    const waiting = !status && this.loading;
    const usage = status?.authenticated ? status.usage : null;
    const error = this.error || status?.error;
    const runtime = status?.runtime;
    const restarting =
      this.control === "restarting" || runtime?.restarting === true;
    const modelList =
      status?.authenticated && !status.modelsError ? status.models : null;
    const unavailable = waiting
      ? "Loading…"
      : status?.authenticated === false
        ? "Signed out"
        : "Unavailable";

    const rows: SettingsDetailRow[] = [
      {
        key: "account",
        label: "GitHub account",
        value: waiting ? undefined : account,
      },
      {
        key: "plan",
        label: "Plan",
        value: waiting ? undefined : (usage?.plan ?? unavailable),
      },
      {
        key: "version",
        label: "CLI version",
        value: waiting ? undefined : version,
      },
      {
        key: "cliPath",
        label: "CLI path",
        kind: "code",
        value: waiting ? undefined : (status?.cliPath ?? "Unavailable"),
      },
      {
        key: "protocol",
        label: "SDK protocol",
        value: waiting ? undefined : (status?.protocolVersion ?? "Unavailable"),
      },
    ];
    const usageRows = usage?.quotas.map(quotaRow) ?? [];
    const emptyUsage =
      usage && !usage.errors.length ? "No usage reported." : unavailable;

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
            <div>
              <p>Uses the GitHub account signed in to Copilot CLI on this server.</p>
              <a class="settings-service-status"
                ${this.hints.link({ id: "service-status", action: ACTION_HINT_ACTION.LINK_OPEN })}
                href="https://www.githubstatus.com/" target="_blank" rel="noreferrer"
              >Service status</a>
            </div>
            <caffold-settings-refresh-button
              ${drawn(this.refreshButton)}
              .refreshing=${this.loading}
              .disabled=${restarting}
              @caffold:settings-refresh-intent=${this.reconcile}
            ></caffold-settings-refresh-button>
          </header>

          <section aria-labelledby="copilot-usage">
            <h3 id="copilot-usage">Usage</h3>
            ${
              usageRows.length
                ? html`<caffold-settings-detail-list .rows=${usageRows}></caffold-settings-detail-list>`
                : html`<p>${emptyUsage}</p>`
            }
            ${usage?.errors.map((message) => html`<p role="status">${message}</p>`)}
          </section>

          <section aria-labelledby="copilot-agent">
            <h3 id="copilot-agent">Agent</h3>
            <caffold-settings-detail-list .rows=${rows}></caffold-settings-detail-list>
          </section>
          ${error ? html`<p role="status">${error}</p>` : nothing}

          <section aria-label="Runtime">
            <caffold-settings-runtime
              ${drawn(this.runtime)}
              .agentName=${"Copilot"}
              description="Restarting stops the Copilot runner and its Task processes. Tasks reopen their saved conversations with the installed CLI."
              .rows=${runnerStatusRows(runtime)}
              .disabled=${!runtime || restarting}
              .restarting=${restarting}
              .message=${this.restartMessage}
              @caffold:runtime-restart-confirmed=${this.restart}
            ></caffold-settings-runtime>
          </section>

          <section aria-labelledby="copilot-models">
            <h3 id="copilot-models">${modelList ? `Models (${modelList.length})` : "Models"}</h3>
            ${
              modelList?.length
                ? html`<ul class="models" role="list">${repeat(
                    modelList,
                    (model) => model.model,
                    (model) => html`<li>${model.displayName}</li>`,
                  )}</ul>`
                : html`<p>${modelList ? "No models available." : status?.modelsError || unavailable}</p>`
            }
          </section>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:copilot",
    ...pull
  }: ActionHintPull = {}) {
    const own = this.hints.scope({ ...pull, scopeId });
    const childScope = {
      scopeId,
      clipRoots: [
        this,
        this.scrollport.value as HTMLDivElement,
        ...(pull.clipRoots ?? []),
      ],
    };
    return mergeActionHintScopes(
      own,
      this.refreshButton.value?.actionHintScope(childScope),
      this.runtime.value?.actionHintScope(childScope),
    );
  }

  keyboardNavigationContexts() {
    return this.runtime.value?.keyboardNavigationContexts() ?? [];
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
