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

const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 8_000;
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
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.reconnectTimeoutMs =
      options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
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
    this.controlRevision = 0;
    this.controlDirty = false;
    this.controlPublication = null;
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
    this.controlRevision += 1;
    this.controlDirty = true;
    void this.flushSubscriptions();
  }

  desiredSubscriptions() {
    const taskList = this.bindings.get("task-list");
    const taskDetail = this.bindings.get("task-detail");
    return {
      controlRevision: Math.max(1, this.controlRevision),
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
        const subscriptions = this.desiredSubscriptions();
        try {
          await this.publishSubscriptions(connectionId, subscriptions);
        } catch (error) {
          if (this.isCurrentConnection(sourceGeneration, connectionId)) {
            this.controlDirty = true;
            this.connectionFailed(this.source, sourceGeneration, error);
          }
          return;
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
      this.retryAttempt = 0;
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.WAIT_TO_REPLACE) {
      if (context.previousNode !== LIVE_CONNECTION_NODE.RECONNECTING) {
        this.notifyBindings(
          "onError",
          new Error("Live updates are unavailable."),
          { closed: false, physical: true },
        );
      }
      this.waitToReplaceConnection();
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

  openConnection() {
    if (
      this.source ||
      this.documentTarget.visibilityState !== "visible" ||
      ![
        LIVE_CONNECTION_NODE.CONNECTING,
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
    this.clearConnectionTimer();
    this.connectionId = "";
    this.controlPublication = null;
    this.controlDirty = true;
    this.dispatchConnection(LIVE_CONNECTION_EVENT.ERROR);
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
    this.connectionId = "";
    this.controlPublication = null;
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
      this.connectionFailed(source, generation);
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

function parsePayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}
