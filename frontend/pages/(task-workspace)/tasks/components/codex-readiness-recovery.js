import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  INITIAL_CODEX_STATUS_SNAPSHOT,
} from "../../codex-status.js";

const CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SETUP_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";

class CaffoldCodexReadinessRecovery extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureRendered();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
    }
  }

  disconnectedCallback() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
    this.restartStateValue = { state: "idle", message: "" };
    this.copyState = "idle";
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.innerHTML = `
      <section class="codex-readiness-surface" aria-labelledby="codex-readiness-title">
        <div class="codex-readiness-card">
          <p class="codex-readiness-eyebrow" data-readiness-eyebrow>Codex setup</p>
          <h2 id="codex-readiness-title" data-readiness-title></h2>
          <p data-readiness-message role="status"></p>
          <p class="codex-readiness-runtime-requirement" hidden>
            Caffold runs Tasks through Codex's background app server. The official standalone Codex CLI installation includes the runtime commands Caffold needs to start and connect to it. Other installations may provide the <code>codex</code> command without this app-server support. Caffold manages the connection automatically.
          </p>
          <dl class="codex-readiness-versions" hidden>
            <div data-readiness-version="detected"><dt>Detected</dt><dd></dd></div>
            <div data-readiness-version="minimum"><dt>Minimum</dt><dd></dd></div>
            <div data-readiness-version="running"><dt>Running</dt><dd></dd></div>
          </dl>
          <div class="codex-readiness-command" hidden>
            <strong data-readiness-command-label></strong>
            <code>${CODEX_INSTALL_COMMAND}</code>
            <button type="button" data-codex-readiness-action="copy-command">Copy command</button>
          </div>
          <p class="codex-readiness-instruction" hidden></p>
          <div class="codex-readiness-actions">
            <button class="codex-readiness-primary-action" type="button" data-codex-readiness-action="restart" hidden>Restart Codex</button>
            <button type="button" data-codex-readiness-action="retry">Retry</button>
            <button type="button" data-codex-readiness-action="settings">Open Settings</button>
            <a href="${CODEX_SETUP_GUIDE}" target="_blank" rel="noreferrer" hidden>Official Codex CLI guide</a>
          </div>
          <p class="codex-readiness-restart-message" role="status" hidden></p>
          <p class="codex-readiness-diagnostic" hidden></p>
        </div>
      </section>
    `;
    this.patch();
  }

  setSnapshot(snapshot) {
    this.ensureState();
    const nextSnapshot = snapshot ?? INITIAL_CODEX_STATUS_SNAPSHOT;
    if (this.snapshotValue === nextSnapshot) {
      return;
    }
    this.snapshotValue = nextSnapshot;
    this.copyState = "idle";
    this.patch();
  }

  setRestartState(state) {
    this.ensureState();
    this.restartStateValue = state ?? { state: "idle", message: "" };
    this.patch();
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-codex-readiness-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    if (action.dataset.codexReadinessAction === "retry") {
      this.dispatchEvent(
        new CustomEvent(CODEX_STATUS_REFRESH_REQUEST_EVENT, { bubbles: true }),
      );
    } else if (action.dataset.codexReadinessAction === "restart") {
      this.dispatchEvent(
        new CustomEvent(CODEX_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
      );
    } else if (action.dataset.codexReadinessAction === "settings") {
      this.dispatchEvent(
        new CustomEvent("caffold:open-settings", {
          bubbles: true,
          detail: { section: "codex" },
        }),
      );
    } else if (action.dataset.codexReadinessAction === "copy-command") {
      void this.copyInstallCommand();
    }
  }

  async copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(CODEX_INSTALL_COMMAND);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
    this.patch();
  }

  patch() {
    if (!this.rendered) {
      return;
    }
    const taskStore = this.snapshotValue.status?.taskStoreReadiness;
    if (
      taskStore?.blocksTaskOperations &&
      taskStore.state !== "waitingForCodex"
    ) {
      const failed = taskStore.state === "failed";
      patchReadinessCard(this, {
        state: `taskStore-${taskStore.state ?? "blocked"}`,
        eyebrow: "Task setup",
        title: failed ? "Task data upgrade failed" : "Preparing Tasks…",
        message: failed
          ? "Caffold could not finish preparing the local Task navigator."
          : "Caffold is preparing the local Task navigator before Tasks start.",
        instruction: failed
          ? "Retry the upgrade. The existing Task database remains unchanged until it succeeds."
          : "This finishes automatically when the local upgrade succeeds.",
        diagnostic: taskStore.diagnosticMessage,
        showInstall: false,
        showGuide: false,
        showRestart: false,
        retryLabel: failed ? "Retry Task setup" : "Preparing…",
        retryDisabled: !failed,
        showSettings: false,
        restartState: this.restartStateValue.state,
        restartMessage: this.restartStateValue.message,
        copyLabel: "Copy command",
        versions: {},
      });
      return;
    }
    const readiness = this.snapshotValue.status?.readiness;
    if (!readiness) {
      if (this.snapshotValue.phase === "failed") {
        patchReadinessCard(this, {
          state: "checkFailed",
          eyebrow: "Codex setup",
          title: "Codex readiness could not be checked",
          message: "Caffold could not load the backend-owned Codex readiness state.",
          instruction: "",
          diagnostic: this.snapshotValue.error,
          showInstall: false,
          showGuide: false,
          showRestart: false,
          restartState: this.restartStateValue.state,
          restartMessage: this.restartStateValue.message,
          copyLabel: "Copy command",
          versions: {},
        });
      }
      return;
    }

    const content = readinessContent(readiness);
    const showInstall = ["missing", "unsupportedInstall", "updateRequired"].includes(
      readiness.state,
    );
    const showGuide = showInstall || readiness.state === "signInRequired";
    const copyLabel = this.copyState === "copied"
      ? "Copied"
      : this.copyState === "failed" ? "Copy failed" : "Copy command";
    const commandLabel = readiness.state === "missing"
      ? "Required official install command"
      : readiness.state === "updateRequired"
        ? "Required official update command"
        : "Required official install or update command";
    patchReadinessCard(this, {
      state: readiness.state,
      eyebrow: "Codex setup",
      title: content.title,
      message: content.message,
      instruction: content.instruction,
      diagnostic: ["error", "incompatible"].includes(readiness.state)
        ? readiness.diagnosticMessage
        : "",
      showInstall,
      showGuide,
      showRestart: readiness.state === "restartRequired",
      retryLabel: taskStore?.blocksTaskOperations
        ? "Retry Task setup"
        : "Retry",
      retryDisabled: false,
      showSettings: true,
      restartState: this.restartStateValue.state,
      restartMessage: this.restartStateValue.message,
      copyLabel,
      commandLabel,
      versions: {
        detected: readiness.detectedExecutable?.version,
        minimum: readiness.minimumSupportedVersion,
        running: readiness.runningAppServerVersion,
      },
    });
  }
}

