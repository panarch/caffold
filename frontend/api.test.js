import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  createTaskFork,
  forkTask,
  getCurrentPlan,
  getHealth,
  getNote,
  getNotes,
  getTask,
  liveUpdatesUrl,
  previewTaskForkSource,
  reorderSection,
  updateLiveSubscriptions,
} from "./api.js";
import { CAFFOLD_ORIGIN_REACHABLE_EVENT } from "./origin-reachability.js";

const originalBrowserGlobals = {
  fetch: globalThis.fetch,
  window: globalThis.window,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalBrowserGlobals)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
});

function installBrowserHarness(fetchImplementation) {
  const windowTarget = Object.assign(new EventTarget(), {
    clearTimeout,
    location: { origin: "http://127.0.0.1" },
    setTimeout,
  });
  globalThis.window = windowTarget;
  globalThis.fetch = fetchImplementation;
  return windowTarget;
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test("Task history cancellation reaches its own HTTP request", async () => {
  let received;
  installBrowserHarness((url, options) => {
    received = { url, signal: options.signal };
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = getTask("task with spaces", "older", { signal: controller.signal });
  assert.equal(received.url.pathname, "/api/tasks/task%20with%20spaces");
  assert.equal(received.url.searchParams.get("cursor"), "older");
  assert.equal(received.signal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("Notes reads go to their own endpoints with the caller's cancellation", async () => {
  const received = [];
  installBrowserHarness((url, options) => {
    received.push({ url, signal: options.signal, method: options.method });
    return Promise.resolve(jsonResponse({ directories: [], notes: [] }));
  });
  const controller = new AbortController();

  await getNotes("", controller.signal);
  await getNotes("directory with spaces", controller.signal);
  await getNote("note with spaces", controller.signal);

  assert.deepEqual(
    received.map(({ url, signal, method }) => [
      `${url.pathname}${url.search}`,
      signal === controller.signal,
      method,
    ]),
    [
      ["/api/notes", true, "GET"],
      ["/api/notes?directoryId=directory+with+spaces", true, "GET"],
      ["/api/notes/note%20with%20spaces", true, "GET"],
    ],
  );
});

test("a current-plan read honors both its caller cancellation and its timeout", async () => {
  const timers = [];
  const cleared = [];
  const windowTarget = installBrowserHarness((url, options) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
      }
    })
  );
  windowTarget.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  windowTarget.clearTimeout = (id) => {
    cleared.push(id);
  };

  const timedOut = getCurrentPlan("task", new AbortController().signal);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 8_000);
  timers[0].callback();
  await assert.rejects(timedOut, {
    code: "request_timeout",
    message: "Request timed out.",
  });

  const controller = new AbortController();
  const cancelled = getCurrentPlan("task", controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  await assert.rejects(getCurrentPlan("task", controller.signal), {
    name: "AbortError",
  });
  assert.deepEqual(cleared, [1, 2, 3]);
});

test("reports origin reachability for a received API response", async () => {
  const windowTarget = installBrowserHarness(async () =>
    jsonResponse({ status: "ok" })
  );
  let reachable = 0;
  windowTarget.addEventListener(CAFFOLD_ORIGIN_REACHABLE_EVENT, () => {
    reachable += 1;
  });

  assert.deepEqual(await getHealth(), { status: "ok" });
  assert.equal(reachable, 1);
});

test("treats an HTTP error response as origin reachability", async () => {
  const windowTarget = installBrowserHarness(async () =>
    jsonResponse(
      { error: { message: "Service unavailable." } },
      { ok: false, status: 503 },
    )
  );
  let reachable = 0;
  windowTarget.addEventListener(CAFFOLD_ORIGIN_REACHABLE_EVENT, () => {
    reachable += 1;
  });

  await assert.rejects(getHealth(), /Service unavailable/);
  assert.equal(reachable, 1);
});

test("does not report reachability for a network exception", async () => {
  const windowTarget = installBrowserHarness(async () => {
    throw new TypeError("Failed to fetch");
  });
  let reachable = 0;
  windowTarget.addEventListener(CAFFOLD_ORIGIN_REACHABLE_EVENT, () => {
    reachable += 1;
  });

  await assert.rejects(getHealth(), /Failed to fetch/);
  assert.equal(reachable, 0);
});

test("serializes Section reorder intent at the API owner", async () => {
  const requests = [];
  installBrowserHarness(async (url, options) => {
    requests.push({ url: `${url}`, options });
    return jsonResponse({ changed: true });
  });

  await reorderSection("section/one", "section two");
  await reorderSection("section/one", null);

  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1/api/tasks/sections/section%2Fone/reorder",
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ beforeSectionId: "section two" }),
      },
    },
    {
      url: "http://127.0.0.1/api/tasks/sections/section%2Fone/reorder",
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ beforeSectionId: null }),
      },
    },
  ]);
});

test("publishes one complete live subscription snapshot to its connection", async () => {
  const requests = [];
  installBrowserHarness(async (url, options) => {
    requests.push({ url: `${url}`, options });
    return jsonResponse(null, { status: 204 });
  });
  const subscriptions = {
    controlRevision: 3,
    taskList: { generation: 1 },
    taskDetail: null,
    watches: [],
  };

  assert.equal(liveUpdatesUrl(), "/api/live");
  await updateLiveSubscriptions("connection/id", subscriptions);

  assert.equal(requests.length, 1);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(
    {
      ...requests[0],
      options: { ...requests[0].options, signal: undefined },
    },
    {
      url: "http://127.0.0.1/api/live/connection%2Fid/subscriptions",
      options: {
        method: "PUT",
        signal: undefined,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptions),
      },
    },
  );
});

test("forks the encoded managed Task id with an empty POST", async () => {
  const requests = [];
  installBrowserHarness(async (url, options) => {
    requests.push({ url: `${url}`, options });
    return jsonResponse({ threadId: "child" });
  });

  assert.deepEqual(await forkTask("source/thread"), { threadId: "child" });
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1/api/tasks/source%2Fthread/fork",
      options: { method: "POST" },
    },
  ]);
});

test("keeps external fork preview and creation on their dedicated API boundary", async () => {
  const requests = [];
  installBrowserHarness(async (url, options) => {
    requests.push({ url: `${url}`, options });
    return jsonResponse({ sourceId: "source", threadId: "child" });
  });
  const controller = new AbortController();

  await previewTaskForkSource(
    { provider: "codex", sourceId: "source" },
    controller.signal,
  );
  await createTaskFork({
    provider: "codex",
    sourceId: "source",
    sectionId: "section-one",
  });

  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1/api/task-forks/preview",
      options: {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex", sourceId: "source" }),
      },
    },
    {
      url: "http://127.0.0.1/api/task-forks",
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          sourceId: "source",
          sectionId: "section-one",
        }),
      },
    },
  ]);
});
