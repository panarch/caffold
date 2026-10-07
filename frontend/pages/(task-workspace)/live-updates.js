import {
  liveUpdatesUrl,
  updateLiveSubscriptions,
} from "../../api.js";
import { reportOriginReachable } from "../../origin-reachability.js";
import {
  LIVE_CONNECTION_EFFECT,
  LIVE_CONNECTION_EVENT,
  LIVE_CONNECTION_NODE,
  transitionLiveConnection,
} from "./live-updates/lifecycle.js";

// What the workspace raises for each connection report, for the App Shell's
// foreground recovery diagnostics.
export const LIVE_CONNECTION_REPORT_EVENT = "caffold:live-connection-report";

const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);
const LIVE_CHANNELS = Object.freeze([
  "task-list",
  "task-detail",
  "watch",
]);

export class WorkspaceLiveUpdates {
  constructor(options = {}) {
    this.documentTarget = options.documentTarget ?? document;
    this.windowTarget = options.windowTarget ?? window;
    this.createEventSource = options.createEventSource ??
      ((url) => new EventSource(url));
    this.publishSubscriptions = options.publishSubscriptions ??
      updateLiveSubscriptions;
    // Hears each physical connection open, answer, and end, by its number.
    this.onConnectionReport = options.onConnectionReport ?? (() => {});
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.reconnectTimeoutMs =
      options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    this.channelOpenTimeoutMs =
      options.channelOpenTimeoutMs ?? DEFAULT_CHANNEL_OPEN_TIMEOUT_MS;
    this.retryDelaysMs = [
      ...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS),
    ];
    this.node = LIVE_CONNECTION_NODE.DETACHED;
    this.source = null;
    this.sourceGeneration = 0;
    this.connectionId = "";
    this.connectionTimer = null;
    this.reconnectTimer = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    // Set when a connection stopped delivering: the next greeting does not show
    // channels open again, so the attempt ends only when one does.
    this.deliveryPending = false;
    this.controlRevision = 0;
    this.controlDirty = false;
    this.controlPublication = null;
    // Each subscription a publication carried that has not opened yet on this
    // connection, with its deadline.
    this.openChecks = new Map();
    this.channelGenerations = new Map(
      LIVE_CHANNELS.map((channel) => [channel, 0]),
    );
    this.bindings = new Map();
    this.watchBindings = new Map();
    this.watchSequence = 0;
    this.boundVisibilityChange = () => this.handleVisibilityChange();
  }

  connect() {
    if (this.node !== LIVE_CONNECTION_NODE.DETACHED) {
      return;
    }
    this.documentTarget.addEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    this.dispatchConnection(
      this.documentTarget.visibilityState === "visible"
        ? LIVE_CONNECTION_EVENT.CONNECT
        : LIVE_CONNECTION_EVENT.SUSPEND,
    );
  }

  disconnect() {
    if (this.node === LIVE_CONNECTION_NODE.DETACHED) {
      return;
    }
    this.documentTarget.removeEventListener(
      "visibilitychange",
      this.boundVisibilityChange,
    );
    this.dispatchConnection(LIVE_CONNECTION_EVENT.DISCONNECT);
  }

  retry() {
    if (
      this.node !== LIVE_CONNECTION_NODE.UNAVAILABLE ||
      this.documentTarget.visibilityState !== "visible"
    ) {
      return false;
    }
    this.retryAttempt = 0;
    this.deliveryPending = false;
    return this.dispatchConnection(LIVE_CONNECTION_EVENT.RETRY);
  }

  suspend() {
    if (
      this.node === LIVE_CONNECTION_NODE.DETACHED ||
      this.node === LIVE_CONNECTION_NODE.SUSPENDED
    ) {
      return false;
    }
    this.notifyBindings("onSuspend");
    return this.dispatchConnection(LIVE_CONNECTION_EVENT.SUSPEND);
  }

  resume() {
    if (this.documentTarget.visibilityState !== "visible") {
      return false;
    }
    this.retryAttempt = 0;
    this.deliveryPending = false;
    const resumed = this.dispatchConnection(LIVE_CONNECTION_EVENT.RESUME);
    if (resumed) {
      this.notifyBindings("onResume");
    }
    return resumed;
  }

  subscribeTaskList(listener) {
    return this.bind("task-list", "task-list", listener);
  }

  subscribeTaskDetail(threadId, listener) {
    const context = `${threadId ?? ""}`.trim();
    if (!context) {
      throw new Error("Task Detail live updates require a thread ID.");
    }
    return this.bind("task-detail", context, listener);
  }

  subscribeWatch(path, listener) {
    const binding = {
      channel: "watch",
      subscriptionId: `watch-${++this.watchSequence}`,
      context: `${path ?? ""}`,
      generation: this.nextChannelGeneration("watch"),
      listener: listener ?? {},
      closed: false,
      close: () => this.closeBinding(binding),
      retry: () => this.retryBinding(binding),
    };
    this.watchBindings.set(binding.subscriptionId, binding);
    this.subscriptionsChanged();
    this.reportUnavailableBinding(binding);
    return binding;
  }

  bind(channel, context, listener = {}) {
    if (!LIVE_CHANNELS.includes(channel)) {
      throw new Error(`Unsupported live channel: ${channel}`);
    }
    const previous = this.bindings.get(channel);
    if (previous) {
      previous.closed = true;
      this.clearOpenCheck(previous);
      previous.listener.onInvalidated?.();
    }
    const binding = {
      channel,
      context,
      generation: this.nextChannelGeneration(channel),
      listener,
      closed: false,
      close: () => this.closeBinding(binding),
      retry: () => this.retryBinding(binding),
    };
    this.bindings.set(channel, binding);
    this.subscriptionsChanged();
    this.reportUnavailableBinding(binding);
    return binding;
  }

  closeBinding(binding) {
    if (binding.closed) {
      return;
    }
    binding.closed = true;
    this.clearOpenCheck(binding);
    if (binding.channel === "watch") {
      if (this.watchBindings.get(binding.subscriptionId) !== binding) {
        return;
      }
      this.watchBindings.delete(binding.subscriptionId);
    } else {
      if (this.bindings.get(binding.channel) !== binding) {
        return;
      }
      this.bindings.delete(binding.channel);
    }
    this.subscriptionsChanged();
  }

  retryBinding(binding) {
    const current = binding.channel === "watch"
      ? this.watchBindings.get(binding.subscriptionId)
      : this.bindings.get(binding.channel);
    if (binding.closed || current !== binding) {
      return false;
    }
    binding.generation = this.nextChannelGeneration(binding.channel);
    this.subscriptionsChanged();
    return true;
  }

  reportUnavailableBinding(binding) {
    if (this.node !== LIVE_CONNECTION_NODE.UNAVAILABLE) {
      return;
    }
    queueMicrotask(() => {
      if (!binding.closed) {
        binding.listener.onError?.(
          new Error("Live updates are unavailable."),
          { closed: true, exhausted: true, physical: true },
        );
      }
    });
  }

  nextChannelGeneration(channel) {
    const generation = (this.channelGenerations.get(channel) ?? 0) + 1;
    this.channelGenerations.set(channel, generation);
    return generation;
  }

  subscriptionsChanged() {
    this.controlDirty = true;
    void this.flushSubscriptions();
  }

  desiredSubscriptions() {
    const taskList = this.bindings.get("task-list");
    const taskDetail = this.bindings.get("task-detail");
    return {
      controlRevision: this.controlRevision,
      taskList: taskList
        ? { generation: taskList.generation }
        : null,
      taskDetail: taskDetail
        ? {
            generation: taskDetail.generation,
            threadId: taskDetail.context,
          }
        : null,
      watches: [...this.watchBindings.values()]
        .filter((binding) => !binding.closed)
        .map((binding) => ({
          subscriptionId: binding.subscriptionId,
          generation: binding.generation,
          path: binding.context,
        }))
        .sort((left, right) =>
          left.subscriptionId.localeCompare(right.subscriptionId)
        ),
    };
  }

  async flushSubscriptions() {
    if (this.controlPublication || !this.connectionId || !this.controlDirty) {
      return this.controlPublication;
    }
    const sourceGeneration = this.sourceGeneration;
    const connectionId = this.connectionId;
    const publication = (async () => {
      while (
        this.controlDirty &&
        this.isCurrentConnection(sourceGeneration, connectionId)
      ) {
        this.controlDirty = false;
        // The gateway ignores a snapshot whose revision is not newer than the
        // last one it applied, so every snapshot sent, the first after
        // gateway-ready included, takes a new revision.
        this.controlRevision += 1;
        const subscriptions = this.desiredSubscriptions();
        const published = this.publishedBindings();
        try {
          await this.publishSubscriptions(connectionId, subscriptions);
        } catch (error) {
          if (this.isCurrentConnection(sourceGeneration, connectionId)) {
            this.controlDirty = true;
            this.connectionFailed(this.source, sourceGeneration, error);
          }
          return;
        }
        if (this.isCurrentConnection(sourceGeneration, connectionId)) {
          this.expectChannelsOpen(published, sourceGeneration, connectionId);
        }
      }
    })().finally(() => {
      if (this.controlPublication === publication) {
        this.controlPublication = null;
      }
      if (this.controlDirty && this.connectionId) {
        void this.flushSubscriptions();
      }
    });
    this.controlPublication = publication;
    return publication;
  }

  // Each subscription the snapshot about to be sent carries, with the generation
  // it asks for.
  publishedBindings() {
    return [...this.bindings.values(), ...this.watchBindings.values()]
      .filter((binding) => !binding.closed)
      .map((binding) => ({ binding, generation: binding.generation }));
  }

  // The server opens every channel it is given before sending anything else on
  // it, so one that stays unopened means the connection has stopped delivering.
  expectChannelsOpen(published, sourceGeneration, connectionId) {
    if (!Number.isFinite(this.channelOpenTimeoutMs)) {
      return;
    }
    for (const { binding, generation } of published) {
      if (
        channelOpened(binding, generation, connectionId) ||
        this.openChecks.get(binding)?.generation === generation
      ) {
        continue;
      }
      this.clearOpenCheck(binding);
      const timer = this.windowTarget.setTimeout(() => {
        this.openChecks.delete(binding);
        if (
          !binding.closed &&
          binding.generation === generation &&
          !channelOpened(binding, generation, connectionId) &&
          this.isCurrentConnection(sourceGeneration, connectionId)
        ) {
          this.connectionUndelivered(this.source, sourceGeneration);
        }
      }, Math.max(0, this.channelOpenTimeoutMs));
      this.openChecks.set(binding, { generation, timer });
    }
  }

  clearOpenCheck(binding) {
    const check = this.openChecks.get(binding);
    if (check) {
      this.windowTarget.clearTimeout(check.timer);
      this.openChecks.delete(binding);
    }
  }

  clearOpenChecks() {
    for (const check of this.openChecks.values()) {
      this.windowTarget.clearTimeout(check.timer);
    }
    this.openChecks.clear();
  }

  handleVisibilityChange() {
    if (this.documentTarget.visibilityState !== "visible") {
      this.suspend();
      return;
    }
    this.resume();
  }

  dispatchConnection(event) {
    const transition = transitionLiveConnection(this.node, event);
    if (transition.node === this.node && transition.effects.length === 0) {
      return false;
    }
    const previousNode = this.node;
    this.node = transition.node;
    for (const effect of transition.effects) {
      this.runConnectionEffect(effect, { event, previousNode });
    }
    return true;
  }

  runConnectionEffect(effect, context) {
    if (effect === LIVE_CONNECTION_EFFECT.OPEN) {
      this.openConnection();
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.SETTLE) {
      this.clearConnectionTimer();
      this.clearReconnectTimer();
      this.clearRetryTimer();
      if (!this.deliveryPending) {
        this.retryAttempt = 0;
      }
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.WAIT_TO_REPLACE) {
      this.reportConnectionTrouble(context.previousNode);
      this.waitToReplaceConnection();
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.REOPEN) {
      this.reportConnectionTrouble(context.previousNode);
      this.closeSource();
      this.openConnection();
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.REPLACE_NOW) {
      this.reportConnectionTrouble(context.previousNode);
      this.clearReconnectTimer();
      this.replaceConnection();
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.CLOSE) {
      if (context.event === LIVE_CONNECTION_EVENT.EXHAUST) {
        this.notifyBindings(
          "onError",
          new Error("Live updates are unavailable."),
          { closed: true, exhausted: true, physical: true },
        );
      }
      this.closeConnection();
    }
  }

  // Consumers hear of trouble when an attempt's first connection fails or goes
  // silent, not again while that attempt replaces it.
  reportConnectionTrouble(previousNode) {
    if (
      [
        LIVE_CONNECTION_NODE.REOPENED,
        LIVE_CONNECTION_NODE.RECONNECTING,
      ].includes(previousNode)
    ) {
      return;
    }
    this.notifyBindings(
      "onError",
      new Error("Live updates are unavailable."),
      { closed: false, physical: true },
    );
  }

  openConnection() {
    if (
      this.source ||
      this.documentTarget.visibilityState !== "visible" ||
      ![
        LIVE_CONNECTION_NODE.CONNECTING,
        LIVE_CONNECTION_NODE.REOPENED,
        LIVE_CONNECTION_NODE.RECONNECTING,
      ].includes(this.node)
    ) {
      return;
    }
    const generation = ++this.sourceGeneration;
    let source;
    try {
      source = this.createEventSource(liveUpdatesUrl());
    } catch (error) {
      this.connectionFailed(null, generation, error);
      return;
    }
    this.source = source;
    this.connectionId = "";
    this.onConnectionReport({ kind: "opened", id: generation });
    source.addEventListener("open", () => {
      if (this.isCurrentSource(source, generation)) {
        reportOriginReachable();
      }
    });
    source.addEventListener("gateway-ready", (event) => {
      this.acceptGatewayReady(source, generation, event);
    });
    source.addEventListener("live-update", (event) => {
      this.acceptLiveUpdate(source, generation, event);
    });
    source.addEventListener("error", () => {
      this.connectionFailed(source, generation);
    });
    this.startConnectionTimer(source, generation);
  }

  acceptGatewayReady(source, generation, event) {
    if (!this.isCurrentSource(source, generation)) {
      return;
    }
    const message = parsePayload(event);
    const connectionId = `${message?.connectionId ?? ""}`.trim();
    if (!connectionId) {
      this.connectionFailed(
        source,
        generation,
        new Error("Live gateway did not identify its connection."),
      );
      return;
    }
    this.connectionId = connectionId;
    this.controlDirty = true;
    this.onConnectionReport({ kind: "answered", id: generation });
    this.dispatchConnection(LIVE_CONNECTION_EVENT.READY);
    void this.flushSubscriptions();
  }

  acceptLiveUpdate(source, sourceGeneration, event) {
    if (!this.isCurrentSource(source, sourceGeneration)) {
      return;
    }
    const message = parsePayload(event);
    const channel = message?.channel;
    const binding = channel === "watch"
      ? this.watchBindings.get(message?.subscriptionId)
      : this.bindings.get(channel);
    if (
      !binding ||
      binding.closed ||
      message?.generation !== binding.generation ||
      typeof message?.type !== "string"
    ) {
      return;
    }
    if (message.type === "channel-open") {
      binding.openedOn = {
        connectionId: this.connectionId,
        generation: message.generation,
      };
      this.clearOpenCheck(binding);
      if (this.deliveryPending) {
        this.deliveryPending = false;
        this.retryAttempt = 0;
      }
      binding.listener.onOpen?.();
      return;
    }
    if (message.type === "channel-error") {
      binding.listener.onError?.(
        new Error(
          message.payload?.message ?? `${channel} live updates are unavailable.`,
        ),
        { closed: true, physical: false },
      );
      return;
    }
    binding.listener.onEvent?.(message.type, message.payload);
  }

  connectionFailed(source, generation, _error = null) {
    if (
      source
        ? !this.isCurrentSource(source, generation)
        : generation !== this.sourceGeneration
    ) {
      return;
    }
    this.releaseConnection();
    if (source) {
      this.onConnectionReport({ kind: "failed", id: generation });
    }
    this.dispatchConnection(LIVE_CONNECTION_EVENT.ERROR);
  }

  connectionStalled(source, generation) {
    if (!this.isCurrentSource(source, generation)) {
      return;
    }
    this.releaseConnection();
    this.onConnectionReport({ kind: "stalled", id: generation });
    this.dispatchConnection(LIVE_CONNECTION_EVENT.STALL);
  }

  connectionUndelivered(source, generation) {
    if (!this.isCurrentSource(source, generation)) {
      return;
    }
    this.releaseConnection();
    this.deliveryPending = true;
    this.onConnectionReport({ kind: "stalled", id: generation });
    this.dispatchConnection(LIVE_CONNECTION_EVENT.UNDELIVERED);
  }

  releaseConnection() {
    this.clearConnectionTimer();
    this.clearOpenChecks();
    this.connectionId = "";
    this.controlPublication = null;
    this.controlDirty = true;
  }

  waitToReplaceConnection() {
    if (this.reconnectTimer !== null) {
      return;
    }
    const source = this.source;
    const generation = this.sourceGeneration;
    const delay = !source || source.readyState === 2
      ? 0
      : this.reconnectTimeoutMs;
    this.reconnectTimer = this.windowTarget.setTimeout(() => {
      if (!this.isCurrentSource(source, generation)) {
        return;
      }
      this.reconnectTimer = null;
      this.replaceConnection();
    }, Math.max(0, delay));
  }

  replaceConnection() {
    this.closeSource();
    const delayMs = this.retryDelaysMs[this.retryAttempt];
    if (!Number.isFinite(delayMs)) {
      this.dispatchConnection(LIVE_CONNECTION_EVENT.EXHAUST);
      return;
    }
    this.retryAttempt += 1;
    this.retryTimer = this.windowTarget.setTimeout(() => {
      this.retryTimer = null;
      this.dispatchConnection(LIVE_CONNECTION_EVENT.REPLACE);
    }, Math.max(0, delayMs));
  }

  closeConnection() {
    this.clearConnectionTimer();
    this.clearReconnectTimer();
    this.clearRetryTimer();
    this.closeSource();
  }

  closeSource() {
    const source = this.source;
    this.source = null;
    this.clearOpenChecks();
    this.connectionId = "";
    this.controlPublication = null;
    if (source) {
      this.onConnectionReport({ kind: "closed", id: this.sourceGeneration });
    }
    this.sourceGeneration += 1;
    source?.close();
  }

  startConnectionTimer(source, generation) {
    this.clearConnectionTimer();
    if (!Number.isFinite(this.connectionTimeoutMs)) {
      return;
    }
    this.connectionTimer = this.windowTarget.setTimeout(() => {
      if (!this.isCurrentSource(source, generation)) {
        return;
      }
      this.connectionTimer = null;
      this.connectionStalled(source, generation);
    }, Math.max(0, this.connectionTimeoutMs));
  }

  clearConnectionTimer() {
    this.windowTarget.clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  clearReconnectTimer() {
    this.windowTarget.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearRetryTimer() {
    this.windowTarget.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  isCurrentSource(source, generation) {
    return this.source === source && this.sourceGeneration === generation;
  }

  isCurrentConnection(sourceGeneration, connectionId) {
    return (
      this.sourceGeneration === sourceGeneration &&
      this.connectionId === connectionId &&
      Boolean(connectionId)
    );
  }

  notifyBindings(method, ...args) {
    for (const binding of [
      ...this.bindings.values(),
      ...this.watchBindings.values(),
    ]) {
      if (!binding.closed) {
        binding.listener[method]?.(...args);
      }
    }
  }
}

function channelOpened(binding, generation, connectionId) {
  return (
    binding.openedOn?.connectionId === connectionId &&
    binding.openedOn.generation === generation
  );
}

function parsePayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}