function patchReadinessCard(root, view) {
  const card = root.querySelector(".codex-readiness-card");
  card.dataset.readinessState = view.state;
  card.querySelector("[data-readiness-eyebrow]").textContent =
    view.eyebrow ?? "Codex setup";
  card.querySelector("[data-readiness-title]").textContent = view.title;
  card.querySelector("[data-readiness-message]").textContent = view.message;

  const versions = card.querySelector(".codex-readiness-versions");
  let visibleVersions = 0;
  for (const [name, value] of Object.entries(view.versions)) {
    const row = versions.querySelector(`[data-readiness-version="${name}"]`);
    row.toggleAttribute("hidden", !value);
    row.querySelector("dd").textContent = value ?? "";
    visibleVersions += value ? 1 : 0;
  }
  versions.toggleAttribute("hidden", visibleVersions === 0);

  const command = card.querySelector(".codex-readiness-command");
  command.toggleAttribute("hidden", !view.showInstall);
  card.querySelector(".codex-readiness-runtime-requirement")
    .toggleAttribute("hidden", !view.showInstall);
  command.querySelector("[data-readiness-command-label]").textContent =
    view.commandLabel ?? "";
  command.querySelector("button").textContent = view.copyLabel;
  const instruction = card.querySelector(".codex-readiness-instruction");
  instruction.toggleAttribute("hidden", !view.instruction);
  instruction.textContent = view.instruction;
  const actions = card.querySelector(".codex-readiness-actions");
  const restart = actions.querySelector(
    '[data-codex-readiness-action="restart"]',
  );
  const restarting = ["restarting", "refreshing"].includes(view.restartState);
  restart.toggleAttribute("hidden", !view.showRestart);
  restart.disabled = restarting;
  restart.textContent = view.restartState === "refreshing"
    ? "Checking…"
    : restarting ? "Restarting…" : "Restart Codex";
  const retry = actions.querySelector('[data-codex-readiness-action="retry"]');
  retry.textContent = view.retryLabel ?? "Retry";
  retry.disabled = Boolean(view.retryDisabled);
  const settings = actions.querySelector(
    '[data-codex-readiness-action="settings"]',
  );
  settings.textContent = "Open Settings";
  settings.toggleAttribute("hidden", view.showSettings === false);
  actions.querySelector("a").toggleAttribute("hidden", !view.showGuide);
  const restartMessage = card.querySelector(".codex-readiness-restart-message");
  restartMessage.toggleAttribute("hidden", !view.restartMessage);
  restartMessage.dataset.state = view.restartState;
  restartMessage.textContent = view.restartMessage;
  const diagnostic = card.querySelector(".codex-readiness-diagnostic");
  diagnostic.toggleAttribute("hidden", !view.diagnostic);
  diagnostic.textContent = view.diagnostic;
}

