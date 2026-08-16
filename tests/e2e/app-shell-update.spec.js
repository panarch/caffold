import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { captureReviewScreenshot } from "./support/task-fixtures.js";

const serviceWorkerSource = readFileSync(
  new URL("../../frontend/service-worker.js", import.meta.url),
  "utf8",
);
const TEST_ACTIVATE_WAITING_MESSAGE = "caffold:test-activate-waiting";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("suppresses the first install but presents a later replacement", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: false });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  await triggerServiceWorkerActivation(page, "first-build");

  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeHidden();
  await expect(page.locator("caffold-settings-about-page")).not.toContainText(
    "Prepared update",
  );

  await triggerServiceWorkerActivation(page, "replacement-build");
  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeVisible();
});

test("discovers a replacement while the current UI remains open", { tag: "@all-viewports" }, async ({ page }) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("settled");
  const previousUpdateCalls = await serviceWorkerUpdateCalls(page);

  await publishServiceWorkerReplacement(page, "replacement-build");
  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeHidden();

  await triggerVisibleServiceWorkerUpdateCheck(page);

  await expect.poll(() => serviceWorkerUpdateCalls(page)).toBeGreaterThan(
    previousUpdateCalls,
  );
  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeVisible();
});

test("rechecks the worker and server diagnostics when About opens", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let healthBuildId = "server-build-a";
  let healthRequests = 0;
  await page.route(/\/api\/health(?:\?|$)/, (route) => {
    healthRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        buildId: healthBuildId,
        buildLabel: healthBuildId,
        buildNumber: "1",
        serverName: "Caffold test server",
        root: "/",
        initialPath: "",
        homePath: "",
        maxFileBytes: 1_048_576,
      }),
    });
  });
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await expect.poll(() => healthRequests).toBe(1);
  const previousUpdateCalls = await serviceWorkerUpdateCalls(page);

  healthBuildId = "server-build-b";
  await publishServiceWorkerReplacement(page, "server-build-b");
  await openAboutWithoutReload(page);

  await expect.poll(() => healthRequests).toBe(2);
  await expect.poll(() => serviceWorkerUpdateCalls(page)).toBeGreaterThan(
    previousUpdateCalls,
  );
  const about = page.locator("caffold-settings-about-page");
  await expect(about).toContainText("server-build-b");
  await expect(about).toContainText("Prepared update");
  await expect(about).toContainText("Update ready");
  await expect(
    about.getByRole("button", { name: "Reload to update" }),
  ).toBeVisible();
  const diagnostics = await about.evaluate((page) => page.diagnosticsText());
  expect(diagnostics).toContain("Status: Update ready");
  expect(diagnostics).toContain("Update handoff: idle");
  expect(diagnostics).toContain("Update target: none");
  expect(diagnostics).toContain("Service Worker controller: none");
  expect(diagnostics).toContain("Service Worker active: server-build-b");
  expect(diagnostics).toContain("Update navigation attempts: 0");
  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeVisible();
  await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
});

test("keeps a dismissed update available and only reports a settled mismatch", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  await triggerServiceWorkerActivation(page, "replacement-build");
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "replacement-build",
      buildLabel: "replacement-build",
    });
  });

  const updateDialog = page.getByRole("dialog", { name: "Caffold update ready" });
  await expect(updateDialog).toBeVisible();
  await expect(updateDialog).toContainText("keep using the current build");
  await expect(
    updateDialog.locator("#caffold-update-dialog-description br"),
  ).toHaveCount(1);
  const dialogButtonStyles = await updateDialog.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    }),
  );
  const primaryColors = await primaryActionColors(page);
  expect(dialogButtonStyles[0]).not.toEqual(primaryColors);
  expect(dialogButtonStyles[1]).toEqual(primaryColors);
  const dialogBox = await updateDialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "pwa-update-ready");

  await updateDialog.getByRole("button", { name: "Later" }).click();
  await expect(updateDialog).toBeHidden();
  await repeatServiceWorkerStateChange(page);
  await expect(updateDialog).toBeHidden();

  await openAboutWithoutReload(page);
  const about = page.locator("caffold-settings-about-page");
  await expect(about).toBeVisible();
  await expect(about).toContainText("Prepared update");
  await expect(about).toContainText("Ready");
  await expect(
    about.getByRole("button", { name: "Reload to update" }),
  ).toBeVisible();
  const aboutReloadColors = await about
    .getByRole("button", { name: "Reload to update" })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      const surfaceStyle = getComputedStyle(button, "::before");
      return {
        backgroundColor: surfaceStyle.backgroundColor,
        borderColor: surfaceStyle.borderColor,
        color: style.color,
      };
    });
  expect(aboutReloadColors).toEqual(primaryColors);
  await captureReviewScreenshot(page, testInfo, "pwa-update-about");

  await retireLatestServiceWorker(page);
  await expect(about).not.toContainText("Prepared update");
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "different-server-build",
      buildLabel: "different-server-build",
    });
  });
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("settled");
  await expect(page.locator("caffold-build-mismatch-alert")).toBeVisible();
  await expect(page.locator("caffold-build-mismatch-alert")).toContainText(
    "different-server-build",
  );
  await captureReviewScreenshot(page, testInfo, "pwa-exceptional-mismatch");
});

