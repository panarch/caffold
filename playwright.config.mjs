import { defineConfig } from "@playwright/test";

import { viewportCoveragePattern } from "./tests/e2e/support/project-coverage.js";
import { createRegularPlaywrightServer } from "./tests/playwright-local-server.mjs";

const localServer = await createRegularPlaywrightServer();

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.mjs",
  globalTeardown: "./tests/e2e/global-teardown.mjs",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  preserveOutput: "always",
  expect: {
    timeout: 7_500,
  },
  webServer: localServer.webServer,
  use: {
    baseURL: localServer.baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      grep: viewportCoveragePattern("desktop"),
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "foldable",
      grep: viewportCoveragePattern("foldable"),
      use: {
        viewport: { width: 933, height: 704 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "phone",
      grep: viewportCoveragePattern("phone"),
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
