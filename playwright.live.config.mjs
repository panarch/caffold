import { defineConfig } from "@playwright/test";
import { join } from "node:path";

import { resolveCodexBin } from "./tests/live/codex-bin.mjs";
import { createLivePlaywrightServer } from "./tests/playwright-local-server.mjs";

const externalLiveURL = process.env.CAFFOLD_LIVE_URL;
const localRuntimeRoot = join(
  process.cwd(),
  "target",
  `caffold-live-${process.pid}`,
);
const localServerScript = join(
  process.cwd(),
  "tests",
  "live",
  "caffold-live-server.mjs",
);
const localServer = externalLiveURL
  ? null
  : await createLivePlaywrightServer({
      codexBin: resolveCodexBin(),
      runtimeRoot: localRuntimeRoot,
      serverScript: localServerScript,
    });

export default defineConfig({
  testDir: "./tests/live",
  timeout: 300_000,
  expect: {
    timeout: 120_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: localServer?.webServer,
  use: {
    baseURL: externalLiveURL ?? localServer.baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
});
