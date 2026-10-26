import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import {
  checkCaffoldUpdate,
  getCaffoldUpdate,
  getHealth,
  type Health,
  sendForegroundRecoveryDiagnostics,
} from "#app/api.ts";
import { BUILD_INFO } from "#app/build-info.js";
import { busySpin } from "#app/component-styles.ts";
import {
  KeyboardContexts,
  KeyboardNavigationController,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import "#app/keyboard-navigation/components/shortcut-dialog.ts";
import type { CaffoldKeyboardShortcutDialog } from "#app/keyboard-navigation/components/shortcut-dialog.ts";
import {
  type ParsedRoute,
  parseRoute,
  routeEquals,
  routeUrl,
} from "#app/navigation-routes.ts";
import { CAFFOLD_ORIGIN_REACHABLE_EVENT } from "#app/origin-reachability.ts";
import { getSettings } from "#app/settings.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "./(task-workspace)/layout.ts";
import type { CaffoldTaskWorkspace } from "./(task-workspace)/layout.ts";
import { LIVE_CONNECTION_REPORT_EVENT } from "./(task-workspace)/live-updates.ts";
import {
  CAFFOLD_UPDATE_CHECK_REQUEST_EVENT,
  type CaffoldUpdateSnapshot,
} from "./(task-workspace)/settings/about/page.ts";
import {
  CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT,
  type CaffoldBuildMismatchAlert,
} from "./components/build-mismatch-alert.ts";
import {
  CAFFOLD_UPDATE_LATER_EVENT,
  CAFFOLD_UPDATE_RELOAD_EVENT,
  type CaffoldUpdateDialog,
} from "./components/update-dialog.ts";
import "./components/update-result-dialog.ts";
import type { CaffoldUpdateResultDialog } from "./components/update-result-dialog.ts";
import {
  FOREGROUND_RECOVERY_PRESENTATION,
  ForegroundRecoveryLifecycle,
  type ForegroundRecoveryRequest,
  type ForegroundRecoverySnapshot,
} from "./foreground-recovery.ts";
import {
  type HistoryEntry,
  NAVIGATION_HISTORY_ACTION,
  NavigationHistory,
} from "./navigation-history.ts";
import { PwaUpdateLifecycle } from "./pwa-update-lifecycle.ts";

// The Navigation API as far as the shell and the workspace use it; TypeScript's
// DOM types do not have it yet.
declare global {
  interface NavigateEvent extends Event {
    readonly canIntercept: boolean;
    readonly navigationType: string;
    readonly hashChange: boolean;
    readonly downloadRequest: string | null;
    readonly destination: { readonly url: string };
    intercept(options: { handler(): Promise<void> }): void;
  }

  interface Navigation extends EventTarget {
    readonly transition: { readonly finished: Promise<unknown> } | null;
  }

  interface Window {
    readonly navigation?: Navigation;
  }
}

// What the PWA update lifecycle says: whether it is still checking, and the
// build it has prepared for this window.
interface PwaUpdateStatus {
  state: "checking" | "ready" | "settled";
  preparedUpdate: { ready: boolean; buildId: string | null };
  diagnostics: ReturnType<typeof normalizePwaUpdateDiagnostics>;
}

/**
 * The application: the workspace, the bootstrap failure that stands in for
 * it, the foreground recovery notice, the Caffold update and build mismatch
 * notices, and the keyboard navigation over all of it. It owns the browser
 * history and routes every navigation into the workspace.
 */
export class CaffoldAppShell extends LitElement {
  pwaUpdateLifecycle!: PwaUpdateLifecycle;
  foregroundRecoveryLifecycle!: ForegroundRecoveryLifecycle;
  foregroundRecoverySnapshot: ForegroundRecoverySnapshot | null = null;
  actionHints: object | null = null;
  private keyboardNavigation!: KeyboardNavigationController;
  private started = false;
  private currentRoute: ParsedRoute | null = null;
  private readonly navigationHistory = new NavigationHistory();
  private rewindingHistory = false;
  private writingEntryChain = false;
  private usesNavigationApi = false;
  private initialPath = "";
  private bootstrapError: { message?: string } | null = null;
  private aboutHealthRequest: Promise<Health | null> | null = null;
  private buildHealth: Health | null = null;
  private caffoldUpdate: CaffoldUpdateSnapshot | null = null;
  private caffoldUpdateRead: Promise<void> | null = null;
  private caffoldUpdateCheck: Promise<void> | null = null;
  private caffoldUpdateGeneration = 0;
  private readonly presentedUpdateBuildIds = new Set<string | null>();
  private pwaUpdateStatus: PwaUpdateStatus = {
    state: "checking",
    preparedUpdate: { ready: false, buildId: null },
    diagnostics: normalizePwaUpdateDiagnostics(null),
  };
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, () => this.performUpdate());
  private readonly keyboard = new KeyboardContexts(this, () =>
    this.performUpdate(),
  );
  private readonly workspace = new DrawnRef<CaffoldTaskWorkspace>(this);
  private readonly bootstrapErrorPanel = new DrawnRef<HTMLElement>(this);
  private readonly foregroundRecoveryNotice = new DrawnRef<HTMLElement>(this);
  private readonly updateDialog = new DrawnRef<CaffoldUpdateDialog>(this);
  private readonly updateResultDialog = new DrawnRef<CaffoldUpdateResultDialog>(
    this,
  );
  private readonly buildMismatchAlert = new DrawnRef<CaffoldBuildMismatchAlert>(
    this,
  );
  private readonly keyboardShortcutDialog =
    new DrawnRef<CaffoldKeyboardShortcutDialog>(this);
  private readonly originReachable = () => {
    void this.foregroundRecoveryLifecycle.reportOriginReachable();
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    if (this.started) {
      window.addEventListener(
        CAFFOLD_ORIGIN_REACHABLE_EVENT,
        this.originReachable,
      );
      this.pwaUpdateLifecycle.connect();
      this.foregroundRecoveryLifecycle.connect();
      this.keyboardNavigation.connect();
      queueMicrotask(() => {
        void this.foregroundRecoveryLifecycle.requestForegroundRecovery();
      });
      return;
    }

    this.started = true;
    this.performUpdate();
    this.keyboardNavigation = new KeyboardNavigationController({
      workspace: this,
      collectKeyboardNavigationContexts: () =>
        this.keyboardNavigationContexts(),
      shortcutDialog: this.keyboardShortcutDialog.value,
      afterActionHintActivation: (target) =>
        this.taskWorkspace.afterActionHintActivation(target),
      openTaskSwitcher: () => this.taskWorkspace.openTaskSwitcher(),
      toggleTerminal: () => this.taskWorkspace.toggleTerminal(),
      toggleSidePane: () => this.taskWorkspace.toggleSidePaneFromKeyboard(),
      readSettings: () => getSettings(),
    });
    this.actionHints = this.keyboardNavigation.actionHints;
    this.keyboardNavigation.connect();
    this.pwaUpdateLifecycle = new PwaUpdateLifecycle({
      currentBuildId: BUILD_INFO.id,
      onReloadReady: () => window.location.reload(),
      onStatusChange: (status: Partial<PwaUpdateStatus> | null) =>
        this.applyPwaUpdateStatus(status),
    });
    this.foregroundRecoveryLifecycle = new ForegroundRecoveryLifecycle({
      onRecover: (request) => this.recoverForeground(request),
      onStateChange: (snapshot) =>
        this.applyForegroundRecoverySnapshot(snapshot),
      onSuspend: () => this.taskWorkspace.suspendForeground(),
      diagnostics: {
        send: (records) => sendForegroundRecoveryDiagnostics(records),
      },
    });
    window.addEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.originReachable,
    );
    this.foregroundRecoverySnapshot =
      this.foregroundRecoveryLifecycle.snapshot();
    const initialRoute = parseRoute(window.location.href);
    // The entries this writes are the shell's own scaffolding, so they go in
    // while nothing is listening for navigation.
    this.adoptInitialEntry(initialRoute);
    this.installNavigationHandlers();

    if (initialRoute) {
      this.keyboardNavigation.routeWillChange();
      this.currentRoute = initialRoute;
      this.taskWorkspace.prepareRoute(initialRoute, {
        defaultCwdPath: this.initialPath,
      });
    }

    this.addEventListener("caffold:open-tasks", () => {
      this.navigateToRoute({ kind: "tasks" });
    });
    this.addEventListener("caffold:open-settings", (event) => {
      this.navigateToRoute({
        kind: "settings",
        section:
          (event as CustomEvent<{ section?: string }>).detail?.section ?? "",
      });
    });
    this.addEventListener("caffold:open-about", () => {
      this.navigateToRoute({ kind: "settings", section: "about" });
    });
    this.addEventListener("caffold:request-tasks-route", (event) => {
      const request = (
        event as CustomEvent<{ route?: ParsedRoute; correction?: boolean }>
      ).detail;
      this.navigateToRoute(request?.route, {
        correction: Boolean(request?.correction),
      });
    });
    this.addEventListener("caffold:request-settings-route", (event) => {
      this.navigateToRoute(
        (event as CustomEvent<{ route?: ParsedRoute }>).detail?.route,
      );
    });
    this.addEventListener("caffold:request-workspace-route", (event) => {
      this.navigateToRoute(
        (event as CustomEvent<{ route?: ParsedRoute }>).detail?.route,
      );
    });
    this.addEventListener("caffold:request-workspace-tab", (event) => {
      const request = (
        event as CustomEvent<{ tab?: string; fallbackRoute?: ParsedRoute }>
      ).detail;
      this.navigateToRoute(
        this.navigationHistory.routeForTab(
          request?.tab,
          request?.fallbackRoute,
        ),
      );
    });
    this.addEventListener(CAFFOLD_UPDATE_RELOAD_EVENT, (event) => {
      event.stopPropagation();
      this.pwaUpdateLifecycle.activatePreparedUpdate();
    });
    this.addEventListener(CAFFOLD_UPDATE_LATER_EVENT, (event) => {
      event.stopPropagation();
    });
    this.addEventListener(CAFFOLD_UPDATE_CHECK_REQUEST_EVENT, (event) => {
      event.stopPropagation();
      void this.checkCaffoldUpdate();
    });
    this.addEventListener(CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT, (event) => {
      event.stopPropagation();
      window.location.reload();
    });
    this.addEventListener("caffold:task-transport-status", (event) => {
      event.stopPropagation();
      this.foregroundRecoveryLifecycle.setTargets(
        (event as CustomEvent<{ targets?: unknown }>).detail?.targets,
      );
    });
    this.addEventListener(LIVE_CONNECTION_REPORT_EVENT, (event) => {
      event.stopPropagation();
      this.foregroundRecoveryLifecycle.reportLiveConnection(
        (event as CustomEvent).detail,
      );
    });
    void this.pwaUpdateLifecycle.start();
    void warmIcons();
    void this.bootstrap();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.removeEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.originReachable,
    );
    this.pwaUpdateLifecycle.disconnect();
    this.foregroundRecoveryLifecycle.disconnect();
    this.keyboardNavigation.disconnect();
  }

  updateBuildStatus(health: Health | null | undefined) {
    this.buildHealth = health ?? null;
    this.taskWorkspace.setBuildStatus(this.buildHealth);
    this.pwaUpdateLifecycle.setServerBuildId(this.buildHealth?.buildId);
    this.draw();
  }

  setBootstrapError(error: { message?: string } | null) {
    this.bootstrapError = error;
    this.draw();
  }

  // A requested route decides its own history treatment from where it stands
  // relative to the current one. `correction` marks the requests that only
  // refine the current destination, such as canonicalizing a URL or leaving a
  // subject that turned out to be unreachable.
  navigateToRoute(
    route: ParsedRoute | null | undefined,
    options: { correction?: boolean } = {},
  ) {
    if (!route || this.rewindingHistory) {
      return false;
    }

    const entries = options.correction
      ? this.navigationHistory.resolveCorrection(this.currentRoute, route)
      : this.navigationHistory.resolve(this.currentRoute, route);
    this.keyboardNavigation.routeWillChange();

    const [first] = entries;
    if (first.action === NAVIGATION_HISTORY_ACTION.TRAVERSE) {
      this.rewindingHistory = true;
      this.navigationHistory.commit(first);
      window.history.go(-first.steps);
      return true;
    }

    if (first.action !== NAVIGATION_HISTORY_ACTION.NONE) {
      this.writeEntryChain(entries);
    }
    this.currentRoute = route;
    void this.applyRoute(route, { keyboardPrepared: true });
    return true;
  }

  actionHintScope() {
    return mergeActionHintScopes(
      this.hints.scope(),
      this.buildMismatchAlert.value?.actionHintScope(),
      this.taskWorkspace.actionHintScope(),
    );
  }

  keyboardNavigationContexts() {
    return mergeKeyboardNavigationContexts(
      this.keyboard.workspace("workspace", {
        actionHints: () => this.actionHintScope(),
        scroll: () => this.taskWorkspace.scrollSurfaceScope(),
        editing: {
          escapeTarget: (editable: Element | null) =>
            this.taskWorkspace.contains(editable)
              ? this.taskWorkspace.actionHintEditingEscapeTarget(editable)
              : null,
        },
      }),
      this.updateDialog.value?.keyboardNavigationContexts() ?? [],
      this.updateResultDialog.value?.keyboardNavigationContexts() ?? [],
      this.keyboardShortcutDialog.value?.keyboardNavigationContexts() ?? [],
      this.taskWorkspace.keyboardNavigationContexts(),
    );
  }

  protected updated() {
    const trigger = this.foregroundRecoverySnapshot?.lastTrigger ?? "";
    if (this.dataset.foregroundRecoveryTrigger !== trigger) {
      this.dataset.foregroundRecoveryTrigger = trigger;
    }
  }

  render() {
    const error = this.bootstrapError;
    const recovery =
      this.foregroundRecoverySnapshot?.presentation ??
      FOREGROUND_RECOVERY_PRESENTATION.NONE;
    const unavailable =
      recovery === FOREGROUND_RECOVERY_PRESENTATION.UNAVAILABLE;
    const offline = recovery === FOREGROUND_RECOVERY_PRESENTATION.OFFLINE;
    const serverId = this.buildHealth?.buildId;
    const mismatch = Boolean(
      serverId &&
        serverId !== BUILD_INFO.id &&
        this.pwaUpdateStatus.state === "settled",
    );
    return html`
      <main class="app-main" aria-label="Workspace">
        <caffold-task-workspace
          ${drawn(this.workspace)}
          ?hidden=${Boolean(error)}
        ></caffold-task-workspace>
        <section
          ${drawn(this.bootstrapErrorPanel)}
          class="app-bootstrap-error"
          role="alert"
          ?hidden=${!error}
        >
          <h1>Caffold is unavailable</h1>
          <p data-bootstrap-error-message>${error?.message ?? ""}</p>
          <button
            ${this.hints.button({
              id: "app:bootstrap:retry",
              label: "Retry",
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              owner: () => this.bootstrapErrorPanel.value,
              clipRoots: () => [this.bootstrapErrorPanel.value],
            })}
            type="button"
            data-action="retry-bootstrap"
            @click=${this.retryBootstrap}
          >Retry</button>
        </section>
      </main>
      <section
        ${drawn(this.foregroundRecoveryNotice)}
        class="app-foreground-recovery"
        role="status"
        aria-live="polite"
        data-recovery-state=${recovery}
        ?hidden=${
          recovery === FOREGROUND_RECOVERY_PRESENTATION.NONE || Boolean(error)
        }
      >
        <span
          class="app-foreground-recovery-spinner"
          aria-hidden="true"
          ?hidden=${unavailable || offline}
        ></span>
        <span
          class="app-foreground-recovery-icon"
          data-foreground-recovery-icon
          ?hidden=${!unavailable && !offline}
        >${inlineIcon(
          "TriangleAlert",
          "Connection issue",
          "app-foreground-recovery-icon-svg",
        )}</span>
        <span data-foreground-recovery-message>${
          offline
            ? "No network connection. Waiting to reconnect..."
            : unavailable
              ? "Caffold server unavailable."
              : "Reconnecting to Caffold server..."
        }</span>
        <button
          ${this.hints.button({
            id: "app:foreground-recovery:retry",
            label: "Retry",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            owner: () => this.foregroundRecoveryNotice.value,
            clipRoots: () => [this.foregroundRecoveryNotice.value],
          })}
          type="button"
          data-action="retry-foreground-recovery"
          ?hidden=${!unavailable}
          @click=${this.retryForegroundRecovery}
        >Retry</button>
      </section>
      <caffold-update-dialog
        ${drawn(this.updateDialog)}
      ></caffold-update-dialog>
      <caffold-update-result-dialog
        ${drawn(this.updateResultDialog)}
      ></caffold-update-result-dialog>
      <caffold-build-mismatch-alert
        ${drawn(this.buildMismatchAlert)}
        hidden
        .serverLabel=${
          mismatch ? this.buildHealth?.buildLabel || serverId || "" : ""
        }
      ></caffold-build-mismatch-alert>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
      <caffold-keyboard-shortcut-dialog
        ${drawn(this.keyboardShortcutDialog)}
      ></caffold-keyboard-shortcut-dialog>
    `;
  }

  private retryBootstrap() {
    void this.bootstrap();
  }

  private retryForegroundRecovery() {
    void this.foregroundRecoveryLifecycle.requestManualRetry();
  }

  private refreshAboutStatus() {
    void this.pwaUpdateLifecycle.checkForUpdate();
    void this.refreshCaffoldUpdate();
    if (this.aboutHealthRequest) {
      return this.aboutHealthRequest;
    }

    const request: Promise<Health | null> = getHealth()
      .then((health) => {
        this.updateBuildStatus(health);
        return health;
      })
      .catch(() => {
        this.updateBuildStatus(null);
        return null;
      })
      .finally(() => {
        if (this.aboutHealthRequest === request) {
          this.aboutHealthRequest = null;
        }
      });
    this.aboutHealthRequest = request;
    return request;
  }

  /**
   * Asks whether a newer Caffold exists and how the last update ended. Both
   * opening Caffold and opening About ask; the server decides when to ask
   * GitHub again. A check under way answers at least as recently, so a read
   * that starts during one waits for it.
   */
  private refreshCaffoldUpdate() {
    if (this.caffoldUpdateCheck) {
      return this.caffoldUpdateCheck;
    }
    if (!this.caffoldUpdateRead) {
      const read: Promise<void> = this.requestCaffoldUpdate(
        getCaffoldUpdate,
      ).finally(() => {
        if (this.caffoldUpdateRead === read) {
          this.caffoldUpdateRead = null;
        }
      });
      this.caffoldUpdateRead = read;
    }
    return this.caffoldUpdateRead;
  }

  /**
   * Has the server ask GitHub now, for About's Check for Updates. The last
   * answer stays on show while the check runs.
   */
  private checkCaffoldUpdate() {
    if (!this.caffoldUpdateCheck) {
      this.applyCaffoldUpdate({
        status: null,
        error: null,
        ...this.caffoldUpdate,
        checking: true,
      });
      const check: Promise<void> = this.requestCaffoldUpdate(
        checkCaffoldUpdate,
      ).finally(() => {
        if (this.caffoldUpdateCheck === check) {
          this.caffoldUpdateCheck = null;
        }
      });
      this.caffoldUpdateCheck = check;
    }
    return this.caffoldUpdateCheck;
  }

  /**
   * Only the request started last is answered on screen, so a read that left
   * before a check cannot replace the check's newer answer.
   */
  private requestCaffoldUpdate(
    ask: () => Promise<CaffoldUpdateSnapshot["status"]>,
  ) {
    const generation = ++this.caffoldUpdateGeneration;
    return ask()
      .then((status) => ({ checking: false, status, error: null }))
      .catch((error) => ({
        checking: false,
        status: null,
        error: error instanceof Error ? error.message : "Request failed.",
      }))
      .then((snapshot: CaffoldUpdateSnapshot) => {
        if (generation === this.caffoldUpdateGeneration) {
          this.applyCaffoldUpdate(snapshot);
        }
      });
  }

  private applyCaffoldUpdate(snapshot: CaffoldUpdateSnapshot) {
    this.caffoldUpdate = snapshot;
    this.taskWorkspace.setCaffoldUpdate(snapshot);
    const attempt = snapshot.status?.lastAttempt;
    if (
      !attempt ||
      !["rolledBack", "restoreFailed"].includes(attempt.outcome) ||
      seenUpdateResult() === attempt.id
    ) {
      return;
    }
    rememberSeenUpdateResult(attempt.id);
    this.keyboardNavigation.cancelStoredMode("interaction-owner", {
      restoreFocus: false,
    });
    this.updateResultDialog.value?.open(attempt);
  }

  private installNavigationHandlers() {
    const navigation = window.navigation;
    this.usesNavigationApi = typeof navigation?.addEventListener === "function";

    if (navigation && this.usesNavigationApi) {
      navigation.addEventListener("navigate", (navigate) => {
        const event = navigate as NavigateEvent;
        if (this.writingEntryChain) {
          return;
        }
        if (
          !event.canIntercept ||
          event.navigationType === "reload" ||
          event.hashChange ||
          event.downloadRequest
        ) {
          return;
        }
        const destination = new URL(event.destination.url);
        if (destination.origin !== window.location.origin) {
          return;
        }
        const route = parseRoute(destination.href);
        if (!route) {
          return;
        }
        event.intercept({
          handler: async () => {
            if (!this.currentRoute || !routeEquals(this.currentRoute, route)) {
              await this.applyRoute(route);
            }
          },
        });
      });
      navigation.addEventListener("currententrychange", () => {
        if (this.writingEntryChain) {
          return;
        }
        const route = parseRoute(window.location.href);
        if (!route) {
          return;
        }
        this.adoptReachedEntry(route);
        if (!this.currentRoute || !routeEquals(this.currentRoute, route)) {
          void this.applyRoute(route);
        }
      });
      return;
    }

    window.addEventListener("popstate", () => {
      if (this.writingEntryChain) {
        return;
      }
      const route = parseRoute(window.location.href);
      if (route) {
        this.adoptReachedEntry(route);
        void this.applyRoute(route);
      }
    });
  }

  // The entry the browser reaches carries where every tab stood when it was
  // written, so arriving through Back, Forward, or a reload restores that
  // instead of the shell deciding what the entry should have meant. An entry
  // the browser created itself, following a native link, arrives without that
  // record and is given one here: the entry is committed by now, which it is
  // not yet while the navigation is being intercepted.
  private adoptReachedEntry(route: ParsedRoute | null) {
    const snapshot = this.readEntryNavigation();
    if (snapshot) {
      this.navigationHistory.restore(snapshot);
      return;
    }

    if (!route) {
      return;
    }

    this.writeEntryChain(
      this.navigationHistory.resolveFollowedLink(this.currentRoute, route),
    );
  }

  // A reload or a Back lands on an entry this shell wrote, so its record is
  // restored. A route the browser reached from outside has no record and no
  // entries under it, so the screens it sits under are written in beneath it;
  // otherwise the system Back leaves the application from a screen that
  // plainly has a parent.
  private adoptInitialEntry(route: ParsedRoute | null) {
    const snapshot = this.readEntryNavigation();
    if (snapshot) {
      this.navigationHistory.restore(snapshot);
      return;
    }

    if (!route) {
      return;
    }

    this.writeEntryChain(
      this.navigationHistory.resolveEntry(null, route, true),
    );
  }

  // Writing one entry reports an arrival at it, and a chain is written in one
  // synchronous run, so the listeners are held off until it is complete rather
  // than reading the shell's own scaffolding as a person navigating.
  private writeEntryChain(entries: HistoryEntry[]) {
    this.writingEntryChain = true;
    try {
      for (const entry of entries) {
        this.navigationHistory.commit(entry);
        this.writeHistoryEntry(entry.route, entry.action);
      }
    } finally {
      this.writingEntryChain = false;
    }
  }

  private readEntryNavigation() {
    return window.history.state?.caffoldNavigation ?? null;
  }

  // Both paths write through the History API. A chain of entries has to be
  // written synchronously and repeatedly, and state written this way is not
  // readable through `navigation.currentEntry`, so one writer keeps the record
  // in one place. The Navigation API decides only which events are listened
  // for, in `installNavigationHandlers`.
  private writeHistoryEntry(
    route: ParsedRoute | null | undefined,
    action: string,
  ) {
    const url = routeUrl(route);
    const state = { caffoldNavigation: this.navigationHistory.snapshot() };
    if (action === NAVIGATION_HISTORY_ACTION.PUSH) {
      window.history.pushState(state, "", url);
    } else {
      window.history.replaceState(state, "", url);
    }
  }

  private async bootstrap() {
    this.setBootstrapError(null);
    try {
      const health = await getHealth();
      this.initialPath = health.initialPath ?? "";
      this.taskWorkspace.setServerPaths({
        root: health.root ?? "",
        homePath: health.homePath ?? null,
      });
      this.updateBuildStatus(health);
      void this.refreshCaffoldUpdate();
      const route = parseRoute(window.location.href);
      if (route) {
        await this.applyRoute(route);
      } else {
        this.navigateToRoute({ kind: "tasks" });
      }
      this.foregroundRecoveryLifecycle.connect();
      return await this.foregroundRecoveryLifecycle.requestInitialActivation({
        discarded: Boolean(
          (document as Document & { wasDiscarded?: boolean }).wasDiscarded,
        ),
      });
    } catch (error) {
      this.updateBuildStatus(null);
      this.setBootstrapError(error as { message?: string });
    }
  }

  private async recoverForeground({
    activationRoute,
    initialActivation,
    isCurrent,
    progress,
  }: ForegroundRecoveryRequest) {
    const route = notificationActivationRoute(activationRoute);
    const currentRoute = parseRoute(window.location.href) ?? this.currentRoute;
    if (
      route &&
      (!currentRoute?.threadId || currentRoute.threadId !== route.threadId)
    ) {
      progress.activatingRoute();
      await this.applyRoute(route, { activation: true });
    }
    if (!isCurrent()) {
      return { stale: true };
    }
    const recoveryRoute = parseRoute(window.location.href) ?? this.currentRoute;
    const recoveryRouteKey = recoveryRoute ? routeUrl(recoveryRoute) : "";
    const recovery = await this.taskWorkspace.recoverForeground({
      isCurrent: () => {
        const current = parseRoute(window.location.href) ?? this.currentRoute;
        return (
          isCurrent() &&
          Boolean(current) &&
          routeUrl(current as ParsedRoute) === recoveryRouteKey
        );
      },
      initialActivation,
      progress,
    });
    // Caffold answering again may mean an update just ended, so a window left
    // open learns how. Asking only after recovery succeeded keeps a server that
    // is still down from showing as a failed check, and recovery never waits.
    if (!initialActivation && !recovery?.stale && !recovery?.retry) {
      void this.refreshCaffoldUpdate();
    }
    return recovery;
  }

  private applyForegroundRecoverySnapshot(
    snapshot: ForegroundRecoverySnapshot | null,
  ) {
    this.foregroundRecoverySnapshot =
      snapshot ?? this.foregroundRecoveryLifecycle?.snapshot() ?? null;
    this.draw();
  }

  private applyPwaUpdateStatus(status: Partial<PwaUpdateStatus> | null) {
    const state = status?.state;
    this.pwaUpdateStatus = {
      state:
        state === "checking" || state === "ready" || state === "settled"
          ? state
          : "checking",
      preparedUpdate: {
        ready: Boolean(status?.preparedUpdate?.ready),
        buildId: status?.preparedUpdate?.buildId ?? null,
      },
      diagnostics: normalizePwaUpdateDiagnostics(status?.diagnostics),
    };
    const preparedUpdate = this.pwaUpdateStatus.preparedUpdate;
    this.taskWorkspace.setUpdateStatus(this.pwaUpdateStatus);
    this.draw();
    if (!preparedUpdate.ready) {
      this.updateDialog.value?.close();
      return;
    }
    if (!this.presentedUpdateBuildIds.has(preparedUpdate.buildId)) {
      this.presentedUpdateBuildIds.add(preparedUpdate.buildId);
      this.keyboardNavigation.cancelStoredMode("interaction-owner", {
        restoreFocus: false,
      });
      this.updateDialog.value?.open();
    }
  }

  private async applyRoute(
    route: ParsedRoute,
    { keyboardPrepared = false, activation = false } = {},
  ) {
    if (!keyboardPrepared) {
      this.keyboardNavigation.routeWillChange();
    }
    // A rewind this shell asked for has arrived, and a destination may still
    // correct itself while it opens.
    this.rewindingHistory = false;
    const previousRoute = this.currentRoute;
    this.currentRoute = route;
    if (window.location.pathname + window.location.search !== routeUrl(route)) {
      this.writeEntryChain(
        activation
          ? this.navigationHistory.resolveEntry(previousRoute, route, false)
          : this.navigationHistory.resolveCorrection(previousRoute, route),
      );
    }
    this.setBootstrapError(null);
    await this.taskWorkspace.openRoute(route, {
      defaultCwdPath: this.initialPath || ".",
    });
    if (route.kind === "settings" && route.section === "about") {
      void this.refreshAboutStatus();
    }
    return true;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private get taskWorkspace() {
    return this.workspace.value as CaffoldTaskWorkspace;
  }
}

