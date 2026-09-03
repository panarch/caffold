import { getClaudeStatus } from "../../../../api.js";
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
import {
  idleTimeoutValue,
  usageWindowLabel,
  usageWindowValue,
} from "./display.js";

export const CLAUDE_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-claude-runtime-restart";

// The agent block asks the same four questions of every installation, so its
// rows stand from the first paint and only their values arrive later.
const AGENT_ROWS = Object.freeze([
  Object.freeze({ key: "version", label: "Version" }),
  Object.freeze({ key: "path", label: "Path", kind: "code" }),
  Object.freeze({ key: "account", label: "Account" }),
  Object.freeze({ key: "plan", label: "Plan" }),
]);

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

  actionHintScope({
    scopeId = "settings:claude",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    const selector = 'button[data-action="open-claude-restart"]';
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
        id: `${scopeId}:restart-runtime`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          "Restart runtime",
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
    scopeId = "settings:claude",
    label = "Claude settings",
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
              <p>The Claude Code installation this server drives.</p>
            </header>
            <section aria-labelledby="settings-claude-agent-title">
              <h3 id="settings-claude-agent-title">Agent</h3>
              <caffold-settings-detail-list data-claude-agent></caffold-settings-detail-list>
            </section>
            <section aria-labelledby="settings-claude-usage-title">
              <h3 id="settings-claude-usage-title">Usage</h3>
              <caffold-settings-detail-list data-claude-usage></caffold-settings-detail-list>
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
              <caffold-settings-detail-list data-claude-runner></caffold-settings-detail-list>
              <p class="settings-runtime-message" role="status" hidden></p>
            </section>
          </div>
        </div>
      `;
      this.agentList = this.querySelector("[data-claude-agent]");
      this.usageList = this.querySelector("[data-claude-usage]");
      this.runnerList = this.querySelector("[data-claude-runner]");
    }

    const unanswered = this.unansweredRows();
    this.agentList.setRows(unanswered ?? this.agentRows());
    this.usageList.setRows(unanswered ?? this.usageRows());
    this.runnerList.setRows(unanswered ?? this.runnerRows());

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
    if (!this.status) {
      return AGENT_ROWS;
    }
    const values = agentValues(this.status);
    return AGENT_ROWS.map((row) => ({ ...row, ...values[row.key] }));
  }

  usageRows() {
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

  runnerRows() {
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
        ? [{ key: "runner-build", label: "Runner build", value: runner.version, kind: "code" }]
        : []),
      ...(Number.isFinite(runner.idleTimeoutSecs)
        ? [{
          key: "idle-timeout",
          label: "Idle timeout",
          value: idleTimeoutValue(runner.idleTimeoutSecs),
        }]
        : []),
    ];
  }

  // A server that never answered leaves no block with anything of its own to
  // report, so all three collapse to the same line.
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

// Each source answered for itself, so each row reads for itself: a binary
// nobody could ask says nothing about the signed-in account.
function agentValues(status) {
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

/** Windows are identified by what they meter, and by position when they are not. */
function usageWindowKey(window, index) {
  return window?.model ? `model:${window.model}` : `kind:${window?.kind ?? index}`;
}

function unavailableValue(problem) {
  return { value: `Unavailable — ${problem}`, state: "negative" };
}

customElements.define("caffold-settings-claude-page", CaffoldSettingsClaudePage);
