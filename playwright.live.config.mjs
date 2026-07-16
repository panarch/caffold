import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  timeout: 180_000,
  expect: {
    timeout: 120_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.CAFFOLD_LIVE_URL ?? "http://127.0.0.1:5178",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
});
