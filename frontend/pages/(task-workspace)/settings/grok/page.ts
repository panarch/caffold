import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import { type GrokStatus, getGrokStatus } from "#app/api.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "../components/detail-list.ts";
import type { SettingsDetailRow } from "../components/detail-list.ts";
import "../components/refresh-button.ts";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.ts";
import {
  onDemandValue,
  prepaidValue,
  usagePeriodLabel,
  usagePeriodValue,
} from "./display.ts";

const GROK_SERVICE_STATUS_URL = "https://status.x.ai";

// Every block asks the same questions of every installation, so its rows
// stand from the first paint and only their values arrive later.
const AGENT_ROWS = Object.freeze([
  Object.freeze({ key: "version", label: "Version" }),
  Object.freeze({ key: "path", label: "Path", kind: "code" as const }),
]);
const ACCOUNT_ROWS = Object.freeze([
  Object.freeze({ key: "account", label: "Account" }),
  Object.freeze({ key: "method", label: "Sign-in" }),
]);
const LEADER_ROWS = Object.freeze([
  Object.freeze({ key: "leader", label: "Leader" }),
  Object.freeze({ key: "leader-build", label: "Leader build" }),
  Object.freeze({ key: "socket", label: "Socket", kind: "code" as const }),
]);
const CONNECTION_ROWS = Object.freeze([
  Object.freeze({ key: "connection", label: "Caffold" }),
  Object.freeze({ key: "auth-methods", label: "Sign-in methods" }),
]);

export class CaffoldSettingsGrokPage extends LitElement {
  static properties = {
    status: { state: true },
    statusState: { state: true },
  };

  declare private status: GrokStatus | null;
  declare private statusState: "idle" | "loading" | "loaded" | "unavailable";
  private operation = 0;
  private active = false;
  private readonly hints: ActionHints = new ActionHints(
    this,
    () => this.performUpdate(),
    { clipRoots: () => [this, this.scrollport.value] },
  );
  private readonly surfaces = new ScrollSurfaces(this, () =>
    this.performUpdate(),
  );
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly refreshButton = new DrawnRef<CaffoldSettingsRefreshButton>(
    this,
  );

  constructor() {
    super();
    this.status = null;
    this.statusState = "idle";
  }

  createRenderRoot() {
    return this;
  }

  activate() {
    if (this.active) {
      return;
    }
    this.active = true;
    void this.reconcile();
  }

  deactivate() {
    this.active = false;
    this.operation += 1;
  }

  async reconcile() {
    const operation = ++this.operation;
    this.statusState = "loading";
    try {
      const status = await getGrokStatus();
      if (operation !== this.operation) return;
      this.status = status;
      this.statusState = "loaded";
    } catch {
      if (operation !== this.operation) return;
      this.status = null;
      this.statusState = "unavailable";
    }
  }

