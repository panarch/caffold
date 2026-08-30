import { expect } from "@playwright/test";

const DEFAULT_EVENT_SOURCE_REGISTRY_KEY = "__caffoldMockEventSources";

export function installTaskSseControllerInBrowser() {
  if (window.__caffoldTaskSse?.fixtureProtocol === "live-gateway-v1") {
    return;
  }
  const defaultRegistry = (window.__caffoldMockEventSources ??= []);
  const physicalRegistry = (window.__caffoldMockLiveEventSources ??= []);
  const connections = new Map();
  const pendingDetailBootstraps = new Map();
  let connectionSequence = 0;

  const detailThreadId = (detail) =>
    detail?.threadId ?? detail?.task?.threadId ?? detail?.task?.id ?? "";
  const detailSource = (threadId) =>
    [...defaultRegistry].reverse().find((source) =>
      source.channel === "task-detail" &&
      source.context === threadId &&
      source.readyState !== 2
    );

  const publishDetailBootstrap = (source, detail) => {
    if (source.readyState !== 1) {
      source.emitOpen();
    }
    source.emit("task-sync", {
      threadId: detailThreadId(detail),
      revision: detail.revision,
      detail,
      reason: "stream-bootstrap",
    });
  };

  const nativeEmit = (source, type, payload = null) => {
    const registered = source.listeners?.get(type);
    const listeners = typeof registered === "function"
      ? [registered]
      : registered ?? [];
    for (const listener of listeners) {
      listener(payload === null ? {} : { data: JSON.stringify(payload) });
    }
  };

  const identify = (source) => {
    if (source.connectionId || source.readyState === 2) {
      return;
    }
    source.connectionId = `mock-live-${++connectionSequence}`;
    connections.set(source.connectionId, source);
    nativeEmit(source, "gateway-ready", {
      connectionId: source.connectionId,
    });
  };

  const openPhysical = (source) => {
    if (source.readyState === 2) {
      return;
    }
    if (source.readyState !== 1) {
      source.readyState = 1;
      nativeEmit(source, "open");
    }
    identify(source);
  };

  const emitEnvelope = (virtual, type, payload) => {
    if (virtual.readyState === 2 || virtual.physical.readyState === 2) {
      return;
    }
    nativeEmit(virtual.physical, "live-update", {
      channel: virtual.channel,
      ...(virtual.subscriptionId
        ? { subscriptionId: virtual.subscriptionId }
        : {}),
      generation: virtual.generation,
      type,
      ...(payload === undefined ? {} : { payload }),
    });
  };

  const createVirtual = (physical, descriptor) => {
    const virtual = {
      physical,
      channel: descriptor.channel,
      context: descriptor.context,
      subscriptionId: descriptor.subscriptionId ?? "",
      generation: descriptor.generation,
      openedConnectionId: "",
      url: descriptor.url,
      readyState: 0,
      closed: false,
      emit(type, payload) {
        emitEnvelope(this, type, payload);
      },
      emitOpen() {
        if (this.readyState === 2) {
          return;
        }
        openPhysical(this.physical);
        if (
          this.physical.connectionId &&
          this.openedConnectionId === this.physical.connectionId
        ) {
          return;
        }
        this.openedConnectionId = this.physical.connectionId;
        this.readyState = 1;
        emitEnvelope(this, "channel-open");
      },
      emitError({ closed = false } = {}) {
        for (const virtual of this.physical.virtuals.values()) {
          if (virtual.readyState !== 2) {
            virtual.readyState = 0;
          }
        }
        this.physical.readyState = closed ? 2 : 0;
        if (this.physical.connectionId) {
          connections.delete(this.physical.connectionId);
          this.physical.connectionId = "";
        }
        nativeEmit(this.physical, "error");
      },
      emitChannelError({ closed = true } = {}) {
        emitEnvelope(this, "channel-error", {
          message: "Live updates are unavailable.",
        });
        if (closed) {
          this.readyState = 2;
          this.closed = true;
        }
      },
      close() {
        this.closed = true;
        this.readyState = 2;
      },
    };
    for (const registry of physical.registries ?? [defaultRegistry]) {
      if (!registry.includes(virtual)) {
        registry.push(virtual);
      }
    }
    return virtual;
  };

  const replaceVirtual = (physical, key, descriptor) => {
    const current = physical.virtuals.get(key);
    if (
      current?.generation === descriptor.generation &&
      current?.context === descriptor.context
    ) {
      return current;
    }
    current?.close();
    const virtual = createVirtual(physical, descriptor);
    physical.virtuals.set(key, virtual);
    if (
      physical.sourceKey &&
      (descriptor.channel === "task-list" || physical.detailTarget)
    ) {
      window[physical.sourceKey] = virtual;
    }
    if (descriptor.channel === "task-list") {
      window.__taskListSource = virtual;
    } else if (descriptor.channel === "task-detail") {
      window.__taskDetailSource = virtual;
    }
    return virtual;
  };

  const removeMissingVirtuals = (physical, desiredKeys) => {
    for (const [key, virtual] of physical.virtuals) {
      if (!desiredKeys.has(key)) {
        virtual.close();
        physical.virtuals.delete(key);
      }
    }
  };

  const applySubscriptions = (physical, subscriptions) => {
    physical.subscriptions = subscriptions;
    const desiredKeys = new Set();
    if (subscriptions.taskList) {
      desiredKeys.add("task-list");
      const virtual = replaceVirtual(physical, "task-list", {
        channel: "task-list",
        context: "task-list",
        generation: subscriptions.taskList.generation,
        url: "/api/tasks/stream",
      });
      if (physical.autoOpen || physical.readyState === 1) {
        queueMicrotask(() => virtual.emitOpen());
      }
    }
    if (subscriptions.taskDetail) {
      const threadId = subscriptions.taskDetail.threadId;
      desiredKeys.add("task-detail");
      const previous = physical.virtuals.get("task-detail");
      const virtual = replaceVirtual(physical, "task-detail", {
        channel: "task-detail",
        context: threadId,
        generation: subscriptions.taskDetail.generation,
        url: `/api/tasks/${encodeURIComponent(threadId)}/stream`,
      });
      if (
        virtual !== previous &&
        physical.detailAvailabilityKey &&
        window[physical.detailAvailabilityKey] !== true
      ) {
        queueMicrotask(() => virtual.emitChannelError({ closed: true }));
      } else if (virtual !== previous && physical.bootstrapFunctionKey) {
        queueMicrotask(async () => {
          const bootstrap = await window[physical.bootstrapFunctionKey]?.(
            threadId,
          );
          if (!bootstrap || virtual.readyState === 2) {
            return;
          }
          virtual.emitOpen();
          virtual.emit("task-sync", {
            threadId: detailThreadId(bootstrap),
            revision: bootstrap.revision,
            detail: bootstrap,
            reason: "stream-bootstrap",
          });
        });
      } else if (physical.autoOpen || physical.readyState === 1) {
        queueMicrotask(() => virtual.emitOpen());
      }
      const pendingBootstrap = pendingDetailBootstraps.get(threadId);
      if (pendingBootstrap) {
        pendingDetailBootstraps.delete(threadId);
        queueMicrotask(() => {
          if (virtual.readyState !== 2) {
            publishDetailBootstrap(virtual, pendingBootstrap);
          }
        });
      }
    }
    for (const watch of subscriptions.watches ?? []) {
      const key = `watch:${watch.subscriptionId}`;
      desiredKeys.add(key);
      const virtual = replaceVirtual(physical, key, {
        channel: "watch",
        context: watch.path ?? "",
        subscriptionId: watch.subscriptionId,
        generation: watch.generation,
        url: `/api/watch?path=${encodeURIComponent(watch.path ?? "")}`,
      });
      if (physical.autoOpen || physical.readyState === 1) {
        queueMicrotask(() => virtual.emitOpen());
      }
    }
    removeMissingVirtuals(physical, desiredKeys);
  };

  const controller = {
    fixtureProtocol: "live-gateway-v1",
    open(source) {
      source.emitOpen?.();
    },
    source: detailSource,
    threadId: detailThreadId,
    bootstrap(detail) {
      const threadId = detailThreadId(detail);
      const source = detailSource(threadId);
      if (!source) {
        pendingDetailBootstraps.set(threadId, detail);
        return null;
      }
      pendingDetailBootstraps.delete(threadId);
      publishDetailBootstrap(source, detail);
      return source;
    },
    identify,
    nativeEmit,
    applySubscriptions,
    forget(source) {
      if (source.connectionId) {
        connections.delete(source.connectionId);
        source.connectionId = "";
      }
    },
    registerPhysical(source) {
      source.virtuals ??= new Map();
      source.customRegistry ??= defaultRegistry;
      const registries = new Set([defaultRegistry]);
      if (source.customRegistry) {
        registries.add(source.customRegistry);
      } else {
        for (const key of Object.keys(window)) {
          try {
            const candidate = window[key];
            if (Array.isArray(candidate) && candidate.includes(source)) {
              registries.add(candidate);
            }
          } catch {
            // Window-owned accessors are outside this fixture's registry surface.
          }
        }
      }
      source.registries = registries;
      if (!physicalRegistry.includes(source)) {
        physicalRegistry.push(source);
      }
      queueMicrotask(() => identify(source));
    },
  };
  window.__caffoldTaskSse = controller;
  window.__caffoldRegisterTaskSseSource = (source) =>
    controller.registerPhysical(source);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url,
      window.location.href,
    );
    const match = url.pathname.match(
      /^\/api\/live\/([^/]+)\/subscriptions$/,
    );
    if (`${init.method ?? "GET"}`.toUpperCase() === "PUT" && match) {
      const connectionId = decodeURIComponent(match[1]);
      if (!connectionId.startsWith("mock-live-")) {
        return originalFetch(input, init);
      }
      const physical = connections.get(connectionId);
      if (!physical || physical.readyState === 2) {
        return new Response(
          JSON.stringify({ code: "live_session_not_found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      applySubscriptions(
        physical,
        JSON.parse(`${init.body ?? "{}"}`),
      );
      return new Response(null, { status: 204 });
    }
    return originalFetch(input, init);
  };
}

export function installEventSourceMockInBrowser({
  registryKey = null,
  sourceKey = null,
  autoOpen = false,
  bootstrapFunctionKey = null,
  detailAvailabilityKey = null,
} = {}) {
  const controller = window.__caffoldTaskSse;
  if (!controller) {
    throw new Error(
      "Task SSE controller must be installed before its EventSource mock",
    );
  }
  const defaultRegistry = window.__caffoldMockEventSources;
  const customRegistry =
    registryKey && registryKey !== "__caffoldMockEventSources"
      ? (window[registryKey] = [])
      : defaultRegistry;

  window.EventSource = class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.readyState = 0;
      this.closed = false;
      this.connectionId = "";
      this.virtuals = new Map();
      this.customRegistry = customRegistry;
      this.sourceKey = sourceKey;
      this.autoOpen = autoOpen;
      this.bootstrapFunctionKey = bootstrapFunctionKey;
      this.detailAvailabilityKey = detailAvailabilityKey;
      this.detailTarget = Boolean(
        bootstrapFunctionKey || detailAvailabilityKey,
      );
      controller.registerPhysical(this);
      if (autoOpen) {
        queueMicrotask(() => this.emitOpen());
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, payload) {
      controller.nativeEmit(this, type, payload);
    }

    emitOpen() {
      if (this.readyState === 2) {
        return;
      }
      this.readyState = 1;
      controller.nativeEmit(this, "open");
      controller.identify(this);
    }

    emitError({ closed = false } = {}) {
      for (const virtual of this.virtuals.values()) {
        if (virtual.readyState !== 2) {
          virtual.readyState = 0;
        }
      }
      this.readyState = closed ? 2 : 0;
      controller.forget(this);
      controller.nativeEmit(this, "error");
    }

    close() {
      this.closed = true;
      this.readyState = 2;
      for (const virtual of this.virtuals.values()) {
        virtual.close();
      }
    }
  };
}

