import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  preserveOutput: "always",
  expect: {
    timeout: 7_500,
  },
  webServer: {
    command:
      "cargo run -- serve --host 127.0.0.1 --port 18765 --root tests/fixtures/home",
    url: "http://127.0.0.1:18765/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:18765",
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
        viewport: { width: 884, height: 1104 },
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
