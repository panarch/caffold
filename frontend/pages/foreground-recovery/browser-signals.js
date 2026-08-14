export const FOREGROUND_RECOVERY_BROWSER_SIGNAL = Object.freeze({
  // The document changed between hidden and visible.
  VISIBILITY_CHANGED: "visibility-changed",

  // Page Lifecycle resumed a document that had been frozen.
  DOCUMENT_RESUMED: "document-resumed",

  // The browser restored this document from its back-forward cache.
  BFCACHE_RESTORED: "bfcache-restored",

  // The top-level window lost focus.
  WINDOW_BLURRED: "window-blurred",

  // The top-level window regained focus.
  WINDOW_FOCUSED: "window-focused",

  // Standard browser connectivity changed to offline.
  NETWORK_OFFLINE: "network-offline",

  // Standard browser connectivity changed to online.
  NETWORK_ONLINE: "network-online",

  // Network Information reported a connection-property change.
  CONNECTION_CHANGED: "connection-changed",

  // The service worker focused this page for a validated notification route.
  NOTIFICATION_ACTIVATED: "notification-activated",
});

export class ForegroundRecoveryBrowserSignals {
  constructor({
    documentTarget = document,
    navigatorTarget = navigator,
    notificationMessageType,
    onSignal = () => {},
    serviceWorkerTarget = navigatorTarget.serviceWorker,
    windowTarget = window,
  } = {}) {
    this.documentTarget = documentTarget;
    this.navigatorTarget = navigatorTarget;
    this.connectionTarget = navigatorTarget.connection;
    this.notificationMessageType = notificationMessageType;
    this.onSignal = onSignal;
    this.serviceWorkerTarget = serviceWorkerTarget;
    this.windowTarget = windowTarget;
    this.connected = false;
    this.boundVisibilityChange = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.VISIBILITY_CHANGED);
    this.boundResume = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.DOCUMENT_RESUMED);
    this.boundPageShow = (event) => {
      if (event?.persisted) {
        this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.BFCACHE_RESTORED);
      }
    };
    this.boundBlur = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_BLURRED, {
        focused: false,
      });
    this.boundFocus = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_FOCUSED, {
        focused: true,
      });
    this.boundOffline = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_OFFLINE);
    this.boundOnline = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_ONLINE);
    this.boundConnectionChange = () =>
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.CONNECTION_CHANGED);
    this.boundServiceWorkerMessage = (event) => {
      if (event?.data?.type !== this.notificationMessageType) {
        return;
      }
      this.emit(FOREGROUND_RECOVERY_BROWSER_SIGNAL.NOTIFICATION_ACTIVATED, {
        activationRoute: event.data?.route,
      });
    };
  }

  connect() {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.documentTarget.addEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    this.documentTarget.addEventListener("resume", this.boundResume);
    this.windowTarget.addEventListener("pageshow", this.boundPageShow);
    this.windowTarget.addEventListener("blur", this.boundBlur);
    this.windowTarget.addEventListener("focus", this.boundFocus);
    this.windowTarget.addEventListener("offline", this.boundOffline);
    this.windowTarget.addEventListener("online", this.boundOnline);
    this.connectionTarget?.addEventListener?.(
      "change",
      this.boundConnectionChange,
    );
    this.serviceWorkerTarget?.addEventListener?.(
      "message",
      this.boundServiceWorkerMessage,
    );
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.documentTarget.removeEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    this.documentTarget.removeEventListener("resume", this.boundResume);
    this.windowTarget.removeEventListener("pageshow", this.boundPageShow);
    this.windowTarget.removeEventListener("blur", this.boundBlur);
    this.windowTarget.removeEventListener("focus", this.boundFocus);
    this.windowTarget.removeEventListener("offline", this.boundOffline);
    this.windowTarget.removeEventListener("online", this.boundOnline);
    this.connectionTarget?.removeEventListener?.(
      "change",
      this.boundConnectionChange,
    );
    this.serviceWorkerTarget?.removeEventListener?.(
      "message",
      this.boundServiceWorkerMessage,
    );
  }

  observe(overrides = {}) {
    return Object.freeze({
      focused: overrides.focused ?? this.documentTarget.hasFocus?.() ?? true,
      visibility: this.documentTarget.visibilityState === "visible"
        ? "visible"
        : "hidden",
      network: Object.freeze({
        onlineHint: this.navigatorTarget?.onLine === false ? false : true,
        connectionType: normalizeString(this.connectionTarget?.type),
        effectiveType: normalizeString(this.connectionTarget?.effectiveType),
      }),
    });
  }

  emit(type, { activationRoute = "", ...overrides } = {}) {
    this.onSignal(Object.freeze({
      activationRoute: normalizeActivationRoute(activationRoute),
      observation: this.observe(overrides),
      type,
    }));
  }
}

function normalizeActivationRoute(route) {
  return typeof route === "string" ? route : "";
}

function normalizeString(value) {
  return typeof value === "string" ? value : null;
}
