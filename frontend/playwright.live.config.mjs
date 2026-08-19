import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCodexBin } from "./tests/live/codex-bin.mjs";
import { createLivePlaywrightServer } from "./tests/playwright-local-server.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const frontendRoot = fileURLToPath(new URL("./", import.meta.url));
const externalLiveURL = process.env.CAFFOLD_LIVE_URL;
const localRuntimeRoot = join(
  repositoryRoot,
  "target",
  `caffold-live-${process.pid}`,
);
const localServerScript = join(
  frontendRoot,
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
  outputDir: join(repositoryRoot, "test-results"),
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
