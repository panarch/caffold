import { html, LitElement, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  type CaffoldUpdateAttempt,
  type CaffoldUpdateStatus,
  type CodexMcpDiagnostics,
  getCodexMcpDiagnostics,
  type Health,
} from "#app/api.js";
import { BUILD_INFO } from "#app/build-info.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import "../components/detail-list.js";
import type { SettingsDetailRow } from "../components/detail-list.js";

/** Asks the workspace to open the update Task dialog. */
export const CAFFOLD_UPDATE_TASK_REQUEST_EVENT =
  "caffold:caffold-update-task-request";

/** Asks the app shell to have the server ask GitHub now. */
export const CAFFOLD_UPDATE_CHECK_REQUEST_EVENT =
  "caffold:caffold-update-check-request";

// The app shell's latest answer about Caffold updates.
export interface CaffoldUpdateSnapshot {
  checking: boolean;
  status: CaffoldUpdateStatus | null;
  error: string | null;
}

interface UpdateDiagnostics {
  handoffNode: string | null;
  targetBuildId: string | null;
  controllerBuildId: string | null;
  activeBuildId: string | null;
  waitingBuildId: string | null;
  navigationAttemptCount: number;
  lastNavigationAttemptBuildId: string | null;
}

// How this window's own update stands: whether a new build is ready to load.
interface UpdateStatus {
  state: "checking" | "ready" | "settled";
  preparedUpdate: { ready: boolean; buildId: string | null };
  diagnostics: UpdateDiagnostics;
}

const CHECKING_UPDATE: CaffoldUpdateSnapshot = {
  checking: true,
  status: null,
  error: null,
};

export class CaffoldSettingsAboutPage extends LitElement {
  static properties = {
    health: { attribute: false },
    caffoldUpdate: { attribute: false },
    updateStatus: { attribute: false },
    copyingDiagnostics: { state: true },
    copyStatus: { state: true },
  };

