import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import "../../components/pane-resizer.js";
import { routeDomain, routeTab, routeTarget } from "../../navigation-routes.js";
import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_RUNTIME_UPDATE_REQUEST_EVENT,
  CODEX_RESET_CREDIT_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  codexResetCredits,
  codexRuntimeUpdateAvailable,
  createCodexStatusLifecycle,
  resetCreditExpiry,
} from "./codex-status.js";
import {
  CODEX_RESET_CREDIT_CONFIRMED_EVENT,
} from "./codex-status/components/reset-credit-dialog.js";
import {
  CODEX_RUNTIME_RESTART_CONFIRMED_EVENT,
} from "./codex-status/components/runtime-restart-dialog.js";
import {
  CODEX_RUNTIME_UPDATE_CONFIRMED_EVENT,
} from "./codex-status/components/runtime-update-dialog.js";
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
} from "../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
} from "../../scroll-scope.js";
import {
  mergeKeyboardNavigationContexts,
} from "../../keyboard-navigation.js";
import "./components/navigation.js";
import {
  ACTIVE_TASK_LIST_STATE_EVENT,
} from "./tasks/components/active-task-list.js";
import {
  TASK_ARCHIVED_DELETE_CONFIRMED_EVENT,
} from "./tasks/components/archived-delete-dialog.js";
import {
  TASK_SWITCHER_SELECT_EVENT,
} from "./tasks/components/task-switcher-dialog.js";
import "./tasks/components/navigator.js";
import "./tasks/layout.js";
import "./notes/components/navigator.js";
import "./notes/layout.js";
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
    this.liveUpdates.connect();
    this.codexStatusLifecycle.connect();
    void warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.liveUpdates.disconnect();
    this.codexStatusLifecycle.disconnect();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.mode = "tasks";
    this.route = { kind: "tasks" };
    this.currentOpenOptions = {};
    this.codexRestartStateValue = { state: "idle", message: "" };
    this.codexUpdateStateValue = { state: "idle", message: "" };
    this.codexResetCreditStateValue = { state: "idle", message: "", retryPending: false };
    this.codexRuntimeActionValue = "idle";
    this.liveUpdates = new WorkspaceLiveUpdates();
    this.codexStatusLifecycle = createCodexStatusLifecycle({
      onSnapshotChange: (snapshot) => this.setCodexStatusSnapshot(snapshot),
      onRestartStateChange: (state) => this.setCodexRestartState(state),
      onUpdateStateChange: (state) => this.setCodexUpdateState(state),
      onResetCreditStateChange: (state) => this.setCodexResetCreditState(state),
      onRuntimeActionChange: (action) => this.setCodexRuntimeAction(action),
    });
    this.codexStatusSnapshotValue = this.codexStatusLifecycle.snapshot();
    this.innerHTML = `
      <div class="task-workspace-route-controls">
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
          class="task-workspace-route-control task-workspace-switcher"
          aria-label="Switch task"
          title="Switch task"
          hidden
        >
          ${renderInlineIcon("History", "Switch task", "task-workspace-route-control-icon")}
        </button>
      </div>
      <section class="task-workspace-surface" aria-label="Task workspace" tabindex="-1">
        <div class="task-workspace-master-detail">
          <aside class="task-workspace-master-pane" aria-label="Workspace navigation">
            <caffold-task-navigator class="tasks-list-region"></caffold-task-navigator>
            <caffold-notes-navigator hidden></caffold-notes-navigator>
            <caffold-settings-navigator hidden></caffold-settings-navigator>
            <caffold-task-workspace-navigation></caffold-task-workspace-navigation>
          </aside>
          <caffold-pane-resizer
            start-default="${NAVIGATION_PANE_DEFAULT_WIDTH}"
            start-min="${NAVIGATION_PANE_MIN_WIDTH}"
            start-max="${NAVIGATION_PANE_MAX_WIDTH}"
            end-min="${WORKSPACE_DETAIL_MIN_WIDTH}"
            storage-key="caffold:pane-width:task-workspace"
            aria-label="Resize navigation pane"
          ></caffold-pane-resizer>
          <div class="task-workspace-detail-pane">
            <caffold-tasks-page></caffold-tasks-page>
            <caffold-notes-workspace hidden></caffold-notes-workspace>
            <caffold-settings-workspace hidden></caffold-settings-workspace>
          </div>
        </div>
      </section>
      <caffold-task-archived-delete-dialog></caffold-task-archived-delete-dialog>
      <caffold-task-switcher-dialog></caffold-task-switcher-dialog>
      <caffold-codex-runtime-restart-dialog></caffold-codex-runtime-restart-dialog>
      <caffold-codex-runtime-update-dialog></caffold-codex-runtime-update-dialog>
      <caffold-codex-reset-credit-dialog></caffold-codex-reset-credit-dialog>
      <caffold-claude-runtime-restart-dialog></caffold-claude-runtime-restart-dialog>
    `;
    this.backButton = this.querySelector(".task-workspace-back");
    this.taskSwitcherButton = this.querySelector(".task-workspace-switcher");
    this.workspaceSurface = this.querySelector(":scope > .task-workspace-surface");
    this.masterDetail = this.querySelector(".task-workspace-master-detail");
    this.masterPane = this.querySelector(".task-workspace-master-pane");
    this.detailPane = this.querySelector(".task-workspace-detail-pane");
    this.taskNavigator = this.querySelector("caffold-task-navigator");
    this.notesNavigator = this.querySelector("caffold-notes-navigator");
    this.settingsNavigator = this.querySelector("caffold-settings-navigator");
    this.masterResizer = this.querySelector(
      ":scope > .task-workspace-surface > .task-workspace-master-detail > caffold-pane-resizer",
    );
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.notesWorkspace = this.querySelector("caffold-notes-workspace");
    this.settingsWorkspace = this.querySelector("caffold-settings-workspace");
    this.navigation = this.querySelector("caffold-task-workspace-navigation");
    this.archivedDeleteDialog = this.querySelector(
      ":scope > caffold-task-archived-delete-dialog",
    );
    this.taskSwitcherDialog = this.querySelector(
      ":scope > caffold-task-switcher-dialog",
    );
    this.codexRuntimeRestartDialog = this.querySelector(
      ":scope > caffold-codex-runtime-restart-dialog",
    );
    this.codexRuntimeUpdateDialog = this.querySelector(
      ":scope > caffold-codex-runtime-update-dialog",
    );
    this.codexResetCreditDialog = this.querySelector(
      ":scope > caffold-codex-reset-credit-dialog",
    );
    this.claudeRuntimeRestartDialog = this.querySelector(
      ":scope > caffold-claude-runtime-restart-dialog",
    );
    this.tasksPage.ensureRendered();
    this.notesWorkspace.ensureRendered();
    this.settingsWorkspace.ensureRendered();
    this.taskNavigator.setLiveUpdates(this.liveUpdates);
    this.tasksPage.setLiveUpdates(this.liveUpdates);
    this.tasksPage.connectTaskNavigator(this.taskNavigator);
    this.notesWorkspace.connectNotesNavigator(this.notesNavigator);
    this.settingsWorkspace.connectSettingsNavigator(this.settingsNavigator);
    this.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.tasksPage.setCodexRestartState(this.codexRestartStateValue);
    this.tasksPage.setCodexRuntimeAction(this.codexRuntimeActionValue);
    this.settingsWorkspace.setCodexRestartState(this.codexRestartStateValue);
    this.settingsWorkspace.setCodexUpdateState(this.codexUpdateStateValue);
    this.settingsWorkspace.setCodexResetCreditState(this.codexResetCreditStateValue);
    this.settingsWorkspace.setCodexRuntimeAction(this.codexRuntimeActionValue);
    this.settingsWorkspace.setClaudeRestartState(this.claudeRestartStateValue);
    this.renderIcons();

    this.backButton.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:request-tasks-route", {
          bubbles: true,
          detail: { route: { kind: "tasks" } },
        }),
      );
    });
    this.taskSwitcherButton.addEventListener("click", () => {
      this.openTaskSwitcher();
    });
    this.taskNavigator.addEventListener(
      "caffold:task-navigator-intent",
      (event) => {
        if (event.detail?.type === "delete-archived-task") {
          this.archivedDeleteDialog.openTask(event.detail.task);
        } else if (event.detail?.type === "open-task-switcher") {
          this.openTaskSwitcher();
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
    this.taskNavigator.addEventListener(ACTIVE_TASK_LIST_STATE_EVENT, () => {
      this.taskSwitcherDialog.updateTasks(
        this.taskNavigator.activeTaskSnapshot(),
      );
    });
    this.taskSwitcherDialog.addEventListener(
      TASK_SWITCHER_SELECT_EVENT,
      (event) => {
        event.stopPropagation();
        this.openSwitchedTask(event.detail);
      },
    );

    this.navigation.addEventListener(
      "caffold:workspace-navigation-intent",
      (event) => {
        event.stopPropagation();
        const tab = event.detail?.mode;
        // Choosing the tab already shown keeps its route, an open Task
        // included, and only brings its list back to the top.
        if (tab === this.mode) {
          this.navigatorForTab(tab).scrollToTop();
          return;
        }
        this.dispatchEvent(
          new CustomEvent("caffold:request-workspace-tab", {
            bubbles: true,
            detail: { tab, fallbackRoute: this.firstRouteForTab(tab) },
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
    this.addEventListener(CODEX_RUNTIME_UPDATE_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      if (this.codexStatusLifecycle.canUpdateRuntime()) {
        this.codexRuntimeUpdateDialog.open();
      }
    });
    this.codexRuntimeUpdateDialog.addEventListener(
      CODEX_RUNTIME_UPDATE_CONFIRMED_EVENT,
      (event) => {
        event.stopPropagation();
        void this.codexStatusLifecycle.requestRuntimeUpdate();
      },
    );
    this.addEventListener(CODEX_RESET_CREDIT_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      const creditId = event.detail?.creditId ?? null;
      if (!this.codexStatusLifecycle.canConsumeResetCredit(creditId)) return;
      const credit = codexResetCredits(this.codexStatusLifecycle.statusSnapshot())
        ?.credits?.find((row) => row.id === creditId);
      this.codexResetCreditDialog.open({
        creditId,
        title: credit?.title,
        expiry: resetCreditExpiry(credit?.expiresAt)?.label,
        retry: event.detail?.retry === true,
      });
    });
    this.codexResetCreditDialog.addEventListener(
      CODEX_RESET_CREDIT_CONFIRMED_EVENT,
      (event) => {
        event.stopPropagation();
        void this.codexStatusLifecycle.requestResetCredit(event.detail?.creditId ?? null);
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
    this.masterResizer.addEventListener("caffold:pane-resize", (event) => {
      this.handleNavigationPaneResize(event);
    });
    this.addEventListener("caffold:tasks-presentation-change", (event) => {
      if (event.target !== this.tasksPage) {
        return;
      }
      event.stopPropagation();
      this.syncPresentationState();
    });
    this.addEventListener("caffold:notes-presentation-change", (event) => {
      if (event.target !== this.notesWorkspace) {
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

  renderIcons() {
    if (this.backButton) {
      this.backButton.innerHTML = renderInlineIcon(
        "ArrowLeft",
        "Back to tasks",
        "task-workspace-route-control-icon",
      );
    }
    if (this.taskSwitcherButton) {
      this.taskSwitcherButton.innerHTML = renderInlineIcon(
        "History",
        "Switch task",
        "task-workspace-route-control-icon",
      );
    }
  }

  // Where a tab opens the first time it is used, before it has a route to
  // return to. Blocked Codex operations send Settings to their repair page.
  firstRouteForTab(tab) {
    if (tab === "notes") {
      return { kind: "notes", noteId: "" };
    }
    if (tab === "settings") {
      return {
        kind: "settings",
        section: this.tasksPage.codexOperationsBlocked() ? "codex" : "",
      };
    }

    return { kind: "tasks" };
  }

  navigatorForTab(tab) {
    if (tab === "notes") {
      return this.notesNavigator;
    }
    if (tab === "settings") {
      return this.settingsNavigator;
    }

    return this.taskNavigator;
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    const previousMode = this.mode;
    this.route = route;
    this.mode = routeTab(route);
    if (previousMode === "tasks" && this.mode !== "tasks") {
      this.tasksPage.deactivate();
    }
    if (previousMode === "notes" && this.mode !== "notes") {
      this.notesWorkspace.deactivate();
    }
    if (this.mode === "tasks") {
      this.tasksPage.prepareRoute(route, options);
    } else if (this.mode === "notes") {
      this.notesWorkspace.prepareRoute(route);
    } else {
      this.settingsWorkspace.prepareRoute(route);
    }
    this.taskNavigator.hidden = this.mode !== "tasks";
    this.notesNavigator.hidden = this.mode !== "notes";
    this.settingsNavigator.hidden = this.mode !== "settings";
    this.tasksPage.hidden = this.mode !== "tasks";
    this.notesWorkspace.hidden = this.mode !== "notes";
    this.settingsWorkspace.hidden = this.mode !== "settings";
    this.updateChrome();
  }

  async openRoute(route, options = {}) {
    this.currentOpenOptions = { ...options };
    this.prepareRoute(route, options);
    if (this.mode === "settings") {
      return null;
    }
    if (this.mode === "notes") {
      this.notesWorkspace.activate();
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
    if (this.mode === "notes" && !initialActivation) {
      this.notesWorkspace.reload();
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
    if (nextStatus?.readiness && !codexRuntimeUpdateAvailable(nextStatus)) {
      this.codexRuntimeUpdateDialog.close();
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

  setCodexUpdateState(state) {
    this.ensureRendered();
    this.codexUpdateStateValue = state ?? { state: "idle", message: "" };
    this.settingsWorkspace.setCodexUpdateState(this.codexUpdateStateValue);
  }

  setCodexResetCreditState(state) {
    this.ensureRendered();
    this.codexResetCreditStateValue = state;
    this.settingsWorkspace.setCodexResetCreditState(state);
  }

  setCodexRuntimeAction(action) {
    this.ensureRendered();
    this.codexRuntimeActionValue = action ?? "idle";
    this.tasksPage.setCodexRuntimeAction(this.codexRuntimeActionValue);
    this.settingsWorkspace.setCodexRuntimeAction(this.codexRuntimeActionValue);
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
    const modeScope = this.mode === "tasks"
      ? this.tasksPage?.actionHintScope()
      : this.mode === "notes"
        ? mergeActionHintScopes(
            hasActionHintLayoutBox(this.notesNavigator)
              ? this.notesNavigator.actionHintScope({
                  scopeId: "notes",
                  clipRoots: navigationClipRoots,
                })
              : null,
            hasActionHintLayoutBox(this.notesWorkspace)
              ? this.notesWorkspace.actionHintScope({
                  scopeId: "notes",
                  clipRoots: detailClipRoots,
                })
              : null,
          )
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
    const resizer = this.masterResizer;
    const resizerScope = hasActionHintLayoutBox(resizer)
      ? resizer.actionHintScope?.({
          scopeId: "workspace:navigation-pane",
          actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
          clipRoots: [this, this.masterDetail].filter(Boolean),
          isCurrent: () =>
            this.isConnected &&
            !this.hidden &&
            this.masterResizer === resizer,
        })
      : null;
    return mergeActionHintScopes(
      routeControlActionHintScope(this, this.backButton, {
        id: "workspace:parent:tasks",
        actionId: ACTION_HINT_ACTION.PARENT,
        fallbackLabel: "Back",
        retained: () => this.backButton,
      }),
      routeControlActionHintScope(this, this.taskSwitcherButton, {
        id: "workspace:task-switcher:open",
        actionId: ACTION_HINT_ACTION.TASK_SWITCHER_OPEN,
        fallbackLabel: "Switch task",
        retained: () => this.taskSwitcherButton,
      }),
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
    const childContexts = this.hidden
      ? []
      : this.mode === "tasks"
        ? this.tasksPage.keyboardNavigationContexts()
        : this.mode === "notes"
          ? this.notesWorkspace.keyboardNavigationContexts()
          : [];
    return mergeKeyboardNavigationContexts(
      this.codexRuntimeRestartDialog?.keyboardNavigationContexts?.() ?? [],
      this.codexRuntimeUpdateDialog?.keyboardNavigationContexts?.() ?? [],
      this.codexResetCreditDialog?.keyboardNavigationContexts?.() ?? [],
      this.claudeRuntimeRestartDialog?.keyboardNavigationContexts?.() ?? [],
      this.archivedDeleteDialog?.keyboardNavigationContexts?.() ?? [],
      this.taskSwitcherDialog?.keyboardNavigationContexts?.() ?? [],
      childContexts,
    );
  }

  scrollSurfaceScope() {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    if (this.mode === "tasks") {
      return this.tasksPage?.scrollSurfaceScope?.() ??
        emptyScrollSurfaceScope();
    }
    if (this.mode === "notes") {
      return mergeScrollSurfaceScopes(
        hasScrollLayoutBox(this.notesNavigator)
          ? this.notesNavigator.scrollSurfaceScope({
              scopeId: "notes",
              clipRoots: [this.masterPane, this.workspaceSurface].filter(Boolean),
            })
          : null,
        hasScrollLayoutBox(this.notesWorkspace)
          ? this.notesWorkspace.scrollSurfaceScope({
              scopeId: "notes",
              clipRoots: [this.detailPane, this.workspaceSurface].filter(Boolean),
            })
          : null,
      );
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

  /**
   * Offer the Task switcher where the Task list it shows is actually held.
   *
   * Notes and Settings never load that list, so a switcher opened there could
   * only report an emptiness it has not checked.
   */
  openTaskSwitcher() {
    this.ensureRendered();
    if (this.hidden || this.mode !== "tasks") {
      return false;
    }
    return this.taskSwitcherDialog.open(
      this.taskNavigator.activeTaskSnapshot(),
    );
  }

  openSwitchedTask({ threadId = "", recovery = false } = {}) {
    if (!threadId) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: {
            kind: "tasks",
            threadId,
            ...(recovery ? { recovery: true } : {}),
          },
        },
      }),
    );
    this.focusOpenedTask(threadId);
  }

  afterActionHintActivation(target) {
    if (![ACTION_HINT_ACTION.TASK_OPEN, ACTION_HINT_ACTION.TASK_OPEN_RECOVERY]
      .includes(target.actionId)) {
      return;
    }
    const threadId = target.id.startsWith("task:")
      ? target.id.slice("task:".length)
      : "";
    this.focusOpenedTask(threadId, target.control);
  }

  /**
   * Put focus where the newly opened Task is once navigation settles.
   *
   * A control the person can still see keeps the focus it just had. Anything
   * else — a compact layout that replaced the list, or a row in a dialog that
   * has since closed — hands focus to the Task itself.
   */
  focusOpenedTask(threadId, control = null) {
    const focusDestination = () => {
      if (
        !this.isConnected ||
        this.mode !== "tasks" ||
        !threadId ||
        this.route?.threadId !== threadId
      ) {
        return;
      }
      if (
        control &&
        window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches
      ) {
        if (control.isConnected && !control.disabled) {
          control.focus({ preventScroll: true });
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
    if (!this.backButton) {
      return;
    }
    const taskRoute = this.mode === "tasks" ? this.route : null;
    const target = taskRoute ? routeTarget(taskRoute) : null;
    const domain = routeDomain(taskRoute);
    const showBack = target === "new" || Boolean(
      (taskRoute?.threadId || taskRoute?.sectionId) &&
      (domain ? target === "list" : target !== "review-file"),
    );

    this.backButton.hidden = !showBack;
    // Back is what stands in for the Task list, whose own header carries the
    // switcher whenever the list is on screen.
    this.taskSwitcherButton.hidden = !showBack;
    this.toggleAttribute("data-workspace-route-control-visible", showBack);
    this.dataset.workspaceMode = this.mode ?? "tasks";
    this.syncPresentationState();

    this.renderIcons();
    this.navigation.setMode(this.mode);
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
    this.dataset.notesView =
      this.notesWorkspace?.dataset.notesView ?? "list";
    this.dataset.settingsView =
      this.settingsWorkspace.dataset.settingsView ?? "list";
  }

  handleNavigationPaneResize(event) {
    event.stopPropagation();
    if (event.detail.phase === "start") {
      this.classList.add("is-resizing-navigation-pane");
      return;
    }
    if (event.detail.phase === "end") {
      this.classList.remove("is-resizing-navigation-pane");
      return;
    }
    if (event.detail.phase === "update") {
      this.applyNavigationPaneWidth();
    }
  }

  applyNavigationPaneWidth() {
    this.style.setProperty(
      "--task-workspace-master-width",
      `${this.masterResizer.value}px`,
    );
  }
}

function routeControlActionHintScope(
  workspace,
  control,
  { id, actionId, fallbackLabel, retained },
) {
  if (!control || control.hidden || !hasActionHintLayoutBox(control)) {
    return null;
  }
  return {
    blocked: false,
    targets: [buttonActionHintTarget({
      invalidationOwner: workspace,
      id,
      actionId,
      label: control.getAttribute("aria-label") || fallbackLabel,
      control,
      clipRoots: [workspace],
      isActionable: () =>
        workspace.isConnected &&
        !workspace.hidden &&
        !control.hidden &&
        retained() === control &&
        !control.disabled,
    })],
    mutationRoots: [control],
    scrollRoots: [],
  };
}

customElements.define("caffold-task-workspace", CaffoldTaskWorkspace);
