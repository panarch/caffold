import { html, LitElement, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  type ActionHintTarget,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { type CodexUpdates, getCodexUpdates } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import "#components/loading-text.ts";
import {
  CODEX_RESET_CREDIT_REQUEST_EVENT,
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_RUNTIME_UPDATE_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  type CodexRateWindow,
  type CodexReadiness,
  type CodexResetCredit,
  type CodexStatus,
  type CodexStatusSnapshot,
  codexRateWindows,
  codexResetCredits,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatResetCredits,
  formatUsedPercent,
  resetCreditExpiry,
} from "../../codex-status.js";
import "../components/detail-list.ts";
import type { SettingsDetailRow } from "../components/detail-list.ts";
import "../components/refresh-button.ts";
import type { CaffoldSettingsRefreshButton } from "../components/refresh-button.ts";
import { serviceStatusTargets } from "../service-status.ts";

const CODEX_INSTALL_COMMAND =
  "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SERVICE_STATUS_URL = "https://status.openai.com";
const CODEX_SETUP_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";
const CONNECTION_PRESENTATION = Object.freeze({
  pending: Object.freeze({ label: "Checking", state: "" }),
  available: Object.freeze({ label: "Connected", state: "positive" }),
  unavailable: Object.freeze({ label: "Unavailable", state: "negative" }),
});
const AUTOMATIC_UPDATES_LABEL: Readonly<Record<string, string>> = Object.freeze(
  {
    enabled: "On",
    disabled: "Off",
  },
);

// What the workspace reports about a runtime restart or update, and about a
// reset credit request.
export interface RuntimeRequestState {
  state?: string;
  message?: string;
}

export interface ResetCreditState {
  state: string;
  message: string;
  retryPending: boolean;
  creditId?: string | null;
}

const IDLE_RESET_CREDIT: ResetCreditState = {
  state: "idle",
  message: "",
  retryPending: false,
};

type ScopeOptions = ActionHintScopeOptions & { isCurrent?: () => boolean };

export class CaffoldSettingsCodexPage extends LitElement {
  static properties = {
    snapshot: { attribute: false },
    runtimeAction: { attribute: false },
    resetCreditState: { attribute: false },
    restartState: { state: true },
    restartMessage: { state: true },
    updateState: { state: true },
    updateMessage: { state: true },
    updates: { state: true },
    updatesState: { state: true },
    updatesProblem: { state: true },
    copyState: { state: true },
  };

  declare snapshot: CodexStatusSnapshot | null;
  declare runtimeAction: string;
  declare resetCreditState: ResetCreditState | null;
  declare private restartState: string;
  declare private restartMessage: string;
  declare private updateState: string;
  declare private updateMessage: string;
  declare private updates: CodexUpdates | null;
  declare private updatesState: "idle" | "loading" | "loaded" | "unavailable";
  declare private updatesProblem: string;
  declare private copyState: "idle" | "copied" | "failed";
  private active = false;
  private updatesOperation = 0;

  constructor() {
    super();
    this.snapshot = null;
    this.runtimeAction = "idle";
    this.resetCreditState = null;
    this.restartState = "idle";
    this.restartMessage = "";
    this.updateState = "idle";
    this.updateMessage = "";
    this.updates = null;
    this.updatesState = "idle";
    this.updatesProblem = "";
    this.copyState = "idle";
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  activate() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.dispatchEvent(
      new CustomEvent(CODEX_STATUS_REFRESH_REQUEST_EVENT, { bubbles: true }),
    );
    void this.reconcileUpdates();
  }

  deactivate() {
    this.active = false;
    this.updatesOperation += 1;
  }

  setRestartState(value: RuntimeRequestState | null | undefined) {
    const before = this.restartState;
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (settled(before, this.restartState)) {
      // The report still names the runtime that was just replaced.
      void this.reconcileUpdates();
    }
  }

  setUpdateState(value: RuntimeRequestState | null | undefined) {
    const before = this.updateState;
    this.updateState = value?.state ?? "idle";
    this.updateMessage = value?.message ?? "";
    if (settled(before, this.updateState)) {
      void this.reconcileUpdates();
    }
  }

  /**
   * Reads the update report while the page is shown. The newest release is
   * checked only here, never in the background.
   */
  async reconcileUpdates() {
    if (!this.active) {
      return;
    }
    const operation = ++this.updatesOperation;
    this.updatesState = "loading";
    try {
      const updates = await getCodexUpdates();
      if (operation !== this.updatesOperation) return;
      this.updates = updates;
      this.updatesState = "loaded";
    } catch (error) {
      if (operation !== this.updatesOperation) return;
      this.updates = null;
      this.updatesState = "unavailable";
      this.updatesProblem = error instanceof Error ? error.message : `${error}`;
    }
  }

  // A new report puts the install command's Copy back to its label.
  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("snapshot")) {
      this.copyState = "idle";
    }
  }

  render() {
    const snapshot = this.snapshot;
    const status = snapshot?.status;
    const readiness = status?.readiness;
    const runtimeBusy = this.runtimeAction !== "idle";
    const restartRequired = readiness?.state === "restartRequired";
    const restarting = ["restarting", "refreshing"].includes(this.restartState);
    const readinessLabel = formatCodexReadiness(snapshot);
    const runtimeSummary = restartRequired
      ? `Codex ${readiness.managedExecutable?.version ?? "target"} is installed while runtime ${readiness.runningAppServerVersion ?? "another version"} is still running.`
      : readiness?.state === "ready"
        ? "The shared Codex runtime is ready.\nYou can restart it manually after confirmation."
        : "Caffold enables an explicit runtime restart only when the backend reports a supported restart target.";
    const restartLabel =
      this.restartState === "refreshing"
        ? "Checking…"
        : restarting
          ? "Restarting…"
          : "Restart runtime…";
    const restartDisabled =
      !codexRuntimeRestartAvailable(status) || runtimeBusy;
    const reason = readiness?.reasonCode ?? "unknown";
    const diagnostic = readiness?.diagnosticMessage ?? "";
    const loadError = snapshot?.phase === "failed" ? snapshot.error : "";
    return html`
      <div class="settings-content-scroll">
        <div class="settings-content-section">
          <header>
            <div>
              <p>Connection, account, plan, and local app-server usage.</p>
              <a
                class="settings-service-status"
                href=${CODEX_SERVICE_STATUS_URL}
                target="_blank"
                rel="noreferrer"
              >Service status</a>
            </div>
            <caffold-settings-refresh-button
              .refreshing=${snapshot?.phase === "checking"}
              .disabled=${runtimeBusy}
              @caffold:settings-refresh-intent=${this.refresh}
            ></caffold-settings-refresh-button>
          </header>
          ${this.repairSurface(readiness, readinessLabel)}
          <section aria-labelledby="settings-codex-usage-title">
            <h3 id="settings-codex-usage-title">Usage</h3>
            <caffold-settings-detail-list
              data-codex-usage
              .rows=${usageWindowRows(status)}
            ></caffold-settings-detail-list>
            ${this.resetCredits(runtimeBusy)}
          </section>
          <section aria-labelledby="settings-codex-agent-title">
            <h3 id="settings-codex-agent-title">Agent</h3>
            <caffold-settings-detail-list
              data-codex-detail
              .rows=${agentRows(snapshot, readinessLabel)}
            ></caffold-settings-detail-list>
          </section>
          <section
            class="settings-runtime-control"
            aria-labelledby="settings-codex-runtime-title"
            data-restart-emphasis=${restartRequired ? "attention" : "neutral"}
          >
            <div>
              <h3 id="settings-codex-runtime-title">Runtime</h3>
              <p data-runtime-summary>${runtimeSummary}</p>
            </div>
            <button
              type="button"
              data-action="open-codex-restart"
              ?disabled=${restartDisabled}
              @click=${this.openRestart}
            >${restartLabel}</button>
          </section>
          <p
            class="settings-runtime-message"
            data-restart-message
            role="status"
            data-state=${this.restartState}
            ?hidden=${!this.restartMessage}
          >${this.restartMessage}</p>
          ${this.updatesSection(status, runtimeBusy)}
          <p
            class="settings-runtime-message"
            data-update-message
            role="status"
            data-state=${this.updateState}
            ?hidden=${!this.updateMessage}
          >${this.updateMessage}</p>
          <section
            class="settings-codex-diagnostic"
            aria-labelledby="settings-codex-diagnostic-title"
            ?hidden=${!diagnostic}
          >
            <h3 id="settings-codex-diagnostic-title">Diagnostic</h3>
            <dl>
              <div>
                <dt>Reason code</dt>
                <dd data-diagnostic-reason>${reason}</dd>
              </div>
              <div>
                <dt>Detail</dt>
                <dd data-diagnostic-detail>${diagnostic}</dd>
              </div>
            </dl>
          </section>
          <p
            class="settings-status-message"
            role="alert"
            ?hidden=${!loadError}
          >${loadError}</p>
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:codex",
    clipRoots = [],
    isCurrent = () => true,
  }: ScopeOptions = {}): ActionHintScope {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const definitions = [
      {
        id: "copy-install-command",
        selector: 'button[data-action="copy-codex-install"]',
      },
      {
        id: "restart-runtime",
        selector: 'button[data-action="open-codex-restart"]',
      },
      {
        id: "update-runtime",
        selector: 'button[data-action="open-codex-update"]',
      },
    ];
    const targetClipRoots = [this, scrollport, ...clipRoots].filter(Boolean);
    const targets: ActionHintTarget[] = [
      ...serviceStatusTargets(this, {
        scopeId,
        clipRoots: targetClipRoots,
        isCurrent,
      }),
      ...definitions.flatMap(({ id, selector }) => {
        const control = this.querySelector<HTMLButtonElement>(selector);
        if (
          !control ||
          control.disabled ||
          control.hidden ||
          !hasActionHintLayoutBox(control)
        ) {
          return [];
        }
        return [
          buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:${id}`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label:
              control.getAttribute("aria-label") ||
              control.textContent?.trim() ||
              id,
            control,
            clipRoots: targetClipRoots,
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              isCurrent() &&
              this.querySelector(selector) === control &&
              !control.disabled &&
              !control.hidden &&
              hasActionHintLayoutBox(control),
          }),
        ];
      }),
      ...[
        ...this.querySelectorAll<HTMLButtonElement>(
          'button[data-action="use-reset-credit"]',
        ),
      ].flatMap((control) => {
        if (
          control.disabled ||
          control.hidden ||
          !hasActionHintLayoutBox(control)
        ) {
          return [];
        }
        const targetKey =
          control.dataset.retry === "true"
            ? "retry"
            : control.dataset.creditId
              ? `credit:${control.dataset.creditId}`
              : "auto";
        return [
          buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:reset-credit:${targetKey}`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label: control.textContent?.trim() || "Use reset",
            control,
            clipRoots: targetClipRoots,
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              isCurrent() &&
              control.isConnected &&
              !control.disabled &&
              !control.hidden &&
              hasActionHintLayoutBox(control),
          }),
        ];
      }),
    ];
    const guide = this.querySelector<HTMLAnchorElement>(
      ".settings-codex-repair a[href]",
    );
    if (guide && !guide.hidden && hasActionHintLayoutBox(guide)) {
      targets.push(
        linkActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:official-guide`,
          actionId: ACTION_HINT_ACTION.LINK_OPEN,
          label: "Open Official Codex CLI guide in a new tab",
          control: guide,
          clipRoots: targetClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(".settings-codex-repair a[href]") === guide &&
            !guide.hidden &&
            hasActionHintLayoutBox(guide),
        }),
      );
    }
    return mergeActionHintScopes(
      this.refreshButton?.actionHintScope({
        scopeId,
        clipRoots: targetClipRoots,
        isCurrent: () => this.isConnected && !this.hidden && isCurrent(),
      }),
      {
        blocked: false,
        targets,
        mutationRoots: [this],
        scrollRoots: [scrollport],
      },
    );
  }

  scrollSurfaceScope({
    scopeId = "settings:codex",
    label = "Codex settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(":scope > .settings-content-scroll") ===
              scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private repairSurface(
    readiness: CodexReadiness | null | undefined,
    readinessLabel: string,
  ) {
    const visible = Boolean(readiness && readiness.state !== "ready");
    const state = readiness?.state ?? "";
    const install = [
      "missing",
      "unsupportedInstall",
      "updateRequired",
    ].includes(state);
    const signIn = state === "signInRequired";
    const copyLabel =
      this.copyState === "copied"
        ? "Copied"
        : this.copyState === "failed"
          ? "Copy failed"
          : "Copy command";
    return html`
      <section
        class="settings-codex-repair"
        aria-labelledby="settings-codex-repair-title"
        ?hidden=${!visible}
      >
        <div>
          <h3 id="settings-codex-repair-title">${readinessLabel}</h3>
          <p data-repair-description>${repairDescription(readiness)}</p>
        </div>
        <div class="settings-codex-command" ?hidden=${!install}>
          <strong>Required official install or update command</strong>
          <code>${CODEX_INSTALL_COMMAND}</code>
          <button
            type="button"
            data-action="copy-codex-install"
            @click=${this.copyInstallCommand}
          >${copyLabel}</button>
        </div>
        <p class="settings-codex-sign-in" ?hidden=${!signIn}>
          <code>codex</code>
        </p>
        <a
          href=${CODEX_SETUP_GUIDE}
          target="_blank"
          rel="noreferrer"
          ?hidden=${!(install || signIn)}
        >Official Codex CLI guide</a>
      </section>
    `;
  }

  private resetCredits(runtimeBusy: boolean) {
    const snapshot = this.snapshot;
    const status = snapshot?.status;
    const action = this.resetCreditState ?? IDLE_RESET_CREDIT;
    const failed = snapshot?.phase === "failed";
    const checking = snapshot?.phase === "checking" && !status;
    const credits = failed ? null : codexResetCredits(status);
    const busy = ["submitting", "refreshing"].includes(action.state);
    const enabled =
      snapshot?.phase === "loaded" &&
      status?.readiness?.state === "ready" &&
      status?.account?.accountType === "chatgpt" &&
      !runtimeBusy &&
      !busy &&
      !action.retryPending;
    const rows = credits?.credits ?? [];
    const unlisted = Math.max(
      0,
      (credits?.availableCount ?? 0) -
        rows.filter(
          (credit) => typeof credit.id === "string" && credit.id.trim(),
        ).length,
    );
    const note = failed
      ? "Could not refresh reset credits. Try Refresh."
      : checking
        ? ""
        : !credits
          ? "Codex did not report reset credit availability."
          : credits.availableCount === 0
            ? "No reset credits available."
            : unlisted > 0
              ? `${unlisted} ${unlisted === 1 ? "credit cannot" : "credits cannot"} be selected individually from Codex's details.`
              : "";
    const retryDisabled =
      busy ||
      runtimeBusy ||
      status?.readiness?.state !== "ready" ||
      status?.account?.accountType !== "chatgpt";
    const count = checking
      ? "—"
      : failed
        ? "Unavailable"
        : formatResetCredits(status);
    return html`
      <section
        class="settings-codex-reset-credits"
        aria-labelledby="settings-codex-reset-title"
      >
        <div class="settings-codex-reset-heading">
          <h4 id="settings-codex-reset-title">Reset credits</h4>
          <span data-reset-credit-count>${count}</span>
        </div>
        <div data-reset-credit-list>${repeat(
          rows,
          (credit, index) => creditKey(credit) || `index:${index}`,
          (credit) => this.resetCreditCard(credit, enabled),
        )}</div>
        <p data-reset-credit-note ?hidden=${!note}>${note}</p>
        <button
          type="button"
          data-action="use-reset-credit"
          data-reset-credit-generic
          ?hidden=${!credits || unlisted === 0 || action.retryPending}
          ?disabled=${!enabled}
          @click=${this.useResetCredit}
        >Let Codex choose a reset</button>
        <button
          type="button"
          data-action="use-reset-credit"
          data-reset-credit-retry
          data-retry="true"
          data-credit-id=${action.creditId || nothing}
          ?hidden=${!action.retryPending}
          ?disabled=${retryDisabled}
          @click=${this.useResetCredit}
        >Retry previous reset request</button>
        <p
          class="settings-runtime-message"
          data-reset-credit-message
          role="status"
          data-state=${action.state}
          ?hidden=${!action.message}
        >${action.message || ""}</p>
      </section>
    `;
  }

  private resetCreditCard(credit: CodexResetCredit, enabled: boolean) {
    const creditId = creditKey(credit);
    const when = resetCreditExpiry(credit.expiresAt);
    const expiry = when
      ? html`<time datetime=${when.datetime}>${when.label}</time>`
      : "not provided by Codex";
    return html`<article class="settings-codex-reset-credit"><div><h5>${
      credit.title || "Rate-limit reset"
    }</h5><p>Expires ${expiry}</p></div><button
      type="button"
      data-action="use-reset-credit"
      data-credit-id=${creditId || nothing}
      ?disabled=${!enabled || !creditId}
      @click=${this.useResetCredit}
    >Use this reset</button></article>`;
  }

  private updatesSection(
    status: CodexStatus | null | undefined,
    runtimeBusy: boolean,
  ) {
    const report = this.updates;
    const unavailable = this.updatesState === "unavailable";
    const availability = unavailable ? "unknown" : report?.update;
    const updating = ["updating", "refreshing"].includes(this.updateState);
    const checking = !report && !unavailable;
    const label =
      this.updateState === "refreshing"
        ? "Checking…"
        : updating
          ? "Updating…"
          : "Update Codex…";
    const summary = updatesText(this.updatesSummary(), checking);
    const latest = updatesText(
      report
        ? (report.latestVersion ?? "Unavailable")
        : unavailable
          ? "Unavailable"
          : "Checking…",
      checking,
    );
    const automatic = updatesText(
      report
        ? (AUTOMATIC_UPDATES_LABEL[report.automaticUpdates ?? ""] ?? "Unknown")
        : unavailable
          ? "Unknown"
          : "Checking…",
      checking,
    );
    const updateDisabled =
      runtimeBusy ||
      !codexRuntimeUpdateAvailable(status) ||
      !["available", "unknown"].includes(availability ?? "");
    return html`
      <section
        class="settings-codex-updates"
        aria-labelledby="settings-codex-updates-title"
      >
        <div>
          <h3 id="settings-codex-updates-title">Updates</h3>
          <p data-updates-summary>${summary}</p>
          <dl>
            <div>
              <dt>Latest version</dt>
              <dd data-updates-latest>${latest}</dd>
            </div>
            <div>
              <dt>Automatic updates</dt>
              <dd data-updates-automatic>${automatic}</dd>
            </div>
          </dl>
        </div>
        <button
          type="button"
          data-action="open-codex-update"
          ?disabled=${updateDisabled}
          @click=${this.openUpdate}
        >${label}</button>
      </section>
    `;
  }

  private updatesSummary() {
    const report = this.updates;
    if (this.updatesState === "unavailable") {
      return `Caffold could not check for a Codex update.\n${this.updatesProblem}`;
    }
    if (!report) {
      return "Checking for updates…";
    }
    const { installedVersion, runningVersion, latestVersion } = report;
    if (report.update === "available") {
      if (
        installedVersion &&
        runningVersion &&
        installedVersion !== runningVersion
      ) {
        return `Codex ${installedVersion} is installed while the runtime is on ${runningVersion}.`;
      }
      return runningVersion
        ? `Codex ${latestVersion} is available. The runtime is on ${runningVersion}.`
        : `Codex ${latestVersion} is available. Codex ${installedVersion} is installed.`;
    }
    if (report.update === "upToDate") {
      return "Codex is up to date.";
    }
    const reason =
      report.problems?.latestVersion ?? report.problems?.installation;
    return reason
      ? `Caffold could not check for a Codex update.\n${reason}`
      : "Caffold could not check for a Codex update.";
  }

  private refresh(event: Event) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent(CODEX_STATUS_REFRESH_REQUEST_EVENT, { bubbles: true }),
    );
    void this.reconcileUpdates();
  }

  private useResetCredit(event: Event) {
    const control = event.currentTarget as HTMLButtonElement;
    if (control.disabled) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(CODEX_RESET_CREDIT_REQUEST_EVENT, {
        bubbles: true,
        detail: {
          creditId: control.dataset.creditId || null,
          retry: control.dataset.retry === "true",
        },
      }),
    );
  }

  private openRestart() {
    this.dispatchEvent(
      new CustomEvent(CODEX_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
    );
  }

  private openUpdate() {
    this.dispatchEvent(
      new CustomEvent(CODEX_RUNTIME_UPDATE_REQUEST_EVENT, { bubbles: true }),
    );
  }

  private async copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(CODEX_INSTALL_COMMAND);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
  }

  private get refreshButton() {
    return this.querySelector<CaffoldSettingsRefreshButton>(
      "caffold-settings-refresh-button",
    );
  }
}

