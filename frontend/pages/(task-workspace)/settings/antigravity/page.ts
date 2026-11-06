import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type AntigravityStatus,
  getAntigravityStatus,
  refreshAntigravity,
  restartAntigravityRuntime,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "../components/detail-list.js";
import "../components/refresh-button.js";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.js";

import "../components/runtime.js";
import type { CaffoldSettingsRuntime } from "../components/runtime.js";

import styles from "./page.css.js";

type Control = "inactive" | "ready" | "requesting";
type Intent = "activate" | "deactivate" | "request" | "settled";

@customElement("caffold-settings-antigravity-page")
export class CaffoldSettingsAntigravityPage extends CaffoldElement {
  static override styles = styles;
  @state() private accessor control: Control = "inactive";
  @state() private accessor status: AntigravityStatus | null = null;
  @state() private accessor error = "";
  @state() private accessor loading = false;
  @state() private accessor restartMessage = "";
  private readonly runtime = new DrawnRef<CaffoldSettingsRuntime>(this);
  private readonly refreshButton = new DrawnRef<CaffoldSettingsRefreshButton>(
    this,
  );
  private requestAction: (() => Promise<AntigravityStatus>) | null = null;
  private generation = 0;
  private readGeneration = 0;
  private reading: AbortController | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });

  activate() {
    if (!this.transition("activate")) return;
    void this.reconcile(true);
  }
  deactivate() {
    if (!this.transition("deactivate")) return;
    this.generation += 1;
    this.requestAction = null;
    this.readGeneration += 1;
    this.reading?.abort();
    this.reading = null;
    this.clearPoll();
    this.loading = false;
    this.restartMessage = "";
    this.runtime.value?.close();
    // An accepted refresh or restart survives browser navigation.
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  async reconcile(refreshOnEntry = false) {
    if (this.control === "inactive" || document.visibilityState === "hidden")
      return;
    this.clearPoll();
    this.reading?.abort();
    const controller = new AbortController();
    this.reading = controller;
    const read = ++this.readGeneration;
    this.loading = true;
    try {
      const status = await getAntigravityStatus({ signal: controller.signal });
      if (read !== this.readGeneration) return;
      this.accept(status);
      this.error = "";
    } catch (error) {
      if (read !== this.readGeneration || controller.signal.aborted) return;
      this.status = null;
      this.error = message(error);
    } finally {
      if (read === this.readGeneration) {
        this.loading = false;
        this.reading = null;
        this.schedulePoll();
      }
    }
    const status = this.status;
    if (
      refreshOnEntry &&
      read === this.readGeneration &&
      status?.installation.ready === true &&
      !status.refreshing &&
      !status.runtime.restarting
    ) {
      await this.run(refreshAntigravity);
    }
  }

  override render() {
    const status = this.status;
    const installation = status?.installation;
    const auth = status?.auth;
    const verified = auth?.verified;
    const installed = installation?.installed === true;
    const request = this.control === "requesting";
    const locked =
      request || !status || status.refreshing || status.runtime.restarting;
    return html`<div class="settings-content-scroll" ${drawn(this.scrollport)} ${this.surfaces.surface({ id: "scroll", clipRoots: () => [this, this.scrollport.value] })}>
      <div class="settings-content-section">
        <header>
          <div>
            <p>Run Antigravity Tasks with the installed Antigravity CLI.</p>
            <a class="settings-service-status"
              ${this.hints.link({ id: "service-status", action: ACTION_HINT_ACTION.LINK_OPEN })}
              href="https://aistudio.google.com/status" target="_blank" rel="noreferrer">Service status</a>
          </div>
          <caffold-settings-refresh-button ${drawn(this.refreshButton)}
            .refreshing=${this.loading || request || status?.refreshing === true} .disabled=${request || status?.refreshing === true || status?.runtime.restarting === true}
            @caffold:settings-refresh-intent=${() => this.run(refreshAntigravity)}
          ></caffold-settings-refresh-button>
        </header>
        <p role="status" class="problem" ?hidden=${!this.error}>${this.error}</p>
        <section aria-labelledby="agy-usage-title"><h3 id="agy-usage-title">Usage</h3>
          <caffold-settings-detail-list .rows=${this.usageRows()}></caffold-settings-detail-list>
          <p class="problem" role="status" ?hidden=${!status?.usage?.error}>${status?.usage?.error}</p>
        </section>
        <section aria-labelledby="agy-install-title"><h3 id="agy-install-title">CLI</h3>
          <caffold-settings-detail-list .rows=${[
            { key: "version", label: "Version", value: installation?.version },
            {
              key: "installation",
              label: "Installation",
              value: installation
                ? installation.installed === null
                  ? "Unavailable"
                  : installation.ready
                    ? "Ready"
                    : installed
                      ? "Update required"
                      : "Not installed"
                : undefined,
            },
            {
              key: "path",
              label: "Path",
              value: installation?.executable ?? (status ? "—" : undefined),
              kind: "code",
            },
          ]}></caffold-settings-detail-list>
          <p class="problem" ?hidden=${!installation?.error}>${installation?.error}</p>
          ${installation && !installation.ready ? html`<p>Install Antigravity CLI ${installation.minimumVersion} or newer and make <code>agy</code> available on PATH. Refresh after installation or update.</p>` : nothing}
        </section>
        <section aria-labelledby="agy-account-title"><h3 id="agy-account-title">Google account</h3>
          <caffold-settings-detail-list .rows=${[
            {
              key: "auth",
              label: "Authentication",
              value: auth
                ? verified
                  ? verified.authenticated
                    ? "Signed in"
                    : "Sign in with CLI"
                  : "Not checked"
                : undefined,
            },
            {
              key: "tier",
              label: "Plan",
              value: auth
                ? verified
                  ? (verified.tier?.name ?? "Not reported")
                  : "Not checked"
                : undefined,
            },
          ]}></caffold-settings-detail-list>
          <p>Uses the CLI's saved authentication. Run <code>agy</code> in a terminal on this server to sign in, then refresh.</p>
        </section>
        <section aria-labelledby="agy-model-title"><h3 id="agy-model-title">Models</h3>
          <caffold-settings-detail-list .rows=${[{ key: "models", label: "Catalog", value: status ? (status.refreshing ? "Refreshing…" : status.modelsError ? "Unavailable" : status.modelsAvailable ? "Available" : "Not yet loaded") : undefined }]}></caffold-settings-detail-list>
          <p class="problem" role="status" ?hidden=${!status?.modelsError}>${status?.modelsError}</p>
        </section>
        <section aria-label="Runtime">
          <caffold-settings-runtime ${drawn(this.runtime)} .agentName=${"Antigravity"}
            .description=${"Restarting stops the runner and every Antigravity session it holds. Conversations resume from their files as their Tasks are opened."}
            .rows=${this.runtimeRows()} .disabled=${locked}
            .restarting=${status?.runtime.restarting === true || (request && this.requestAction === restartAntigravityRuntime)}
            .message=${this.restartMessage}
            @caffold:runtime-restart-confirmed=${() => this.run(restartAntigravityRuntime, "Antigravity runner restarted.")}
          ></caffold-settings-runtime>
        </section>
      </div></div>
`;
  }

  actionHintScope({
    scopeId = "settings:antigravity",
    ...pull
  }: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope({ ...pull, scopeId }),
      this.runtime.value?.actionHintScope({
        ...pull,
        scopeId,
        clipRoots: [
          this,
          this.scrollport.value as HTMLDivElement,
          ...(pull.clipRoots ?? []),
        ],
      }),
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
    scopeId = "settings:antigravity",
    label = "Antigravity settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  keyboardNavigationContexts() {
    return this.runtime.value?.keyboardNavigationContexts() ?? [];
  }

  private runtimeRows() {
    const runtime = this.status?.runtime;
    if (!runtime) return [{ key: "runner", label: "Runner" }];
    if (runtime.running === null)
      return [
        {
          key: "runner",
          label: "Runner",
          value: `Unavailable${runtime.error ? ` — ${runtime.error}` : ""}`,
          state: "negative",
        },
      ];
    if (!runtime.running)
      return [{ key: "runner", label: "Runner", value: "Not running" }];
    return [
      { key: "runner", label: "Runner", value: `Running · pid ${runtime.pid}` },
      { key: "sessions", label: "Sessions", value: String(runtime.sessions) },
      {
        key: "runner-build",
        label: "Runner build",
        value: runtime.version,
        kind: "code" as const,
      },
      ...(runtime.idleTimeoutSecs !== null
        ? [
            {
              key: "idle-timeout",
              label: "Idle timeout",
              value:
                runtime.idleTimeoutSecs < 60
                  ? `${runtime.idleTimeoutSecs}s`
                  : `${Math.round(runtime.idleTimeoutSecs / 60)} min`,
            },
          ]
        : []),
    ];
  }

  private usageRows() {
    const usage = this.status?.usage;
    if (!usage?.windows.length) {
      return [
        {
          key: "usage",
          label: "Usage",
          value: usage?.error
            ? "Unavailable"
            : this.status?.refreshing
              ? "Refreshing…"
              : "Not yet loaded",
        },
      ];
    }
    return usage.windows.map((window) => ({
      key: `${window.group}:${window.period}`,
      label: `${window.group} · ${window.period === "fiveHours" ? "5 hours" : "Weekly"}`,
      value: usageWindowValue(window),
    }));
  }

  private transition(intent: Intent) {
    const next: Partial<Record<Control, Partial<Record<Intent, Control>>>> = {
      inactive: { activate: "ready" },
      ready: { deactivate: "inactive", request: "requesting" },
      requesting: { deactivate: "inactive", settled: "ready" },
    };
    const target = next[this.control]?.[intent];
    if (!target) return false;
    this.control = target;
    return true;
  }
  private async run(
    action: () => Promise<AntigravityStatus>,
    successMessage = "",
  ) {
    if (!this.transition("request")) return;
    this.requestAction = action;
    this.clearPoll();
    this.readGeneration += 1;
    this.reading?.abort();
    const generation = ++this.generation;
    this.error = "";
    this.restartMessage = "";
    try {
      const status = await action();
      if (generation === this.generation) {
        this.accept(status);
        this.restartMessage = successMessage;
      }
    } catch (error) {
      if (generation === this.generation) this.error = message(error);
    } finally {
      if (generation === this.generation) {
        this.requestAction = null;
        this.transition("settled");
        this.schedulePoll();
      }
    }
  }
  private accept(status: AntigravityStatus) {
    this.status = status;
  }
  private schedulePoll() {
    this.clearPoll();
    const status = this.status;
    if (
      this.control !== "ready" ||
      !status ||
      document.visibilityState === "hidden"
    )
      return;
    if (status.refreshing || status.runtime.restarting)
      this.poll = setTimeout(() => {
        void this.reconcile();
      }, 1000);
  }
  private clearPoll() {
    if (this.poll !== null) clearTimeout(this.poll);
    this.poll = null;
  }
}
function usageWindowValue(
  window: AntigravityStatus["usage"]["windows"][number],
) {
  const percent = `${Math.round(window.percent)}% used`;
  const date = new Date(window.resetsAt);
  if (Number.isNaN(date.getTime())) return percent;
  const sameDay = new Date().toDateString() === date.toDateString();
  const reset = new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${percent} · resets ${reset}`;
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The server did not confirm this action. Refresh status before trying again.";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-antigravity-page": CaffoldSettingsAntigravityPage;
  }
}