  render() {
    const unanswered = this.unansweredRows();
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-content-scroll"
      >
        <div class="settings-content-section">
          <header>
            <div>
              <p>The Grok CLI installation this server drives.</p>
              <a
                ${this.hints.link({
                  id: "service-status",
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
                class="settings-service-status"
                href=${GROK_SERVICE_STATUS_URL}
                target="_blank"
                rel="noreferrer"
              >Service status</a>
            </div>
            <caffold-settings-refresh-button
              ${drawn(this.refreshButton)}
              .refreshing=${this.statusState === "loading"}
              @caffold:settings-refresh-intent=${this.refresh}
            ></caffold-settings-refresh-button>
          </header>
          <section aria-labelledby="settings-grok-usage-title">
            <h3 id="settings-grok-usage-title">Usage</h3>
            <caffold-settings-detail-list
              data-grok-usage
              .rows=${unanswered ?? this.usageRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-grok-agent-title">
            <h3 id="settings-grok-agent-title">Agent</h3>
            <caffold-settings-detail-list
              data-grok-agent
              .rows=${unanswered ?? this.agentRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-grok-account-title">
            <h3 id="settings-grok-account-title">Account</h3>
            <caffold-settings-detail-list
              data-grok-account
              .rows=${unanswered ?? this.accountRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-grok-leader-title">
            <h3 id="settings-grok-leader-title">Leader</h3>
            <caffold-settings-detail-list
              data-grok-leader
              .rows=${unanswered ?? this.leaderRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-grok-connection-title">
            <h3 id="settings-grok-connection-title">Connection</h3>
            <caffold-settings-detail-list
              data-grok-connection
              .rows=${unanswered ?? this.connectionRows()}
            ></caffold-settings-detail-list>
          </section>
        </div>
      </div>
    `;
  }

  actionHintScope({ scopeId = "settings:grok", ...pull }: ActionHintPull = {}) {
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
    scopeId = "settings:grok",
    label = "Grok settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private agentRows(): readonly SettingsDetailRow[] {
    if (!this.status) {
      return AGENT_ROWS;
    }
    const problem = this.status.problems?.executable;
    const executable = this.status.executable;
    return [
      {
        ...AGENT_ROWS[0],
        ...(problem
          ? unavailableValue(problem)
          : { value: executable?.version ?? "Unknown" }),
      },
      {
        ...AGENT_ROWS[1],
        value: problem ? "Unknown" : (executable?.path ?? "Not detected"),
      },
    ];
  }

  private accountRows(): readonly SettingsDetailRow[] {
    if (!this.status) {
      return ACCOUNT_ROWS;
    }
    const problem = this.status.problems?.auth;
    const auth = this.status.auth ?? {};
    const verified = auth.verified;
    const account = problem
      ? unavailableValue(problem)
      : verified
        ? {
            value: verified.authenticated
              ? signedInValue(verified)
              : "Signed out",
            state: verified.authenticated ? "" : "negative",
          }
        : auth.cachedSignIn
          ? {
              value:
                "Cached sign-in present — verified once Caffold is connected",
            }
          : { value: "Signed out — no cached sign-in", state: "negative" };
    const method =
      verified?.mode ?? this.status.connection?.defaultAuthMethod ?? "Unknown";
    return [
      { ...ACCOUNT_ROWS[0], ...account },
      { ...ACCOUNT_ROWS[1], value: problem ? "Unknown" : method },
    ];
  }

  private usageRows(): SettingsDetailRow[] {
    if (!this.status) {
      return [{ key: "usage", label: "Usage" }];
    }
    const problem = this.status.problems?.usage;
    if (problem) {
      return [{ key: "usage", label: "Usage", ...unavailableValue(problem) }];
    }
    const usage = this.status.usage;
    if (!usage) {
      return [
        {
          key: "usage",
          label: "Usage",
          value: "Reported once Caffold is connected",
        },
      ];
    }
    return usageDetailRows(usage);
  }

  private leaderRows(): readonly SettingsDetailRow[] {
    if (!this.status) {
      return LEADER_ROWS;
    }
    const problem = this.status.problems?.leader;
    if (problem) {
      return [
        { ...LEADER_ROWS[0], ...unavailableValue(problem) },
        { ...LEADER_ROWS[1], value: "Unknown" },
        {
          ...LEADER_ROWS[2],
          value: this.status.leader?.socketPath ?? "Unknown",
        },
      ];
    }
    const leader = this.status.leader;
    const installed = installedVersion(this.status.executable?.version);
    return [
      {
        ...LEADER_ROWS[0],
        value: leader?.running
          ? leader.pid
            ? `Running · pid ${leader.pid}`
            : "Running"
          : leader?.socketStale
            ? "Not running — a socket file remains and is replaced on the next connection"
            : "Not running — starts with the first Grok Task",
      },
      {
        ...LEADER_ROWS[1],
        ...leaderBuildValue(leader, installed),
      },
      { ...LEADER_ROWS[2], value: leader?.socketPath ?? "Unknown" },
    ];
  }

  private connectionRows(): readonly SettingsDetailRow[] {
    if (!this.status) {
      return CONNECTION_ROWS;
    }
    const problem = this.status.problems?.connection;
    const connection = this.status.connection ?? {};
    const methods = connection.authMethods ?? [];
    return [
      {
        ...CONNECTION_ROWS[0],
        ...(problem
          ? unavailableValue(problem)
          : { value: connectionValue(connection, this.status.leader) }),
      },
      {
        ...CONNECTION_ROWS[1],
        value: methods.length ? methods.join(" · ") : "Unknown",
      },
    ];
  }

  // A server that never answered leaves no block with anything of its own to
  // report, so every block collapses to the same line.
  private unansweredRows(): SettingsDetailRow[] | null {
    if (this.statusState !== "unavailable") {
      return null;
    }
    return [
      {
        key: "status",
        label: "Status",
        ...unavailableValue("The server did not answer."),
      },
    ];
  }

  private refresh(event: Event) {
    event.stopPropagation();
    void this.reconcile();
  }
}

function usageDetailRows(
  usage: NonNullable<GrokStatus["usage"]>,
): SettingsDetailRow[] {
  const rows: SettingsDetailRow[] = [];
  if (Number.isFinite(usage.percent) || usage.period) {
    rows.push({
      key: "usage",
      label: usagePeriodLabel(usage.period),
      value: usagePeriodValue(usage),
    });
  }
  if (usage.onDemand) {
    rows.push({
      key: "on-demand",
      label: "On-demand",
      value: onDemandValue(usage.onDemand),
    });
  }
  if (usage.prepaid) {
    rows.push({
      key: "prepaid",
      label: "Prepaid",
      value: prepaidValue(usage.prepaid),
    });
  }
  return rows.length
    ? rows
    : [{ key: "usage", label: "Usage", value: "None reported" }];
}

function signedInValue(verified: NonNullable<GrokStatus["auth"]["verified"]>) {
  const who = verified.email ?? "Signed in";
  return verified.subscriptionTier
    ? `${who} · ${verified.subscriptionTier}`
    : who;
}

/** The version number inside "grok 1.0.30 (04b7ffed98c6) [stable]". */
function installedVersion(version: string | null | undefined) {
  return version?.split(/\s+/).find((word) => /^\d+\.\d+/.test(word)) ?? null;
}

/** The running leader's build, and whether the installed executable has moved on. */
function leaderBuildValue(
  leader: GrokStatus["leader"],
  installed: string | null,
) {
  if (!leader?.running) {
    return { value: "—" };
  }
  if (!leader.version) {
    return { value: "Unknown" };
  }
  if (installed && installed !== leader.version) {
    return {
      value: `${leader.version} — differs from the installed ${installed}`,
      state: "negative",
    };
  }
  return { value: leader.version };
}

function connectionValue(
  connection: Partial<GrokStatus["connection"]>,
  leader: GrokStatus["leader"],
) {
  switch (connection.state) {
    case "ready":
      return connection.agentVersion
        ? `Connected · agent ${connection.agentVersion}`
        : "Connected";
    case "starting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "stopping":
      return "Shutting down";
    default:
      return leader?.running
        ? "Not connected"
        : "Not connected — connects with the first Grok Task";
  }
}

function unavailableValue(problem: string) {
  return { value: `Unavailable — ${problem}`, state: "negative" };
}

customElements.define("caffold-settings-grok-page", CaffoldSettingsGrokPage);
