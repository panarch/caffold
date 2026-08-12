import { routeDomain, routeTarget } from "../../../navigation-routes.js";
import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  codexBlocksTaskOperations,
} from "../codex-status.js";
import "./components/detail.js";
import "./components/recovery.js";
import {
  TASK_IMAGE_PREVIEW_EVENT,
} from "./components/image-preview-dialog.js";
import "./components/task-new.js";
import {
  TASK_TRANSPORT_RETRY_EVENT,
} from "./components/task-transport-overlay.js";
import { retryStaleTaskTransports } from "./runtime-state.js";
import { taskDetailThreadId } from "./task-list-model.js";

const CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SETUP_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";

class CaffoldTasksPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.view = "home";
    this.detailView = "conversation";
    this.detailPresentation = "reading";
    this.taskListState = "loading";
    this.selectedThreadId = "";
    this.adoptedThreadId = "";
    this.currentRoute = { kind: "tasks" };
    this.currentOpenOptions = {};
    this.codexStatusValue = null;
    this.codexRestartStateValue = { state: "idle", message: "" };
    this.setupCopyState = "idle";
    this.boundTaskNavigatorIntent = (event) => {
      event.stopPropagation();
      if (event.detail?.type === "select-task") {
        this.requestRoute({
          kind: "tasks",
          threadId: event.detail.threadId,
        });
      } else if (event.detail?.type === "select-task-recovery") {
        this.requestRoute({
          kind: "tasks",
          threadId: event.detail.threadId,
          recovery: true,
        });
      } else if (event.detail?.type === "new-task") {
        this.requestNewTaskRoute();
      }
    };
    this.boundTaskNavigatorListState = (event) => {
      event.stopPropagation();
      this.syncTaskListState(event.detail);
    };
    this.boundTaskNavigatorTransportChange = (event) => {
      event.stopPropagation();
      this.taskNew()?.setTransportAvailable(event.detail?.available);
    };
    this.boundTaskTransportRetry = (event) => {
      event.stopPropagation();
      this.retryTaskTransports();
    };

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-detail-pane" role="region" aria-label="Task content">
          <section class="codex-readiness-surface" aria-live="polite">
            <div class="codex-readiness-check" data-readiness-view="checking" role="status">
              <span class="codex-readiness-spinner" aria-hidden="true"></span>
              <span>Checking Codex readiness…</span>
              <div class="codex-readiness-actions">
                <button type="button" data-codex-readiness-action="settings">Open Settings</button>
              </div>
            </div>
            <div class="codex-readiness-card" data-readiness-view="card" hidden>
              <p class="codex-readiness-eyebrow">Codex setup</p>
              <h2 data-readiness-title></h2>
              <p data-readiness-message></p>
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
          <caffold-task-new hidden></caffold-task-new>
          <caffold-task-detail hidden></caffold-task-detail>
          <caffold-task-recovery hidden></caffold-task-recovery>
        </div>
      </section>
      <caffold-task-image-preview-dialog></caffold-task-image-preview-dialog>
    `;
    this.addEventListener("caffold:task-new-route-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.route) {
        this.requestRoute(event.detail.route);
      }
    });
    this.addEventListener("caffold:task-created", (event) => {
      event.stopPropagation();
      this.adoptCreatedDetail(event.detail?.detail);
    });
    this.addEventListener("caffold:task-snapshot", (event) => {
      event.stopPropagation();
      if (event.detail?.task) {
        this.taskNavigator()?.upsertCanonicalTask(event.detail.task);
      }
    });
    this.addEventListener("caffold:task-detail-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "task-archived" && event.detail.task) {
        this.taskNavigator()?.acceptArchivedTask(event.detail.task);
        this.requestRoute({ kind: "tasks" }, { replace: true });
      } else if (
        ["review-route", "domain-route"].includes(event.detail?.type) &&
        event.detail.route
      ) {
        this.requestRoute(event.detail.route, {
          replace: event.detail.replace,
        });
      }
    });
    this.addEventListener("caffold:task-recovery-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "recheck") {
        void this.recheckRecovery();
      } else if (event.detail?.type === "resolved") {
        this.resolveRecovery(event.detail);
      }
    });
    this.addEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
    );
    this.addEventListener(TASK_IMAGE_PREVIEW_EVENT, (event) => {
      event.stopPropagation();
      this.imagePreviewDialog()?.openImage(event.detail);
    });
    this.addEventListener("click", (event) => {
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
    });
    this.render();
  }

  connectTaskNavigator(navigator) {
    this.ensureRendered();
    if (this.connectedTaskNavigator === navigator) {
      return;
    }
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-intent",
      this.boundTaskNavigatorIntent,
    );
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-list-state",
      this.boundTaskNavigatorListState,
    );
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTaskNavigatorTransportChange,
    );
    this.connectedTaskNavigator?.removeEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
    );
    this.connectedTaskNavigator = navigator ?? null;
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-intent",
      this.boundTaskNavigatorIntent,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-list-state",
      this.boundTaskNavigatorListState,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTaskNavigatorTransportChange,
    );
    this.connectedTaskNavigator?.addEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
    );
    this.syncTaskListState(this.connectedTaskNavigator?.listState());
    this.taskNew()?.setTransportAvailable(
      this.connectedTaskNavigator?.isTransportAvailable?.(),
    );
    this.connectedTaskNavigator?.setSelectedThreadId(this.selectedThreadId);
  }

  deactivate() {
    this.imagePreviewDialog()?.dismiss();
    if (this.view === "detail") {
      this.taskDetail()?.deactivate({ retainComposerDom: true });
    } else if (this.view === "recovery") {
      this.taskRecovery()?.deactivate();
    } else {
      this.taskNew()?.deactivate();
    }
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.currentRoute = { ...route };
    this.currentOpenOptions = { ...options };
    const target = routeTarget(route);
    const domain = routeDomain(route);
    const nextView = target === "recovery"
      ? "recovery"
      : route?.threadId
      ? "detail"
      : target === "new"
        ? "new"
        : "home";
    const nextDetailView = domain ||
      (["review", "review-file"].includes(target) ? "review" : "conversation");
    const nextThreadId = `${route?.threadId ?? ""}`;
    if (nextView !== this.view || nextThreadId !== this.selectedThreadId) {
      this.imagePreviewDialog()?.dismiss();
    }
    const preserveAdopted =
      nextThreadId &&
      this.adoptedThreadId === nextThreadId &&
      taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId;
    const preserveLoadedTask =
      Boolean(options.preserveLoadedTask) ||
      preserveAdopted ||
      (this.selectedThreadId === nextThreadId &&
        taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId);

    this.view = nextView;
    this.detailView = nextDetailView;
    this.detailPresentation = taskRoutePresentation(route);
    this.selectedThreadId = nextThreadId;
    this.setAttribute("data-tasks-view", nextView);
    this.taskNavigator()?.setSelectedThreadId(nextThreadId);
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    }
    if (nextView !== "recovery") {
      this.taskRecovery()?.deactivate();
    }
    if (nextView === "detail") {
      this.taskNew()?.deactivate();
      this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask, route });
    } else if (nextView === "recovery") {
      this.taskNew()?.deactivate();
      this.taskRecovery()?.prepare(options.recovery ?? null);
    }
    this.render();
    return { preserveLoadedTask };
  }

  async openRoute(route, options = {}) {
    const prepared = this.prepareRoute(route, options);
    if (this.codexOperationsBlocked()) {
      this.render();
      return null;
    }
    const target = routeTarget(route);
    if (target === "new") {
      this.taskNew()?.prepare({
        cwd: route.cwd ?? "",
        defaultCwdPath: options.defaultCwdPath ?? "",
      });
      this.taskNew()?.open();
      void this.taskNavigator()?.activate();
      this.render();
      return null;
    }
    if (target === "recovery" && route?.threadId) {
      this.taskNew()?.deactivate();
      this.taskDetail()?.deactivate();
      await this.taskNavigator()?.activate({ force: true });
      const recovery = this.taskNavigator()?.recoveryFor(route.threadId);
      if (!recovery) {
        const task = this.taskNavigator()?.taskFor(route.threadId);
        this.requestRoute(
          task
            ? { kind: "tasks", threadId: route.threadId }
            : { kind: "tasks" },
          { replace: true },
        );
        return null;
      }
      this.taskRecovery()?.updateRecovery(recovery);
      this.render();
      return recovery;
    }
    if (route?.threadId) {
      this.taskNew()?.deactivate();
      void this.taskNavigator()?.activate();
      const result = await this.taskDetail()?.open(route.threadId, {
        preserveLoadedTask: prepared.preserveLoadedTask,
        route,
      });
      if (this.adoptedThreadId === route.threadId) {
        this.adoptedThreadId = "";
      }
      return result;
    }
    this.taskNew()?.prepare({
      defaultCwdPath: options.defaultCwdPath ?? "",
    });
    this.taskNew()?.open();
    this.render();
    return await this.taskNavigator()?.activate({ force: true });
  }

  adoptCreatedDetail(detail) {
    const threadId = taskDetailThreadId(detail);
    if (!threadId || !detail?.task) {
      return;
    }
    this.adoptedThreadId = threadId;
    this.selectedThreadId = threadId;
    this.taskDetail()?.adoptCreatedDetail(detail);
    this.taskNavigator()?.placeCanonicalTaskAtTop(
      detail.task,
      detail.activeTopPlacement,
    );
    this.requestRoute({ kind: "tasks", threadId });
  }

  async recheckRecovery() {
    const threadId = this.selectedThreadId;
    if (!threadId || this.view !== "recovery") {
      return null;
    }
    await this.taskNavigator()?.activate({ force: true });
    const recovery = this.taskNavigator()?.recoveryFor(threadId);
    if (recovery) {
      this.taskRecovery()?.updateRecovery(recovery);
      return recovery;
    }
    const task = this.taskNavigator()?.taskFor(threadId);
    this.requestRoute(
      task ? { kind: "tasks", threadId } : { kind: "tasks" },
      { replace: true },
    );
    return null;
  }

  resolveRecovery(detail) {
    const threadId = detail?.threadId ?? taskDetailThreadId({ task: detail?.task });
    if (detail?.resolution === "restored" && detail.task) {
      this.taskNavigator()?.placeCanonicalTaskAtTop(
        detail.task,
        detail.activeTopPlacement,
      );
      this.requestRoute(
        { kind: "tasks", threadId: detail.task.threadId },
        { replace: true },
      );
    } else if (detail?.resolution === "archived" && detail.task) {
      this.taskNavigator()?.acceptArchivedTask(detail.task);
      this.requestRoute({ kind: "tasks" }, { replace: true });
    } else if (detail?.resolution === "removed") {
      this.taskNavigator()?.removeTask(threadId);
      this.requestRoute({ kind: "tasks" }, { replace: true });
    }
  }

  setCodexStatus(status) {
    this.ensureRendered();
    const wasBlocked = this.codexOperationsBlocked();
    this.codexStatusValue = status ?? null;
    this.setupCopyState = "idle";
    const blocked = this.codexOperationsBlocked();
    this.taskNew()?.setCodexStatus(this.codexStatusValue);
    this.taskNavigator()?.setCodexStatus(this.codexStatusValue);
    if (blocked) {
      this.taskDetail()?.deactivate();
    }
    this.render();
    return wasBlocked && !blocked;
  }

  setCodexRestartState(state) {
    this.ensureRendered();
    this.codexRestartStateValue = state ?? { state: "idle", message: "" };
    this.renderSetupSurface();
  }

  codexOperationsBlocked() {
    return codexBlocksTaskOperations(this.codexStatusValue);
  }

  async copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(CODEX_INSTALL_COMMAND);
      this.setupCopyState = "copied";
    } catch {
      this.setupCopyState = "failed";
    }
    this.renderSetupSurface();
  }

  get taskDetailView() {
    return this.view === "detail" ? this.detailView : "conversation";
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.view === "detail"
      ? this.taskDetail()?.selectedTaskContextPath() ?? ""
      : this.taskNew()?.selectedContextPath() ?? "";
  }

  newTaskContextPath() {
    this.ensureRendered();
    return this.view === "detail"
      ? this.taskDetail()?.newTaskContextPath() ?? ""
      : this.taskNew()?.selectedContextPath() ?? "";
  }

  taskNavigator() {
    return this.connectedTaskNavigator ?? null;
  }

  taskNew() {
    return this.querySelector(":scope > .tasks-surface caffold-task-new");
  }

  taskDetail() {
    return this.querySelector(":scope > .tasks-surface caffold-task-detail");
  }

  taskRecovery() {
    return this.querySelector(":scope > .tasks-surface caffold-task-recovery");
  }

  imagePreviewDialog() {
    return this.querySelector(
      ":scope > caffold-task-image-preview-dialog",
    );
  }

  retryTaskTransports() {
    const navigator = this.taskNavigator();
    const detail = this.taskDetail();
    return retryStaleTaskTransports([
      navigator
        ? {
            state: navigator.streamState,
            retry: () => navigator.retryStream(),
          }
        : null,
      detail
        ? {
            state: detail.streamState,
            retry: () => detail.retryStream(),
          }
        : null,
    ]);
  }

  syncTaskListState(state = {}) {
    const count = Number(state.count ?? 0);
    const nextState = state.loaded
      ? count > 0
        ? "available"
        : "empty"
      : state.error
        ? "error"
        : count > 0
          ? "available"
          : "loading";
    if (this.taskListState === nextState) {
      return;
    }
    this.taskListState = nextState;
    this.render();
  }

  requestRoute(route, options = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: { ...route },
          replace: Boolean(options.replace),
        },
      }),
    );
  }

  requestNewTaskRoute() {
    const cwd = this.newTaskContextPath();
    this.requestRoute({
      kind: "tasks",
      new: true,
      ...(cwd && cwd !== "." ? { cwd } : {}),
    });
  }

  render() {
    this.ensureRendered();
    this.setAttribute("data-tasks-view", this.view);
    this.setAttribute("data-task-list-state", this.taskListState);
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.setAttribute(
      "data-task-detail-presentation",
      this.detailPresentation,
    );
    const showNew = this.view === "new" || this.view === "home";
    const blocked = this.codexOperationsBlocked();
    this.setupSurface()?.toggleAttribute("hidden", !blocked);
    this.taskNew()?.toggleAttribute("hidden", blocked || !showNew);
    this.taskDetail()?.toggleAttribute("hidden", blocked || this.view !== "detail");
    this.taskRecovery()?.toggleAttribute("hidden", blocked || this.view !== "recovery");
    this.renderSetupSurface();
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
    this.dispatchEvent(
      new CustomEvent("caffold:tasks-presentation-change", { bubbles: true }),
    );
  }

  setupSurface() {
    return this.querySelector(
      ":scope > .tasks-surface .codex-readiness-surface",
    );
  }

  renderSetupSurface() {
    const surface = this.setupSurface();
    if (!surface || !this.codexOperationsBlocked()) {
      return;
    }
    const checking = surface.querySelector('[data-readiness-view="checking"]');
    const card = surface.querySelector('[data-readiness-view="card"]');
    const readiness = this.codexStatusValue?.readiness;
    if (!readiness) {
      const error = this.codexStatusValue?.readinessLoadError;
      checking.toggleAttribute("hidden", Boolean(error));
      card.toggleAttribute("hidden", !error);
      if (error) {
        patchReadinessCard(card, {
          state: "checkFailed",
          title: "Codex readiness could not be checked",
          message: "Caffold could not load the backend-owned Codex readiness state.",
          instruction: "",
          diagnostic: error,
          showInstall: false,
          showGuide: false,
          showRestart: false,
          restartState: this.codexRestartStateValue.state,
          restartMessage: this.codexRestartStateValue.message,
          copyLabel: "Copy command",
          versions: {},
        });
      }
      return;
    }

    checking.hidden = true;
    card.hidden = false;
    const content = readinessContent(readiness);
    const showInstall = ["missing", "unsupportedInstall", "updateRequired"].includes(
      readiness.state,
    );
    const showGuide = showInstall || readiness.state === "signInRequired";
    const copyLabel = this.setupCopyState === "copied"
      ? "Copied"
      : this.setupCopyState === "failed" ? "Copy failed" : "Copy command";
    const commandLabel = readiness.state === "missing"
      ? "Required official install command"
      : readiness.state === "updateRequired"
        ? "Required official update command"
        : "Required official install or update command";
    patchReadinessCard(card, {
      state: readiness.state,
      title: content.title,
      message: content.message,
      instruction: content.instruction,
      diagnostic: ["error", "incompatible"].includes(readiness.state)
        ? readiness.diagnosticMessage
        : "",
      showInstall,
      showGuide,
      showRestart: readiness.state === "restartRequired",
      restartState: this.codexRestartStateValue.state,
      restartMessage: this.codexRestartStateValue.message,
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

function patchReadinessCard(card, view) {
  card.dataset.readinessState = view.state;
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
  actions.querySelector('[data-codex-readiness-action="settings"]').textContent =
    "Open Settings";
  actions.querySelector("a").toggleAttribute("hidden", !view.showGuide);
  const restartMessage = card.querySelector(
    ".codex-readiness-restart-message",
  );
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

function taskRoutePresentation(route) {
  const domain = routeDomain(route);
  const target = routeTarget(route);
  if (domain === "git") {
    return route.kind === "compare" || target !== "list" ? "code" : "reading";
  }
  if (domain === "github") {
    return target === "files" || target === "file" ? "code" : "reading";
  }
  return target === "review" || target === "review-file" ? "code" : "reading";
}

if (!customElements.get("caffold-tasks-page")) {
  customElements.define("caffold-tasks-page", CaffoldTasksPage);
}