test("keeps consecutive server builds inside the update lifecycle", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  await triggerServiceWorkerActivation(page, "replacement-build-b");
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "replacement-build-b",
      buildLabel: "replacement-build-b",
    });
  });
  const updateDialog = page.getByRole("dialog", {
    name: "Caffold update ready",
  });
  await expect(updateDialog).toBeVisible();
  await updateDialog.getByRole("button", { name: "Later" }).click();

  await holdServiceWorkerUpdates(page);
  await publishServiceWorkerReplacement(page, "replacement-build-c");
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "replacement-build-c",
      buildLabel: "replacement-build-c",
    });
  });

  const buildMismatchAlert = page.locator("caffold-build-mismatch-alert");
  await expect
    .poll(() => serviceWorkerUpdateSnapshot(page))
    .toMatchObject({
      state: "ready",
      preparedUpdate: { ready: true, buildId: "replacement-build-b" },
    });
  await expect(buildMismatchAlert).toBeHidden();

  await releaseServiceWorkerUpdates(page);
  await expect
    .poll(() => serviceWorkerUpdateSnapshot(page))
    .toMatchObject({
      state: "ready",
      preparedUpdate: { ready: true, buildId: "replacement-build-c" },
    });
  await expect(buildMismatchAlert).toBeHidden();
  await expect(updateDialog).toBeVisible();
  await openAboutWithoutReload(page);
  await expect(page.locator("caffold-settings-about-page")).toContainText(
    "Update ready",
  );
});

test("defers exceptional mismatch while an update check or install is pending", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  await holdServiceWorkerUpdates(page);
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "unprepared-server-build",
      buildLabel: "unprepared-server-build",
    });
  });

  const buildMismatchAlert = page.locator("caffold-build-mismatch-alert");
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("checking");
  await expect(buildMismatchAlert).toBeHidden();

  await releaseServiceWorkerUpdates(page);
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("settled");
  await expect(buildMismatchAlert).toBeVisible();

  await beginServiceWorkerInstall(page, "unprepared-server-build");
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("checking");
  await expect(buildMismatchAlert).toBeHidden();

  await failServiceWorkerInstall(page);
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("settled");
  await expect(buildMismatchAlert).toBeVisible();
});

test("releases update observers while disconnected and restores them once", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await holdServiceWorkerUpdates(page);
  await publishServiceWorkerReplacement(page, "replacement-while-disconnected");
  await page.locator("caffold-app-shell").evaluate((shell) => {
    void shell.pwaUpdateLifecycle.checkForUpdate();
  });
  await expect.poll(() => serviceWorkerUpdateState(page)).toBe("checking");
  const updateCallsBeforeDisconnect = await serviceWorkerUpdateCalls(page);

  await page.locator("caffold-app-shell").evaluate((shell) => {
    window.__caffoldDetachedAppShell = shell;
    shell.remove();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
  });
  await releaseServiceWorkerUpdates(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Boolean(
            window.__caffoldDetachedAppShell.pwaUpdateLifecycle.runtime
              .updateRequest,
          ),
      ),
    )
    .toBe(false);
  const disconnected = await page.evaluate(() => ({
    observedWorkers:
      window.__caffoldDetachedAppShell.pwaUpdateLifecycle.runtime
        .observedServiceWorkers.size,
    updateIntervalActive:
      window.__caffoldDetachedAppShell.pwaUpdateLifecycle.runtime
        .updateIntervalId !== null,
  }));
  expect(disconnected).toEqual({
    observedWorkers: 0,
    updateIntervalActive: false,
  });
  await page.waitForTimeout(50);
  expect(await serviceWorkerUpdateCalls(page)).toBe(updateCallsBeforeDisconnect);

  await page.evaluate(() => {
    document.body.append(window.__caffoldDetachedAppShell);
  });
  await expect.poll(() => serviceWorkerUpdateCalls(page)).toBeGreaterThan(
    updateCallsBeforeDisconnect,
  );
  await expect
    .poll(() =>
      page.locator("caffold-app-shell").evaluate(
        (shell) => shell.pwaUpdateLifecycle.runtime.updateIntervalId !== null,
      ),
    )
    .toBe(true);
});

test("keeps a prepared cache safe from the current worker's pruning", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, {
    controlled: true,
    waitingBuildId: "prepared-build",
  });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  const pruneRequests = await page.evaluate(() =>
    window.__caffoldServiceWorkerMessages.filter(
      ({ message }) => message.type === "caffold:prune-shell-caches",
    ),
  );
  expect(pruneRequests).toEqual([]);
});

test("removes a prepared update when its worker becomes unavailable", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);

  await triggerServiceWorkerActivation(page, "discarded-build");
  const updateDialog = page.getByRole("dialog", {
    name: "Caffold update ready",
  });
  await expect(updateDialog).toBeVisible();
  await retireLatestServiceWorker(page);

  await expect(updateDialog).toBeHidden();
  await expect
    .poll(() =>
      page.locator("caffold-app-shell").evaluate(
        (shell) => shell.pwaUpdateLifecycle.snapshot().preparedUpdate,
      ),
    )
    .toEqual({ ready: false, buildId: null });
  await openAboutWithoutReload(page);
  await expect(page.locator("caffold-settings-about-page")).not.toContainText(
    "Prepared update",
  );
});