// Readiness and Connection report the check itself, so they always answer.
// Every other row on the page is unknown until that check comes back, and
// holds its place rather than reporting an install or a limit nobody looked
// for.
function agentRows(
  snapshot: CodexStatusSnapshot | null,
  readinessLabel: string,
): SettingsDetailRow[] {
  const status = snapshot?.status;
  const readiness = status?.readiness;
  const answered = (value: string) => (readiness ? value : undefined);
  const connection = CONNECTION_PRESENTATION[codexConnection(status)];
  return [
    {
      key: "readiness",
      label: "Readiness",
      value: readinessLabel,
      state: readinessState(readiness),
    },
    {
      key: "connection",
      label: "Connection",
      value: connection.label,
      state: connection.state,
    },
    {
      key: "account",
      label: "Account",
      value: answered(formatCodexAccount(status)),
    },
    { key: "plan", label: "Plan", value: answered(formatCodexPlan(status)) },
    {
      key: "minimum",
      label: "Minimum supported",
      value: answered(readiness?.minimumSupportedVersion ?? "Unknown"),
    },
    {
      key: "detected-version",
      label: "Detected version",
      value: answered(readiness?.detectedExecutable?.version ?? "Not detected"),
    },
    {
      key: "detected-path",
      label: "Detected path",
      value: answered(readiness?.detectedExecutable?.path ?? "Not detected"),
    },
    {
      key: "managed-version",
      label: "Managed version",
      value: answered(readiness?.managedExecutable?.version ?? "Not available"),
    },
    {
      key: "managed-path",
      label: "Managed path",
      value: answered(readiness?.managedExecutable?.path ?? "Not available"),
    },
    {
      key: "runtime-version",
      label: "App-server runtime",
      value: answered(readiness?.runningAppServerVersion ?? "Not running"),
    },
  ];
}

