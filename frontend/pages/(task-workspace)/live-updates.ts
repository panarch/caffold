import { liveUpdatesUrl, updateLiveSubscriptions } from "../../api.js";
import { reportOriginReachable } from "../../origin-reachability.js";
import {
  LIVE_CONNECTION_EFFECT,
  LIVE_CONNECTION_EVENT,
  LIVE_CONNECTION_NODE,
  type LiveConnectionEffect,
  type LiveConnectionEvent,
  type LiveConnectionNode,
  transitionLiveConnection,
} from "./live-updates/lifecycle.js";

// What the workspace raises for each connection report, for the App Shell's
// foreground recovery diagnostics.
export const LIVE_CONNECTION_REPORT_EVENT = "caffold:live-connection-report";

const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);
// Once the bounded retry is spent, attempts go on at these delays; the last
// one repeats.
const DEFAULT_AUTOMATIC_RETRY_DELAYS_MS = Object.freeze([
  5_000, 10_000, 20_000, 30_000,
]);
const LIVE_CHANNELS = Object.freeze([
  "task-list",
  "task-detail",
  "watch",
] as const);

type LiveChannel = (typeof LIVE_CHANNELS)[number];

// How a channel's subscriber hears of trouble: whether its subscription
// ended, whether the bounded retry is spent, and whether the trouble is the
// physical connection's rather than the channel's own.
interface LiveErrorOptions {
  closed?: boolean;
  exhausted?: boolean;
  physical?: boolean;
}

// What a subscriber hears from its channel on the workspace gateway.
export interface LiveSubscriptionListener {
  onOpen?(): void;
  onError?(error: unknown, options?: LiveErrorOptions): void;
  onEvent?(type: string, payload: unknown): void;
  onInvalidated?(): void;
  onSuspend?(): void;
  onResume?(): void;
}

// One subscription on the gateway.
export interface LiveSubscription {
  close(): void;
  retry(): boolean;
}

interface ChannelBinding extends LiveSubscription {
  channel: Exclude<LiveChannel, "watch">;
  context: string;
  generation: number;
  listener: LiveSubscriptionListener;
  closed: boolean;
  openedOn?: { connectionId: string; generation: number };
}

interface WatchBinding extends Omit<ChannelBinding, "channel"> {
  channel: "watch";
  subscriptionId: string;
}

type Binding = ChannelBinding | WatchBinding;

interface OpenCheck {
  generation: number;
  sourceGeneration: number;
  connectionId: string;
  timer: number | null;
}

// Which subscription a message on the connection is for.
interface LiveAddress {
  channel?: string;
  subscriptionId?: string;
}

interface LiveMessage extends LiveAddress {
  connectionId?: unknown;
  generation?: number;
  type?: unknown;
  payload?: unknown;
}

// The header line of one part of a large message.
interface LiveMessagePart extends LiveAddress {
  generation: number;
  index: number;
  count: number;
}

export interface LiveConnectionReport {
  kind: "opened" | "answered" | "failed" | "stalled" | "closed";
  id: number;
}

export interface WorkspaceLiveUpdatesOptions {
  documentTarget?: Document;
  windowTarget?: Window;
  createEventSource?: (url: string) => EventSource;
  publishSubscriptions?: (
    connectionId: string,
    subscriptions: unknown,
  ) => Promise<unknown>;
  // Hears each physical connection open, answer, and end, by its number.
  onConnectionReport?: (report: LiveConnectionReport) => void;
  connectionTimeoutMs?: number;
  reconnectTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  automaticRetryDelaysMs?: readonly number[];
}

// The workspace's one live connection, shared by its channels.
export class WorkspaceLiveUpdates {
  private readonly documentTarget: Document;
  private readonly windowTarget: Window;
  private readonly createEventSource: (url: string) => EventSource;
  private readonly publishSubscriptions: NonNullable<
    WorkspaceLiveUpdatesOptions["publishSubscriptions"]
  >;
  private readonly onConnectionReport: (report: LiveConnectionReport) => void;
  private readonly connectionTimeoutMs: number;
  private readonly reconnectTimeoutMs: number;
  private readonly channelOpenTimeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly automaticRetryDelaysMs: number[];
  private node: LiveConnectionNode;
  private source: EventSource | null;
  private sourceGeneration: number;
  private connectionId: string;
  private connectionTimer: number | null;
  private reconnectTimer: number | null;
  private retryTimer: number | null;
  private retryAttempt: number;
  private automaticRetryAttempt: number;
  private deliveryPending: boolean;
  private controlRevision: number;
  private controlDirty: boolean;
  private controlPublication: Promise<void> | null;
  private readonly openChecks: Map<Binding, OpenCheck>;
  private readonly partialMessages: Map<
    Binding,
    { generation: number; count: number; pieces: string[] }
  >;
  private readonly channelGenerations: Map<LiveChannel, number>;
  private readonly bindings: Map<string, ChannelBinding>;
  private readonly watchBindings: Map<string, WatchBinding>;
  private watchSequence: number;
  private readonly boundVisibilityChange: () => void;