test("retains activation through an unowned transition and reloads on controllerchange", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await prepareWaitingServiceWorker(page, "replacement-build");
  await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeVisible();
  await interceptPreparedReloads(page);

  await page.getByRole("dialog", { name: "Caffold update ready" })
    .getByRole("button", { name: "Reload" })
    .click();
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:activate-prepared-build",
    "replacement-build",
  )).toBe(1);

  await startPreparedServiceWorkerActivation(page, {
    temporarilyUnowned: true,
  });
  const transition = await page.locator("caffold-app-shell").evaluate((shell) => {
    const runtime = shell.pwaUpdateLifecycle.runtime;
    return {
      active: runtime.registration.active,
      handoffNode: runtime.handoffState.node,
      preparedBuildId: runtime.snapshot().preparedUpdate.buildId,
      targetBuildId: runtime.handoffState.targetBuildId,
      waiting: runtime.registration.waiting,
    };
  });
  expect(transition).toEqual({
    active: null,
    handoffNode: "activating",
    preparedBuildId: "replacement-build",
    targetBuildId: "replacement-build",
    waiting: null,
  });

  const pruneRequests = await serviceWorkerMessageCount(
    page,
    "caffold:prune-shell-caches",
  );
  await page.locator("caffold-app-shell").evaluate(async (shell) => {
    await caches.open("caffold-shell-transition-probe");
    await shell.pwaUpdateLifecycle.runtime.pruneShellCachesIfSafe();
  });
  expect(await serviceWorkerMessageCount(
    page,
    "caffold:prune-shell-caches",
  )).toBe(pruneRequests);

  await completePreparedServiceWorkerActivation(page);
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build",
  )).toBe(1);
  await controlLatestServiceWorker(page);
  await expect.poll(() => preparedReloadCount(page)).toBe(1);

  await controlLatestServiceWorker(page);
  await announceLatestControlled(page);
  expect(await preparedReloadCount(page)).toBe(1);
});

test("uses a differing controlled-message wrapper as a safe fallback hint", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await triggerServiceWorkerActivation(page, "replacement-build");
  await interceptPreparedReloads(page);

  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.pwaUpdateLifecycle.activatePreparedUpdate();
  });
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build",
  )).toBe(1);

  await controlLatestServiceWorker(page, { dispatch: false });
  await announceLatestControlled(page, { differentSource: true });
  await expect.poll(() => preparedReloadCount(page)).toBe(1);
});

test("reconnect and repeated update requests safely resume one handoff", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await triggerServiceWorkerActivation(page, "replacement-build");
  await interceptPreparedReloads(page);

  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.pwaUpdateLifecycle.activatePreparedUpdate();
    shell.pwaUpdateLifecycle.activatePreparedUpdate();
  });
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build",
  )).toBe(2);

  await page.locator("caffold-app-shell").evaluate((shell) => {
    window.__caffoldDetachedAppShell = shell;
    shell.remove();
    document.body.append(shell);
  });
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build",
  )).toBeGreaterThan(2);

  await controlLatestServiceWorker(page);
  await announceLatestControlled(page, { differentSource: true });
  await expect.poll(() => preparedReloadCount(page)).toBe(1);
});

test("retargets an in-flight handoff to the latest prepared build", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await prepareWaitingServiceWorker(page, "replacement-build-b");
  await interceptPreparedReloads(page);

  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.pwaUpdateLifecycle.activatePreparedUpdate();
  });
  await startPreparedServiceWorkerActivation(page);
  await completePreparedServiceWorkerActivation(page);
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build-b",
  )).toBe(1);

  await prepareWaitingServiceWorker(page, "replacement-build-c");
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:activate-prepared-build",
    "replacement-build-c",
  )).toBe(1);
  await expect.poll(() => page.locator("caffold-app-shell").evaluate(
    (shell) => shell.pwaUpdateLifecycle.runtime.handoffState.targetBuildId,
  )).toBe("replacement-build-c");

  await startPreparedServiceWorkerActivation(page, {
    preservePreviousActive: true,
  });
  await expect.poll(() => page.locator("caffold-app-shell").evaluate(
    (shell) => shell.pwaUpdateLifecycle.runtime.handoffState.targetBuildId,
  )).toBe("replacement-build-c");

  await controlServiceWorker(page, "replacement-build-b");
  expect(await preparedReloadCount(page)).toBe(0);

  await completePreparedServiceWorkerActivation(page);
  await expect.poll(() => serviceWorkerMessageCount(
    page,
    "caffold:claim-prepared-build",
    "replacement-build-c",
  )).toBe(1);
  await controlServiceWorker(page, "replacement-build-c");
  await expect.poll(() => preparedReloadCount(page)).toBe(1);
});

test("routes dialog and About reload intents through the app shell", { tag: "@all-viewports" }, async ({ page }) => {
  await installServiceWorkerFixture(page, { controlled: true });
  await page.goto("/");
  await waitForServiceWorkerRegistration(page);
  await page.locator("caffold-app-shell").evaluate((shell) => {
    window.__caffoldReloadRequests = 0;
    shell.pwaUpdateLifecycle.activatePreparedUpdate = () => {
      window.__caffoldReloadRequests += 1;
    };
  });

  await triggerServiceWorkerActivation(page, "replacement-build");
  const updateDialog = page.getByRole("dialog", { name: "Caffold update ready" });
  await updateDialog.getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => reloadRequests(page)).toBe(1);

  await triggerServiceWorkerActivation(page, "next-replacement-build");
  await page.getByRole("dialog", { name: "Caffold update ready" })
    .getByRole("button", { name: "Later" })
    .click();
  await openAboutWithoutReload(page);
  await page
    .locator("caffold-settings-about-page")
    .getByRole("button", { name: "Reload to update" })
    .click();
  await expect.poll(() => reloadRequests(page)).toBe(2);
});

