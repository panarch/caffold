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
  await expect(
    shell.locator(":scope > .app-main > caffold-task-workspace"),
  ).toHaveCount(1);
  await expect(shell.locator(":scope > caffold-update-dialog")).toHaveCount(1);
  await expect(
    shell.locator(":scope > caffold-build-mismatch-alert"),
  ).toHaveCount(1);
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
    "/assets/pages/components/build-mismatch-alert.css",
    "/assets/pages/components/build-mismatch-alert.js",
    "/assets/pages/components/pwa-update-lifecycle.js",
    "/assets/pages/components/update-dialog.css",
    "/assets/pages/components/update-dialog.js",
    "/assets/pages/(task-workspace)/layout.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/review/changes-tree.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/(git)/layout.js",
    "/assets/pages/(task-workspace)/tasks/components/detail/(github)/layout.js",
    "/assets/pages/(task-workspace)/settings/codex/status-model.js",
    "/assets/pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.js",
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
  expect(serviceWorker).toContain("caffold:claim-prepared-build");
  expect(serviceWorker).toContain('activeShellFirst(request, "/")');
  expect(serviceWorker).toContain("APP_SHELL_ASSET_PATHS.has(url.pathname)");
  expect(serviceWorker).not.toContain("networkFirst");
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

test("keeps exceptional build mismatch outside application layout", async ({
  page,
}) => {
  await page.goto("/");
  const shell = page.locator("caffold-app-shell");
  const alert = shell.locator("caffold-build-mismatch-alert");
  await expect(alert).toBeHidden();
  await shell.evaluate((element) => {
    element.updateBuildStatus({
      buildId: "new-server-build",
      buildLabel: "new-server-build",
    });
  });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("New Caffold build available");
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();

  const layout = await shell.evaluate((element) => {
    const main = element.querySelector(".app-main").getBoundingClientRect();
    const shellRect = element.getBoundingClientRect();
    const alertElement = element.querySelector("caffold-build-mismatch-alert");
    const alertRect = alertElement.getBoundingClientRect();
    const style = getComputedStyle(alertElement);
    return {
      alertBottom: Math.round(alertRect.bottom),
      alertTop: Math.round(alertRect.top),
      mainBottom: Math.round(main.bottom),
      position: style.position,
      shellPosition: getComputedStyle(element).position,
      shellBottom: Math.round(shellRect.bottom),
      shellTop: Math.round(shellRect.top),
      zIndex: Number(style.zIndex),
    };
  });
  expect(layout).toMatchObject({
    alertBottom: page.viewportSize().height,
    mainBottom: page.viewportSize().height,
    position: "fixed",
    shellBottom: page.viewportSize().height,
    shellPosition: "fixed",
    shellTop: 0,
  });
  expect(layout.alertTop).toBeLessThan(layout.mainBottom);
  expect(layout.zIndex).toBeGreaterThan(20);
});
