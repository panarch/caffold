import { getHealth } from "../api.js";
import { BUILD_INFO } from "../build-info.js";
import { renderInlineIcon, warmIcons } from "../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "../action-hints.js";
import {
  KeyboardNavigationController,
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "../keyboard-navigation.js";
import { CAFFOLD_ORIGIN_REACHABLE_EVENT } from "../origin-reachability.js";
import { getSettings } from "../settings.js";
import {
  parseRoute,
  routeEquals,
  routeUrl,
} from "../navigation-routes.js";
import {
  NAVIGATION_HISTORY_ACTION,
  NavigationHistory,
} from "./navigation-history.js";
import {
  ForegroundRecoveryLifecycle,
  FOREGROUND_RECOVERY_PRESENTATION,
} from "./foreground-recovery.js";
import { CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT } from "./components/build-mismatch-alert.js";
import { PwaUpdateLifecycle } from "./pwa-update-lifecycle.js";
import {
  CAFFOLD_UPDATE_LATER_EVENT,
  CAFFOLD_UPDATE_RELOAD_EVENT,
} from "./components/update-dialog.js";
import "../keyboard-navigation/components/presentation.js";
import "../keyboard-navigation/components/shortcut-dialog.js";
import "./(task-workspace)/layout.js";

class CaffoldAppShell extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
      window.addEventListener(
        CAFFOLD_ORIGIN_REACHABLE_EVENT,
        this.boundOriginReachable,
      );
      this.pwaUpdateLifecycle?.connect();
      this.foregroundRecoveryLifecycle?.connect();
      this.keyboardNavigation?.connect();
      queueMicrotask(() => {
        void this.foregroundRecoveryLifecycle?.requestForegroundRecovery();
      });
      return;
    }

    this.initialized = true;
    this.foregroundRecoverySnapshot = null;
    this.boundIconsReady = () => this.renderForegroundRecoveryIcon();
    this.boundOriginReachable = () => {
      void this.foregroundRecoveryLifecycle?.reportOriginReachable();
    };
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.currentRoute = null;
    this.navigationHistory = new NavigationHistory();
    this.rewindingHistory = false;
    this.writingEntryChain = false;
    this.initialPath = "";
    this.aboutHealthRequest = null;
    this.buildHealth = null;
    this.presentedUpdateBuildIds = new Set();
    this.pwaUpdateStatus = {
      state: "checking",
      preparedUpdate: { ready: false, buildId: null },
      diagnostics: emptyPwaUpdateDiagnostics(),
    };
    this.render();
    this.taskWorkspace = this.querySelector("caffold-task-workspace");
    this.taskWorkspace.ensureRendered();
    this.updateDialog = this.querySelector(":scope > caffold-update-dialog");
    this.buildMismatchAlert = this.querySelector(
      ":scope > caffold-build-mismatch-alert",
    );
    this.keyboardNavigationPresentation = this.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    this.keyboardShortcutDialog = this.querySelector(
      ":scope > caffold-keyboard-shortcut-dialog",
    );
    this.keyboardNavigation = new KeyboardNavigationController({
      workspace: this,
      collectKeyboardNavigationContexts: () =>
        this.keyboardNavigationContexts(),
      shortcutDialog: this.keyboardShortcutDialog,
      afterActionHintActivation: (target) =>
        this.taskWorkspace.afterActionHintActivation(target),
      openTaskSwitcher: () => this.taskWorkspace.openTaskSwitcher(),
      readSettings: () => getSettings(),
    });
    this.actionHints = this.keyboardNavigation.actionHints;
    this.keyboardNavigation.connect();
    this.pwaUpdateLifecycle = new PwaUpdateLifecycle({
      currentBuildId: BUILD_INFO.id,
      onReloadReady: () => window.location.reload(),
      onStatusChange: (status) => this.applyPwaUpdateStatus(status),
    });
    this.foregroundRecoveryLifecycle = new ForegroundRecoveryLifecycle({
      onRecover: (request) => this.recoverForeground(request),
      onStateChange: (snapshot) =>
        this.applyForegroundRecoverySnapshot(snapshot),
      onSuspend: () => this.taskWorkspace.suspendForeground(),
    });
    window.addEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.boundOriginReachable,
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
        section: event.detail?.section ?? "",
      });
    });
    this.addEventListener("caffold:open-about", () => {
      this.navigateToRoute({ kind: "settings", section: "about" });
    });
    this.addEventListener("caffold:request-tasks-route", (event) => {
      this.navigateToRoute(event.detail?.route, {
        correction: Boolean(event.detail?.correction),
      });
    });
    this.addEventListener("caffold:request-settings-route", (event) => {
      this.navigateToRoute(event.detail?.route);
    });
    this.addEventListener("caffold:request-workspace-route", (event) => {
      this.navigateToRoute(event.detail?.route);
    });
    this.addEventListener("caffold:request-workspace-tab", (event) => {
      this.navigateToRoute(
        this.navigationHistory.routeForTab(
          event.detail?.tab,
          event.detail?.fallbackRoute,
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
    this.addEventListener(CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT, (event) => {
      event.stopPropagation();
      window.location.reload();
    });
    this.addEventListener("caffold:task-transport-status", (event) => {
      event.stopPropagation();
      this.foregroundRecoveryLifecycle?.setTargets(event.detail?.targets);
    });
    void this.pwaUpdateLifecycle.start();
    void warmIcons();
    this.bootstrap();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    window.removeEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.boundOriginReachable,
    );
    this.pwaUpdateLifecycle?.disconnect();
    this.foregroundRecoveryLifecycle?.disconnect();
    this.keyboardNavigation?.disconnect();
  }

  render() {
    this.innerHTML = `
      <main class="app-main" aria-label="Workspace">
        <caffold-task-workspace></caffold-task-workspace>
        <section class="app-bootstrap-error" role="alert" hidden>
          <h1>Caffold is unavailable</h1>
          <p data-bootstrap-error-message></p>
          <button type="button" data-action="retry-bootstrap">Retry</button>
        </section>
      </main>
      <section
        class="app-foreground-recovery"
        role="status"
        aria-live="polite"
        data-recovery-state="none"
        hidden
      >
        <span class="app-foreground-recovery-spinner" aria-hidden="true"></span>
        <span class="app-foreground-recovery-icon" data-foreground-recovery-icon hidden></span>
        <span data-foreground-recovery-message></span>
        <button type="button" data-action="retry-foreground-recovery" hidden>Retry</button>
      </section>
      <caffold-update-dialog></caffold-update-dialog>
      <caffold-build-mismatch-alert hidden></caffold-build-mismatch-alert>
      <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      <caffold-keyboard-shortcut-dialog></caffold-keyboard-shortcut-dialog>
    `;
    this.querySelector('[data-action="retry-bootstrap"]')?.addEventListener(
      "click",
      () => void this.bootstrap(),
    );
    this.querySelector('[data-action="retry-foreground-recovery"]')
      ?.addEventListener("click", () => {
        void this.foregroundRecoveryLifecycle?.requestManualRetry();
      });
    this.renderForegroundRecoveryIcon();
  }

  refreshAboutStatus() {
    void this.pwaUpdateLifecycle.checkForUpdate();
    if (this.aboutHealthRequest) {
      return this.aboutHealthRequest;
    }

    const request = getHealth()
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

  installNavigationHandlers() {
    this.usesNavigationApi =
      "navigation" in window &&
      typeof window.navigation?.addEventListener === "function";

    if (this.usesNavigationApi) {
      window.navigation.addEventListener("navigate", (event) => {
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
      window.navigation.addEventListener("currententrychange", () => {
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
  adoptReachedEntry(route) {
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
  adoptInitialEntry(route) {
    const snapshot = this.readEntryNavigation();
    if (snapshot) {
      this.navigationHistory.restore(snapshot);
      return;
    }

    if (!route) {
      return;
    }

    this.writeEntryChain(this.navigationHistory.resolveEntry(null, route, true));
  }

  // Writing one entry reports an arrival at it, and a chain is written in one
  // synchronous run, so the listeners are held off until it is complete rather
  // than reading the shell's own scaffolding as a person navigating.
  writeEntryChain(entries) {
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

  readEntryNavigation() {
    return window.history.state?.caffoldNavigation ?? null;
  }

  // Both paths write through the History API. A chain of entries has to be
  // written synchronously and repeatedly, and state written this way is not
  // readable through `navigation.currentEntry`, so one writer keeps the record
  // in one place. The Navigation API decides only which events are listened
  // for, in `installNavigationHandlers`.
  writeHistoryEntry(route, action) {
    const url = routeUrl(route);
    const state = { caffoldNavigation: this.navigationHistory.snapshot() };
    if (action === NAVIGATION_HISTORY_ACTION.PUSH) {
      window.history.pushState(state, "", url);
    } else {
      window.history.replaceState(state, "", url);
    }
  }

  async bootstrap() {
    this.setBootstrapError(null);
    try {
      const health = await getHealth();
      this.initialPath = health.initialPath ?? "";
      this.updateBuildStatus(health);
      const route = parseRoute(window.location.href);
      if (route) {
        await this.applyRoute(route);
      } else {
        this.navigateToRoute({ kind: "tasks" });
      }
      this.foregroundRecoveryLifecycle.connect();
      return await this.foregroundRecoveryLifecycle.requestInitialActivation({
        discarded: Boolean(document.wasDiscarded),
      });
    } catch (error) {
      this.updateBuildStatus(null);
      this.setBootstrapError(error);
    }
  }

  async recoverForeground({
    activationRoute,
    initialActivation,
    isCurrent,
    progress,
  }) {
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
    return await this.taskWorkspace.recoverForeground({
      isCurrent: () => {
        const current = parseRoute(window.location.href) ?? this.currentRoute;
        return (
          isCurrent() &&
          Boolean(current) &&
          routeUrl(current) === recoveryRouteKey
        );
      },
      initialActivation,
      progress,
    });
  }

  setBootstrapError(error) {
    const panel = this.querySelector(".app-bootstrap-error");
    const message = panel?.querySelector("[data-bootstrap-error-message]");
    if (!panel || !message) {
      return;
    }
    panel.hidden = !error;
    this.taskWorkspace.hidden = Boolean(error);
    message.textContent = error?.message ?? "";
    this.updateForegroundRecoveryNotice();
  }

  applyForegroundRecoverySnapshot(snapshot) {
    this.foregroundRecoverySnapshot = snapshot ??
      this.foregroundRecoveryLifecycle?.snapshot() ?? null;
    this.dataset.foregroundRecoveryTrigger =
      this.foregroundRecoverySnapshot?.lastTrigger ?? "";
    this.updateForegroundRecoveryNotice();
  }

  updateForegroundRecoveryNotice() {
    const notice = this.querySelector(".app-foreground-recovery");
    const message = notice?.querySelector(
      "[data-foreground-recovery-message]",
    );
    const spinner = notice?.querySelector(
      ".app-foreground-recovery-spinner",
    );
    const icon = notice?.querySelector("[data-foreground-recovery-icon]");
    const retry = notice?.querySelector(
      '[data-action="retry-foreground-recovery"]',
    );
    if (!notice || !message || !spinner || !icon || !retry) {
      return;
    }
    const state = this.foregroundRecoverySnapshot?.presentation ??
      FOREGROUND_RECOVERY_PRESENTATION.NONE;
    const bootstrapError = !this.querySelector(".app-bootstrap-error")?.hidden;
    notice.hidden =
      state === FOREGROUND_RECOVERY_PRESENTATION.NONE || bootstrapError;
    notice.dataset.recoveryState = state;
    const unavailable = state === "unavailable";
    const offline = state === "offline";
    spinner.hidden = unavailable || offline;
    icon.hidden = !unavailable && !offline;
    retry.hidden = !unavailable;
    message.textContent = offline
      ? "No network connection. Waiting to reconnect..."
      : unavailable
        ? "Caffold server unavailable."
        : "Reconnecting to Caffold server...";
  }

  renderForegroundRecoveryIcon() {
    const icon = this.querySelector("[data-foreground-recovery-icon]");
    if (icon) {
      icon.innerHTML = renderInlineIcon(
        "TriangleAlert",
        "Connection issue",
        "app-foreground-recovery-icon-svg",
      );
    }
  }

  updateBuildStatus(health) {
    this.buildHealth = health ?? null;
    this.taskWorkspace?.setBuildStatus(this.buildHealth);
    this.pwaUpdateLifecycle?.setServerBuildId(this.buildHealth?.buildId);
    this.renderBuildAlert();
  }

  applyPwaUpdateStatus(status) {
    this.pwaUpdateStatus = {
      state: ["checking", "ready", "settled"].includes(status?.state)
        ? status.state
        : "checking",
      preparedUpdate: {
        ready: Boolean(status?.preparedUpdate?.ready),
        buildId: status?.preparedUpdate?.buildId ?? null,
      },
      diagnostics: normalizePwaUpdateDiagnostics(status?.diagnostics),
    };
    const preparedUpdate = this.pwaUpdateStatus.preparedUpdate;
    this.taskWorkspace?.setUpdateStatus(this.pwaUpdateStatus);
    this.renderBuildAlert();
    const updateDialog = this.updateDialog;
    if (!preparedUpdate.ready) {
      updateDialog?.close();
      return;
    }
    if (!this.presentedUpdateBuildIds.has(preparedUpdate.buildId)) {
      this.presentedUpdateBuildIds.add(preparedUpdate.buildId);
      this.keyboardNavigation?.cancelStoredMode("interaction-owner", {
        restoreFocus: false,
      });
      updateDialog?.open();
    }
  }

  renderBuildAlert() {
    const alert = this.buildMismatchAlert;
    if (!alert) {
      return;
    }
    const serverId = this.buildHealth?.buildId;
    const serverLabel = this.buildHealth?.buildLabel || serverId;
    const mismatch = Boolean(
      serverId &&
        serverId !== BUILD_INFO.id &&
        this.pwaUpdateStatus.state === "settled",
    );
    alert.setStatus(mismatch ? { serverLabel } : null);
  }

  // A requested route decides its own history treatment from where it stands
  // relative to the current one. `correction` marks the requests that only
  // refine the current destination, such as canonicalizing a URL or leaving a
  // subject that turned out to be unreachable.
  navigateToRoute(route, options = {}) {
    if (!route || this.rewindingHistory) {
      return false;
    }

    const entries = options.correction
      ? this.navigationHistory.resolveCorrection(this.currentRoute, route)
      : this.navigationHistory.resolve(this.currentRoute, route);
    this.keyboardNavigation?.routeWillChange();

    const [first] = entries;
    if (first.action === NAVIGATION_HISTORY_ACTION.TRAVERSE) {
      this.rewindingHistory = true;
      this.navigationHistory.commit(first);
      window.history.go(-first.steps);
      return true;
    }

    const applyOptions = { keyboardPrepared: true };
    if (first.action !== NAVIGATION_HISTORY_ACTION.NONE) {
      this.writeEntryChain(entries);
    }
    this.currentRoute = route;
    void this.applyRoute(route, applyOptions);
    return true;
  }

  async applyRoute(route, { keyboardPrepared = false, activation = false } = {}) {
    if (!keyboardPrepared) {
      this.keyboardNavigation?.routeWillChange();
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

  actionHintScope() {
    return mergeActionHintScopes(
      this.bootstrapRetryActionHintScope(),
      this.foregroundRetryActionHintScope(),
      this.buildMismatchAlert?.actionHintScope?.(),
      this.taskWorkspace?.actionHintScope?.(),
    );
  }

  bootstrapRetryActionHintScope() {
    const panel = this.querySelector(":scope > .app-main > .app-bootstrap-error");
    const control = panel?.querySelector('[data-action="retry-bootstrap"]');
    if (!panel || !control) {
      return emptyActionHintScope();
    }
    const visible =
      !panel.hidden &&
      !control.hidden &&
      hasActionHintLayoutBox(control);
    return {
      blocked: false,
      targets: visible ? [buttonActionHintTarget({
        invalidationOwner: this,
        id: "app:bootstrap:retry",
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.textContent?.trim() || "Retry Caffold bootstrap",
        control,
        clipRoots: [panel],
        isActionable: () =>
          this.isConnected &&
          this.querySelector(":scope > .app-main > .app-bootstrap-error") ===
            panel &&
          !panel.hidden &&
          panel.querySelector('[data-action="retry-bootstrap"]') === control &&
          !control.hidden &&
          !control.disabled,
      })] : [],
      mutationRoots: [panel],
      scrollRoots: [],
    };
  }

  foregroundRetryActionHintScope() {
    const notice = this.querySelector(":scope > .app-foreground-recovery");
    const control = notice?.querySelector(
      '[data-action="retry-foreground-recovery"]',
    );
    if (!notice || !control) {
      return emptyActionHintScope();
    }
    const visible =
      !notice.hidden &&
      !control.hidden &&
      notice.dataset.recoveryState === "unavailable" &&
      hasActionHintLayoutBox(control);
    return {
      blocked: false,
      targets: visible ? [buttonActionHintTarget({
        invalidationOwner: this,
        id: "app:foreground-recovery:retry",
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.textContent?.trim() || "Retry foreground recovery",
        control,
        clipRoots: [notice],
        isActionable: () =>
          this.isConnected &&
          this.querySelector(":scope > .app-foreground-recovery") === notice &&
          !notice.hidden &&
          notice.dataset.recoveryState === "unavailable" &&
          notice.querySelector(
            '[data-action="retry-foreground-recovery"]',
          ) === control &&
          !control.hidden &&
          !control.disabled,
      })] : [],
      mutationRoots: [notice],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    const presentation = this.keyboardNavigationPresentation;
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    const workspaceContexts = dialog && hud && selector
      ? [keyboardNavigationContext({
          id: "workspace",
          kind: "workspace",
          root: this,
          actionHints: {
            dialog,
            scope: this.actionHintScope(),
          },
          scroll: {
            hud,
            selector,
            scope: this.taskWorkspace?.scrollSurfaceScope?.(),
          },
          editing: {
            escapeTarget: (editable) =>
              this.taskWorkspace?.contains(editable)
                ? this.taskWorkspace.actionHintEditingEscapeTarget(editable)
                : null,
          },
        })]
      : [];
    return mergeKeyboardNavigationContexts(
      workspaceContexts,
      this.updateDialog?.keyboardNavigationContexts?.() ?? [],
      this.taskWorkspace?.keyboardNavigationContexts?.() ?? [],
    );
  }
}

function normalizePwaUpdateDiagnostics(diagnostics) {
  return {
    handoffNode: diagnosticString(diagnostics?.handoffNode),
    targetBuildId: diagnosticString(diagnostics?.targetBuildId),
    controllerBuildId: diagnosticString(diagnostics?.controllerBuildId),
    activeBuildId: diagnosticString(diagnostics?.activeBuildId),
    waitingBuildId: diagnosticString(diagnostics?.waitingBuildId),
    navigationAttemptCount:
      Number.isInteger(diagnostics?.navigationAttemptCount) &&
      diagnostics.navigationAttemptCount >= 0
        ? diagnostics.navigationAttemptCount
        : 0,
    lastNavigationAttemptBuildId: diagnosticString(
      diagnostics?.lastNavigationAttemptBuildId,
    ),
  };
}

function emptyPwaUpdateDiagnostics() {
  return normalizePwaUpdateDiagnostics(null);
}

function diagnosticString(value) {
  return typeof value === "string" && value ? value : null;
}

customElements.define("caffold-app-shell", CaffoldAppShell);

function notificationActivationRoute(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  let url;
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
