import { getClaudeStatus } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import {
  idleTimeoutValue,
  usageWindowLabel,
  usageWindowValue,
} from "./display.js";

export const CLAUDE_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-claude-runtime-restart";

class CaffoldSettingsClaudePage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.restartState = "idle";
    this.restartMessage = "";
    this.status = null;
    this.statusState = "idle";
    this.operation = 0;
    this.active = false;
    this.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="open-claude-restart"]')) {
        this.dispatchEvent(
          new CustomEvent(CLAUDE_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
        );
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
      const status = await getClaudeStatus();
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

  setRestartState(value) {
    const before = this.restartState;
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (this.initialized) {
      this.render();
      if (this.restartState === "restarted" && before !== "restarted") {
        // The runner block still shows the runner that just ended.
        void this.reconcile();
      }
    }
  }

  render() {
    if (!this.pageMounted) {
      this.pageMounted = true;
      this.innerHTML = `
        <div class="settings-content-scroll">
          <div class="settings-content-section">
            <header>
              <p>The Claude Code installation this server drives.</p>
            </header>
            <section aria-labelledby="settings-claude-agent-title">
              <h3 id="settings-claude-agent-title">Agent</h3>
              <dl class="settings-details" data-claude-agent></dl>
            </section>
            <section aria-labelledby="settings-claude-usage-title">
              <h3 id="settings-claude-usage-title">Usage</h3>
              <dl class="settings-details" data-claude-usage></dl>
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
                <button type="button" data-action="open-claude-restart">Restart runtime</button>
              </div>
              <dl class="settings-details" data-claude-runner></dl>
              <p class="settings-runtime-message" role="status" hidden></p>
            </section>
          </div>
        </div>
      `;
    }

    const pending = this.pendingRows();
    this.querySelector("[data-claude-agent]").innerHTML =
      pending || this.agentRows();
    this.querySelector("[data-claude-usage]").innerHTML =
      pending || this.usageRows();
    this.querySelector("[data-claude-runner]").innerHTML =
      pending || this.runnerRows();

    const restarting = this.restartState === "restarting";
    const restart = this.querySelector('[data-action="open-claude-restart"]');
    restart.disabled = restarting;
    restart.textContent = restarting ? "Restarting…" : "Restart runtime";
    const message = this.querySelector(".settings-runtime-message");
    message.hidden = !this.restartMessage;
    message.dataset.state = this.restartState;
    message.textContent = this.restartMessage;
  }

  agentRows() {
    // Each source answered for itself, so each row reads for itself: a
    // binary nobody could ask says nothing about the signed-in account.
    const executableProblem = this.status?.problems?.executable;
    const executable = this.status?.executable;
    const auth = this.status?.auth;
    const authProblem = this.status?.problems?.auth;
    return [
      executableProblem
        ? detail("Version", `Unavailable — ${executableProblem}`, false, "unavailable")
        : detail("Version", executable?.version ?? "Unknown"),
      executable?.path ? detail("Path", executable.path, true) : "",
      authProblem
        ? detail("Account", `Unavailable — ${authProblem}`, false, "unavailable")
        : detail("Account", accountValue(auth), false, auth?.loggedIn ? "" : "unavailable"),
      auth?.subscription ? detail("Plan", planLabel(auth.subscription)) : "",
    ].join("");
  }

  usageRows() {
    const problem = this.status?.problems?.usage;
    if (problem) {
      return unavailableRow(problem);
    }
    const windows = this.status?.usage?.windows ?? [];
    if (windows.length === 0) {
      return detail("Windows", "None reported");
    }
    return windows
      .map((window) => detail(usageWindowLabel(window), usageWindowValue(window)))
      .join("");
  }

  runnerRows() {
    const problem = this.status?.problems?.runner;
    if (problem) {
      return unavailableRow(problem);
    }
    const runner = this.status?.runner;
    if (!runner?.running) {
      return detail("Runner", "Not running");
    }
    return [
      detail("Runner", runner.pid ? `Running · pid ${runner.pid}` : "Running"),
      Number.isFinite(runner.sessions) ? detail("Sessions", `${runner.sessions}`) : "",
      runner.version ? detail("Runner build", runner.version, true) : "",
      Number.isFinite(runner.idleTimeoutSecs)
        ? detail("Idle timeout", idleTimeoutValue(runner.idleTimeoutSecs))
        : "",
    ].join("");
  }

  pendingRows() {
    // A refresh keeps the rows it already has until the new ones arrive;
    // only a panel with nothing yet says it is checking.
    if (
      (this.statusState === "loading" || this.statusState === "idle") &&
      !this.status
    ) {
      return detail("Status", "Checking…");
    }
    if (this.statusState === "unavailable") {
      return unavailableRow("The server did not answer.");
    }
    return "";
  }
}

function accountValue(auth) {
  if (!auth?.loggedIn) {
    return "Signed out";
  }
  const who = auth.email ?? "Signed in";
  return auth.method ? `${who} · ${auth.method}` : who;
}

function planLabel(subscription) {
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

function unavailableRow(message) {
  return detail("Status", `Unavailable — ${message}`, false, "unavailable");
}

function detail(label, value, code = false, state = "") {
  const content = code
    ? `<code>${escapeHtml(value)}</code>`
    : escapeHtml(value);
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd${state ? ` data-state="${escapeHtml(state)}"` : ""}>${content}</dd>
    </div>
  `;
}

customElements.define("caffold-settings-claude-page", CaffoldSettingsClaudePage);
