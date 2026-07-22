import { defineConfig } from "@playwright/test";

import { resolveCodexBin } from "./tests/live/codex-bin.mjs";

const defaultLiveURL = "http://127.0.0.1:55178";
const externalLiveURL = process.env.CAFFOLD_LIVE_URL;
const codexBin = resolveCodexBin();

export default defineConfig({
  testDir: "./tests/live",
  timeout: 300_000,
  expect: {
    timeout: 120_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: externalLiveURL
    ? undefined
    : {
    command:
      "cargo run --quiet -- serve --host 127.0.0.1 --port 55178",
        url: defaultLiveURL,
        env: { ...process.env, CAFFOLD_CODEX_BIN: codexBin },
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
  use: {
    baseURL: externalLiveURL ?? defaultLiveURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
});
