import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("serves one Task workspace shell and only active static assets", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const shell = page.locator("caffold-app-shell");
  await expect(shell.locator(":scope > .app-main > caffold-task-workspace")).toHaveCount(1);
  await expect(shell.locator("caffold-files-page")).toHaveCount(0);
  await expect(shell.locator("caffold-review-workspace")).toHaveCount(0);
  await expect(shell.locator("caffold-header-actions")).toHaveCount(0);
  await expect(shell.locator("caffold-pathbar")).toHaveCount(0);

  const buildInfo = await (await request.get("/assets/build-info.js")).text();
  const buildId = buildInfo.match(/id: "([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();
  const health = await (await request.get("/api/health")).json();
  expect(health.buildId).toBe(buildId);

  const serviceWorkerResponse = await request.get("/service-worker.js");
  expect(serviceWorkerResponse.headers()["cache-control"]).toContain("no-cache");
  const serviceWorker = await serviceWorkerResponse.text();
  expect(serviceWorker).toContain(
    `const CACHE_NAME = ${JSON.stringify(`caffold-shell-${health.buildId}`)};`,
  );
  for (const asset of [
    "/assets/pages/layout.js",
    "/assets/pages/(task-workspace)/layout.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/review/changes-tree.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/(git)/layout.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/(github)/layout.js",
    "/assets/pages/(task-workspace)/settings/codex/status-model.js",
    "/assets/components/file-navigator/list.js",
  ]) {
    expect(serviceWorker).toContain(asset);
    expect((await request.get(asset)).ok(), asset).toBe(true);
  }
  for (const removed of [
    "/assets/pages/files/page.js",
    "/assets/pages/(review-workspace)/layout.js",
    "/assets/components/file-browser.js",
    "/assets/components/git-diff-browser.js",
    "/assets/pages/components/app-menu.js",
    "/assets/pages/components/pathbar.js",
    "/assets/pages/components/header-actions.js",
  ]) {
    expect(serviceWorker).not.toContain(removed);
    expect((await request.get(removed)).status(), removed).toBe(404);
  }
});

test("does not serve obsolete standalone application routes", async ({ request }) => {
  for (const route of [
    "/files",
    "/git/diff",
    "/git/compare",
    "/git/log",
    "/github/issues",
    "/github/pulls",
  ]) {
    expect((await request.get(route, { maxRedirects: 0 })).status(), route).toBe(404);
  }
});

test("keeps build updates at the application lifetime boundary", async ({ page }) => {
  await page.goto("/");
  const shell = page.locator("caffold-app-shell");
  await expect(shell.locator(".app-build-alert")).toBeHidden();
  await shell.evaluate((element) => {
    element.updateBuildStatus({
      buildId: "new-server-build",
      buildLabel: "new-server-build",
    });
  });
  const alert = shell.locator(".app-build-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("New Caffold build available");
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
});
