import type {
  LiveSubscription,
  WorkspaceLiveUpdates,
} from "./pages/(task-workspace)/live-updates.js";

export type RefreshState = "refreshing" | "idle" | "error";

export interface RefreshCoordinator {
  request(): Promise<void>;
  readonly active: boolean;
}

export interface WatchChange {
  revision?: number;
  paths?: string[];
  overflow?: boolean;
  gitStatusChanged?: boolean;
  gitRefsChanged?: boolean;
}

// What the server says when a watch is ready: its revision and the scope it
// covers.
interface WatchReady {
  revision?: number;
  scopePath?: string;
  repositoryRootPath?: string | null;
}

export interface WatchListener {
  onReady?: (ready: WatchReady & { recovered: boolean }) => void;
  onChange?: (change: WatchChange) => void;
  onRecover?: (ready: WatchReady) => void;
  onError?: (error: unknown) => void;
}

type WatchGateway = Pick<WorkspaceLiveUpdates, "subscribeWatch">;

// One path's watch, shared by every listener on the same gateway.
interface WatchScope {
  liveUpdates: WatchGateway;
  path: string;
  binding: LiveSubscription | null;
  listeners: Set<WatchListener>;
  ready: WatchReady | null;
  unavailable: boolean;
  error: unknown;
  hasConnected: boolean;
  retryTimer: number | null;
}

const scopesByGateway = new WeakMap<WatchGateway, Map<string, WatchScope>>();
const WATCH_RETRY_DELAY_MS = 3_000;

export function subscribeToWatch(
  gateway: unknown,
  path: string,
  listener: WatchListener,
) {
  const liveUpdates = gateway as WatchGateway | null | undefined;
  if (!liveUpdates?.subscribeWatch) {
    queueMicrotask(() =>
      listener.onError?.(new Error("Live updates are unavailable.")),
    );
    return () => {};
  }

  let scopes = scopesByGateway.get(liveUpdates);
  if (!scopes) {
    scopes = new Map();
    scopesByGateway.set(liveUpdates, scopes);
  }
  const key = path ?? "";
  const scope = scopes.get(key) ?? createScope(liveUpdates, key);
  scopes.set(key, scope);

  scope.listeners.add(listener);
  if (scope.ready) {
    queueMicrotask(() =>
      listener.onReady?.({ ...scope.ready, recovered: false }),
    );
  } else if (scope.unavailable) {
    queueMicrotask(() => listener.onError?.(scope.error));
  }

  return () => {
    scope.listeners.delete(listener);
    if (scope.listeners.size > 0) {
      return;
    }
    window.clearTimeout(scope.retryTimer ?? undefined);
    scope.binding?.close();
    scopes.delete(key);
  };
}

export function createRefreshCoordinator(
  refresh: () => Promise<void>,
  onState: (state: RefreshState, error?: unknown) => void = () => {},
): RefreshCoordinator {
  let active: Promise<void> | null = null;
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

export function watchChangeAffectsPath(
  change: WatchChange | null | undefined,
  path: string,
) {
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

function createScope(liveUpdates: WatchGateway, path: string) {
  const scope: WatchScope = {
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

function connectScope(scope: WatchScope) {
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

function acceptWatchEvent(scope: WatchScope, type: string, payload: unknown) {
  if (type === "ready") {
    const recovered = scope.hasConnected && scope.unavailable;
    const ready = payload as WatchReady;
    scope.ready = ready;
    scope.hasConnected = true;
    scope.unavailable = false;
    scope.error = null;
    window.clearTimeout(scope.retryTimer ?? undefined);
    scope.retryTimer = null;
    notify(scope, "onReady", { ...ready, recovered });
    return;
  }
  if (type === "change") {
    if (scope.unavailable) {
      scope.unavailable = false;
      scope.error = null;
      notify(scope, "onReady", { ...scope.ready, recovered: true });
    }
    notify(scope, "onChange", payload as WatchChange);
    return;
  }
  if (type === "watch-error") {
    markUnavailable(
      scope,
      new Error(
        (payload as { message?: string } | null)?.message ??
          "Live updates are unavailable.",
      ),
    );
    scheduleWatchRetry(scope);
  }
}

function scheduleWatchRetry(scope: WatchScope) {
  if (scope.retryTimer !== null || scope.listeners.size === 0) {
    return;
  }
  scope.retryTimer = window.setTimeout(() => {
    scope.retryTimer = null;
    scope.binding?.retry();
  }, WATCH_RETRY_DELAY_MS);
}

function markUnavailable(scope: WatchScope, error: unknown) {
  scope.unavailable = true;
  scope.error = error;
  notify(scope, "onError", error);
}

function notify<Method extends keyof WatchListener>(
  scope: WatchScope,
  method: Method,
  value: Parameters<NonNullable<WatchListener[Method]>>[0],
) {
  for (const listener of scope.listeners) {
    (listener[method] as ((ready: typeof value) => void) | undefined)?.(value);
  }
}

function normalizeWatchPath(path: unknown) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}