export async function installEventSourceMock(page, options = {}) {
  await page.addInitScript(installTaskSseControllerInBrowser);
  await page.addInitScript(installEventSourceMockInBrowser, options);
}

export function activeLiveUpdateChannels(page, {
  registryKey = DEFAULT_EVENT_SOURCE_REGISTRY_KEY,
} = {}) {
  return page.evaluate((key) =>
    (window[key] ?? [])
      .filter((source) => source.readyState !== 2)
      .map((source) => source.channel)
      .sort(),
  registryKey);
}

export function activeWatchSubscriptionId(page, {
  registryKey = DEFAULT_EVENT_SOURCE_REGISTRY_KEY,
} = {}) {
  return page.evaluate((key) => {
    const sources = (window[key] ?? []).filter(
      (source) => source.channel === "watch" && source.readyState !== 2,
    );
    return sources.length === 1 ? sources[0].subscriptionId ?? null : null;
  }, registryKey);
}

export function isWatchSubscriptionClosed(page, subscriptionId, {
  registryKey = DEFAULT_EVENT_SOURCE_REGISTRY_KEY,
} = {}) {
  return page.evaluate(({ key, id }) => {
    const source = (window[key] ?? []).find(
      (candidate) =>
        candidate.channel === "watch" && candidate.subscriptionId === id,
    );
    return source ? source.readyState === 2 : null;
  }, { key: registryKey, id: subscriptionId });
}

export async function emitTaskDetailBootstrap(page, detail) {
  const threadId = detail.threadId ?? detail.task?.threadId ?? detail.task?.id;
  await expect
    .poll(() =>
      page.evaluate(
        (requestedThreadId) =>
          Boolean(window.__caffoldTaskSse?.source(requestedThreadId)),
        threadId,
      ),
    )
    .toBe(true);

  await page.evaluate((bootstrapDetail) => {
    window.__caffoldTaskSse.bootstrap(bootstrapDetail);
  }, detail);
}

export async function openTaskWithBootstrap(tasksPage, detail) {
  await tasksPage.evaluate(async (element, bootstrapDetail) => {
    const taskDetail = element.querySelector("caffold-task-detail");
    const threadId =
      bootstrapDetail.threadId ??
      bootstrapDetail.task?.threadId ??
      bootstrapDetail.task?.id;
    const opening = taskDetail.open(threadId);
    await new Promise((resolve) => setTimeout(resolve));
    window.__caffoldTaskSse.bootstrap(bootstrapDetail);
    await opening;
  }, detail);
}