  constructor(options: WorkspaceLiveUpdatesOptions = {}) {
    this.documentTarget = options.documentTarget ?? document;
    this.windowTarget = options.windowTarget ?? window;
    this.createEventSource =
      options.createEventSource ?? ((url) => new EventSource(url));
    this.publishSubscriptions =
      options.publishSubscriptions ?? updateLiveSubscriptions;
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
    this.automaticRetryDelaysMs = [
      ...(options.automaticRetryDelaysMs ?? DEFAULT_AUTOMATIC_RETRY_DELAYS_MS),
    ];
    this.node = LIVE_CONNECTION_NODE.DETACHED;
    this.source = null;
    this.sourceGeneration = 0;
    this.connectionId = "";
    this.connectionTimer = null;
    this.reconnectTimer = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.automaticRetryAttempt = 0;
    // Set when a connection stopped delivering: the next greeting does not show
    // channels open again, so the attempt ends only when one does.
    this.deliveryPending = false;
    this.controlRevision = 0;
    this.controlDirty = false;
    this.controlPublication = null;
    // Each subscription a publication carried that has not opened yet on this
    // connection, with its deadline.
    this.openChecks = new Map();
    // The parts of a large message each subscription has received so far on
    // this connection.
    this.partialMessages = new Map();
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
    this.clearRetryTimer();
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
    this.automaticRetryAttempt = 0;
    this.deliveryPending = false;
    const resumed = this.dispatchConnection(LIVE_CONNECTION_EVENT.RESUME);
    if (resumed) {
      this.notifyBindings("onResume");
    }
    return resumed;
  }

  subscribeTaskList(listener: LiveSubscriptionListener) {
    return this.bind("task-list", "task-list", listener);
  }

  subscribeTaskDetail(threadId: string, listener: LiveSubscriptionListener) {
    const context = `${threadId ?? ""}`.trim();
    if (!context) {
      throw new Error("Task Detail live updates require a thread ID.");
    }
    return this.bind("task-detail", context, listener);
  }