test("prepares and reloads the latest consecutive replacement through the real browser lifecycle", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await startBuildLifecycleServer(testInfo.project.use.baseURL);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect(page.getByRole("dialog", { name: "Caffold update ready" })).toBeHidden();
    await page.reload();
    await expect.poll(() => activeControllerState(page)).toBe("activated");
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-a",
    );

    await openAboutWithoutReload(page);
    const about = page.locator("caffold-settings-about-page");
    await expect(about).toContainText("browser-build-a");

    fixture.setBuild("browser-build-b", 2);
    await openAboutWithoutReload(page);

    const updateDialog = page.getByRole("dialog", {
      name: "Caffold update ready",
    });
    await expect(about).toContainText("browser-build-b");
    await expect.poll(() => shellCacheKeys(page), { timeout: 20_000 }).toEqual(
      expect.arrayContaining([
        "caffold-shell-browser-build-a",
        "caffold-shell-browser-build-b",
      ]),
    );
    await expect.poll(() => cachedShellBuild(page, "browser-build-b")).toBe(
      "browser-build-b",
    );
    await expect.poll(() => fetchedShellBuild(page)).toBe("browser-build-a");
    await expect.poll(() => serviceWorkerDiagnostics(page)).toMatchObject({
      activeState: "activated",
      controllerState: "activated",
      activeIsController: true,
      activeIsFirstInstallation: false,
      waitingState: "installed",
      readyIsWaiting: true,
      ready: true,
    });
    await expect(updateDialog).toBeVisible();
    await expect(about).toContainText("Prepared update");
    await expect(about).toContainText("Update ready");
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();

    const readyLayout = await appShellLayout(page);
    expect(readyLayout).toEqual({
      mainBottom: readyLayout.viewportHeight,
      position: "fixed",
      shellBottom: readyLayout.viewportHeight,
      shellTop: 0,
      viewportHeight: readyLayout.viewportHeight,
    });

    await updateDialog.getByRole("button", { name: "Later" }).click();
    await expect(updateDialog).toBeHidden();

    fixture.setBuild("browser-build-c", 3);
    await openAboutWithoutReload(page);
    await expect(about).toContainText("browser-build-c");
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await expect.poll(() => shellCacheKeys(page), { timeout: 20_000 }).toEqual(
      expect.arrayContaining(["caffold-shell-browser-build-c"]),
    );
    await expect.poll(() => cachedShellBuild(page, "browser-build-c")).toBe(
      "browser-build-c",
    );
    await expect.poll(() => serviceWorkerDiagnostics(page)).toMatchObject({
      lifecycleState: "ready",
      readyBuildId: "browser-build-c",
      readyIsWaiting: true,
    });
    await expect(updateDialog).toBeVisible();
    await expect(about).toContainText("Update ready");
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await updateDialog.getByRole("button", { name: "Later" }).click();
    await expect(updateDialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Reload to update" }),
    ).toHaveCount(1);
    await captureReviewScreenshot(page, testInfo, "pwa-update-about-latest-ready");
    await deferUpdateNavigation(page);
    await about.getByRole("button", { name: "Reload to update" }).click();
    await expect.poll(() => serviceWorkerDiagnostics(page)).toMatchObject({
      targetBuildId: "browser-build-c",
    });
    await activateWaitingServiceWorker(page);
    await expect.poll(() => reconcileServiceWorkerDiagnostics(page)).toMatchObject({
      controllerBuildId: "browser-build-c",
      handoffNode: "applying",
      navigationAttemptCount: 1,
      targetBuildId: "browser-build-c",
    });
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await releaseDeferredUpdateNavigation(page);
    const navigationResponse = await navigation;
    expect(navigationResponse.headers()["x-caffold-test-build"]).toBe(
      "browser-build-c",
    );

    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-c",
    );
    await expect(page.locator("caffold-settings-about-page")).toContainText(
      "browser-build-c",
    );
    await expect(page.locator("caffold-settings-about-page")).toContainText("Current");
    await expect(page.locator("caffold-settings-about-page")).not.toContainText(
      "Prepared update",
    );
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await expect(updateDialog).toBeHidden();
    const updatedLayout = await appShellLayout(page);
    expect(updatedLayout).toEqual({
      mainBottom: updatedLayout.viewportHeight,
      position: "fixed",
      shellBottom: updatedLayout.viewportHeight,
      shellTop: 0,
      viewportHeight: updatedLayout.viewportHeight,
    });
    await expect.poll(() => shellCacheKeys(page)).not.toContain(
      "caffold-shell-browser-build-a",
    );

    await page.reload();
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-c",
    );
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await expect(updateDialog).toBeHidden();
  } finally {
    await fixture.close();
  }
});

test("reloads through controllerchange without a custom acknowledgement or loop", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await startBuildLifecycleServer(testInfo.project.use.baseURL);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => activeControllerState(page)).toBe("activated");
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-a",
    );
    await page.evaluate(() => {
      sessionStorage.setItem("caffold-controlled-message-count", "0");
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "caffold:update-controlled") {
          const count = Number(
            sessionStorage.getItem("caffold-controlled-message-count") ?? "0",
          );
          sessionStorage.setItem(
            "caffold-controlled-message-count",
            String(count + 1),
          );
        }
      });
    });

    fixture.setBuild("browser-build-b", 2, { omitControlledAck: true });
    await page.locator("caffold-app-shell").evaluate(async (shell) => {
      await shell.pwaUpdateLifecycle.checkForUpdate();
    });

    const updateDialog = page.getByRole("dialog", {
      name: "Caffold update ready",
    });
    await expect(updateDialog).toBeVisible();
    await deferUpdateNavigation(page);
    await updateDialog.getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => serviceWorkerDiagnostics(page)).toMatchObject({
      targetBuildId: "browser-build-b",
    });
    await activateWaitingServiceWorker(page);
    await expect.poll(() => reconcileServiceWorkerDiagnostics(page)).toMatchObject({
      controllerBuildId: "browser-build-b",
      handoffNode: "applying",
      navigationAttemptCount: 1,
      targetBuildId: "browser-build-b",
    });
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await releaseDeferredUpdateNavigation(page);
    const navigationResponse = await navigation;
    expect(navigationResponse.headers()["x-caffold-test-build"]).toBe(
      "browser-build-b",
    );
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-b",
    );
    expect(await page.evaluate(() =>
      sessionStorage.getItem("caffold-controlled-message-count")
    )).toBe("0");
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await expect(updateDialog).toBeHidden();

    await page.reload();
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-b",
    );
    await expect(page.locator("caffold-build-mismatch-alert")).toBeHidden();
    await expect(updateDialog).toBeHidden();
  } finally {
    await fixture.close();
  }
});

