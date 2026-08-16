import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { getHealth, reorderSection } from "./api.js";
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