function creditKey(credit: CodexResetCredit) {
  return typeof credit.id === "string" && credit.id.trim() ? credit.id : "";
}

function settled(before: string, after: string) {
  return (
    ["restarting", "updating", "refreshing"].includes(before) &&
    ["succeeded", "failed"].includes(after)
  );
}

// Text still being checked is the shared loading phrase.
function updatesText(text: string, checking: boolean) {
  return checking
    ? html`<caffold-loading-text>${text}</caffold-loading-text>`
    : text;
}

function codexConnection(status: CodexStatus | null | undefined) {
  if (!status?.readiness) {
    return "pending";
  }
  return status?.diagnostics?.processConnected ? "available" : "unavailable";
}

function readinessState(readiness: CodexReadiness | null | undefined) {
  if (!readiness) {
    return "";
  }
  if (readiness.state === "ready") {
    return "positive";
  }
  if (
    [
      "missing",
      "unsupportedInstall",
      "updateRequired",
      "signInRequired",
      "restartRequired",
    ].includes(readiness.state)
  ) {
    return "attention";
  }
  return "negative";
}

/** Only the windows Codex reported get a row; the rest were never metered. */
function usageWindowRows(
  status: CodexStatus | null | undefined,
): SettingsDetailRow[] {
  return codexRateWindows(status).map(
    ({ limitId, limitName, name, window }) => ({
      key: limitId ? `${limitId}:${name}` : name,
      label: limitName
        ? `${formatRateWindowLabel(window, name)} · ${limitName}`
        : formatRateWindowLabel(window, name),
      value: usageWindowValue(window),
    }),
  );
}