test("recovers when the first controlled-update navigation leaves the old document alive", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const fixture = await startBuildLifecycleServer(testInfo.project.use.baseURL);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => activeControllerState(page)).toBe("activated");
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-a",
    );

    fixture.setBuild("browser-build-b", 2, { omitControlledAck: true });
    await page.locator("caffold-app-shell").evaluate(async (shell) => {
      await shell.pwaUpdateLifecycle.checkForUpdate();
      window.__caffoldLostUpdateNavigations = 0;
      shell.pwaUpdateLifecycle.runtime.onReloadReady = () => {
        window.__caffoldLostUpdateNavigations += 1;
      };
    });

    const updateDialog = page.getByRole("dialog", {
      name: "Caffold update ready",
    });
    await expect(updateDialog).toBeVisible();
    await updateDialog.getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => page.locator("caffold-app-shell").evaluate(
      (shell) => shell.pwaUpdateLifecycle.runtime.handoffState.targetBuildId,
    )).toBe("browser-build-b");
    await activateWaitingServiceWorker(page);
    await expect.poll(() => page.locator("caffold-app-shell").evaluate(
      (shell) => {
        const runtime = shell.pwaUpdateLifecycle.runtime;
        return {
          activeBuildId: runtime.serviceWorkerBuildIds.get(
            runtime.registration?.active,
          ) ?? null,
          activeState: runtime.registration?.active?.state ?? null,
          controllerBuildId: runtime.controllerBuildId(),
          handoffNode: runtime.handoffState.node,
          targetBuildId: runtime.handoffState.targetBuildId,
          targetPhase: runtime.handoffState.targetPhase,
          waitingState: runtime.registration?.waiting?.state ?? null,
        };
      },
    )).toEqual({
      activeBuildId: "browser-build-b",
      activeState: "activated",
      controllerBuildId: "browser-build-b",
      handoffNode: "applying",
      targetBuildId: "browser-build-b",
      targetPhase: "controlled",
      waitingState: null,
    });
    await expect.poll(() => page.evaluate(
      () => window.__caffoldLostUpdateNavigations,
    )).toBe(1);

    const stalled = await page.locator("caffold-app-shell").evaluate((shell) => {
      const runtime = shell.pwaUpdateLifecycle.runtime;
      return {
        controllerBuildId: runtime.controllerBuildId(),
        documentBuildId: document
          .querySelector('meta[name="caffold-test-build"]')
          ?.getAttribute("content"),
        handoffNode: runtime.handoffState.node,
        navigationAttemptCount:
          runtime.snapshot().diagnostics.navigationAttemptCount,
        targetBuildId: runtime.handoffState.targetBuildId,
      };
    });
    expect(stalled).toMatchObject({
      controllerBuildId: "browser-build-b",
      documentBuildId: "browser-build-a",
      handoffNode: "applying",
      navigationAttemptCount: 1,
      targetBuildId: "browser-build-b",
    });

    await page.locator("caffold-app-shell").evaluate(async (shell) => {
      document.dispatchEvent(new Event("resume"));
      await shell.pwaUpdateLifecycle.checkForUpdate();
    });
    expect(await page.evaluate(
      () => window.__caffoldLostUpdateNavigations,
    )).toBe(1);

    await page.locator("caffold-app-shell").evaluate((shell) => {
      shell.pwaUpdateLifecycle.runtime.onReloadReady = () =>
        window.location.reload();
    });
    await openAboutWithoutReload(page);
    const reloadButton = page
      .locator("caffold-settings-about-page")
      .getByRole("button", { name: "Reload to update" });
    await expect(reloadButton).toBeVisible();
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await reloadButton.click();
    const navigationResponse = await navigation;

    expect(navigationResponse.headers()["x-caffold-test-build"]).toBe(
      "browser-build-b",
    );
    await expect(page.locator('meta[name="caffold-test-build"]')).toHaveAttribute(
      "content",
      "browser-build-b",
    );
    await expect(updateDialog).toBeHidden();
  } finally {
    await fixture.close();
  }
});

