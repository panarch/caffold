import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { viewportCoveragePattern } from "./tests/e2e/support/project-coverage.js";
import { createRegularPlaywrightServer } from "./tests/playwright-local-server.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const localServer = await createRegularPlaywrightServer();

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: join(repositoryRoot, "test-results"),
  globalSetup: "./tests/e2e/global-setup.mjs",
  globalTeardown: "./tests/e2e/global-teardown.mjs",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
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
