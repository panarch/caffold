// One workspace owns one physical EventSource. Domain subscriptions, their
// generations, and their presentation remain orthogonal to this connection
// graph.
export const LIVE_CONNECTION_NODE = Object.freeze({
  DETACHED: "detached",
  SUSPENDED: "suspended",
  CONNECTING: "connecting",
  // The attempt's first connection gave no first answer in time, and a fresh
  // connection replaced it at once.
  REOPENED: "reopened",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  // The bounded retry is spent. While the page is visible, a fresh attempt
  // follows each automatic retry delay, and Retry starts one at once.
  UNAVAILABLE: "unavailable",
});

export const LIVE_CONNECTION_EVENT = Object.freeze({
  CONNECT: "connect",
  READY: "ready",
  ERROR: "error",
  // The current connection gave no first answer within its time limit.
  STALL: "stall",
  // A channel sent on the connected source has not opened, and nothing has
  // arrived for the channel limit, so the connection is no longer delivering.
  UNDELIVERED: "undelivered",
  REPLACE: "replace",
  EXHAUST: "exhaust",
  RETRY: "retry",
  // The automatic retry delay of an unavailable connection ended.
  RETRY_DUE: "retry-due",
  SUSPEND: "suspend",
  RESUME: "resume",
  DISCONNECT: "disconnect",
});

export const LIVE_CONNECTION_EFFECT = Object.freeze({
  OPEN: "open",
  SETTLE: "settle",
  WAIT_TO_REPLACE: "wait-to-replace",
  REOPEN: "reopen",
  REPLACE_NOW: "replace-now",
  CLOSE: "close",
  WAIT_TO_RETRY: "wait-to-retry",
});

export type LiveConnectionNode =
  (typeof LIVE_CONNECTION_NODE)[keyof typeof LIVE_CONNECTION_NODE];

export type LiveConnectionEvent =
  (typeof LIVE_CONNECTION_EVENT)[keyof typeof LIVE_CONNECTION_EVENT];

export type LiveConnectionEffect =
  (typeof LIVE_CONNECTION_EFFECT)[keyof typeof LIVE_CONNECTION_EFFECT];

// This is the complete allowed-edge graph. A rejected event leaves the node
// unchanged and starts no effect.
export const LIVE_CONNECTION_EDGES: Readonly<
  Record<
    LiveConnectionNode,
    Readonly<Partial<Record<LiveConnectionEvent, LiveConnectionNode>>>
  >
