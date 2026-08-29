const scopesByGateway = new WeakMap();
const WATCH_RETRY_DELAY_MS = 3_000;

export function subscribeToWatch(liveUpdates, path, listener) {
  if (!liveUpdates?.subscribeWatch) {
    queueMicrotask(() => listener.onError?.(new Error("Live updates are unavailable.")));
    return () => {};
  }

  let scopes = scopesByGateway.get(liveUpdates);
  if (!scopes) {
    scopes = new Map();
    scopesByGateway.set(liveUpdates, scopes);
  }
  const key = path ?? "";
  let scope = scopes.get(key);
  if (!scope) {
    scope = createScope(liveUpdates, key);
    scopes.set(key, scope);
  }

  scope.listeners.add(listener);
  if (scope.ready) {
    queueMicrotask(() => listener.onReady?.({ ...scope.ready, recovered: false }));
  } else if (scope.unavailable) {
    queueMicrotask(() => listener.onError?.(scope.error));
  }

  return () => {
    scope.listeners.delete(listener);
    if (scope.listeners.size > 0) {
      return;
    }
    window.clearTimeout(scope.retryTimer);
    scope.binding?.close();
    scopes.delete(key);
  };
}

export function createRefreshCoordinator(refresh, onState = () => {}) {
  let active = null;
  let dirty = false;

  async function run() {
    onState("refreshing");
    try {
      do {
        dirty = false;
        await refresh();
      } while (dirty);
      onState("idle");
    } catch (error) {
      onState("error", error);
    } finally {
      active = null;
    }
  }

  return {
    request() {
      if (active) {
        dirty = true;
        return active;
      }
      active = run();
      return active;
    },
    get active() {
      return Boolean(active);
    },
  };
}

export function watchChangeAffectsPath(change, path) {
  const target = normalizeWatchPath(path);
  if (!target) {
    return false;
  }
  if (change?.overflow) {
    return true;
  }

  const paths = Array.isArray(change?.paths) ? change.paths : [];
  if (paths.length === 0) {
    return true;
  }

  return paths.some((path) => {
    const changed = normalizeWatchPath(path);
    return (
      !changed ||
      changed === target ||
      target.startsWith(`${changed}/`) ||
      changed.startsWith(`${target}/`)
    );
  });
}

function createScope(liveUpdates, path) {
  const scope = {
    liveUpdates,
    path,
    binding: null,
    listeners: new Set(),
    ready: null,
    unavailable: false,
    error: null,
    hasConnected: false,
    retryTimer: null,
  };

  connectScope(scope);
  return scope;
}

function connectScope(scope) {
  if (scope.binding) {
    return;
  }

  scope.binding = scope.liveUpdates.subscribeWatch(scope.path, {
    onEvent: (type, payload) => acceptWatchEvent(scope, type, payload),
    onError: (error, { closed = false, physical = false } = {}) => {
      markUnavailable(scope, error);
      if (closed && !physical) {
        scheduleWatchRetry(scope);
      }
    },
    onInvalidated: () => {
      markUnavailable(scope, new Error("Live updates are unavailable."));
    },
    onResume: () => {
      if (scope.ready) {
        notify(scope, "onRecover", scope.ready);
      }
    },
  });
}

function acceptWatchEvent(scope, type, payload) {
  if (type === "ready") {
    const recovered = scope.hasConnected && scope.unavailable;
    scope.ready = payload;
    scope.hasConnected = true;
    scope.unavailable = false;
    scope.error = null;
    window.clearTimeout(scope.retryTimer);
    scope.retryTimer = null;
    notify(scope, "onReady", { ...payload, recovered });
    return;
  }
  if (type === "change") {
    if (scope.unavailable) {
      scope.unavailable = false;
      scope.error = null;
      notify(scope, "onReady", { ...scope.ready, recovered: true });
    }
    notify(scope, "onChange", payload);
    return;
  }
  if (type === "watch-error") {
    markUnavailable(
      scope,
      new Error(payload?.message ?? "Live updates are unavailable."),
    );
    scheduleWatchRetry(scope);
  }
}

function scheduleWatchRetry(scope) {
  if (scope.retryTimer !== null || scope.listeners.size === 0) {
    return;
  }
  scope.retryTimer = window.setTimeout(() => {
    scope.retryTimer = null;
    scope.binding?.retry();
  }, WATCH_RETRY_DELAY_MS);
}

function markUnavailable(scope, error) {
  scope.unavailable = true;
  scope.error = error;
  notify(scope, "onError", error);
}

function notify(scope, method, value) {
  for (const listener of scope.listeners) {
    listener[method]?.(value);
  }
}

function normalizeWatchPath(path) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}