async function installServiceWorkerFixture(
  page,
  { controlled, waitingBuildId = null },
) {
  await page.addInitScript(({ controlled: startsControlled, waitingBuildId }) => {
    class MockServiceWorker extends EventTarget {
      constructor(name, state = "activated") {
        super();
        this.name = name;
        this.state = state;
      }

      postMessage(message) {
        window.__caffoldServiceWorkerMessages.push({
          name: this.name,
          message,
        });
      }

      setState(state) {
        this.state = state;
        this.dispatchEvent(new Event("statechange"));
      }
    }

    class MockServiceWorkerRegistration extends EventTarget {
      constructor(active) {
        super();
        this.active = active;
        this.installing = null;
        this.scope = `${window.location.origin}/`;
        this.updateCalls = 0;
        this.waiting = null;
      }

      async update() {
        this.updateCalls += 1;
        const fixture = window.__caffoldServiceWorkerFixture;
        if (fixture.updatesHeld) {
          await new Promise((resolve) => {
            fixture.heldUpdateResolvers.push(resolve);
          });
        }
        window.__caffoldServiceWorkerFixture.activatePending();
        return this;
      }
    }

    const controller = startsControlled
      ? new MockServiceWorker("current-build")
      : null;
    const registration = new MockServiceWorkerRegistration(controller);
    registration.waiting = waitingBuildId
      ? new MockServiceWorker(waitingBuildId, "installed")
      : null;
    class MockServiceWorkerContainer extends EventTarget {
      constructor(activeController) {
        super();
        this.controller = activeController;
        this.registerCalls = 0;
      }

      async register() {
        this.registerCalls += 1;
        return registration;
      }

      announceReady(worker) {
        const event = new Event("message");
        Object.defineProperties(event, {
          data: {
            value: {
              type: "caffold:update-ready",
              buildId: worker.name,
            },
          },
          source: { value: worker },
        });
        this.dispatchEvent(event);
      }

      announceControlled(worker, { differentSource = false } = {}) {
        const event = new Event("message");
        Object.defineProperties(event, {
          data: {
            value: {
              type: "caffold:update-controlled",
              buildId: worker.name,
            },
          },
          source: {
            value: differentSource
              ? new MockServiceWorker(`${worker.name}-message-wrapper`, worker.state)
              : worker,
          },
        });
        this.dispatchEvent(event);
      }

      setController(worker, { dispatch = true } = {}) {
        this.controller = worker;
        if (dispatch) {
          this.dispatchEvent(new Event("controllerchange"));
        }
      }
    }
    const serviceWorker = new MockServiceWorkerContainer(controller);
    window.__caffoldServiceWorkerMessages = [];
    window.__caffoldServiceWorkerFixture = {
      heldUpdateResolvers: [],
      pendingWorkerName: null,
      updatesHeld: false,
      workersByName: new Map(controller ? [[controller.name, controller]] : []),
      activate(name) {
        const worker = new MockServiceWorker(name, "installing");
        this.workersByName.set(name, worker);
        registration.installing = worker;
        registration.dispatchEvent(new Event("updatefound"));
        registration.active = worker;
        worker.setState("activating");
        serviceWorker.announceReady(worker);
        worker.setState("activated");
        registration.installing = null;
        this.latestWorker = worker;
      },
      prepare(name) {
        const worker = new MockServiceWorker(name, "installing");
        this.workersByName.set(name, worker);
        registration.installing = worker;
        this.latestWorker = worker;
        registration.dispatchEvent(new Event("updatefound"));
        worker.setState("installed");
        registration.installing = null;
        registration.waiting = worker;
        serviceWorker.announceReady(worker);
      },
      startPreparedActivation({
        preservePreviousActive = false,
        temporarilyUnowned = true,
      } = {}) {
        const worker = this.latestWorker;
        if (!worker) {
          return;
        }
        const previousActive = registration.active;
        registration.waiting = null;
        registration.active = temporarilyUnowned
          ? (preservePreviousActive ? previousActive : null)
          : worker;
        worker.setState("activating");
      },
      completePreparedActivation() {
        const worker = this.latestWorker;
        if (!worker) {
          return;
        }
        registration.active = worker;
        worker.setState("activated");
      },
      controlLatest({ dispatch = true } = {}) {
        serviceWorker.setController(this.latestWorker, { dispatch });
      },
      control(name, { dispatch = true } = {}) {
        serviceWorker.setController(this.workersByName.get(name), { dispatch });
      },
      announceLatestControlled({ differentSource = false } = {}) {
        serviceWorker.announceControlled(this.latestWorker, { differentSource });
      },
      beginInstall(name) {
        const worker = new MockServiceWorker(name, "installing");
        registration.installing = worker;
        this.latestWorker = worker;
        registration.dispatchEvent(new Event("updatefound"));
      },
      failInstall() {
        registration.installing?.setState("redundant");
        registration.installing = null;
      },
      holdUpdates() {
        this.updatesHeld = true;
      },
      releaseUpdates() {
        this.updatesHeld = false;
        for (const resolve of this.heldUpdateResolvers.splice(0)) {
          resolve();
        }
      },
      activatePending() {
        if (!this.pendingWorkerName) {
          return;
        }
        const name = this.pendingWorkerName;
        this.pendingWorkerName = null;
        this.activate(name);
      },
      publish(name) {
        this.pendingWorkerName = name;
      },
      repeatStateChange() {
        this.latestWorker?.dispatchEvent(new Event("statechange"));
      },
      retireLatest() {
        registration.active = controller;
        this.latestWorker?.setState("redundant");
      },
      registration,
      serviceWorker,
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
  }, { controlled, waitingBuildId });
}

async function waitForServiceWorkerRegistration(page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fixture = window.__caffoldServiceWorkerFixture;
        const shell = document.querySelector("caffold-app-shell");
        const lifecycle = shell.pwaUpdateLifecycle.runtime;
        return (
          fixture.serviceWorker.registerCalls === 1 &&
          lifecycle.registration === fixture.registration &&
          lifecycle.updateIntervalId !== null &&
          fixture.registration.updateCalls >= 1 &&
          !lifecycle.updateRequest
        );
      }),
    )
    .toBe(true);
}

async function triggerServiceWorkerActivation(page, name) {
  await page.evaluate((workerName) => {
    window.__caffoldServiceWorkerFixture.activate(workerName);
  }, name);
}

async function prepareWaitingServiceWorker(page, name) {
  await page.evaluate((workerName) => {
    window.__caffoldServiceWorkerFixture.prepare(workerName);
  }, name);
}

