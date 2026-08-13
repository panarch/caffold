import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import { routeDomain, routeTarget } from "../../navigation-routes.js";
import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  createCodexStatusLifecycle,
} from "./codex-status.js";
import {
  CODEX_RUNTIME_RESTART_CONFIRMED_EVENT,
} from "./codex-status/components/runtime-restart-dialog.js";
import "./components/navigation.js";
import {
  TASK_ARCHIVED_DELETE_CONFIRMED_EVENT,
} from "./tasks/components/archived-delete-dialog.js";
import "./tasks/components/navigator.js";
import "./tasks/page.js";
import "./settings/navigator.js";
import "./settings/layout.js";

const NAVIGATION_PANE_DEFAULT_WIDTH = 380;
const NAVIGATION_PANE_MIN_WIDTH = 280;
const NAVIGATION_PANE_MAX_WIDTH = 520;
const WORKSPACE_DETAIL_MIN_WIDTH = 520;
const WORKSPACE_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";

class CaffoldTaskWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderIcons();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
    this.attachGlobalListeners();
    this.codexStatusLifecycle.connect();
    void warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.codexStatusLifecycle.disconnect();
    this.stopNavigationPaneResize();
    this.detachGlobalListeners();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.mode = "tasks";
    this.route = { kind: "tasks" };
    this.lastTaskRoute = { kind: "tasks" };
    this.navigationPaneWidth = NAVIGATION_PANE_DEFAULT_WIDTH;
    this.globalListenersAttached = false;
    this.currentOpenOptions = {};
    this.routeActivationRequested = false;
    this.pendingCodexTaskRoute = null;
    this.codexRestartStateValue = { state: "idle", message: "" };
    this.codexStatusLifecycle = createCodexStatusLifecycle({
      onSnapshotChange: (snapshot) => this.setCodexStatusSnapshot(snapshot),
      onRestartStateChange: (state) => this.setCodexRestartState(state),
    });
    this.codexStatusSnapshotValue = this.codexStatusLifecycle.snapshot();
    this.boundResize = () => this.syncNavigationPaneWidth();
    this.boundPointerMove = (event) => this.resizeNavigationPane(event);
    this.boundPointerUp = () => this.stopNavigationPaneResize();
    this.innerHTML = `
      <button
        type="button"
        class="task-workspace-route-control task-workspace-back"
        aria-label="Back to tasks"
        title="Back to tasks"
        hidden
      >
        ${renderInlineIcon("ArrowLeft", "Back to tasks", "task-workspace-route-control-icon")}
      </button>
      <button
        type="button"
        class="task-workspace-route-control task-workspace-close"
        aria-label="Close new task"
        title="Close new task"
        hidden
      >
        ${renderInlineIcon("X", "Close new task", "task-workspace-route-control-icon")}
      </button>
      <section class="task-workspace-surface">
        <div class="task-workspace-master-detail">
          <aside class="task-workspace-master-pane" aria-label="Workspace navigation">
            <caffold-task-navigator class="tasks-list-region"></caffold-task-navigator>
            <caffold-settings-navigator hidden></caffold-settings-navigator>
            <caffold-task-workspace-navigation></caffold-task-workspace-navigation>
          </aside>
          <div
            class="task-workspace-master-resizer"
            role="separator"
            tabindex="0"
            aria-label="Resize navigation pane"
            aria-orientation="vertical"
            aria-valuemin="${NAVIGATION_PANE_MIN_WIDTH}"
            aria-valuemax="${NAVIGATION_PANE_MAX_WIDTH}"
            aria-valuenow="${this.navigationPaneWidth}"
          ></div>
          <div class="task-workspace-detail-pane">
            <caffold-tasks-page></caffold-tasks-page>
            <caffold-settings-workspace hidden></caffold-settings-workspace>
          </div>
        </div>
      </section>
      <caffold-task-archived-delete-dialog></caffold-task-archived-delete-dialog>
      <caffold-codex-runtime-restart-dialog></caffold-codex-runtime-restart-dialog>
    `;
    this.backButton = this.querySelector(".task-workspace-back");
    this.closeButton = this.querySelector(".task-workspace-close");
    this.masterDetail = this.querySelector(".task-workspace-master-detail");
    this.masterPane = this.querySelector(".task-workspace-master-pane");
    this.taskNavigator = this.querySelector("caffold-task-navigator");
    this.settingsNavigator = this.querySelector("caffold-settings-navigator");
    this.masterResizer = this.querySelector(".task-workspace-master-resizer");
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.settingsWorkspace = this.querySelector("caffold-settings-workspace");
    this.navigation = this.querySelector("caffold-task-workspace-navigation");
    this.archivedDeleteDialog = this.querySelector(
      ":scope > caffold-task-archived-delete-dialog",
    );
    this.codexRuntimeRestartDialog = this.querySelector(
      ":scope > caffold-codex-runtime-restart-dialog",
    );
    this.tasksPage.ensureRendered();
    this.settingsWorkspace.ensureRendered();
    this.tasksPage.connectTaskNavigator(this.taskNavigator);
    this.settingsWorkspace.connectSettingsNavigator(this.settingsNavigator);
    this.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.tasksPage.setCodexRestartState(this.codexRestartStateValue);
    this.settingsWorkspace.setCodexRestartState(this.codexRestartStateValue);
    this.renderIcons();

    this.backButton.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:request-tasks-route", {
          bubbles: true,
          detail: {
            route: { kind: "tasks" },
            replace: true,
          },
        }),
      );
    });
    this.taskNavigator.addEventListener(
      "caffold:task-navigator-intent",
      (event) => {
        if (event.detail?.type === "delete-archived-task") {
          this.archivedDeleteDialog.openTask(event.detail.task);
        }
      },
    );
    this.archivedDeleteDialog.addEventListener(
      TASK_ARCHIVED_DELETE_CONFIRMED_EVENT,
      (event) => {
        event.stopPropagation();
        void this.taskNavigator?.deleteThread(event.detail?.threadId);
      },
    );

    this.closeButton.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:close-task-workspace", { bubbles: true }),
      );
    });
    this.navigation.addEventListener(
      "caffold:workspace-navigation-intent",
      (event) => {
        event.stopPropagation();
        const route = event.detail?.mode === "tasks"
          ? this.lastTaskRoute
          : {
              kind: "settings",
              section: this.tasksPage.codexOperationsBlocked() ? "codex" : "",
            };
        this.dispatchEvent(
          new CustomEvent("caffold:request-workspace-route", {
            bubbles: true,
            detail: { route: { ...route } },
          }),
        );
      },
    );
    this.addEventListener(CODEX_STATUS_REFRESH_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      const retry = this.codexStatusLifecycle.statusSnapshot()
        ?.taskStoreReadiness?.blocksTaskOperations
        ? this.codexStatusLifecycle.retryTaskStoreMigration()
        : this.codexStatusLifecycle.refresh();
      void retry.catch(() => {});
    });
    this.addEventListener(CODEX_RUNTIME_RESTART_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      if (this.codexStatusLifecycle.canRestartRuntime()) {
        this.codexRuntimeRestartDialog.open();
      }
    });
    this.codexRuntimeRestartDialog.addEventListener(
      CODEX_RUNTIME_RESTART_CONFIRMED_EVENT,
      (event) => {
        event.stopPropagation();
        void this.codexStatusLifecycle.requestRuntimeRestart();
      },
    );
    this.masterResizer.addEventListener("pointerdown", (event) => {
      this.startNavigationPaneResize(event, this.masterResizer);
    });
    this.masterResizer.addEventListener("keydown", (event) => {
      if (this.handleNavigationPaneResizeKeydown(event)) {
        event.stopPropagation();
      }
    });
    this.addEventListener("caffold:tasks-presentation-change", (event) => {
      if (event.target !== this.tasksPage) {
        return;
      }
      event.stopPropagation();
      this.syncPresentationState();
    });
    this.addEventListener("caffold:settings-presentation-change", (event) => {
      if (event.target !== this.settingsWorkspace) {
        return;
      }
      event.stopPropagation();
      this.syncPresentationState();
    });
    this.applyNavigationPaneWidth();
    this.updateChrome();
  }

  attachGlobalListeners() {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    window.addEventListener("resize", this.boundResize);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("resize", this.boundResize);
  }

  renderIcons() {
    if (this.backButton) {
      this.backButton.innerHTML = renderInlineIcon(
        "ArrowLeft",
        "Back to tasks",
        "task-workspace-route-control-icon",
      );
    }
    if (this.closeButton) {
      this.closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close new task",
        "task-workspace-route-control-icon",
      );
    }
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    const previousMode = this.mode;
    this.route = route;
    this.mode = route?.kind === "settings" ? "settings" : "tasks";
    if (previousMode === "tasks" && this.mode !== "tasks") {
      this.tasksPage.deactivate();
    }
    if (this.mode === "tasks") {
      this.lastTaskRoute = { ...route };
      this.tasksPage.prepareRoute(route, options);
    } else {
      this.settingsWorkspace.prepareRoute(route);
    }
    this.taskNavigator.hidden = this.mode !== "tasks";
    this.settingsNavigator.hidden = this.mode !== "settings";
    this.tasksPage.hidden = this.mode !== "tasks";
    this.settingsWorkspace.hidden = this.mode !== "settings";
    this.updateChrome();
  }

  async openRoute(route, options = {}) {
    this.routeActivationRequested = true;
    this.currentOpenOptions = { ...options };
    this.prepareRoute(route, options);
    if (this.mode === "settings") {
      this.pendingCodexTaskRoute = null;
      return null;
    }
    void this.taskNavigator.activate();
    if (this.tasksPage.codexOperationsBlocked()) {
      this.pendingCodexTaskRoute = {
        route: { ...route },
        options: { ...options },
      };
      return null;
    }
    this.pendingCodexTaskRoute = null;
    const result = await this.tasksPage.openRoute(route, options);
    this.updateChrome();
    return result;
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.tasksPage.selectedTaskContextPath();
  }

  adoptCreatedDetail(detail) {
    this.ensureRendered();
    this.tasksPage.adoptCreatedDetail(detail);
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureRendered();
    const nextSnapshot = snapshot ?? this.codexStatusLifecycle.snapshot();
    const nextStatus = nextSnapshot.status;
    this.codexStatusSnapshotValue = nextSnapshot;
    const becameAvailable = this.tasksPage.setCodexStatusSnapshot(nextSnapshot);
    this.settingsWorkspace.setCodexStatusSnapshot(nextSnapshot);
    this.navigation.setCodexStatusSnapshot(nextSnapshot);
    if (
      nextStatus?.readiness &&
      nextStatus.readiness.state !== "restartRequired"
    ) {
      this.codexRuntimeRestartDialog.close();
    }
    this.toggleAttribute(
      "data-codex-recovery-visible",
      this.tasksPage.codexRecoveryVisible(),
    );
    if (
      this.routeActivationRequested &&
      this.tasksPage.codexOperationsBlocked() &&
      this.mode === "tasks"
    ) {
      this.pendingCodexTaskRoute = {
        route: { ...this.route },
        options: { ...this.currentOpenOptions },
      };
    }
    if (becameAvailable && this.pendingCodexTaskRoute) {
      const pending = this.pendingCodexTaskRoute;
      this.pendingCodexTaskRoute = null;
      void this.tasksPage.openRoute(pending.route, pending.options);
    }
    return becameAvailable;
  }

  setCodexRestartState(state) {
    this.ensureRendered();
    this.codexRestartStateValue = state ?? { state: "idle", message: "" };
    this.tasksPage.setCodexRestartState(this.codexRestartStateValue);
    this.settingsWorkspace.setCodexRestartState(this.codexRestartStateValue);
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.settingsWorkspace.setBuildStatus(health);
  }

  setUpdateStatus(status) {
    this.ensureRendered();
    this.settingsWorkspace.setUpdateStatus(status);
  }

  updateChrome() {
    if (!this.backButton || !this.closeButton) {
      return;
    }
    const taskRoute = this.mode === "tasks" ? this.route : null;
    const target = taskRoute ? routeTarget(taskRoute) : null;
    const domain = routeDomain(taskRoute);
    const showBack = Boolean(
      taskRoute?.threadId &&
      (domain ? target === "list" : target !== "review-file"),
    );
    const showClose = target === "new";

    this.backButton.hidden = !showBack;
    this.closeButton.hidden = !showClose;
    this.toggleAttribute(
      "data-workspace-route-control-visible",
      showBack || showClose,
    );
    this.toggleAttribute("data-workspace-back-visible", showBack);
    this.toggleAttribute("data-workspace-close-visible", showClose);
    this.dataset.workspaceMode = this.mode ?? "tasks";
    this.syncPresentationState();

    this.renderIcons();
    this.navigation.setMode(this.mode);
    this.syncNavigationPaneWidth();
  }

  syncPresentationState() {
    if (!this.tasksPage || !this.settingsWorkspace) {
      return;
    }
    this.dataset.tasksView = this.tasksPage.dataset.tasksView ?? "home";
    this.dataset.taskListState =
      this.tasksPage.dataset.taskListState ?? "loading";
    this.dataset.taskDetailView =
      this.tasksPage.dataset.taskDetailView ?? "conversation";
    this.dataset.taskDetailPresentation =
      this.tasksPage.dataset.taskDetailPresentation ?? "reading";
    this.dataset.settingsView =
      this.settingsWorkspace.dataset.settingsView ?? "list";
  }

  startNavigationPaneResize(event, separator) {
    if (
      event.button !== 0 ||
      !["tasks", "settings"].includes(this.mode) ||
      !window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches
    ) {
      return;
    }
    event.preventDefault();
    this.navigationPaneResizeStart = {
      pointerX: event.clientX,
      width: this.navigationPaneWidth,
    };
    this.classList.add("is-resizing-navigation-pane");
    separator.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", this.boundPointerMove);
    window.addEventListener("pointerup", this.boundPointerUp, { once: true });
    window.addEventListener("pointercancel", this.boundPointerUp, { once: true });
  }

  resizeNavigationPane(event) {
    if (!this.navigationPaneResizeStart) {
      return;
    }
    this.setNavigationPaneWidth(
      this.navigationPaneResizeStart.width +
        event.clientX -
        this.navigationPaneResizeStart.pointerX,
    );
  }

  stopNavigationPaneResize() {
    this.navigationPaneResizeStart = null;
    this.classList.remove("is-resizing-navigation-pane");
    window.removeEventListener("pointermove", this.boundPointerMove);
    window.removeEventListener("pointerup", this.boundPointerUp);
    window.removeEventListener("pointercancel", this.boundPointerUp);
  }

  handleNavigationPaneResizeKeydown(event) {
    if (
      event.currentTarget !== this.masterResizer ||
      !["tasks", "settings"].includes(this.mode) ||
      !window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches
    ) {
      return false;
    }
    let nextWidth = this.navigationPaneWidth;
    if (event.key === "ArrowLeft") {
      nextWidth -= event.shiftKey ? 40 : 16;
    } else if (event.key === "ArrowRight") {
      nextWidth += event.shiftKey ? 40 : 16;
    } else if (event.key === "Home") {
      nextWidth = NAVIGATION_PANE_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.navigationPaneMaximumWidth();
    } else {
      return false;
    }
    event.preventDefault();
    this.setNavigationPaneWidth(nextWidth);
    return true;
  }

  navigationPaneMaximumWidth() {
    const available =
      (this.masterDetail?.clientWidth ?? 0) - WORKSPACE_DETAIL_MIN_WIDTH;
    return Math.max(
      NAVIGATION_PANE_MIN_WIDTH,
      Math.min(NAVIGATION_PANE_MAX_WIDTH, available),
    );
  }

  setNavigationPaneWidth(width) {
    this.navigationPaneWidth = Math.max(
      NAVIGATION_PANE_MIN_WIDTH,
      Math.min(this.navigationPaneMaximumWidth(), width),
    );
    this.applyNavigationPaneWidth();
  }

  syncNavigationPaneWidth() {
    const shellWidth = this.masterDetail?.clientWidth ?? 0;
    if (
      !window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches ||
      shellWidth <= 0
    ) {
      this.applyNavigationPaneWidth();
      return;
    }
    this.setNavigationPaneWidth(this.navigationPaneWidth);
  }

  applyNavigationPaneWidth() {
    this.style.setProperty(
      "--task-workspace-master-width",
      `${this.navigationPaneWidth}px`,
    );
    if (!this.masterResizer) {
      return;
    }
    this.masterResizer.setAttribute(
      "aria-valuemax",
      `${this.navigationPaneMaximumWidth()}`,
    );
    this.masterResizer.setAttribute(
      "aria-valuenow",
      `${Math.round(this.navigationPaneWidth)}`,
    );
  }
}

customElements.define("caffold-task-workspace", CaffoldTaskWorkspace);
