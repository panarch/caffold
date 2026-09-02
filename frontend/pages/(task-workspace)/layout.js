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
import { restartClaudeRuntime } from "../../api.js";
import { WorkspaceLiveUpdates } from "./live-updates.js";
import {
  CLAUDE_RUNTIME_RESTART_REQUEST_EVENT,
} from "./settings/claude/page.js";
import {
  CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT,
} from "./settings/claude/components/runtime-restart-dialog.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
  separatorActionHintTarget,
} from "./action-hints.js";
import { KeyboardNavigationController } from "./keyboard-navigation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../scroll-scope.js";
import {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "./keyboard-navigation-context.js";
import "./action-hints/components/dialog.js";
import "./components/navigation.js";
import {
  TASK_ARCHIVED_DELETE_CONFIRMED_EVENT,
} from "./tasks/components/archived-delete-dialog.js";
import "./tasks/components/navigator.js";
import "./tasks/layout.js";
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
    this.keyboardNavigation.connect();
    this.attachGlobalListeners();
    this.liveUpdates.connect();
    this.codexStatusLifecycle.connect();
    void warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.keyboardNavigation?.disconnect();
    this.liveUpdates.disconnect();
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
    this.codexRestartStateValue = { state: "idle", message: "" };
    this.liveUpdates = new WorkspaceLiveUpdates();
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
      <section class="task-workspace-surface" aria-label="Task workspace" tabindex="-1">
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
      <caffold-claude-runtime-restart-dialog></caffold-claude-runtime-restart-dialog>
      <caffold-action-hint-dialog></caffold-action-hint-dialog>
      <caffold-scroll-mode-hud></caffold-scroll-mode-hud>
      <caffold-scroll-surface-selector></caffold-scroll-surface-selector>
    `;
    this.backButton = this.querySelector(".task-workspace-back");
    this.closeButton = this.querySelector(".task-workspace-close");
    this.workspaceSurface = this.querySelector(":scope > .task-workspace-surface");
    this.masterDetail = this.querySelector(".task-workspace-master-detail");
    this.masterPane = this.querySelector(".task-workspace-master-pane");
    this.detailPane = this.querySelector(".task-workspace-detail-pane");
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
    this.claudeRuntimeRestartDialog = this.querySelector(
      ":scope > caffold-claude-runtime-restart-dialog",
    );
    this.actionHintDialog = this.querySelector(
      ":scope > caffold-action-hint-dialog",
    );
    this.scrollModeHud = this.querySelector(
      ":scope > caffold-scroll-mode-hud",
    );
    this.scrollSurfaceSelector = this.querySelector(
      ":scope > caffold-scroll-surface-selector",
    );
    this.keyboardNavigation = new KeyboardNavigationController({
      workspace: this,
      actionHintDialog: this.actionHintDialog,
      scrollSelector: this.scrollSurfaceSelector,
      collectKeyboardNavigationContexts: () =>
        this.keyboardNavigationContexts(),
      afterActionHintActivation: (target) =>
        this.afterActionHintActivation(target),
    });
    this.actionHints = this.keyboardNavigation.actionHints;
    this.tasksPage.ensureRendered();
    this.settingsWorkspace.ensureRendered();
    this.taskNavigator.setLiveUpdates(this.liveUpdates);
    this.tasksPage.setLiveUpdates(this.liveUpdates);
    this.tasksPage.connectTaskNavigator(this.taskNavigator);
    this.settingsWorkspace.connectSettingsNavigator(this.settingsNavigator);
    this.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.tasksPage.setCodexRestartState(this.codexRestartStateValue);
    this.settingsWorkspace.setCodexRestartState(this.codexRestartStateValue);
    this.settingsWorkspace.setClaudeRestartState(this.claudeRestartStateValue);
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
    this.addEventListener(CLAUDE_RUNTIME_RESTART_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      this.claudeRuntimeRestartDialog.open();
    });
    this.claudeRuntimeRestartDialog.addEventListener(
      CLAUDE_RUNTIME_RESTART_CONFIRMED_EVENT,
      (event) => {
        event.stopPropagation();
        void this.restartClaudeRuntimeNow();
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
    this.keyboardNavigation.routeWillChange();
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
    this.currentOpenOptions = { ...options };
    this.prepareRoute(route, options);
    if (this.mode === "settings") {
      return null;
    }
    void this.taskNavigator.activate();
    const result = await this.tasksPage.openRoute(route, options);
    this.updateChrome();
    return result;
  }

  suspendForeground() {
    this.liveUpdates.suspend();
    this.codexStatusLifecycle.suspend();
    this.tasksPage?.suspendForeground();
  }

  async recoverForeground({
    initialActivation = false,
    isCurrent = () => true,
    progress,
  } = {}) {
    this.codexStatusLifecycle.resume();
    progress?.validatingStatus();
    let statusError = null;
    const statusSnapshot = this.codexStatusLifecycle.snapshot();
    if (initialActivation && statusSnapshot.phase === "failed") {
      statusError = new Error(statusSnapshot.error || "Caffold status unavailable.");
    } else if (!(initialActivation && statusSnapshot.phase === "loaded")) {
      try {
        await this.codexStatusLifecycle.refresh();
      } catch (error) {
        statusError = error;
      }
    }
    if (!isCurrent()) {
      return { stale: true, retry: false };
    }
    const tasksRecovery = this.mode === "tasks"
      ? this.tasksPage.recoverForeground({
          initialActivation,
          isCurrent,
          progress,
        })
      : Promise.resolve({ retry: false });
    this.liveUpdates.resume();
    this.liveUpdates.retry();
    const tasks = await tasksRecovery;
    return {
      retry: Boolean(
        statusError ||
        (!initialActivation && this.tasksPage.taskStoreOperationsBlocked()) ||
        tasks?.retry
      ),
      error: statusError ?? tasks?.error ?? null,
    };
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
    this.tasksPage.setCodexStatusSnapshot(nextSnapshot);
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
      this.tasksPage.taskStoreRecoveryVisible(),
    );
  }

  setClaudeRestartState(state) {
    this.claudeRestartStateValue = state ?? null;
    this.settingsWorkspace?.setClaudeRestartState(this.claudeRestartStateValue);
  }

  // Confirmed by the person in the dialog; every state this passes through is
  // shown on the settings page that asked.
  async restartClaudeRuntimeNow() {
    this.setClaudeRestartState({
      state: "restarting",
      message: "Restarting the Claude runner\u2026",
    });
    try {
      await restartClaudeRuntime();
      this.setClaudeRestartState({
        state: "restarted",
        message:
          "Claude runner restarted. Conversations resume as their Tasks are opened.",
      });
    } catch (error) {
      this.setClaudeRestartState({
        state: "failed",
        message: error instanceof Error ? error.message : "The restart failed.",
      });
    }
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

  actionHintScope() {
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const navigationClipRoots = [this, this.masterPane].filter(Boolean);
    const detailClipRoots = [this, this.querySelector(
      ":scope > .task-workspace-surface > .task-workspace-master-detail > .task-workspace-detail-pane",
    )].filter(Boolean);
    const routeControl = [this.backButton, this.closeButton].find(
      (control) =>
        control && !control.hidden && hasActionHintLayoutBox(control),
    ) ?? null;
    const ownScope = routeControl
      ? {
          blocked: false,
          targets: [buttonActionHintTarget({
            id: `workspace:parent:${routeControl === this.backButton ? "tasks" : "close"}`,
            actionId: ACTION_HINT_ACTION.PARENT,
            label: routeControl.getAttribute("aria-label") || "Back",
            control: routeControl,
            clipRoots: [this],
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              !routeControl.hidden &&
              [this.backButton, this.closeButton].includes(routeControl) &&
              !routeControl.disabled,
          })],
          mutationRoots: [routeControl],
          scrollRoots: [],
        }
      : emptyActionHintScope();
    const modeScope = this.mode === "tasks"
      ? this.tasksPage?.actionHintScope()
      : this.mode === "settings"
        ? mergeActionHintScopes(
            hasActionHintLayoutBox(this.settingsNavigator)
              ? this.settingsNavigator.actionHintScope({
                  scopeId: "settings",
                  clipRoots: navigationClipRoots,
                })
              : null,
            hasActionHintLayoutBox(this.settingsWorkspace)
              ? this.settingsWorkspace.actionHintScope({
                  scopeId: "settings",
                  clipRoots: detailClipRoots,
                })
              : null,
          )
        : null;
    const resizerScope = workspaceResizerActionHintScope(this, {
      clipRoots: [this, this.masterDetail].filter(Boolean),
    });
    return mergeActionHintScopes(
      ownScope,
      hasActionHintLayoutBox(this.navigation)
        ? this.navigation.actionHintScope({
            scopeId: "workspace",
            clipRoots: navigationClipRoots,
          })
        : null,
      resizerScope,
      modeScope,
    );
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    const workspaceScope = this.workspaceScrollSurfaceScope();
    const workspaceContext = keyboardNavigationContext({
      id: "workspace",
      kind: "workspace",
      root: this,
      actionHints: {
        dialog: this.actionHintDialog,
        scope: this.actionHintScope(),
      },
      scroll: {
        hud: this.scrollModeHud,
        scope: workspaceScope,
      },
      editing: {
        escapeTarget: (editable) =>
          this.actionHintEditingEscapeTarget(editable),
      },
    });
    const childContexts =
      !this.hidden && this.mode === "tasks"
        ? this.tasksPage.keyboardNavigationContexts()
        : [];
    return mergeKeyboardNavigationContexts(
      [workspaceContext],
      this.codexRuntimeRestartDialog?.keyboardNavigationContexts?.() ?? [],
      this.claudeRuntimeRestartDialog?.keyboardNavigationContexts?.() ?? [],
      this.archivedDeleteDialog?.keyboardNavigationContexts?.() ?? [],
      childContexts,
    );
  }

  workspaceScrollSurfaceScope() {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    if (this.mode === "tasks") {
      return this.tasksPage?.scrollSurfaceScope?.() ??
        emptyScrollSurfaceScope();
    }
    if (this.mode !== "settings") {
      return emptyScrollSurfaceScope();
    }
    return mergeScrollSurfaceScopes(
      hasScrollLayoutBox(this.settingsNavigator)
        ? this.settingsNavigator.scrollSurfaceScope({
            scopeId: "settings",
            clipRoots: [this.masterPane, this.workspaceSurface].filter(Boolean),
          })
        : null,
      hasScrollLayoutBox(this.settingsWorkspace)
        ? this.settingsWorkspace.scrollSurfaceScope({
            scopeId: "settings",
            clipRoots: [this.detailPane, this.workspaceSurface].filter(Boolean),
          })
        : null,
    );
  }

  actionHintEditingEscapeTarget(editable) {
    if (this.tasksPage?.contains(editable)) {
      return this.tasksPage.querySelector(":scope .tasks-detail-pane");
    }
    if (this.settingsWorkspace?.contains(editable)) {
      return this.settingsWorkspace.querySelector(
        ":scope .settings-workspace-detail-pane",
      );
    }
    return this.querySelector(":scope > .task-workspace-surface");
  }

  afterActionHintActivation(target) {
    if (![ACTION_HINT_ACTION.TASK_OPEN, ACTION_HINT_ACTION.TASK_OPEN_RECOVERY]
      .includes(target.actionId)) {
      return;
    }
    const threadId = target.id.startsWith("task:")
      ? target.id.slice("task:".length)
      : "";
    const focusDestination = () => {
      if (
        !this.isConnected ||
        this.mode !== "tasks" ||
        !threadId ||
        this.route?.threadId !== threadId
      ) {
        return;
      }
      if (window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches) {
        if (target.control?.isConnected && !target.control.disabled) {
          target.control.focus({ preventScroll: true });
        }
        return;
      }
      this.tasksPage.focusActionHintDestination();
    };
    const navigationFinished = window.navigation?.transition?.finished;
    if (navigationFinished && typeof navigationFinished.then === "function") {
      void navigationFinished.then(focusDestination, () => {});
      return;
    }
    queueMicrotask(focusDestination);
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

function workspaceResizerActionHintScope(owner, { clipRoots }) {
  const control = owner.masterResizer;
  if (!workspaceResizerAvailable(owner, control)) {
    return null;
  }
  return {
    blocked: false,
    targets: [separatorActionHintTarget({
      id: "workspace:navigation-pane:separator",
      actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
      label: control.getAttribute("aria-label") || "Resize navigation pane",
      control,
      clipRoots,
      isActionable: () =>
        owner.isConnected &&
        !owner.hidden &&
        owner.masterResizer === control &&
        workspaceResizerAvailable(owner, control),
    })],
    mutationRoots: [control],
    scrollRoots: [],
  };
}

function workspaceResizerAvailable(owner, control) {
  return Boolean(
    control &&
      ["tasks", "settings"].includes(owner.mode) &&
      window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches &&
      hasActionHintLayoutBox(control),
  );
}

customElements.define("caffold-task-workspace", CaffoldTaskWorkspace);
