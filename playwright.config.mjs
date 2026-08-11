import { defineConfig } from "@playwright/test";

import { createRegularPlaywrightServer } from "./tests/playwright-local-server.mjs";

const localServer = await createRegularPlaywrightServer();

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.mjs",
  globalTeardown: "./tests/e2e/global-teardown.mjs",
  timeout: 30_000,
  preserveOutput: "always",
  expect: {
    timeout: 7_500,
  },
  webServer: localServer.webServer,
  use: {
    baseURL: localServer.baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "foldable",
      use: {
        viewport: { width: 933, height: 704 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "phone",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
