import { expect, test } from "@playwright/test";
import { waitForActionHintTarget } from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("serves one Task workspace shell and only active static assets", { tag: "@all-viewports" }, async ({
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
  await expect(
    shell.locator(":scope > caffold-keyboard-navigation-presentation"),
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
    "/assets/pages/pwa-update-lifecycle.js",
    "/assets/pages/pwa-update-lifecycle/machine.js",
    "/assets/pages/pwa-update-lifecycle/runtime.js",
    "/assets/pages/components/build-mismatch-alert.css",
    "/assets/pages/components/build-mismatch-alert.js",
    "/assets/pages/components/update-dialog.css",
    "/assets/pages/components/update-dialog.js",
    "/assets/action-hints.js",
    "/assets/action-hints/components/dialog.js",
    "/assets/keyboard-navigation.js",
    "/assets/keyboard-navigation/context.js",
    "/assets/keyboard-navigation/components/presentation.js",
    "/assets/keyboard-navigation/components/selector.js",
    "/assets/pages/(task-workspace)/layout.js",
    "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/changes-tree.js",
    "/assets/pages/(task-workspace)/tasks/(detail)/(git)/layout.js",
    "/assets/pages/(task-workspace)/tasks/(detail)/(github)/layout.js",
    "/assets/pages/(task-workspace)/codex-status.js",
    "/assets/pages/(task-workspace)/codex-status/model.js",
    "/assets/pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js",
    "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js",
    "/assets/pages/(task-workspace)/settings/components/detail-list.css",
    "/assets/pages/(task-workspace)/settings/components/detail-list.js",
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
    "/assets/pages/(task-workspace)/action-hints.js",
    "/assets/pages/(task-workspace)/keyboard-navigation.js",
    "/assets/pages/(task-workspace)/keyboard-navigation-context.js",
  ]) {
    expect(serviceWorker).not.toContain(removed);
    expect((await request.get(removed)).status(), removed).toBe(404);
  }
  expect(serviceWorker).toContain("caffold:claim-prepared-build");
  expect(serviceWorker).toContain('activeShellFirst(request, "/")');
  expect(serviceWorker).toContain("APP_SHELL_ASSET_PATHS.has(url.pathname)");
  expect(serviceWorker).not.toContain("networkFirst");
});

test("keeps bootstrap Retry keyboard-accessible outside the hidden workspace", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/");
  const shell = page.locator("caffold-app-shell");
  const workspace = shell.locator("caffold-task-workspace");
  await shell.evaluate((element) => {
    element.setBootstrapError(new Error("Temporary bootstrap failure"));
  });
  await expect(workspace).toBeHidden();

  await page.keyboard.press("f");
  const hint = page.locator("caffold-action-hint-dialog > dialog:modal");
  await expect(hint).toBeVisible();
  const retry = hint.getByRole("button", { name: / — Retry$/ });
  const code = await retry.getAttribute("data-action-hint-code");
  expect(code).toBeTruthy();
  await page.keyboard.type(code.toLowerCase());

  await expect(hint).toBeHidden();
  await expect(workspace).toBeVisible();
});

test("merges foreground Retry with normal workspace targets", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/");
  const shell = page.locator("caffold-app-shell");
  await expect.poll(() => shell.evaluate(
    (element) => element.foregroundRecoveryLifecycle.snapshot(),
  )).toMatchObject({
    lastTrigger: "bootstrap",
    presentation: "none",
  });
  await shell.evaluate((element) => {
    element.foregroundRecoveryLifecycle.disconnect();
    window.__foregroundKeyboardRetries = 0;
    element.foregroundRecoveryLifecycle.requestManualRetry = () => {
      window.__foregroundKeyboardRetries += 1;
    };
    element.applyForegroundRecoverySnapshot({
      lastTrigger: "test",
      presentation: "unavailable",
    });
  });

  await waitForActionHintTarget(page, "Retry");
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("f");
  const hint = page.locator("caffold-action-hint-dialog > dialog:modal");
  await expect(hint).toBeVisible();
  await expect(hint.getByRole("button", { name: / — Retry$/ })).toBeVisible();
  await expect(hint.locator('[data-action-hint-code="M"]')).toBeVisible();
  const retryCode = await hint.getByRole("button", {
    name: / — Retry$/,
  }).getAttribute("data-action-hint-code");
  expect(retryCode).toBeTruthy();
  await page.keyboard.type(retryCode.toLowerCase());
  await expect.poll(() => page.evaluate(
    () => window.__foregroundKeyboardRetries,
  )).toBe(1);
});

test("does not serve obsolete standalone application routes", { tag: "@all-viewports" }, async ({ request }) => {
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

test("keeps exceptional build mismatch outside application layout", { tag: "@all-viewports" }, async ({
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

  await alert.getByRole("button", { name: "Reload" }).focus();
  await page.keyboard.press("f");
  const hint = page.locator("caffold-action-hint-dialog > dialog:modal");
  await expect(hint.getByRole("button", { name: / — Reload$/ })).toBeVisible();
  await page.keyboard.press("Escape");

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