/** Which failed update this browser has told, so it tells each one once. */
const SEEN_UPDATE_RESULT_KEY = "caffold:update-result-seen";

function seenUpdateResult() {
  try {
    return window.localStorage.getItem(SEEN_UPDATE_RESULT_KEY);
  } catch {
    return null;
  }
}

function rememberSeenUpdateResult(id: string) {
  try {
    window.localStorage.setItem(SEEN_UPDATE_RESULT_KEY, id);
  } catch {
    // A browser that cannot store it tells the same result again next time.
  }
}

function normalizePwaUpdateDiagnostics(
  diagnostics: Record<string, unknown> | null | undefined,
) {
  const attempts = diagnostics?.navigationAttemptCount;
  return {
    handoffNode: diagnosticString(diagnostics?.handoffNode),
    targetBuildId: diagnosticString(diagnostics?.targetBuildId),
    controllerBuildId: diagnosticString(diagnostics?.controllerBuildId),
    activeBuildId: diagnosticString(diagnostics?.activeBuildId),
    waitingBuildId: diagnosticString(diagnostics?.waitingBuildId),
    navigationAttemptCount:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 0
        ? attempts
        : 0,
    lastNavigationAttemptBuildId: diagnosticString(
      diagnostics?.lastNavigationAttemptBuildId,
    ),
  };
}

function diagnosticString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function notificationActivationRoute(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) {
    return null;
  }
  const route = parseRoute(url.href);
  if (!route?.threadId || routeUrl(route) !== url.pathname + url.search) {
    return null;
  }
  return route;
}

await busySpin.register(
  "caffold-app-shell",
  "> .app-foreground-recovery > .app-foreground-recovery-spinner",
);

customElements.define("caffold-app-shell", CaffoldAppShell);