async function startPreparedServiceWorkerActivation(
  page,
  {
    preservePreviousActive = false,
    temporarilyUnowned = true,
  } = {},
) {
  await page.evaluate(({ preservePreviousActive, temporarilyUnowned }) => {
    window.__caffoldServiceWorkerFixture.startPreparedActivation({
      preservePreviousActive,
      temporarilyUnowned,
    });
  }, { preservePreviousActive, temporarilyUnowned });
}

async function completePreparedServiceWorkerActivation(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.completePreparedActivation();
  });
}

async function controlLatestServiceWorker(page, { dispatch = true } = {}) {
  await page.evaluate(({ dispatch }) => {
    window.__caffoldServiceWorkerFixture.controlLatest({ dispatch });
  }, { dispatch });
}

async function controlServiceWorker(page, name, { dispatch = true } = {}) {
  await page.evaluate(({ dispatch, workerName }) => {
    window.__caffoldServiceWorkerFixture.control(workerName, { dispatch });
  }, { dispatch, workerName: name });
}

async function announceLatestControlled(
  page,
  { differentSource = false } = {},
) {
  await page.evaluate(({ differentSource }) => {
    window.__caffoldServiceWorkerFixture.announceLatestControlled({
      differentSource,
    });
  }, { differentSource });
}

async function repeatServiceWorkerStateChange(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.repeatStateChange();
  });
}

async function retireLatestServiceWorker(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.retireLatest();
  });
}

async function beginServiceWorkerInstall(page, name) {
  await page.evaluate((workerName) => {
    window.__caffoldServiceWorkerFixture.beginInstall(workerName);
  }, name);
}

async function failServiceWorkerInstall(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.failInstall();
  });
}

async function holdServiceWorkerUpdates(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.holdUpdates();
  });
}

async function releaseServiceWorkerUpdates(page) {
  await page.evaluate(() => {
    window.__caffoldServiceWorkerFixture.releaseUpdates();
  });
}

async function publishServiceWorkerReplacement(page, name) {
  await page.evaluate((workerName) => {
    window.__caffoldServiceWorkerFixture.publish(workerName);
  }, name);
}

async function triggerVisibleServiceWorkerUpdateCheck(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function serviceWorkerUpdateCalls(page) {
  return await page.evaluate(
    () => window.__caffoldServiceWorkerFixture.registration.updateCalls,
  );
}

async function serviceWorkerUpdateState(page) {
  return (await serviceWorkerUpdateSnapshot(page)).state;
}

async function serviceWorkerUpdateSnapshot(page) {
  return await page.locator("caffold-app-shell").evaluate(
    (shell) => shell.pwaUpdateLifecycle.snapshot(),
  );
}

async function reloadRequests(page) {
  return await page.evaluate(() => window.__caffoldReloadRequests);
}

async function interceptPreparedReloads(page) {
  await page.locator("caffold-app-shell").evaluate((shell) => {
    window.__caffoldPreparedReloads = 0;
    shell.pwaUpdateLifecycle.runtime.onReloadReady = () => {
      window.__caffoldPreparedReloads += 1;
    };
  });
}

async function deferUpdateNavigation(page) {
  await page.locator("caffold-app-shell").evaluate((shell) => {
    let releaseNavigation;
    const navigationReleased = new Promise((resolve) => {
      releaseNavigation = resolve;
    });
    window.__caffoldReleaseDeferredUpdateNavigation = releaseNavigation;
    shell.pwaUpdateLifecycle.runtime.onReloadReady = () => {
      void navigationReleased.then(() => window.location.reload());
    };
  });
}

async function releaseDeferredUpdateNavigation(page) {
  await page.evaluate(() => {
    const releaseNavigation = window.__caffoldReleaseDeferredUpdateNavigation;
    window.__caffoldReleaseDeferredUpdateNavigation = null;
    window.setTimeout(releaseNavigation, 0);
  });
}

async function preparedReloadCount(page) {
  return await page.evaluate(() => window.__caffoldPreparedReloads ?? 0);
}

async function serviceWorkerMessageCount(page, type, name = null) {
  return await page.evaluate(({ messageType, workerName }) =>
    window.__caffoldServiceWorkerMessages.filter(
      ({ message, name: sourceName }) =>
        message.type === messageType &&
        (workerName === null || sourceName === workerName),
    ).length,
  { messageType: type, workerName: name });
}

async function openAboutWithoutReload(page) {
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.navigateToRoute({ kind: "settings", section: "about" });
  });
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
}

async function activeControllerState(page) {
  return await page.evaluate(() => navigator.serviceWorker.controller?.state ?? null);
}

async function shellCacheKeys(page) {
  return await page.evaluate(() => caches.keys());
}

async function cachedShellBuild(page, buildId) {
  return await page.evaluate(async (cacheBuildId) => {
    const cache = await caches.open(`caffold-shell-${cacheBuildId}`);
    const response = await cache.match("/", { ignoreSearch: true });
    const html = await response?.text();
    return html?.match(/name="caffold-test-build" content="([^"]+)"/)?.[1] ?? null;
  }, buildId);
}

async function fetchedShellBuild(page) {
  return await page.evaluate(async () => {
    const html = await (await fetch("/")).text();
    return html.match(/name="caffold-test-build" content="([^"]+)"/)?.[1] ?? null;
  });
}

