import { getGrokStatus } from "../../../../api.js";
import "../components/detail-list.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";

// Every block asks the same questions of every installation, so its rows
// stand from the first paint and only their values arrive later.
const AGENT_ROWS = Object.freeze([
  Object.freeze({ key: "version", label: "Version" }),
  Object.freeze({ key: "path", label: "Path", kind: "code" }),
]);
const ACCOUNT_ROWS = Object.freeze([
  Object.freeze({ key: "account", label: "Account" }),
  Object.freeze({ key: "method", label: "Sign-in" }),
]);
const LEADER_ROWS = Object.freeze([
  Object.freeze({ key: "leader", label: "Leader" }),
  Object.freeze({ key: "leader-build", label: "Leader build" }),
  Object.freeze({ key: "socket", label: "Socket", kind: "code" }),
]);
const CONNECTION_ROWS = Object.freeze([
  Object.freeze({ key: "connection", label: "Caffold" }),
  Object.freeze({ key: "auth-methods", label: "Sign-in methods" }),
]);

class CaffoldSettingsGrokPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.status = null;
    this.statusState = "idle";
    this.operation = 0;
    this.active = false;
    this.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="refresh-grok-status"]')) {
        void this.reconcile();
      }
    });
    this.render();
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
    this.render();
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
    this.render();
  }

  actionHintScope({
    scopeId = "settings:grok",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    const selector = 'button[data-action="refresh-grok-status"]';
    const control = this.querySelector(selector);
    if (
      this.hidden ||
      !scrollport ||
      !control ||
      control.disabled ||
      control.hidden ||
      !hasActionHintLayoutBox(control)
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:refresh`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          "Check again",
        control,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          !control.hidden &&
          hasActionHintLayoutBox(control),
      })],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:grok",
    label = "Grok settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
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
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    if (!this.pageMounted) {
      this.pageMounted = true;
      this.innerHTML = `
        <div class="settings-content-scroll">
          <div class="settings-content-section">
            <header>
              <p>The Grok CLI installation this server drives.</p>
              <button type="button" data-action="refresh-grok-status">Check again</button>
            </header>
            <section aria-labelledby="settings-grok-agent-title">
              <h3 id="settings-grok-agent-title">Agent</h3>
              <caffold-settings-detail-list data-grok-agent></caffold-settings-detail-list>
            </section>
            <section aria-labelledby="settings-grok-account-title">
              <h3 id="settings-grok-account-title">Account</h3>
              <caffold-settings-detail-list data-grok-account></caffold-settings-detail-list>
            </section>
            <section aria-labelledby="settings-grok-leader-title">
              <h3 id="settings-grok-leader-title">Leader</h3>
              <caffold-settings-detail-list data-grok-leader></caffold-settings-detail-list>
            </section>
            <section aria-labelledby="settings-grok-connection-title">
              <h3 id="settings-grok-connection-title">Connection</h3>
              <caffold-settings-detail-list data-grok-connection></caffold-settings-detail-list>
            </section>
          </div>
        </div>
      `;
      this.agentList = this.querySelector("[data-grok-agent]");
      this.accountList = this.querySelector("[data-grok-account]");
      this.leaderList = this.querySelector("[data-grok-leader]");
      this.connectionList = this.querySelector("[data-grok-connection]");
    }

    const unanswered = this.unansweredRows();
    this.agentList.setRows(unanswered ?? this.agentRows());
    this.accountList.setRows(unanswered ?? this.accountRows());
    this.leaderList.setRows(unanswered ?? this.leaderRows());
    this.connectionList.setRows(unanswered ?? this.connectionRows());

    const refresh = this.querySelector('[data-action="refresh-grok-status"]');
    const loading = this.statusState === "loading";
    refresh.disabled = loading;
    refresh.textContent = loading ? "Checking…" : "Check again";
  }

  agentRows() {
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
        value: problem ? "Unknown" : executable?.path ?? "Not detected",
      },
    ];
  }

  accountRows() {
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
          value: verified.authenticated ? signedInValue(verified) : "Signed out",
          state: verified.authenticated ? "" : "negative",
        }
        : auth.cachedSignIn
          ? { value: "Cached sign-in present — verified once Caffold is connected" }
          : { value: "Signed out — no cached sign-in", state: "negative" };
    const method = verified?.mode ??
      this.status.connection?.defaultAuthMethod ??
      "Unknown";
    return [
      { ...ACCOUNT_ROWS[0], ...account },
      { ...ACCOUNT_ROWS[1], value: problem ? "Unknown" : method },
    ];
  }

  leaderRows() {
    if (!this.status) {
      return LEADER_ROWS;
    }
    const problem = this.status.problems?.leader;
    if (problem) {
      return [
        { ...LEADER_ROWS[0], ...unavailableValue(problem) },
        { ...LEADER_ROWS[1], value: "Unknown" },
        { ...LEADER_ROWS[2], value: this.status.leader?.socketPath ?? "Unknown" },
      ];
    }
    const leader = this.status.leader;
    const installed = installedVersion(this.status.executable?.version);
    return [
      {
        ...LEADER_ROWS[0],
        value: leader?.running
          ? leader.pid ? `Running · pid ${leader.pid}` : "Running"
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

  connectionRows() {
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
  unansweredRows() {
    if (this.statusState !== "unavailable") {
      return null;
    }
    return [{
      key: "status",
      label: "Status",
      ...unavailableValue("The server did not answer."),
    }];
  }
}

function signedInValue(verified) {
  const who = verified.email ?? "Signed in";
  return verified.subscriptionTier ? `${who} · ${verified.subscriptionTier}` : who;
}

/** The version number inside "grok 1.0.30 (04b7ffed98c6) [stable]". */
function installedVersion(version) {
  return version?.split(/\s+/).find((word) => /^\d+\.\d+/.test(word)) ?? null;
}

/** The running leader's build, and whether the installed executable has moved on. */
function leaderBuildValue(leader, installed) {
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

function connectionValue(connection, leader) {
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

function unavailableValue(problem) {
  return { value: `Unavailable — ${problem}`, state: "negative" };
}

customElements.define("caffold-settings-grok-page", CaffoldSettingsGrokPage);