  declare health: Health | null;
  /** Whether a newer Caffold exists, and how the last update ended. */
  declare caffoldUpdate: CaffoldUpdateSnapshot | null;
  declare updateStatus: unknown;
  declare private copyingDiagnostics: boolean;
  declare private copyStatus: string;
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.health = null;
    this.caffoldUpdate = null;
    this.updateStatus = null;
    this.copyingDiagnostics = false;
    this.copyStatus = "";
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const updates = this.caffoldUpdate ?? CHECKING_UPDATE;
    const updateStatus = normalizeUpdateStatus(this.updateStatus);
    const view = caffoldUpdatesView(updates, this.health);
    const built = buildDate();
    const status = buildStatus(this.health, updateStatus);
    const preparedUpdate = updateStatus.preparedUpdate;
    const rows: SettingsDetailRow[] = [
      {
        key: "ui-build",
        label: "UI build",
        value: BUILD_INFO.id,
        kind: "code",
      },
      {
        key: "server-build",
        label: "Server build",
        value: this.health?.buildId ?? "Unavailable",
        kind: "code",
      },
      {
        key: "built",
        label: "Built",
        value: formatBuildDate(built),
        kind: "time",
        datetime: built.toISOString(),
      },
      {
        key: "status",
        label: "Status",
        value: status.label,
        state: status.state,
      },
      ...(preparedUpdate.ready
        ? [
            {
              key: "prepared-update",
              label: "Prepared update",
              value: "Ready",
              state: "positive",
            },
          ]
        : []),
    ];
    // A changed phrase is a new one, so its delay and animation start over.
    const summary = view.checking
      ? keyed(
          view.summary,
          html`<caffold-loading-text>${view.summary}</caffold-loading-text>`,
        )
      : view.summary;
    const latest = view.latest.url
      ? html`<a
          ${this.hints.link({
            id: "latest-release",
            label: `Open the ${view.latest.text} release in a new tab`,
            action: ACTION_HINT_ACTION.LINK_OPEN,
          })}
          href=${view.latest.url}
          target="_blank"
          rel="noreferrer"
        >${view.latest.text}</a>`
      : view.latest.text;
    const action = view.offersUpdate ? "update-caffold" : "check-for-updates";
    const actionLabel = view.offersUpdate
      ? "Update Caffold"
      : "Check for Updates";
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
          <header class="settings-about-heading">
            <img src="/assets/icons/caffold.png" alt="" />
            <p>A review-first workspace for agent-assisted development.</p>
          </header>
          <section
            class="settings-about-updates"
            aria-labelledby="settings-about-updates-title"
          >
            <div>
              <h3 id="settings-about-updates-title">Updates</h3>
              <p data-updates-summary>${summary}</p>
              <dl>
                <div>
                  <dt>Version</dt>
                  <dd data-updates-version>${view.version}</dd>
                </div>
                <div>
                  <dt>Latest version</dt>
                  <dd data-updates-latest>${latest}</dd>
                </div>
                <div data-updates-last-row ?hidden=${!view.lastUpdate}>
                  <dt>Last update</dt>
                  <dd
                    data-updates-last
                    data-state=${view.lastUpdate?.state || nothing}
                  >${view.lastUpdate?.text ?? ""}</dd>
                </div>
              </dl>
            </div>
            <button
              ${this.hints.button({
                id: action,
                label: actionLabel,
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action=${action}
              ?disabled=${!view.actionEnabled}
              @click=${this.updateAction}
            >${actionLabel}</button>
          </section>
          <section aria-labelledby="settings-about-window-title">
            <h3 id="settings-about-window-title">This window</h3>
            <caffold-settings-detail-list
              .rows=${rows}
            ></caffold-settings-detail-list>
          </section>
          <footer class="settings-about-actions">
            <span
              data-about-copy-status
              role="status"
              aria-live="polite"
            >${this.copyStatus}</span>
            <button
              ${this.hints.button({
                id: "reload-update",
                label: "Reload to update",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="reload-update"
              ?hidden=${!preparedUpdate.ready}
              @click=${this.reloadUpdate}
            >Reload to update</button>
            <button
              ${this.hints.button({
                id: "copy-diagnostics",
                label: "Copy diagnostics",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="copy-diagnostics"
              ?disabled=${this.copyingDiagnostics}
              @click=${this.copyDiagnostics}
            >Copy diagnostics</button>
          </footer>
        </div>
      </div>
    `;
  }

  async copyDiagnostics() {
    if (this.copyingDiagnostics) {
      return;
    }
    this.copyingDiagnostics = true;
    this.copyStatus = "Collecting…";
    let codexMcpDiagnostics: CodexMcpDiagnostics;
    try {
      codexMcpDiagnostics = await getCodexMcpDiagnostics();
    } catch (error) {
      codexMcpDiagnostics = {
        available: false,
        processGeneration: null,
        appServerVersion: null,
        threads: [],
        error: error instanceof Error ? error.message : "Request failed.",
      };
    }
    try {
      await navigator.clipboard.writeText(
        this.diagnosticsText(codexMcpDiagnostics),
      );
      this.copyStatus = "Copied";
    } catch {
      this.copyStatus = "Copy failed";
    } finally {
      this.copyingDiagnostics = false;
    }
  }

  diagnosticsText(codexMcpDiagnostics: CodexMcpDiagnostics | null = null) {
    const updateStatus = normalizeUpdateStatus(this.updateStatus);
    const diagnostics = updateStatus.diagnostics;
    return [
      `Caffold ${BUILD_INFO.version}`,
      `UI build: ${BUILD_INFO.id}`,
      `Server build: ${this.health?.buildId ?? "unavailable"}`,
      `Built: ${buildDate().toISOString()}`,
      ...caffoldUpdateDiagnosticLines(
        this.caffoldUpdate ?? CHECKING_UPDATE,
        this.health,
      ),
      `Status: ${buildStatus(this.health, updateStatus).label}`,
      `Update lifecycle: ${updateStatus.state}`,
      `Prepared update: ${updateStatus.preparedUpdate.ready ? "ready" : "none"}`,
      `Update handoff: ${diagnostics.handoffNode ?? "none"}`,
      `Update target: ${diagnostics.targetBuildId ?? "none"}`,
      `Service Worker controller: ${diagnostics.controllerBuildId ?? "none"}`,
      `Service Worker active: ${diagnostics.activeBuildId ?? "none"}`,
      `Service Worker waiting: ${diagnostics.waitingBuildId ?? "none"}`,
      `Update navigation attempts: ${diagnostics.navigationAttemptCount}`,
      `Last update navigation target: ${diagnostics.lastNavigationAttemptBuildId ?? "none"}`,
      ...codexMcpDiagnosticLines(codexMcpDiagnostics),
    ].join("\n");
  }

  actionHintScope({
    scopeId = "settings:about",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:about",
    label = "About Caffold",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private updateAction(event: Event) {
    const control = event.currentTarget as HTMLButtonElement;
    if (control.disabled) {
      return;
    }
    if (control.dataset.action === "update-caffold") {
      this.dispatchEvent(
        new CustomEvent(CAFFOLD_UPDATE_TASK_REQUEST_EVENT, {
          bubbles: true,
          composed: true,
          detail: { opener: control },
        }),
      );
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CAFFOLD_UPDATE_CHECK_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private reloadUpdate() {
    this.dispatchEvent(
      new CustomEvent("caffold:update-reload", {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

/**
 * What the Updates section says. `snapshot` is the app shell's latest answer
 * about Caffold updates; `health` supplies the version before that answer.
 */
export function caffoldUpdatesView(
  snapshot: CaffoldUpdateSnapshot | null | undefined,
  health: Health | null = null,
) {
  const status = snapshot?.status ?? null;
  if (snapshot?.checking !== false && !status) {
    return {
      summary: "Checking for updates…",
      checking: true,
      version: health?.version ?? "Checking…",
      latest: { text: "Checking…", url: null as string | null },
      lastUpdate: null as { text: string; state: string } | null,
      offersUpdate: false,
      actionEnabled: false,
    };
  }
  const version = status?.version ?? health?.version ?? "Unavailable";
  const lastUpdate = lastUpdateValue(status?.lastAttempt);
  if (!status) {
    return {
      summary:
        `Caffold could not check for updates.\n${snapshot?.error ?? ""}`.trim(),
      checking: false,
      version,
      latest: { text: "Unavailable", url: null as string | null },
      lastUpdate,
      offersUpdate: false,
      actionEnabled: true,
    };
  }
  const latest = status.latestRelease
    ? {
        text: status.latestRelease.version,
        url: status.latestRelease.url as string | null,
      }
    : { text: "Unavailable", url: null as string | null };
  const view = {
    checking: false,
    version,
    latest,
    lastUpdate,
    offersUpdate: false,
    actionEnabled: true,
  };
  if (snapshot?.checking) {
    // A check someone asked for keeps the last answer on show.
    return {
      ...view,
      summary: "Checking for updates…",
      checking: true,
      actionEnabled: false,
    };
  }
  const running = status.runningAttempt;
  if (running) {
    const target = running.toVersion ?? status.latestRelease?.version;
    return {
      ...view,
      summary: target ? `Updating to Caffold ${target}…` : "Updating Caffold…",
      checking: true,
      offersUpdate: true,
      actionEnabled: false,
    };
  }
  if (!status.latestRelease) {
    return {
      ...view,
      summary:
        `Caffold could not check for updates.\n${status.releaseError ?? ""}`.trim(),
    };
  }
  if (!status.updateAvailable) {
    return { ...view, summary: "Caffold is up to date." };
  }
  if (!status.updateTask) {
    return {
      ...view,
      summary: `Caffold ${latest.text} is available. Install it from the release page.`,
    };
  }
  return {
    ...view,
    summary: `Caffold ${latest.text} is available. The menu-bar app can also update it.`,
    offersUpdate: true,
  };
}

/** How the newest finished update ended, with when. */
export function lastUpdateValue(
  attempt: CaffoldUpdateAttempt | null | undefined,
) {
  if (!attempt) {
    return null;
  }
  const from = attempt.fromVersion;
  const outcome = (
    {
      succeeded: { text: `Updated to ${attempt.toVersion}`, state: "positive" },
      rolledBack: {
        text: `Rolled back to ${from} — ${attempt.reason}`,
        state: "negative",
      },
      homebrewFailed: { text: "Homebrew could not update", state: "negative" },
      upToDate: { text: "Already up to date", state: "" },
      restoreFailed: { text: `Could not restore ${from}`, state: "negative" },
      interrupted: { text: "Interrupted", state: "negative" },
    } as Record<string, { text: string; state: string }>
  )[attempt.outcome];
  if (!outcome) {
    return null;
  }
  const finished = attempt.finishedAt ? new Date(attempt.finishedAt) : null;
  const when =
    finished && !Number.isNaN(finished.getTime())
      ? ` · ${new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(finished)}`
      : "";
  return { text: `${outcome.text}${when}`, state: outcome.state };
}

function caffoldUpdateDiagnosticLines(
  snapshot: CaffoldUpdateSnapshot,
  health: Health | null,
) {
  const status = snapshot?.status ?? null;
  const attempt = status?.lastAttempt;
  return [
    `Caffold version: ${status?.version ?? health?.version ?? "unavailable"}`,
    `Latest release: ${
      status?.latestRelease?.version ??
      (status?.releaseError
        ? `unavailable (${diagnosticLineValue(status.releaseError, "")})`
        : snapshot?.checking === false
          ? "unavailable"
          : "checking")
    }`,
    `Last update: ${
      attempt
        ? `${attempt.outcome} ${attempt.fromVersion} -> ${attempt.toVersion ?? "unknown"} at ${attempt.finishedAt ?? "unknown"}`
        : "none"
    }`,
  ];
}

function buildDate() {
  return new Date(Number(BUILD_INFO.number) * 1000);
}

function formatBuildDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function buildStatus(
  health: Health | null,
  updateStatus: Pick<UpdateStatus, "state"> = { state: "checking" },
) {
  if (updateStatus.state === "ready") {
    return { state: "positive", label: "Update ready" };
  }
  if (!health?.buildId) {
    return { state: "negative", label: "Server unavailable" };
  }
  if (health.buildId !== BUILD_INFO.id) {
    if (updateStatus.state === "checking") {
      return { state: "", label: "Checking for update" };
    }
    return { state: "negative", label: "Reload required" };
  }
  return { state: "positive", label: "Current" };
}

function normalizeUpdateStatus(value: unknown): UpdateStatus {
  const status = value as {
    state?: unknown;
    preparedUpdate?: { ready?: unknown; buildId?: unknown };
    diagnostics?: Record<string, unknown>;
  } | null;
  const state = status?.state;
  const buildId = status?.preparedUpdate?.buildId;
  return {
    state:
      state === "checking" || state === "ready" || state === "settled"
        ? state
        : "checking",
    preparedUpdate: {
      ready: Boolean(status?.preparedUpdate?.ready),
      buildId: typeof buildId === "string" && buildId ? buildId : null,
    },
    diagnostics: normalizeUpdateDiagnostics(status?.diagnostics),
  };
}

function normalizeUpdateDiagnostics(
  diagnostics: Record<string, unknown> | null | undefined,
): UpdateDiagnostics {
  const count = diagnostics?.navigationAttemptCount;
  return {
    handoffNode: diagnosticValue(diagnostics?.handoffNode),
    targetBuildId: diagnosticValue(diagnostics?.targetBuildId),
    controllerBuildId: diagnosticValue(diagnostics?.controllerBuildId),
    activeBuildId: diagnosticValue(diagnostics?.activeBuildId),
    waitingBuildId: diagnosticValue(diagnostics?.waitingBuildId),
    navigationAttemptCount:
      Number.isInteger(count) && (count as number) >= 0 ? (count as number) : 0,
    lastNavigationAttemptBuildId: diagnosticValue(
      diagnostics?.lastNavigationAttemptBuildId,
    ),
  };
}

function diagnosticValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function codexMcpDiagnosticLines(diagnostics: CodexMcpDiagnostics | null) {
  const generation = diagnostics?.processGeneration;
  const lines = [
    `Codex app-server: ${diagnosticLineValue(diagnostics?.appServerVersion, "unavailable")}`,
    `Codex runtime generation: ${Number.isSafeInteger(generation) && (generation as number) >= 0 ? generation : "unavailable"}`,
  ];
  if (!diagnostics?.available) {
    lines.push(
      `Codex MCP diagnostics: unavailable${diagnosticErrorSuffix(diagnostics?.error)}`,
    );
    return lines;
  }

  const threads = Array.isArray(diagnostics.threads) ? diagnostics.threads : [];
  lines.push("Codex MCP diagnostics: available");
  lines.push(`Codex MCP loaded managed threads: ${threads.length}`);
  for (const thread of threads) {
    const threadId = diagnosticQuotedValue(thread?.threadId, "unknown");
    if (!thread?.available) {
      lines.push(
        `Codex MCP thread ${threadId}: unavailable${diagnosticErrorSuffix(thread?.error)}`,
      );
      continue;
    }
    const servers = Array.isArray(thread.servers) ? thread.servers : [];
    if (servers.length === 0) {
      lines.push(`Codex MCP thread ${threadId}: no servers reported`);
      continue;
    }
    for (const server of servers) {
      lines.push(
        `Codex MCP thread ${threadId}, server ${diagnosticQuotedValue(server?.name, "unknown")}: runtime=${knownMcpRuntimeStatus(server?.runtimeStatus)}; auth=${knownMcpAuthStatus(server?.authStatus)}`,
      );
    }
  }
  return lines;
}

function knownMcpRuntimeStatus(value: unknown) {
  return [
    "notStarted",
    "starting",
    "connected",
    "authenticationRequired",
    "failed",
    "cancelled",
    "disabled",
    "unknown",
  ].includes(`${value}`)
    ? value
    : "unavailable";
}

function knownMcpAuthStatus(value: unknown) {
  return [
    "unknown",
    "unsupported",
    "notLoggedIn",
    "bearerToken",
    "oAuth",
  ].includes(`${value}`)
    ? value
    : "unknown";
}

function diagnosticErrorSuffix(error: unknown) {
  return typeof error === "string" && error
    ? ` (${diagnosticQuotedValue(error, "unknown")})`
    : "";
}

function diagnosticQuotedValue(value: unknown, fallback: string) {
  return JSON.stringify(typeof value === "string" && value ? value : fallback);
}

function diagnosticLineValue(value: unknown, fallback: string) {
  return typeof value === "string" && value
    ? value
        .replaceAll("\\", "\\\\")
        .replaceAll("\r", "\\r")
        .replaceAll("\n", "\\n")
    : fallback;
}

customElements.define("caffold-settings-about-page", CaffoldSettingsAboutPage);