  subscribeWatch(
    path: string,
    listener: LiveSubscriptionListener,
  ): LiveSubscription {
    const binding: WatchBinding = {
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

  private bind(
    channel: ChannelBinding["channel"],
    context: string,
    listener: LiveSubscriptionListener = {},
  ): LiveSubscription {
    if (!LIVE_CHANNELS.includes(channel)) {
      throw new Error(`Unsupported live channel: ${channel}`);
    }
    const previous = this.bindings.get(channel);
    if (previous) {
      previous.closed = true;
      this.clearOpenCheck(previous);
      this.partialMessages.delete(previous);
      previous.listener.onInvalidated?.();
    }
    const binding: ChannelBinding = {
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

  private closeBinding(binding: Binding) {
    if (binding.closed) {
      return;
    }
    binding.closed = true;
    this.clearOpenCheck(binding);
    this.partialMessages.delete(binding);
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

  private retryBinding(binding: Binding) {
    const current =
      binding.channel === "watch"
        ? this.watchBindings.get(binding.subscriptionId)
        : this.bindings.get(binding.channel);
    if (binding.closed || current !== binding) {
      return false;
    }
    binding.generation = this.nextChannelGeneration(binding.channel);
    this.subscriptionsChanged();
    return true;
  }

  private reportUnavailableBinding(binding: Binding) {
    if (this.node !== LIVE_CONNECTION_NODE.UNAVAILABLE) {
      return;
    }
    queueMicrotask(() => {
      if (!binding.closed) {
        binding.listener.onError?.(new Error("Live updates are unavailable."), {
          closed: true,
          exhausted: true,
          physical: true,
        });
      }
    });
  }

  private nextChannelGeneration(channel: LiveChannel) {
    const generation = (this.channelGenerations.get(channel) ?? 0) + 1;
    this.channelGenerations.set(channel, generation);
    return generation;
  }

  private subscriptionsChanged() {
    this.controlDirty = true;
    void this.flushSubscriptions();
  }

  private desiredSubscriptions() {
    const taskList = this.bindings.get("task-list");
    const taskDetail = this.bindings.get("task-detail");
    return {
      controlRevision: this.controlRevision,
      taskList: taskList ? { generation: taskList.generation } : null,
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
          left.subscriptionId.localeCompare(right.subscriptionId),
        ),
    };
  }

  private async flushSubscriptions() {
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
        // The checks start as the snapshot leaves, so a connection that
        // stopped delivering is found while its answer is still outstanding.
        this.expectChannelsOpen(
          this.publishedBindings(),
          sourceGeneration,
          connectionId,
        );
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

  // Each subscription the snapshot about to be sent carries, with the generation
  // it asks for.
  private publishedBindings() {
    return [...this.bindings.values(), ...this.watchBindings.values()]
      .filter((binding) => !binding.closed)
      .map((binding) => ({ binding, generation: binding.generation }));
  }

  // The server opens every channel it is given before sending anything else on
  // it, so one that stays unopened while nothing arrives means the connection
  // has stopped delivering. A large message still arriving in parts is not
  // that: every delivery starts each check's limit again.
  private expectChannelsOpen(
    published: Array<{ binding: Binding; generation: number }>,
    sourceGeneration: number,
    connectionId: string,
  ) {
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
      this.armOpenCheck(binding, {
        generation,
        sourceGeneration,
        connectionId,
      });
    }
  }

  private extendOpenChecks() {
    for (const [binding, check] of this.openChecks) {
      this.windowTarget.clearTimeout(check.timer ?? undefined);
      this.armOpenCheck(binding, check);
    }
  }

  private armOpenCheck(
    binding: Binding,
    { generation, sourceGeneration, connectionId }: Omit<OpenCheck, "timer">,
  ) {
    const check: OpenCheck = {
      generation,
      sourceGeneration,
      connectionId,
      timer: null,
    };
    check.timer = this.windowTarget.setTimeout(
      () => {
        if (this.openChecks.get(binding) !== check) {
          return;
        }
        this.openChecks.delete(binding);
        if (
          !binding.closed &&
          binding.generation === generation &&
          !channelOpened(binding, generation, connectionId) &&
          this.isCurrentConnection(sourceGeneration, connectionId)
        ) {
          this.connectionUndelivered(this.source, sourceGeneration);
        }
      },
      Math.max(0, this.channelOpenTimeoutMs),
    );
    this.openChecks.set(binding, check);
  }

  private clearOpenCheck(binding: Binding) {
    const check = this.openChecks.get(binding);
    if (check) {
      this.windowTarget.clearTimeout(check.timer ?? undefined);
      this.openChecks.delete(binding);
    }
  }

  private clearOpenChecks() {
    for (const check of this.openChecks.values()) {
      this.windowTarget.clearTimeout(check.timer ?? undefined);
    }
    this.openChecks.clear();
  }

  private handleVisibilityChange() {
    if (this.documentTarget.visibilityState !== "visible") {
      this.suspend();
      return;
    }
    this.resume();
  }

  private dispatchConnection(event: LiveConnectionEvent) {
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

  private runConnectionEffect(
    effect: LiveConnectionEffect,
    context: { event: LiveConnectionEvent; previousNode: LiveConnectionNode },
  ) {
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
        this.automaticRetryAttempt = 0;
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
      return;
    }
    if (effect === LIVE_CONNECTION_EFFECT.WAIT_TO_RETRY) {
      this.waitToRetry();
    }
  }

  // Consumers hear of trouble when an attempt's first connection fails or goes
  // silent, not again while that attempt replaces it.
  private reportConnectionTrouble(previousNode: LiveConnectionNode) {
    if (
      (
        [
          LIVE_CONNECTION_NODE.REOPENED,
          LIVE_CONNECTION_NODE.RECONNECTING,
        ] as LiveConnectionNode[]
      ).includes(previousNode)
    ) {
      return;
    }
    this.notifyBindings("onError", new Error("Live updates are unavailable."), {
      closed: false,
      physical: true,
    });
  }

  private openConnection() {
    if (
      this.source ||
      this.documentTarget.visibilityState !== "visible" ||
      !(
        [
          LIVE_CONNECTION_NODE.CONNECTING,
          LIVE_CONNECTION_NODE.REOPENED,
          LIVE_CONNECTION_NODE.RECONNECTING,
        ] as LiveConnectionNode[]
      ).includes(this.node)
    ) {
      return;
    }
    const generation = ++this.sourceGeneration;
    let source: EventSource;
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
    source.addEventListener("live-update-part", (event) => {
      this.acceptLiveUpdatePart(source, generation, event);
    });
    source.addEventListener("error", () => {
      this.connectionFailed(source, generation);
    });
    this.startConnectionTimer(source, generation);
  }

  private acceptGatewayReady(
    source: EventSource,
    generation: number,
    event: { data: string },
  ) {
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

  private acceptLiveUpdate(
    source: EventSource,
    sourceGeneration: number,
    event: { data: string },
  ) {
    if (!this.isCurrentSource(source, sourceGeneration)) {
      return;
    }
    this.extendOpenChecks();
    const message = parsePayload(event);
    const channel = message?.channel;
    const binding = this.addressedBinding(message);
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
        this.automaticRetryAttempt = 0;
      }
      binding.listener.onOpen?.();
      return;
    }
    if (message.type === "channel-error") {
      // A refusal carries its API error code, as a failed request does.
      const payload = message.payload as {
        message?: string;
        code?: string;
      } | null;
      const error: Error & { code?: string } = new Error(
        payload?.message ?? `${channel} live updates are unavailable.`,
      );
      if (payload?.code) {
        error.code = payload.code;
      }
      binding.listener.onError?.(error, { closed: true, physical: false });
      return;
    }
    binding.listener.onEvent?.(message.type, message.payload);
  }

  // A message too large for one event arrives in parts: a header line naming
  // the subscription, the generation, and the part's place, then a piece of
  // the message. The pieces of the current generation join back into it.
  private acceptLiveUpdatePart(
    source: EventSource,
    sourceGeneration: number,
    event: { data?: unknown },
  ) {
    if (!this.isCurrentSource(source, sourceGeneration)) {
      return;
    }
    this.extendOpenChecks();
    const data = `${event?.data ?? ""}`;
    const lineEnd = data.indexOf("\n");
    const part =
      lineEnd < 0
        ? null
        : (parseJson(data.slice(0, lineEnd)) as LiveMessagePart | null);
    const binding = this.addressedBinding(part);
    if (
      !part ||
      !binding ||
      binding.closed ||
      part.generation !== binding.generation ||
      !Number.isSafeInteger(part.index) ||
      !Number.isSafeInteger(part.count) ||
      part.index < 0 ||
      part.index >= part.count
    ) {
      return;
    }
    if (part.index === 0) {
      this.partialMessages.set(binding, {
        generation: part.generation,
        count: part.count,
        pieces: [],
      });
    }
    const partial = this.partialMessages.get(binding);
    if (
      partial?.generation !== part.generation ||
      partial.count !== part.count ||
      partial.pieces.length !== part.index
    ) {
      this.partialMessages.delete(binding);
      return;
    }
    partial.pieces.push(data.slice(lineEnd + 1));
    if (partial.pieces.length < partial.count) {
      return;
    }
    this.partialMessages.delete(binding);
    this.acceptLiveUpdate(source, sourceGeneration, {
      data: partial.pieces.join(""),
    });
  }

  private addressedBinding(message: LiveAddress | null): Binding | undefined {
    return message?.channel === "watch"
      ? this.watchBindings.get(message?.subscriptionId ?? "")
      : this.bindings.get(message?.channel ?? "");
  }

  private connectionFailed(
    source: EventSource | null,
    generation: number,
    _error: unknown = null,
  ) {
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

  private connectionStalled(source: EventSource, generation: number) {
    if (!this.isCurrentSource(source, generation)) {
      return;
    }
    this.releaseConnection();
    this.onConnectionReport({ kind: "stalled", id: generation });
    this.dispatchConnection(LIVE_CONNECTION_EVENT.STALL);
  }

  private connectionUndelivered(
    source: EventSource | null,
    generation: number,
  ) {
    if (!this.isCurrentSource(source, generation)) {
      return;
    }
    this.releaseConnection();
    this.deliveryPending = true;
    this.onConnectionReport({ kind: "stalled", id: generation });
    this.dispatchConnection(LIVE_CONNECTION_EVENT.UNDELIVERED);
  }

  private releaseConnection() {
    this.clearConnectionTimer();
    this.clearOpenChecks();
    this.partialMessages.clear();
    this.connectionId = "";
    this.controlPublication = null;
    this.controlDirty = true;
  }

  private waitToReplaceConnection() {
    if (this.reconnectTimer !== null) {
      return;
    }
    const source = this.source;
    const generation = this.sourceGeneration;
    const delay =
      !source || source.readyState === 2 ? 0 : this.reconnectTimeoutMs;
    this.reconnectTimer = this.windowTarget.setTimeout(
      () => {
        if (!this.isCurrentSource(source, generation)) {
          return;
        }
        this.reconnectTimer = null;
        this.replaceConnection();
      },
      Math.max(0, delay),
    );
  }

  private replaceConnection() {
    this.closeSource();
    const delayMs = this.retryDelaysMs[this.retryAttempt];
    if (!Number.isFinite(delayMs)) {
      this.dispatchConnection(LIVE_CONNECTION_EVENT.EXHAUST);
      return;
    }
    this.retryAttempt += 1;
    this.retryTimer = this.windowTarget.setTimeout(
      () => {
        this.retryTimer = null;
        this.dispatchConnection(LIVE_CONNECTION_EVENT.REPLACE);
      },
      Math.max(0, delayMs),
    );
  }

  // Each automatic retry waits longer than the last, up to the final delay.
  private waitToRetry() {
    const delays = this.automaticRetryDelaysMs;
    const delayMs =
      delays[Math.min(this.automaticRetryAttempt, delays.length - 1)];
    if (!Number.isFinite(delayMs)) {
      return;
    }
    this.automaticRetryAttempt += 1;
    this.retryTimer = this.windowTarget.setTimeout(
      () => {
        this.retryTimer = null;
        this.dispatchConnection(LIVE_CONNECTION_EVENT.RETRY_DUE);
      },
      Math.max(0, delayMs),
    );
  }

  private closeConnection() {
    this.clearConnectionTimer();
    this.clearReconnectTimer();
    this.clearRetryTimer();
    this.closeSource();
  }

  private closeSource() {
    const source = this.source;
    this.source = null;
    this.clearOpenChecks();
    this.partialMessages.clear();
    this.connectionId = "";
    this.controlPublication = null;
    if (source) {
      this.onConnectionReport({ kind: "closed", id: this.sourceGeneration });
    }
    this.sourceGeneration += 1;
    source?.close();
  }

  private startConnectionTimer(source: EventSource, generation: number) {
    this.clearConnectionTimer();
    if (!Number.isFinite(this.connectionTimeoutMs)) {
      return;
    }
    this.connectionTimer = this.windowTarget.setTimeout(
      () => {
        if (!this.isCurrentSource(source, generation)) {
          return;
        }
        this.connectionTimer = null;
        this.connectionStalled(source, generation);
      },
      Math.max(0, this.connectionTimeoutMs),
    );
  }

  private clearConnectionTimer() {
    this.windowTarget.clearTimeout(this.connectionTimer ?? undefined);
    this.connectionTimer = null;
  }

  private clearReconnectTimer() {
    this.windowTarget.clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
  }

  private clearRetryTimer() {
    this.windowTarget.clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
  }

  private isCurrentSource(source: EventSource | null, generation: number) {
    return this.source === source && this.sourceGeneration === generation;
  }

  private isCurrentConnection(sourceGeneration: number, connectionId: string) {
    return (
      this.sourceGeneration === sourceGeneration &&
      this.connectionId === connectionId &&
      Boolean(connectionId)
    );
  }

  private notifyBindings<Method extends keyof LiveSubscriptionListener>(
    method: Method,
    ...args: Parameters<NonNullable<LiveSubscriptionListener[Method]>>
  ) {
    for (const binding of [
      ...this.bindings.values(),
      ...this.watchBindings.values(),
    ]) {
      if (!binding.closed) {
        (
          binding.listener[method] as
            | ((...values: typeof args) => void)
            | undefined
        )?.(...args);
      }
    }
  }
}

function channelOpened(
  binding: Binding,
  generation: number,
  connectionId: string,
) {
  return (
    binding.openedOn?.connectionId === connectionId &&
    binding.openedOn.generation === generation
  );
}

function parsePayload(event: { data: string }) {
  return parseJson(event.data) as LiveMessage | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
