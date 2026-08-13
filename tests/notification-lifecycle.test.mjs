import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUSH_CLIENT_ID_STORAGE_KEY,
  getOrCreatePushClientId,
  installationLabel,
  notificationState,
  pushSupport,
  shortPushClientId,
  subscriptionPayload,
} from "../frontend/pages/(task-workspace)/settings/notifications/lifecycle.js";

test("client ID remains stable and replaces malformed storage", () => {
  let stored = null;
  let generated = 0;
  const storage = {
    getItem: () => stored,
    setItem(key, value) {
      assert.equal(key, PUSH_CLIENT_ID_STORAGE_KEY);
      stored = value;
    },
  };
  const cryptoApi = {
    randomUUID() {
      generated += 1;
      return "00000000-0000-4000-8000-000000000001";
    },
  };

  assert.equal(
    getOrCreatePushClientId(storage, cryptoApi),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(getOrCreatePushClientId(storage, cryptoApi), stored);
  assert.equal(generated, 1);
  assert.equal(shortPushClientId(stored), "00000000");

  stored = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  assert.equal(
    getOrCreatePushClientId(storage, cryptoApi),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  assert.equal(stored, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(generated, 1);
});

test("support distinguishes unsupported and iOS installation requirements", () => {
  const supported = {
    Notification: {},
    PushManager: class {},
    navigator: {
      serviceWorker: {},
      userAgent: "Mozilla/5.0 (Macintosh)",
    },
  };
  assert.deepEqual(pushSupport(supported), {
    supported: true,
    requiresInstallation: false,
  });
  assert.deepEqual(pushSupport({ navigator: {} }), {
    supported: false,
    requiresInstallation: false,
  });
  assert.deepEqual(pushSupport({ ...supported, isSecureContext: false }), {
    supported: false,
    requiresInstallation: false,
  });
  assert.deepEqual(
    pushSupport({
      ...supported,
      navigator: {
        serviceWorker: {},
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        standalone: false,
      },
      matchMedia: () => ({ matches: false }),
    }),
    { supported: true, requiresInstallation: true },
  );
});

test("generated installation labels are bounded at Unicode boundaries", async () => {
  const label = await installationLabel({
    userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
    platform: "Test",
    userAgentData: {
      platform: "TestOS",
      async getHighEntropyValues() {
        return {
          fullVersionList: [{ brand: "Chrome", version: "140.0.0.0" }],
          platformVersion: "1.0",
          model: "📱".repeat(200),
        };
      },
    },
  });
  assert.equal([...label].length, 120);
  assert.equal(label.endsWith("\ud83d"), false);

  assert.equal(
    await installationLabel({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1",
      platform: "iPhone",
    }),
    "Safari 18 on iOS",
  );
});

test("notification permission is requested only by the explicit Enable action", () => {
  const pagePath = fileURLToPath(new URL(
    "../frontend/pages/(task-workspace)/settings/notifications/page.js",
    import.meta.url,
  ));
  const source = readFileSync(pagePath, "utf8");
  const enableBranch = source.slice(
    source.indexOf('if (action === "enable")'),
    source.indexOf('if (action === "disable")'),
  );
  assert.equal(source.match(/Notification\.requestPermission\(\)/g)?.length, 1);
  assert.match(enableBranch, /Notification\.requestPermission\(\)/);
});

test("state model represents every explicit browser lifecycle state", () => {
  const state = (overrides) =>
    notificationState({
      supported: true,
      requiresInstallation: false,
      permission: "default",
      hasSubscription: false,
      serverState: "unknown",
      ...overrides,
    });

  assert.equal(state({ supported: false }), "unsupported");
  assert.equal(state({ requiresInstallation: true }), "not-installed");
  assert.equal(state({ syncing: true }), "syncing");
  assert.equal(state({ permission: "denied" }), "denied");
  assert.equal(
    state({ permission: "granted", hasSubscription: false }),
    "granted-not-subscribed",
  );
  assert.equal(
    state({ permission: "granted", hasSubscription: true }),
    "granted-not-subscribed",
  );
  assert.equal(
    state({
      permission: "granted",
      hasSubscription: true,
      serverState: "subscribed",
    }),
    "subscribed",
  );
  assert.equal(
    state({
      permission: "granted",
      hasSubscription: true,
      serverState: "revoked",
    }),
    "disabled",
  );
});

test("browser subscription serialization sends only the provider contract and label", () => {
  const payload = subscriptionPayload(
    {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      toJSON: () => ({ keys: { p256dh: "public", auth: "secret" } }),
    },
    "Chrome 140 on macOS 16",
  );
  assert.deepEqual(payload, {
    installationLabel: "Chrome 140 on macOS 16",
    endpoint: "https://push.example/subscription",
    expirationTime: null,
    keys: { p256dh: "public", auth: "secret" },
  });
});
