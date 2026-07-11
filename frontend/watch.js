import { watchUrl } from "./api.js";

const scopes = new Map();

export function subscribeToWatch(path, listener) {
  if (!("EventSource" in window)) {
    queueMicrotask(() => listener.onError?.(new Error("Live updates are unavailable.")));
    return () => {};
  }

  const key = path ?? "";
  let scope = scopes.get(key);
  if (!scope) {
    scope = createScope(key);
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
    scope.source.close();
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

function createScope(path) {
  const scope = {
    path,
    source: new EventSource(watchUrl(path)),
    listeners: new Set(),
    ready: null,
    unavailable: false,
    error: null,
    hasConnected: false,
  };

  scope.source.addEventListener("ready", (event) => {
    const ready = parsePayload(event);
    if (!ready) {
      return;
    }
    const recovered = scope.hasConnected && scope.unavailable;
    scope.ready = ready;
    scope.hasConnected = true;
    scope.unavailable = false;
    scope.error = null;
    notify(scope, "onReady", { ...ready, recovered });
  });
  scope.source.addEventListener("change", (event) => {
    const change = parsePayload(event);
    if (change) {
      if (scope.unavailable) {
        scope.unavailable = false;
        scope.error = null;
        notify(scope, "onReady", { ...scope.ready, recovered: true });
      }
      notify(scope, "onChange", change);
    }
  });
  scope.source.addEventListener("watch-error", (event) => {
    const payload = parsePayload(event);
    markUnavailable(scope, new Error(payload?.message ?? "Live updates are unavailable."));
  });
  scope.source.addEventListener("error", () => {
    markUnavailable(scope, new Error("Live updates are unavailable."));
  });

  return scope;
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

function parsePayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    return;
  }
  for (const scope of scopes.values()) {
    if (scope.ready) {
      notify(scope, "onRecover", scope.ready);
    }
  }
});
