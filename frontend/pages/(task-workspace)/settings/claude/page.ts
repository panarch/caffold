import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import { type ClaudeStatus, getClaudeStatus } from "#app/api.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "../components/detail-list.ts";
import type { SettingsDetailRow } from "../components/detail-list.ts";
import "../components/refresh-button.ts";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.ts";
import {
  idleTimeoutValue,
  usageWindowLabel,
  usageWindowValue,
} from "./display.ts";

export const CLAUDE_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-claude-runtime-restart";

const CLAUDE_SERVICE_STATUS_URL = "https://status.claude.com";

// The agent block asks the same four questions of every installation, so its
// rows stand from the first paint and only their values arrive later.
const AGENT_ROWS: readonly SettingsDetailRow[] = Object.freeze([
  Object.freeze({ key: "version", label: "Version" }),
  Object.freeze({ key: "path", label: "Path", kind: "code" as const }),
  Object.freeze({ key: "account", label: "Account" }),
  Object.freeze({ key: "plan", label: "Plan" }),
]);

type UsageWindow = NonNullable<ClaudeStatus["usage"]>["windows"][number];

export class CaffoldSettingsClaudePage extends LitElement {
  static properties = {
    restartState: { state: true },
    restartMessage: { state: true },
    status: { state: true },
    statusState: { state: true },
  };

  declare private restartState: string;
  declare private restartMessage: string;
  declare private status: ClaudeStatus | null;
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
    this.restartState = "idle";
    this.restartMessage = "";
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
      const status = await getClaudeStatus();
      if (operation !== this.operation) return;
      this.status = status;
      this.statusState = "loaded";
    } catch {
      if (operation !== this.operation) return;
      this.status = null;
      this.statusState = "unavailable";
    }
  }

  setRestartState(value: { state?: string; message?: string } | null) {
    const before = this.restartState;
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (this.restartState === "restarted" && before !== "restarted") {
      // The runner block still shows the runner that just ended.
      void this.reconcile();
    }
  }

  render() {
    const unanswered = this.unansweredRows();
    const restarting = this.restartState === "restarting";
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
              <p>The Claude Code installation this server drives.</p>
              <a
                ${this.hints.link({
                  id: "service-status",
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
                class="settings-service-status"
                href=${CLAUDE_SERVICE_STATUS_URL}
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
          <section aria-labelledby="settings-claude-usage-title">
            <h3 id="settings-claude-usage-title">Usage</h3>
            <caffold-settings-detail-list
              data-claude-usage
              .rows=${unanswered ?? this.usageRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-claude-agent-title">
            <h3 id="settings-claude-agent-title">Agent</h3>
            <caffold-settings-detail-list
              data-claude-agent
              .rows=${unanswered ?? this.agentRows()}
            ></caffold-settings-detail-list>
          </section>
          <section aria-labelledby="settings-claude-runtime-title">
            <div class="settings-runtime-control">
              <div>
                <h3 id="settings-claude-runtime-title">Runtime</h3>
                <p data-runtime-summary>
                  Restarting stops the runner and every Claude session it holds,
                  the way an application update does. Conversations resume from
                  their files as their Tasks are opened.
                </p>
              </div>
              <button
                ${this.hints.button({
                  id: "restart-runtime",
                  label: "Restart runtime",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="open-claude-restart"
                ?disabled=${restarting}
                @click=${this.openRestart}
              >${restarting ? "Restarting…" : "Restart runtime"}</button>
            </div>
            <caffold-settings-detail-list
              data-claude-runner
              .rows=${unanswered ?? this.runnerRows()}
            ></caffold-settings-detail-list>
            <p
              class="settings-runtime-message"
              role="status"
              data-state=${this.restartState}
              ?hidden=${!this.restartMessage}
            >${this.restartMessage}</p>
          </section>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:claude",
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
    scopeId = "settings:claude",
    label = "Claude settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private agentRows(): readonly SettingsDetailRow[] {
    if (!this.status) {
      return AGENT_ROWS;
    }
    const values = agentValues(this.status);
    return AGENT_ROWS.map((row) => ({
      ...row,
      ...values[row.key as keyof typeof values],
    }));
  }

  private usageRows(): SettingsDetailRow[] {
    if (!this.status) {
      return [{ key: "windows", label: "Windows" }];
    }
    const problem = this.status.problems?.usage;
    if (problem) {
      return [{ key: "status", label: "Status", ...unavailableValue(problem) }];
    }
    const windows = this.status.usage?.windows ?? [];
    if (windows.length === 0) {
      return [{ key: "windows", label: "Windows", value: "None reported" }];
    }
    return windows.map((window, index) => ({
      key: usageWindowKey(window, index),
      label: usageWindowLabel(window),
      value: usageWindowValue(window),
    }));
  }

  private runnerRows(): SettingsDetailRow[] {
    if (!this.status) {
      return [{ key: "runner", label: "Runner" }];
    }
    const problem = this.status.problems?.runner;
    if (problem) {
      return [{ key: "status", label: "Status", ...unavailableValue(problem) }];
    }
    const runner = this.status.runner;
    if (!runner?.running) {
      return [{ key: "runner", label: "Runner", value: "Not running" }];
    }
    return [
      {
        key: "runner",
        label: "Runner",
        value: runner.pid ? `Running · pid ${runner.pid}` : "Running",
      },
      ...(Number.isFinite(runner.sessions)
        ? [{ key: "sessions", label: "Sessions", value: `${runner.sessions}` }]
        : []),
      ...(runner.version
        ? [
            {
              key: "runner-build",
              label: "Runner build",
              value: runner.version,
              kind: "code" as const,
            },
          ]
        : []),
      ...(Number.isFinite(runner.idleTimeoutSecs)
        ? [
            {
              key: "idle-timeout",
              label: "Idle timeout",
              value: idleTimeoutValue(runner.idleTimeoutSecs ?? 0),
            },
          ]
        : []),
    ];
  }

  // A server that never answered leaves no block with anything of its own to
  // report, so all three collapse to the same line.
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

  private openRestart() {
    this.dispatchEvent(
      new CustomEvent(CLAUDE_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
    );
  }
}

// Each source answered for itself, so each row reads for itself: a binary
// nobody could ask says nothing about the signed-in account.
function agentValues(status: ClaudeStatus) {
  const problems = status.problems ?? {};
  const executable = status.executable;
  const auth = status.auth;
  return {
    version: problems.executable
      ? unavailableValue(problems.executable)
      : { value: executable?.version ?? "Unknown" },
    path: problems.executable
      ? { value: "Unknown" }
      : { value: executable?.path ?? "Not detected" },
    account: problems.auth
      ? unavailableValue(problems.auth)
      : { value: accountValue(auth), state: auth?.loggedIn ? "" : "negative" },
    plan: problems.auth
      ? { value: "Unknown" }
      : { value: auth?.subscription ? planLabel(auth.subscription) : "None" },
  };
}

function accountValue(auth: ClaudeStatus["auth"]) {
  if (!auth?.loggedIn) {
    return "Signed out";
  }
  const who = auth.email ?? "Signed in";
  return auth.method ? `${who} · ${auth.method}` : who;
}

function planLabel(subscription: string) {
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

/** Windows are identified by what they meter, and by position when they are not. */
function usageWindowKey(window: UsageWindow | null | undefined, index: number) {
  return window?.model
    ? `model:${window.model}`
    : `kind:${window?.kind ?? index}`;
}

function unavailableValue(problem: string) {
  return { value: `Unavailable — ${problem}`, state: "negative" };
}

customElements.define(
  "caffold-settings-claude-page",
  CaffoldSettingsClaudePage,
);