/** One window as its row reads: how much is used, and when it lets go. */
function usageWindowValue(window: CodexRateWindow) {
  const used = `${formatUsedPercent(window)} used`;
  const reset = formatRateReset(window);
  return reset === "-" ? used : `${used} · resets ${reset}`;
}

function repairDescription(readiness: CodexReadiness | null | undefined) {
  if (readiness?.reasonCode === "appServerCommandsUnavailable") {
    return "The detected CLI lacks the app-server daemon commands Caffold uses to manage Task connections. Install or update the official standalone CLI with the required command below.";
  }
  return (
    (
      {
        missing:
          "Codex Tasks require the official standalone CLI because it includes the app-server daemon commands used for managed connections. Install it below, then run codex and sign in.",
        unsupportedInstall:
          "This installation does not provide a supported app-server daemon. Install the official standalone CLI with the required command below.",
        updateRequired:
          "Update the official standalone CLI with the required command below. Caffold rejects older versions before starting the app-server daemon.",
        signInRequired:
          "Run codex in a terminal and complete sign-in, then refresh this page.",
        restartRequired:
          "Confirm a shared runtime restart below to use the installed Codex version.",
        incompatible:
          "The installed version passed the minimum check, but the required app-server protocol did not initialize.",
        error:
          "Retry the readiness check. The diagnostic below can help identify an unclassified runtime failure.",
      } as Record<string, string>
    )[readiness?.state ?? ""] ??
    "Refresh the canonical Codex readiness diagnosis."
  );
}

customElements.define("caffold-settings-codex-page", CaffoldSettingsCodexPage);