> = Object.freeze({
  [LIVE_CONNECTION_NODE.DETACHED]: Object.freeze({
    [LIVE_CONNECTION_EVENT.CONNECT]: LIVE_CONNECTION_NODE.CONNECTING,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
  }),
  [LIVE_CONNECTION_NODE.SUSPENDED]: Object.freeze({
    [LIVE_CONNECTION_EVENT.RESUME]: LIVE_CONNECTION_NODE.CONNECTING,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
  [LIVE_CONNECTION_NODE.CONNECTING]: Object.freeze({
    [LIVE_CONNECTION_EVENT.READY]: LIVE_CONNECTION_NODE.CONNECTED,
    [LIVE_CONNECTION_EVENT.ERROR]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.STALL]: LIVE_CONNECTION_NODE.REOPENED,
    [LIVE_CONNECTION_EVENT.EXHAUST]: LIVE_CONNECTION_NODE.UNAVAILABLE,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
  [LIVE_CONNECTION_NODE.REOPENED]: Object.freeze({
    [LIVE_CONNECTION_EVENT.READY]: LIVE_CONNECTION_NODE.CONNECTED,
    [LIVE_CONNECTION_EVENT.ERROR]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.STALL]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
  [LIVE_CONNECTION_NODE.CONNECTED]: Object.freeze({
    [LIVE_CONNECTION_EVENT.READY]: LIVE_CONNECTION_NODE.CONNECTED,
    [LIVE_CONNECTION_EVENT.ERROR]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.UNDELIVERED]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
  [LIVE_CONNECTION_NODE.RECONNECTING]: Object.freeze({
    [LIVE_CONNECTION_EVENT.READY]: LIVE_CONNECTION_NODE.CONNECTED,
    [LIVE_CONNECTION_EVENT.ERROR]: LIVE_CONNECTION_NODE.RECONNECTING,
    [LIVE_CONNECTION_EVENT.REPLACE]: LIVE_CONNECTION_NODE.CONNECTING,
    [LIVE_CONNECTION_EVENT.EXHAUST]: LIVE_CONNECTION_NODE.UNAVAILABLE,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
  [LIVE_CONNECTION_NODE.UNAVAILABLE]: Object.freeze({
    [LIVE_CONNECTION_EVENT.RETRY]: LIVE_CONNECTION_NODE.CONNECTING,
    [LIVE_CONNECTION_EVENT.RETRY_DUE]: LIVE_CONNECTION_NODE.CONNECTING,
    [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_NODE.SUSPENDED,
    [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_NODE.DETACHED,
  }),
});

export function transitionLiveConnection(
  node: LiveConnectionNode,
  event: LiveConnectionEvent,
): { node: LiveConnectionNode; effects: LiveConnectionEffect[] } {
  const next = LIVE_CONNECTION_EDGES[node]?.[event] ?? node;
  if (
    next === node &&
    !Object.hasOwn(LIVE_CONNECTION_EDGES[node] ?? {}, event)
  ) {
    return { node, effects: [] };
  }
  return {
    node: next,
    effects: effectsFor(node, event),
  };
}

function effectsFor(
  node: LiveConnectionNode,
  event: LiveConnectionEvent,
): LiveConnectionEffect[] {
  if (
    (
      [
        LIVE_CONNECTION_EVENT.CONNECT,
        LIVE_CONNECTION_EVENT.REPLACE,
        LIVE_CONNECTION_EVENT.RETRY,
        LIVE_CONNECTION_EVENT.RETRY_DUE,
        LIVE_CONNECTION_EVENT.RESUME,
      ] as LiveConnectionEvent[]
    ).includes(event)
  ) {
    return [LIVE_CONNECTION_EFFECT.OPEN];
  }
  if (event === LIVE_CONNECTION_EVENT.READY) {
    return [LIVE_CONNECTION_EFFECT.SETTLE];
  }
  if (event === LIVE_CONNECTION_EVENT.ERROR) {
    return [LIVE_CONNECTION_EFFECT.WAIT_TO_REPLACE];
  }
  // Nothing waits on a silent connection: the browser is not retrying it. An
  // attempt swaps its first one for a fresh connection and ends on the second,
  // so an attempt lasts as long as one connection plus its retry grace.
  if (event === LIVE_CONNECTION_EVENT.STALL) {
    return node === LIVE_CONNECTION_NODE.CONNECTING
      ? [LIVE_CONNECTION_EFFECT.REOPEN]
      : [LIVE_CONNECTION_EFFECT.REPLACE_NOW];
  }
  // A connection that stopped delivering is not retried by the browser either,
  // so it is replaced within the bounded retry.
  if (event === LIVE_CONNECTION_EVENT.UNDELIVERED) {
    return [LIVE_CONNECTION_EFFECT.REPLACE_NOW];
  }
  // A spent retry does not give up: the next attempt waits for a longer delay.
  if (event === LIVE_CONNECTION_EVENT.EXHAUST) {
    return [LIVE_CONNECTION_EFFECT.CLOSE, LIVE_CONNECTION_EFFECT.WAIT_TO_RETRY];
  }
  if (
    (
      [
        LIVE_CONNECTION_EVENT.DISCONNECT,
        LIVE_CONNECTION_EVENT.SUSPEND,
      ] as LiveConnectionEvent[]
    ).includes(event)
  ) {
    return [LIVE_CONNECTION_EFFECT.CLOSE];
  }
  return [];
}