function readinessContent(readiness) {
  if (
    readiness.state === "unsupportedInstall" &&
    readiness.reasonCode === "appServerCommandsUnavailable"
  ) {
    return {
      title: "Install a compatible Codex CLI",
      message:
        "The detected Codex installation does not include the runtime support Caffold Tasks require.",
      instruction:
        "Run the required command above, start codex and complete sign-in, then retry.",
    };
  }
  return {
    missing: {
      title: "Install Codex to start Tasks",
      message: "Caffold requires the official standalone Codex installation.",
      instruction: "Run the required command above, start codex and complete sign-in, then retry.",
    },
    unsupportedInstall: {
      title: "Use the official standalone Codex",
      message: "The detected Codex installation is not supported for Caffold Tasks.",
      instruction: "Run the required command above, start codex and complete sign-in, then retry.",
    },
    updateRequired: {
      title: "Update Codex to continue",
      message: "The installed Codex version is older than Caffold supports.",
      instruction: "Run the required command above, then retry.",
    },
    signInRequired: {
      title: "Sign in to Codex",
      message: "Codex is installed and compatible, but authentication is required.",
      instruction: "Run codex in a terminal, complete sign-in, then retry.",
    },
    restartRequired: {
      title: "Restart the Codex runtime",
      message: "The installed Codex version differs from the running app-server runtime.",
      instruction: "Restart the shared runtime to use the installed Codex version. Caffold will ask for confirmation first.",
    },
    incompatible: {
      title: "Codex runtime is incompatible",
      message: "This Codex version passed the minimum check but its app-server protocol could not initialize.",
      instruction: "Refresh after updating Codex, or inspect the diagnostic details in Settings.",
    },
    error: {
      title: "Codex runtime is unavailable",
      message: "Caffold encountered a Codex runtime error that needs attention.",
      instruction: "Retry the diagnosis or inspect Codex Settings for details.",
    },
  }[readiness.state] ?? {
    title: "Codex setup is required",
    message: "Codex is not ready for Task operations.",
    instruction: "Retry the diagnosis or open Settings.",
  };
}

if (!customElements.get("caffold-codex-readiness-recovery")) {
  customElements.define(
    "caffold-codex-readiness-recovery",
    CaffoldCodexReadinessRecovery,
  );
}