async function serviceWorkerDiagnostics(page) {
  return await page.evaluate(() => {
    const shell = document.querySelector("caffold-app-shell");
    const lifecycle = shell.pwaUpdateLifecycle.runtime;
    return {
      controllerBuildId: lifecycle.controllerBuildId(),
      handoffNode: lifecycle.handoffState.node,
      lifecycleState: lifecycle.snapshot().state,
      navigationAttemptCount:
        lifecycle.snapshot().diagnostics.navigationAttemptCount,
      targetBuildId: lifecycle.handoffState.targetBuildId,
      activeState: lifecycle.registration?.active?.state ?? null,
      waitingState: lifecycle.registration?.waiting?.state ?? null,
      controllerState: navigator.serviceWorker.controller?.state ?? null,
      activeIsController:
        lifecycle.registration?.active === navigator.serviceWorker.controller,
      activeIsFirstInstallation:
        lifecycle.registration?.active === lifecycle.firstInstallationServiceWorker,
      readyIsWaiting:
        lifecycle.readyServiceWorker === lifecycle.registration?.waiting,
      readyBuildId: lifecycle.readyServiceWorkerBuildId,
      ready: Boolean(lifecycle.readyServiceWorker),
      updatePending: Boolean(lifecycle.updateRequest),
    };
  });
}

async function reconcileServiceWorkerDiagnostics(page) {
  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.pwaUpdateLifecycle.runtime.syncServiceWorkerState({
      resumeHandoff: false,
    });
  });
  return serviceWorkerDiagnostics(page);
}

async function appShellLayout(page) {
  return await page.locator("caffold-app-shell").evaluate((shell) => {
    const main = shell.querySelector(".app-main").getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      mainBottom: Math.round(main.bottom),
      position: getComputedStyle(shell).position,
      shellBottom: Math.round(shellRect.bottom),
      shellTop: Math.round(shellRect.top),
      viewportHeight: window.innerHeight,
    };
  });
}

async function primaryActionColors(page) {
  return await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = [
      "position:fixed",
      "left:-10000px",
      "border:1px solid var(--primary-action-border)",
      "background:var(--primary-action-bg)",
      "color:var(--primary-action-fg)",
    ].join(";");
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const colors = {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
    };
    probe.remove();
    return colors;
  });
}

async function activateWaitingServiceWorker(page) {
  // Keep the real-browser regression focused on controller and document
  // ownership. The production activation message is covered by the mocked
  // browser lifecycle and service-worker contract tests. Address the exact
  // waiting worker instead of using CDP's acknowledgement-free scope lookup.
  const waitingState = await page.evaluate(async (messageType) => {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.waiting?.postMessage({ type: messageType });
    return registration?.waiting?.state ?? null;
  }, TEST_ACTIVATE_WAITING_MESSAGE);
  expect(waitingState).toBe("installed");
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting?.state ?? null;
  }), {
    message: "waiting service worker should begin activation",
  }).not.toBe("installed");
}

async function startBuildLifecycleServer(upstreamOrigin) {
  let currentBuild = {
    id: "browser-build-a",
    number: 1,
    omitControlledAck: false,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://caffold.test");
      if (url.pathname === "/service-worker.js") {
        let body = serviceWorkerSource.replace(
          '"caffold-shell-__CAFFOLD_BUILD_ID__"',
          JSON.stringify(`caffold-shell-${currentBuild.id}`),
        );
        const productionActivationHandler = [
          "  if (event.data?.type === ACTIVATE_PREPARED_BUILD_MESSAGE) {",
          "    event.waitUntil(self.skipWaiting());",
          "    return;",
          "  }",
        ].join("\n");
        if (!body.includes(productionActivationHandler)) {
          throw new Error("PWA lifecycle fixture activation hook is stale");
        }
        body = body.replace(
          productionActivationHandler,
          [
            "  if (event.data?.type === ACTIVATE_PREPARED_BUILD_MESSAGE) {",
            "    // The lifecycle fixture owns this edge through an explicit control.",
            "    return;",
            "  }",
          ].join("\n"),
        );
        body += `\nself.addEventListener("message", (event) => {
  if (event.data?.type === ${JSON.stringify(TEST_ACTIVATE_WAITING_MESSAGE)}) {
    event.waitUntil(self.skipWaiting());
  }
});\n`;
        if (currentBuild.omitControlledAck) {
          body = body.replace(
            "  client?.postMessage({ type: UPDATE_CONTROLLED_MESSAGE, buildId: BUILD_ID });",
            "  // Lifecycle fixture intentionally omits the custom acknowledgement.",
          );
        }
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "text/javascript; charset=utf-8",
          "Service-Worker-Allowed": "/",
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/assets/build-info.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(buildInfoSource(currentBuild));
        return;
      }
      if (url.pathname === "/api/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          status: "ok",
          buildId: currentBuild.id,
          buildLabel: currentBuild.id,
          buildNumber: String(currentBuild.number),
          serverName: "Caffold lifecycle fixture",
          root: "/",
          initialPath: "",
          homePath: "",
          maxFileBytes: 1_048_576,
        }));
        return;
      }

      const upstream = await fetch(new URL(request.url, upstreamOrigin));
      const headers = Object.fromEntries(upstream.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      let body = Buffer.from(await upstream.arrayBuffer());
      if (url.pathname === "/") {
        headers["x-caffold-test-build"] = currentBuild.id;
        body = Buffer.from(
          body.toString("utf8").replace(
            "</head>",
            `<meta name="caffold-test-build" content="${currentBuild.id}" /></head>`,
          ),
        );
      }
      response.writeHead(upstream.status, headers);
      response.end(body);
    } catch (error) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setBuild(id, number, { omitControlledAck = false } = {}) {
      currentBuild = { id, number, omitControlledAck };
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

function buildInfoSource(build) {
  return `export const BUILD_INFO = Object.freeze({
    id: ${JSON.stringify(build.id)},
    label: ${JSON.stringify(build.id)},
    version: "0.4.0",
    commit: "browser-fixture",
    number: ${build.number},
  });`;
}
