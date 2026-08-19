import { expect } from "@playwright/test";

export function installTaskSseControllerInBrowser() {
  const defaultRegistry = (window.__caffoldMockEventSources ??= []);
  const detailThreadId = (detail) =>
    detail?.threadId ?? detail?.task?.threadId ?? detail?.task?.id ?? "";
  const detailSource = (threadId) =>
    [...defaultRegistry].reverse().find((source) => {
      const match = source.url.match(/\/api\/tasks\/([^/?]+)\/stream/);
      return (
        match &&
        decodeURIComponent(match[1]) === threadId &&
        source.readyState !== 2
      );
    });
  const openSource = (source) => {
    if (source.readyState === 1) {
      return;
    }
    if (typeof source.emitOpen === "function") {
      source.emitOpen();
      return;
    }
    source.readyState = 1;
    const listeners = source.listeners?.get("open");
    for (const listener of Array.isArray(listeners)
      ? listeners
      : listeners
        ? [listeners]
        : []) {
      listener({});
    }
  };

  window.__caffoldRegisterTaskSseSource = (source) => {
    if (!defaultRegistry.includes(source)) {
      defaultRegistry.push(source);
    }
    if (source.url.startsWith("/api/tasks/stream")) {
      window.__taskListSource = source;
    }
  };
  window.__caffoldTaskSse = {
    open: openSource,
    source: detailSource,
    threadId: detailThreadId,
    bootstrap(detail) {
      const threadId = detailThreadId(detail);
      const source = detailSource(threadId);
      if (!source) {
        throw new Error(`Task detail stream is not active for ${threadId}`);
      }
      openSource(source);
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason: "stream-bootstrap",
      });
      return source;
    },
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
      const detailMatch = url.match(/\/api\/tasks\/([^/?]+)\/stream/);
      if (
        detailMatch &&
        detailAvailabilityKey &&
        window[detailAvailabilityKey] !== true
      ) {
        throw new Error("Task detail EventSource is unavailable in this fixture");
      }
      this.url = url;
      this.listeners = new Map();
      this.readyState = 0;
      this.closed = false;
      window.__caffoldRegisterTaskSseSource(this);
      if (customRegistry !== defaultRegistry) {
        customRegistry.push(this);
      }
      if (sourceKey) {
        window[sourceKey] = this;
      }
      if (bootstrapFunctionKey && detailMatch) {
        queueMicrotask(async () => {
          const bootstrap = await window[bootstrapFunctionKey]?.(
            decodeURIComponent(detailMatch[1]),
          );
          if (!bootstrap || this.readyState === 2) {
            return;
          }
          controller.open(this);
          this.emit("task-sync", {
            threadId: controller.threadId(bootstrap),
            revision: bootstrap.revision,
            detail: bootstrap,
            reason: "stream-bootstrap",
          });
        });
      } else if (autoOpen) {
        queueMicrotask(() => controller.open(this));
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, payload) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(payload) });
      }
    }

    emitOpen() {
      this.readyState = 1;
      for (const listener of this.listeners.get("open") ?? []) {
        listener({});
      }
    }

    emitError({ closed = false } = {}) {
      this.readyState = closed ? 2 : 0;
      for (const listener of this.listeners.get("error") ?? []) {
        listener({});
      }
    }

    close() {
      this.closed = true;
      this.readyState = 2;
    }
  };
}

export async function installEventSourceMock(page, options = {}) {
  await page.addInitScript(installTaskSseControllerInBrowser);
  await page.addInitScript(installEventSourceMockInBrowser, options);
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
    window.__caffoldTaskSse.bootstrap(bootstrapDetail);
    await opening;
  }, detail);
}
