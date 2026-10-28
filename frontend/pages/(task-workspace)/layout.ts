import { html, LitElement, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
  withActionHintOcclusionRoots,
} from "#app/action-hints.js";
import { type Health, restartClaudeRuntime } from "#app/api.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import { routeDomain, routeTab, routeTarget } from "#app/navigation-routes.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import { containsAcrossShadowRoots } from "#app/shadow-roots.js";
import { DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/pane-resizer.js";
import type { CaffoldPaneResizer } from "#components/pane-resizer.js";
import {
  CODEX_RESET_CREDIT_REQUEST_EVENT,
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_RUNTIME_UPDATE_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  type CodexResetCreditRequestState,
  type CodexRuntimeRequestState,
  type CodexStatusSnapshot,
  codexResetCredits,
  codexRuntimeUpdateAvailable,
  createCodexStatusLifecycle,
  resetCreditExpiry,
} from "./codex-status.js";
import "./codex-status/components/reset-credit-dialog.js";
import type { CaffoldCodexResetCreditDialog } from "./codex-status/components/reset-credit-dialog.js";
import "./codex-status/components/runtime-restart-dialog.js";
import type { CaffoldCodexRuntimeRestartDialog } from "./codex-status/components/runtime-restart-dialog.js";
import "./codex-status/components/runtime-update-dialog.js";
import type { CaffoldCodexRuntimeUpdateDialog } from "./codex-status/components/runtime-update-dialog.js";
import "./components/navigation.js";
import type { CaffoldTaskWorkspaceNavigation } from "./components/navigation.js";
import "./components/update-task-dialog.js";
import type { CaffoldUpdateTaskDialog } from "./components/update-task-dialog.js";
import {
  LIVE_CONNECTION_REPORT_EVENT,
  WorkspaceLiveUpdates,
} from "./live-updates.js";
import "./notes/components/navigator.js";
import type { CaffoldNotesNavigator } from "./notes/components/navigator.js";
import "./notes/layout.js";
import type { CaffoldNotesWorkspace } from "./notes/layout.js";
import {
  CAFFOLD_UPDATE_TASK_REQUEST_EVENT,
  type CaffoldUpdateSnapshot,
} from "./settings/about/page.js";
import "./settings/claude/components/runtime-restart-dialog.js";
import type { CaffoldClaudeRuntimeRestartDialog } from "./settings/claude/components/runtime-restart-dialog.js";
import { CLAUDE_RUNTIME_RESTART_REQUEST_EVENT } from "./settings/claude/page.js";
import "./settings/components/navigator.js";
import type { CaffoldSettingsNavigator } from "./settings/components/navigator.js";
import "./settings/layout.js";
import type { CaffoldSettingsWorkspace } from "./settings/layout.js";
import {
  createTaskStoreStatusLifecycle,
  TASK_STORE_RETRY_REQUEST_EVENT,
  type TaskStoreStatusSnapshot,
} from "./task-store-status.js";
import "./tasks/components/archived-delete-dialog.js";
import type { CaffoldTaskArchivedDeleteDialog } from "./tasks/components/archived-delete-dialog.js";
import "./tasks/components/navigator.js";
import type { CaffoldTaskNavigator } from "./tasks/components/navigator.js";
import "./tasks/components/task-switcher-dialog.js";
import type {
  CaffoldTaskSwitcherDialog,
  TaskSwitcherSelectDetail,
} from "./tasks/components/task-switcher-dialog.js";
import "./tasks/layout.js";
import type { PaneResizeDetail } from "../../components/pane-resizer.js";
import type { ParsedRoute } from "../../navigation-routes.js";
import type { RequestTasksRouteDetail } from "../layout.js";
import type { CodexResetCreditConfirmedDetail } from "./codex-status/components/reset-credit-dialog.js";
import type { WorkspaceNavigationIntentDetail } from "./components/navigation.js";
import type { LiveConnectionReport } from "./live-updates.js";
import type { TaskStartIntent } from "./task-create-intent-event.js";
import type { TaskArchivedDeleteConfirmedDetail } from "./tasks/components/archived-delete-dialog.js";
import type { CaffoldTasksPage } from "./tasks/layout.js";
import type { TaskNavigatorIntentDetail } from "./tasks/task-navigator-intent-event.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import { adoptScopedStyle } from "#app/scoped-style.js";

export interface RequestWorkspaceTabDetail {
  tab: WorkspaceTab | undefined;
  fallbackRoute: ParsedRoute;
}

const WORKSPACE_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";
const ROUTE_CONTROL_ICON = "task-workspace-route-control-icon";

type WorkspaceTab = "tasks" | "notes" | "settings";

// A workspace route as this layout reads it; each tab's screen reads the
// rest.
interface WorkspaceRoute {
  kind: string;
  threadId?: string;
  sectionId?: string;
  [field: string]: unknown;
}

// What the Tasks screen opens a route with.
interface RouteOptions {
  preserveLoadedTask?: boolean;
  defaultCwdPath?: string;
}

// What a foreground return is still checking.
interface ForegroundProgress {
  validatingStatus(): void;
  validatingTransports(stages: { detail: boolean; list: boolean }): void;
}

// A pane the corner toggle shows and hides: what it is called, whether it
// sits beside the detail, and whether it can collapse now.
interface SidePane {
  label: string;
  beside: boolean;
  collapsible: boolean;
  collapsed: boolean;
  setCollapsed?(collapsed: boolean): void;
}

adoptScopedStyle(
  compactIconButton,
  "caffold-task-workspace",
  "> .task-workspace-route-controls > .task-workspace-route-control",
);

/**
 * The workspace: the navigation pane with each tab's list and the tab
 * buttons, the detail pane with each tab's screen, the corner controls, and
 * the dialogs the tabs share. It owns the live connection and the Codex and
 * Task store statuses every tab reads.
 *
 * The app shell routes here and reads it right after, so it draws at once.
 */
@customElement("caffold-task-workspace")
export class CaffoldTaskWorkspace extends LitElement {
  private mode: WorkspaceTab = "tasks";
  private route: WorkspaceRoute = { kind: "tasks" };
  private codexRestartState: CodexRuntimeRequestState = {
    state: "idle",
    message: "",
  };
  private codexUpdateState: CodexRuntimeRequestState = {
    state: "idle",
    message: "",
  };
  private codexResetCreditState: CodexResetCreditRequestState = {
    state: "idle",
    message: "",
    retryPending: false,
  };
  private codexRuntimeAction = "idle";
  private claudeRestartState: { state: string; message: string } | null = null;
  private caffoldUpdate: CaffoldUpdateSnapshot | null = null;
  readonly liveUpdates = new WorkspaceLiveUpdates({
    onConnectionReport: (report) => {
      this.dispatchEvent(
        new CustomEvent<LiveConnectionReport>(LIVE_CONNECTION_REPORT_EVENT, {
          bubbles: true,
          detail: report,
        }),
      );
    },
  });
  private readonly taskStoreStatusLifecycle = createTaskStoreStatusLifecycle({
    onSnapshotChange: (snapshot) => this.setTaskStoreStatusSnapshot(snapshot),
  });
  private taskStoreStatusSnapshot: TaskStoreStatusSnapshot =
    this.taskStoreStatusLifecycle.snapshot();
  private readonly codexStatusLifecycle = createCodexStatusLifecycle({
    onSnapshotChange: (snapshot) => this.setCodexStatusSnapshot(snapshot),
    onRestartStateChange: (state) => this.setCodexRestartState(state),
    onUpdateStateChange: (state) => this.setCodexUpdateState(state),
    onResetCreditStateChange: (state) => this.setCodexResetCreditState(state),
    onRuntimeActionChange: (action) => this.setCodexRuntimeAction(action),
  });
  codexStatusSnapshotValue: CodexStatusSnapshot =
    this.codexStatusLifecycle.snapshot();
  // What each tab's screen shows, as it last said.
  private presentation = {
    tasksView: "home",
    taskListState: "loading",
    taskDetailView: "conversation",
    taskDetailPresentation: "reading",
    taskDetailHeaderHidden: false,
    notesView: "list",
    notesPicker: "",
    settingsView: "list",
  };
  private taskStoreTakeover = false;
  private showBack = false;
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  // Each part the workspace draws, by the name its getter reads it with.
  private readonly parts = new DrawnRefs<Element>(this);
  private detailOpen = false;
  private navigationPaneCollapsed = false;
  private sidePaneToggleState = {
    shown: false,
    enabled: true,
    expanded: true,
    label: "",
    side: "",
  };
  private readonly sidePaneResizeObserver = new ResizeObserver(() => {
    this.syncSidePaneToggle();
  });
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.addEventListener("caffold:side-pane-change", (event) => {
      event.stopPropagation();
      this.syncSidePaneToggle();
    });
    this.addEventListener(CAFFOLD_UPDATE_TASK_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      const status = this.caffoldUpdate?.status ?? null;
      this.updateTaskDialog.open({
        status,
        composerSettings:
          this.taskNavigator.sectionForDirectory(status?.updateTask?.cwd ?? "")
            ?.composerSettings ?? null,
        opener: event.detail?.opener,
      });
    });
    this.addEventListener(CODEX_STATUS_REFRESH_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      void this.codexStatusLifecycle.refresh().catch(() => {});
    });
    this.addEventListener(TASK_STORE_RETRY_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      this.taskStoreStatusLifecycle.retry();
    });
    this.addEventListener(CODEX_RUNTIME_RESTART_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      if (this.codexStatusLifecycle.canRestartRuntime()) {
        this.codexRuntimeRestartDialog.open();
      }
    });
    this.addEventListener(CODEX_RUNTIME_UPDATE_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      if (this.codexStatusLifecycle.canUpdateRuntime()) {
        this.codexRuntimeUpdateDialog.open();
      }
    });
    this.addEventListener(CODEX_RESET_CREDIT_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      const request = event.detail;
      const creditId = request?.creditId ?? null;
      if (!this.codexStatusLifecycle.canConsumeResetCredit(creditId)) {
        return;
      }
      const credit = codexResetCredits(
        this.codexStatusLifecycle.statusSnapshot(),
      )?.credits?.find((row) => row.id === creditId);
      this.codexResetCreditDialog.open({
        creditId,
        title: credit?.title,
        expiry: resetCreditExpiry(credit?.expiresAt)?.label,
        retry: request?.retry === true,
      });
    });
    this.addEventListener(CLAUDE_RUNTIME_RESTART_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      this.claudeRuntimeRestartDialog.open();
    });
  }

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.performUpdate();
    this.sidePaneResizeObserver.observe(this);
    this.liveUpdates.connect();
    this.taskStoreStatusLifecycle.connect();
    this.codexStatusLifecycle.connect();
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.sidePaneResizeObserver.disconnect();
    this.liveUpdates.disconnect();
    this.taskStoreStatusLifecycle.disconnect();
    this.codexStatusLifecycle.disconnect();
  }

  get tasksPage() {
    return this.child<CaffoldTasksPage>("tasks-page");
  }

  get taskNavigator() {
    return this.child<CaffoldTaskNavigator>("task-navigator");
  }

  get codexRuntimeRestartDialog() {
    return this.child<CaffoldCodexRuntimeRestartDialog>(
      "codex-runtime-restart-dialog",
    );
  }

  prepareRoute(route: WorkspaceRoute, options: RouteOptions = {}) {
    this.performUpdate();
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
    this.updateChrome();
  }

  async openRoute(route: WorkspaceRoute, options: RouteOptions = {}) {
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
    this.taskStoreStatusLifecycle.suspend();
    this.codexStatusLifecycle.suspend();
    this.tasksPage.suspendForeground();
  }

  async recoverForeground({
    initialActivation = false,
    isCurrent = () => true,
    progress,
  }: {
    initialActivation?: boolean;
    isCurrent?: () => boolean;
    progress?: ForegroundProgress;
  } = {}) {
    this.taskStoreStatusLifecycle.resume();
    this.codexStatusLifecycle.resume();
    progress?.validatingStatus();
    let storeError: unknown = null;
    // Connecting already asked the store, so the initial activation reuses an
    // answer it has instead of asking again.
    if (
      !(initialActivation && this.taskStoreStatusLifecycle.snapshot().readiness)
    ) {
      try {
        await this.taskStoreStatusLifecycle.check();
      } catch (error) {
        storeError = error;
      }
    }
    if (!isCurrent()) {
      return { stale: true, retry: false };
    }
    if (this.mode === "notes" && !initialActivation) {
      this.notesWorkspace.reload();
    }
    const tasksRecovery =
      this.mode === "tasks"
        ? this.tasksPage.recoverForeground({
            initialActivation,
            isCurrent,
            progress,
          })
        : this.recoverTaskList({ initialActivation });
    this.liveUpdates.resume();
    this.liveUpdates.retry();
    const tasks: { retry?: boolean; error?: unknown } = await tasksRecovery;
    return {
      retry: Boolean(
        storeError ||
          (!initialActivation && this.tasksPage.taskStoreOperationsBlocked()) ||
          tasks?.retry,
      ),
      error: storeError ?? tasks?.error ?? null,
    };
  }

  setCodexStatusSnapshot(snapshot: CodexStatusSnapshot | null | undefined) {
    this.performUpdate();
    const nextSnapshot = snapshot ?? this.codexStatusLifecycle.snapshot();
    const nextStatus = nextSnapshot.status;
    this.codexStatusSnapshotValue = nextSnapshot;
    this.settingsWorkspace.setCodexStatusSnapshot(nextSnapshot);
    if (
      nextStatus?.readiness &&
      nextStatus.readiness.state !== "restartRequired"
    ) {
      this.codexRuntimeRestartDialog.close();
    }
    if (nextStatus?.readiness && !codexRuntimeUpdateAvailable(nextStatus)) {
      this.codexRuntimeUpdateDialog.close();
    }
  }

  setTaskStoreStatusSnapshot(
    snapshot: TaskStoreStatusSnapshot | null | undefined,
  ) {
    this.performUpdate();
    this.taskStoreStatusSnapshot =
      snapshot ?? this.taskStoreStatusLifecycle.snapshot();
    this.tasksPage.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
    this.taskStoreTakeover = this.tasksPage.taskStoreRecoveryVisible();
    this.syncNavigationPane();
  }

  setBuildStatus(health: Health | null | undefined) {
    this.performUpdate();
    this.settingsWorkspace.setBuildStatus(health);
  }

  setUpdateStatus(
    status: { preparedUpdate?: { ready?: boolean } | null } | null | undefined,
  ) {
    this.performUpdate();
    this.navigation.setUpdateStatus(status);
    this.settingsWorkspace.setUpdateStatus(status);
  }

  /** Whether a newer Caffold exists, and how the last update ended. */
  setCaffoldUpdate(snapshot: CaffoldUpdateSnapshot | null | undefined) {
    this.performUpdate();
    this.caffoldUpdate = snapshot ?? null;
    this.navigation.setCaffoldUpdate(snapshot);
    this.settingsWorkspace.setCaffoldUpdate(snapshot);
  }

  setServerPaths(server: { root?: string; homePath?: string | null }) {
    this.performUpdate();
    this.tasksPage.setServerPaths(server);
  }

  actionHintScope() {
    const own = this.hints.scope({ scopeId: "workspace" });
    if (this.hidden) {
      return emptyActionHintScope();
    }
    const navigationClipRoots = [this, this.masterPane];
    const detailClipRoots = [this, this.detailPane];
    const modeScope =
      this.mode === "tasks"
        ? this.tasksPage.actionHintScope()
        : this.mode === "notes"
          ? this.notesWorkspace.actionHintScope({
              scopeId: "notes",
              leftClipRoots: navigationClipRoots,
              rightClipRoots: detailClipRoots,
            })
          : mergeActionHintScopes(
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
            );
    const resizer = this.masterResizer;
    const resizerScope = hasActionHintLayoutBox(resizer)
      ? resizer.actionHintScope({
          scopeId: "workspace:navigation-pane",
          actionId: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
          clipRoots: [this, this.masterDetail],
        })
      : null;
    return mergeActionHintScopes(
      own,
      hasActionHintLayoutBox(this.navigation)
        ? this.navigation.actionHintScope({
            scopeId: "workspace",
            clipRoots: navigationClipRoots,
          })
        : null,
      resizerScope,
      withActionHintOcclusionRoots(modeScope, [this.navigation]),
    );
  }

  keyboardNavigationContexts() {
    const childContexts = this.hidden
      ? []
      : this.mode === "tasks"
        ? this.tasksPage.keyboardNavigationContexts()
        : this.mode === "notes"
          ? this.notesWorkspace.keyboardNavigationContexts()
          : [];
    return mergeKeyboardNavigationContexts(
      this.codexRuntimeRestartDialog.keyboardNavigationContexts(),
      this.codexRuntimeUpdateDialog.keyboardNavigationContexts(),
      this.codexResetCreditDialog.keyboardNavigationContexts(),
      this.claudeRuntimeRestartDialog.keyboardNavigationContexts(),
      this.updateTaskDialog.keyboardNavigationContexts(),
      this.archivedDeleteDialog.keyboardNavigationContexts(),
      this.taskSwitcherDialog.keyboardNavigationContexts(),
      childContexts,
    );
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    if (this.hidden) {
      return emptyScrollSurfaceScope();
    }
    if (this.mode === "tasks") {
      return this.tasksPage.scrollSurfaceScope();
    }
    const surface = this.workspaceSurface;
    if (this.mode === "notes") {
      return this.notesWorkspace.scrollSurfaceScope({
        scopeId: "notes",
        leftClipRoots: [this.masterPane, surface],
        rightClipRoots: [this.detailPane, surface],
      });
    }
    return mergeScrollSurfaceScopes(
      hasScrollLayoutBox(this.settingsNavigator)
        ? this.settingsNavigator.scrollSurfaceScope({
            scopeId: "settings",
            clipRoots: [this.masterPane, surface],
          })
        : null,
      hasScrollLayoutBox(this.settingsWorkspace)
        ? this.settingsWorkspace.scrollSurfaceScope({
            scopeId: "settings",
            clipRoots: [this.detailPane, surface],
          })
        : null,
    );
  }

  actionHintEditingEscapeTarget(editable: Element | null) {
    // Escape in a terminal belongs to the program running there, and Escape
    // in New Task's directory path returns to its folder list.
    if (
      this.tasksPage.ownsTerminalInput(editable) ||
      this.tasksPage.ownsEditingEscape(editable)
    ) {
      return null;
    }
    if (containsAcrossShadowRoots(this.tasksPage, editable)) {
      return this.tasksPage.editingEscapeTarget();
    }
    if (containsAcrossShadowRoots(this.settingsWorkspace, editable)) {
      return this.settingsWorkspace.editingEscapeTarget();
    }
    return this.workspaceSurface;
  }

  /** The terminal toggle of the open Task or Section; Tasks alone has one. */
  toggleTerminal() {
    this.performUpdate();
    return (
      !this.hidden && this.mode === "tasks" && this.tasksPage.toggleTerminal()
    );
  }

  /**
   * Offer the Task switcher where the Task list it shows is actually held.
   *
   * Notes and Settings never load that list, so a switcher opened there could
   * only report an emptiness it has not checked.
   */
  openTaskSwitcher() {
    this.performUpdate();
    if (this.hidden || this.mode !== "tasks") {
      return false;
    }
    return this.taskSwitcherDialog.open(
      this.taskNavigator.activeTaskSnapshot(),
    );
  }

  afterActionHintActivation(target: {
    id: string;
    actionId: string;
    control?: Element | null;
  }) {
    if (
      target.actionId !== ACTION_HINT_ACTION.TASK_OPEN &&
      target.actionId !== ACTION_HINT_ACTION.TASK_OPEN_RECOVERY
    ) {
      return;
    }
    const threadId = target.id.startsWith("task:")
      ? target.id.slice("task:".length)
      : "";
    this.focusOpenedTask(threadId, target.control as HTMLElement | null);
  }

  /**
   * The side pane toggle behind its key combinations. It does what the corner
   * button does, only while that button is shown and enabled, and reports
   * whether it acted so an unused key stays with the page.
   */
  toggleSidePaneFromKeyboard() {
    this.performUpdate();
    const pane = this.currentSidePane();
    if (
      this.hidden ||
      !pane ||
      !this.sidePaneToggleShown(pane) ||
      !pane.collapsible
    ) {
      return false;
    }
    this.toggleSidePane();
    return true;
  }

  // Each tab's screen is handed what it shares with the others once it
  // exists.
  protected override firstUpdated() {
    this.taskNavigator.setLiveUpdates(this.liveUpdates);
    this.tasksPage.setLiveUpdates(this.liveUpdates);
    this.tasksPage.connectTaskNavigator(this.taskNavigator);
    this.notesWorkspace.connectNotesNavigator(this.notesNavigator);
    this.notesWorkspace.connectPrimarySlot(
      this.child<HTMLDivElement>("notes-primary-slot"),
    );
    this.settingsWorkspace.connectSettingsNavigator(this.settingsNavigator);
    this.setTaskStoreStatusSnapshot(this.taskStoreStatusSnapshot);
    this.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    const settings = this.settingsWorkspace;
    settings.setCodexRestartState(this.codexRestartState);
    settings.setCodexUpdateState(this.codexUpdateState);
    settings.setCodexResetCreditState(this.codexResetCreditState);
    settings.setCodexRuntimeAction(this.codexRuntimeAction);
    settings.setClaudeRestartState(this.claudeRestartState);
    this.applyNavigationPaneWidth();
    this.updateChrome();
  }

  protected override updated() {
    const presentation = this.presentation;
    const values: Record<string, string> = {
      workspaceMode: this.mode,
      tasksView: presentation.tasksView,
      taskListState: presentation.taskListState,
      taskDetailView: presentation.taskDetailView,
      taskDetailPresentation: presentation.taskDetailPresentation,
      notesView: presentation.notesView,
      notesPicker: presentation.notesPicker,
      settingsView: presentation.settingsView,
    };
    for (const [name, value] of Object.entries(values)) {
      if (this.dataset[name] !== value) {
        this.dataset[name] = value;
      }
    }
    const side = this.sidePaneToggleState.side;
    if (!side) {
      delete this.dataset.sidePaneToggle;
    } else if (this.dataset.sidePaneToggle !== side) {
      this.dataset.sidePaneToggle = side;
    }
    const flags: Record<string, boolean> = {
      "data-workspace-route-control-visible": this.showBack,
      "data-task-detail-header-hidden": presentation.taskDetailHeaderHidden,
      "data-task-store-takeover": this.taskStoreTakeover,
      "data-workspace-detail-open": this.detailOpen,
      "data-side-pane-collapsed": this.navigationPaneCollapsed,
    };
    for (const [name, on] of Object.entries(flags)) {
      if (this.hasAttribute(name) !== on) {
        this.toggleAttribute(name, on);
      }
    }
  }

  override render() {
    const toggle = this.sidePaneToggleState;
    const mode = this.mode;
    return html`
      <div
        ${drawn(this.parts.of("route-controls"))}
        class="task-workspace-route-controls"
      >
        <button
          ${this.hints.button({
            id: "side-pane:toggle",
            label: toggle.label || "Toggle side pane",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            owner: () => this.parts.get("route-controls"),
          })}
          type="button"
          class="task-workspace-route-control task-workspace-side-pane-toggle"
          aria-expanded=${toggle.expanded ? "true" : "false"}
          aria-label=${toggle.label || nothing}
          title=${toggle.label || nothing}
          ?disabled=${!toggle.enabled}
          ?hidden=${!toggle.shown}
          @click=${this.toggleSidePane}
        >${
          toggle.label
            ? inlineIcon("PanelLeft", toggle.label, ROUTE_CONTROL_ICON)
            : nothing
        }</button>
        <button
          ${this.hints.button({
            id: "parent:tasks",
            label: "Back to tasks",
            action: ACTION_HINT_ACTION.PARENT,
            owner: () => this.parts.get("route-controls"),
          })}
          type="button"
          class="task-workspace-route-control task-workspace-back"
          aria-label="Back to tasks"
          title="Back to tasks"
          ?hidden=${!this.showBack}
          @click=${this.requestTasksHome}
        >${inlineIcon(
          "ArrowLeft",
          "Back to tasks",
          ROUTE_CONTROL_ICON,
        )}</button>
        <button
          ${this.hints.button({
            id: "task-switcher:open",
            label: "Switch task",
            action: ACTION_HINT_ACTION.TASK_SWITCHER_OPEN,
            owner: () => this.parts.get("route-controls"),
          })}
          type="button"
          class="task-workspace-route-control task-workspace-switcher"
          aria-label="Switch task"
          title="Switch task"
          ?hidden=${!this.showBack}
          @click=${this.openTaskSwitcher}
        >${inlineIcon("History", "Switch task", ROUTE_CONTROL_ICON)}</button>
      </div>
      <section
        ${drawn(this.parts.of("surface"))}
        class="task-workspace-surface"
        aria-label="Task workspace"
        tabindex="-1"
      >
        <div
          ${drawn(this.parts.of("master-detail"))}
          class="task-workspace-master-detail"
        >
          <aside
            ${drawn(this.parts.of("master-pane"))}
            class="task-workspace-master-pane"
            aria-label="Workspace navigation"
          >
            <caffold-task-navigator
              ${drawn(this.parts.of("task-navigator"))}
              class="tasks-list-region"
              ?hidden=${mode !== "tasks"}
              @caffold:task-navigator-intent=${this.taskNavigatorIntent}
              @caffold:active-task-list-state=${this.activeTasksChange}
            ></caffold-task-navigator>
            <caffold-notes-navigator
              ${drawn(this.parts.of("notes-navigator"))}
              ?hidden=${mode !== "notes"}
            ></caffold-notes-navigator>
            <caffold-settings-navigator
              ${drawn(this.parts.of("settings-navigator"))}
              ?hidden=${mode !== "settings"}
            ></caffold-settings-navigator>
            <div
              ${drawn(this.parts.of("notes-primary-slot"))}
              class="notes-primary-slot"
            ></div>
            <caffold-task-workspace-navigation
              ${drawn(this.parts.of("navigation"))}
              @caffold:workspace-navigation-intent=${this.chooseTab}
            ></caffold-task-workspace-navigation>
          </aside>
          <caffold-pane-resizer
            ${drawn(this.parts.of("master-resizer"))}
            start-default="380"
            start-min="280"
            start-max="520"
            end-min="520"
            storage-key="caffold:pane-width:task-workspace"
            collapsed-storage-key="caffold:pane-collapsed:task-workspace"
            aria-label="Resize navigation pane"
            @caffold:pane-resize=${this.resizeNavigationPane}
          ></caffold-pane-resizer>
          <div
            ${drawn(this.parts.of("detail-pane"))}
            class="task-workspace-detail-pane"
          >
            <caffold-tasks-page
              ${drawn(this.parts.of("tasks-page"))}
              ?hidden=${mode !== "tasks"}
              @caffold:tasks-presentation-change=${this.presentationChange}
            ></caffold-tasks-page>
            <caffold-notes-workspace
              ${drawn(this.parts.of("notes-workspace"))}
              ?hidden=${mode !== "notes"}
              @caffold:notes-presentation-change=${this.presentationChange}
            ></caffold-notes-workspace>
            <caffold-settings-workspace
              ${drawn(this.parts.of("settings-workspace"))}
              ?hidden=${mode !== "settings"}
              @caffold:settings-presentation-change=${this.presentationChange}
            ></caffold-settings-workspace>
          </div>
        </div>
      </section>
      <caffold-task-archived-delete-dialog
        ${drawn(this.parts.of("archived-delete-dialog"))}
        @caffold:task-archived-delete-confirmed=${this.deleteArchivedTask}
      ></caffold-task-archived-delete-dialog>
      <caffold-task-switcher-dialog
        ${drawn(this.parts.of("task-switcher-dialog"))}
        @caffold:task-switcher-select=${this.openSwitchedTaskFromDialog}
      ></caffold-task-switcher-dialog>
      <caffold-codex-runtime-restart-dialog
        ${drawn(this.parts.of("codex-runtime-restart-dialog"))}
        @caffold:codex-runtime-restart-confirmed=${this.restartCodexRuntime}
      ></caffold-codex-runtime-restart-dialog>
      <caffold-codex-runtime-update-dialog
        ${drawn(this.parts.of("codex-runtime-update-dialog"))}
        @caffold:codex-runtime-update-confirmed=${this.updateCodexRuntime}
      ></caffold-codex-runtime-update-dialog>
      <caffold-codex-reset-credit-dialog
        ${drawn(this.parts.of("codex-reset-credit-dialog"))}
        @caffold:codex-reset-credit-confirmed=${this.consumeResetCredit}
      ></caffold-codex-reset-credit-dialog>
      <caffold-claude-runtime-restart-dialog
        ${drawn(this.parts.of("claude-runtime-restart-dialog"))}
        @caffold:claude-runtime-restart-confirmed=${this.restartClaudeRunner}
      ></caffold-claude-runtime-restart-dialog>
      <caffold-update-task-dialog
        ${drawn(this.parts.of("update-task-dialog"))}
        @caffold:task-create-intent=${this.startUpdateTask}
      ></caffold-update-task-dialog>
    `;
  }

  private requestTasksHome() {
    this.dispatchEvent(
      new CustomEvent<RequestTasksRouteDetail>("caffold:request-tasks-route", {
        bubbles: true,
        detail: { route: { kind: "tasks" } },
      }),
    );
  }

  private taskNavigatorIntent(event: CustomEvent<TaskNavigatorIntentDetail>) {
    const intent = event.detail;
    if (intent?.type === "delete-archived-task") {
      this.archivedDeleteDialog.openTask(intent.task);
    } else if (intent?.type === "open-task-switcher") {
      this.openTaskSwitcher();
    }
  }

  private activeTasksChange() {
    this.taskSwitcherDialog.updateTasks(
      this.taskNavigator.activeTaskSnapshot(),
    );
  }

  private chooseTab(event: CustomEvent<WorkspaceNavigationIntentDetail>) {
    event.stopPropagation();
    const tab = event.detail?.mode;
    // Choosing the tab already shown keeps its route, an open Task included,
    // and brings its list back to the top. A Notes pair keeps its hidden or
    // choosing tree at the same position.
    if (tab === this.mode) {
      if (tab === "notes") {
        if (!this.notesWorkspace.sideBySide()) {
          this.notesNavigator.scrollToTop();
        }
      } else if (tab === "settings") {
        this.settingsNavigator.scrollToTop();
      } else {
        this.taskNavigator.scrollToTop();
      }
      return;
    }
    // Where a tab opens the first time it is used, before it has a route to
    // return to.
    const fallbackRoute =
      tab === "notes"
        ? { kind: "notes", noteId: "" }
        : tab === "settings"
          ? { kind: "settings", section: "" }
          : { kind: "tasks" };
    this.dispatchEvent(
      new CustomEvent<RequestWorkspaceTabDetail>(
        "caffold:request-workspace-tab",
        {
          bubbles: true,
          detail: { tab, fallbackRoute },
        },
      ),
    );
  }

  private presentationChange(event: Event) {
    if (event.target !== event.currentTarget) {
      return;
    }
    event.stopPropagation();
    this.syncPresentationState();
  }

  private deleteArchivedTask(
    event: CustomEvent<TaskArchivedDeleteConfirmedDetail>,
  ) {
    event.stopPropagation();
    void this.taskNavigator.deleteThread(`${event.detail?.threadId ?? ""}`);
  }

  private openSwitchedTaskFromDialog(
    event: CustomEvent<TaskSwitcherSelectDetail>,
  ) {
    event.stopPropagation();
    this.openSwitchedTask(event.detail);
  }

  private restartCodexRuntime(event: Event) {
    event.stopPropagation();
    void this.codexStatusLifecycle.requestRuntimeRestart();
  }

  private updateCodexRuntime(event: Event) {
    event.stopPropagation();
    void this.codexStatusLifecycle.requestRuntimeUpdate();
  }

  private consumeResetCredit(
    event: CustomEvent<CodexResetCreditConfirmedDetail>,
  ) {
    event.stopPropagation();
    void this.codexStatusLifecycle.requestResetCredit(
      event.detail?.creditId ?? null,
    );
  }

  // The update Task starts the way Start Task does, through the Tasks page,
  // which opens it once created.
  private startUpdateTask(event: CustomEvent<TaskStartIntent>) {
    const intent = event.detail;
    if (intent?.type !== "start") {
      return;
    }
    event.stopPropagation();
    const completion = this.tasksPage.startTaskCreation(
      intent.request,
      intent.submission,
    );
    intent.accepted = Boolean(completion);
    intent.completion = completion;
  }

  // Hiding suspends the Task list whichever mode is shown, and a suspended list
  // holds no subscription, so recovery resumes it outside Tasks as well. No
  // other Task surface is open there.
  private async recoverTaskList({
    initialActivation,
  }: {
    initialActivation: boolean;
  }) {
    if (initialActivation) {
      return { retry: false };
    }
    try {
      await this.taskNavigator.recoverForeground();
      return { retry: false };
    } catch (error) {
      return { retry: true, error };
    }
  }

  private setClaudeRestartState(state: { state: string; message: string }) {
    this.claudeRestartState = state;
    this.settingsWorkspace.setClaudeRestartState(this.claudeRestartState);
  }

  // Confirmed by the person in the dialog; every state this passes through is
  // shown on the settings page that asked.
  private async restartClaudeRunner(event: Event) {
    event.stopPropagation();
    this.setClaudeRestartState({
      state: "restarting",
      message: "Restarting the Claude runner…",
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

  private setCodexRestartState(state: CodexRuntimeRequestState | null) {
    this.performUpdate();
    this.codexRestartState = state ?? { state: "idle", message: "" };
    this.settingsWorkspace.setCodexRestartState(this.codexRestartState);
  }

  private setCodexUpdateState(state: CodexRuntimeRequestState | null) {
    this.performUpdate();
    this.codexUpdateState = state ?? { state: "idle", message: "" };
    this.settingsWorkspace.setCodexUpdateState(this.codexUpdateState);
  }

  private setCodexResetCreditState(state: CodexResetCreditRequestState) {
    this.performUpdate();
    this.codexResetCreditState = state;
    this.settingsWorkspace.setCodexResetCreditState(state);
  }

  private setCodexRuntimeAction(action: string | null) {
    this.performUpdate();
    this.codexRuntimeAction = action ?? "idle";
    this.settingsWorkspace.setCodexRuntimeAction(this.codexRuntimeAction);
  }

  private openSwitchedTask({
    threadId = "",
    recovery = false,
  }: Partial<TaskSwitcherSelectDetail> = {}) {
    if (!threadId) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<RequestTasksRouteDetail>("caffold:request-tasks-route", {
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

  /**
   * Put focus where the newly opened Task is once navigation settles.
   *
   * A control the person can still see keeps the focus it just had. Anything
   * else — a compact layout that replaced the list, or a row in a dialog that
   * has since closed — hands focus to the Task itself.
   */
  private focusOpenedTask(
    threadId: string,
    control: (HTMLElement & { disabled?: boolean }) | null = null,
  ) {
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
    if (navigationFinished) {
      void navigationFinished.then(focusDestination, () => {});
      return;
    }
    queueMicrotask(focusDestination);
  }

  private updateChrome() {
    const taskRoute = this.mode === "tasks" ? this.route : null;
    const target = taskRoute ? routeTarget(taskRoute) : null;
    const domain = routeDomain(taskRoute);
    this.showBack =
      target === "new" ||
      Boolean(
        (taskRoute?.threadId || taskRoute?.sectionId) &&
          (domain ? target === "list" : target !== "review-file"),
      );
    this.syncPresentationState();
    this.navigation.setMode(this.mode);
  }

  private syncPresentationState() {
    const tasks = this.tasksPage;
    const notes = this.notesWorkspace.dataset;
    this.presentation = {
      tasksView: tasks.dataset.tasksView ?? "home",
      taskListState: tasks.dataset.taskListState ?? "loading",
      taskDetailView: tasks.dataset.taskDetailView ?? "conversation",
      taskDetailPresentation: tasks.dataset.taskDetailPresentation ?? "reading",
      taskDetailHeaderHidden: tasks.hasAttribute(
        "data-task-detail-header-hidden",
      ),
      notesView: notes.notesView ?? "list",
      notesPicker: notes.notesPicker ?? "",
      settingsView: this.settingsWorkspace.dataset.settingsView ?? "list",
    };
    this.syncNavigationPane();
  }

  private resizeNavigationPane(event: CustomEvent<PaneResizeDetail>) {
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

  private applyNavigationPaneWidth() {
    this.style.setProperty(
      "--task-workspace-master-width",
      `${this.masterResizer.value}px`,
    );
  }

  // Whether the detail pane has something open, which is also the side the
  // single-pane layout shows. The navigation pane collapses only then.
  private syncNavigationPane() {
    const presentation = this.presentation;
    const tasksView = presentation.tasksView;
    this.detailOpen =
      this.mode === "notes"
        ? presentation.notesView !== "list"
        : this.mode === "settings"
          ? presentation.settingsView === "detail"
          : this.taskStoreTakeover ||
            tasksView === "new" ||
            tasksView === "detail" ||
            tasksView === "recovery" ||
            (tasksView === "home" && presentation.taskListState === "empty");
    this.navigationPaneCollapsed =
      this.detailOpen &&
      this.masterResizer.collapsed &&
      !(this.mode === "notes" && this.notesWorkspace.sideBySide());
    this.syncSidePaneToggle();
  }

  private navigationSidePane(): SidePane {
    if (this.mode === "notes" && this.notesWorkspace.sideBySide()) {
      return {
        label: "navigation pane",
        beside: false,
        collapsible: false,
        collapsed: false,
      };
    }
    const collapsible = this.detailOpen;
    return {
      label: "navigation pane",
      beside: window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches,
      collapsible,
      collapsed: collapsible && this.masterResizer.collapsed,
      setCollapsed: (collapsed) => {
        this.masterResizer.setCollapsed(collapsed);
        this.syncNavigationPane();
      },
    };
  }

  // A code surface replaces the navigation pane with its own file tree, so the
  // toggle serves that tree while one is shown.
  private showsCodeSurface() {
    return (
      this.mode === "tasks" &&
      this.presentation.taskDetailPresentation === "code"
    );
  }

  private currentSidePane(): SidePane | null {
    return this.showsCodeSurface()
      ? this.tasksPage.sidePane()
      : this.navigationSidePane();
  }

  private toggleSidePane() {
    const pane = this.currentSidePane();
    if (!pane?.collapsible) {
      return;
    }
    pane.setCollapsed?.(!pane.collapsed);
    this.syncSidePaneToggle();
  }

  /**
   * Show the toggle wherever its pane sits beside the detail, unless the
   * compact Back is using the same corner. It stays in place while nothing is
   * open to collapse for, so the header it sits over never shifts.
   */
  private syncSidePaneToggle() {
    const pane = this.currentSidePane();
    this.sidePaneToggleState =
      pane && this.sidePaneToggleShown(pane)
        ? {
            shown: true,
            enabled: pane.collapsible,
            expanded: !pane.collapsed,
            label: `${pane.collapsed ? "Show" : "Hide"} ${pane.label}`,
            side:
              !this.showsCodeSurface() && !pane.collapsed
                ? "navigation"
                : "detail",
          }
        : { ...this.sidePaneToggleState, shown: false, side: "" };
    this.draw();
  }

  private sidePaneToggleShown(pane: SidePane) {
    const compactRouteControlsShown =
      this.showBack &&
      !window.matchMedia(WORKSPACE_MASTER_DETAIL_MEDIA_QUERY).matches;
    return pane.beside && !compactRouteControlsShown;
  }

  // A screen that connects while the workspace first draws reports in before
  // that drawing ends; the workspace reads every screen again right after.
  private draw() {
    if (!this.hasUpdated) {
      return;
    }
    this.requestUpdate();
    this.performUpdate();
  }

  // The children are drawn the first time one is needed, which can be before
  // the workspace is in the document.
  private child<T extends Element>(name: string) {
    this.performUpdate();
    return this.parts.get(name) as T;
  }

  private get workspaceSurface() {
    return this.child<HTMLElement>("surface");
  }

  private get masterDetail() {
    return this.child<HTMLElement>("master-detail");
  }

  private get masterPane() {
    return this.child<HTMLElement>("master-pane");
  }

  private get detailPane() {
    return this.child<HTMLElement>("detail-pane");
  }

  private get masterResizer() {
    return this.child<CaffoldPaneResizer>("master-resizer");
  }

  private get notesNavigator() {
    return this.child<CaffoldNotesNavigator>("notes-navigator");
  }

  private get settingsNavigator() {
    return this.child<CaffoldSettingsNavigator>("settings-navigator");
  }

  private get notesWorkspace() {
    return this.child<CaffoldNotesWorkspace>("notes-workspace");
  }

  private get settingsWorkspace() {
    return this.child<CaffoldSettingsWorkspace>("settings-workspace");
  }

  private get navigation() {
    return this.child<CaffoldTaskWorkspaceNavigation>("navigation");
  }

  private get archivedDeleteDialog() {
    return this.child<CaffoldTaskArchivedDeleteDialog>(
      "archived-delete-dialog",
    );
  }

  private get taskSwitcherDialog() {
    return this.child<CaffoldTaskSwitcherDialog>("task-switcher-dialog");
  }

  private get codexRuntimeUpdateDialog() {
    return this.child<CaffoldCodexRuntimeUpdateDialog>(
      "codex-runtime-update-dialog",
    );
  }

  private get codexResetCreditDialog() {
    return this.child<CaffoldCodexResetCreditDialog>(
      "codex-reset-credit-dialog",
    );
  }

  private get claudeRuntimeRestartDialog() {
    return this.child<CaffoldClaudeRuntimeRestartDialog>(
      "claude-runtime-restart-dialog",
    );
  }

  private get updateTaskDialog() {
    return this.child<CaffoldUpdateTaskDialog>("update-task-dialog");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-workspace": CaffoldTaskWorkspace;
  }

  interface HTMLElementEventMap {
    [LIVE_CONNECTION_REPORT_EVENT]: CustomEvent<LiveConnectionReport>;
    "caffold:request-workspace-tab": CustomEvent<RequestWorkspaceTabDetail>;
  }
}
