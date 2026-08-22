import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockClaudeStatus,
  mockCodexStatus,
} from "./support/browser-defaults.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "./support/task-fixtures.js";

const SETTINGS_KEY = "caffold:settings";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

test("shows Codex versions and explicitly restarts an outdated runtime", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let restarted = false;
  let restartRequests = 0;
  let statusRequests = 0;
  let releaseRestart;
  const restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  const status = () => mockCodexStatus({
    readiness: {
      state: restarted ? "ready" : "restartRequired",
      blocksTaskOperations: !restarted,
      reasonCode: restarted ? "ready" : "runtimeVersionMismatch",
      diagnosticMessage: restarted
        ? "Codex is ready for Task operations."
        : "The installed Codex version differs from the running runtime.",
      minimumSupportedVersion: "0.147.0",
      detectedExecutable: {
        path: "/Users/example/.local/bin/codex",
        version: "0.147.0",
      },
      managedExecutable: {
        path: "/Users/example/.codex/packages/standalone/current/codex",
        version: "0.147.0",
      },
      runningAppServerVersion: restarted ? "0.147.0" : "0.146.1",
    },
  });
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    statusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(status()),
    });
  });
  await page.route(/\/api\/codex\/restart(?:\?|$)/, async (route) => {
    restartRequests += 1;
    expect(route.request().method()).toBe("POST");
    await restartGate;
    restarted = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "restarted",
        managedCodexVersion: "0.147.0",
        appServerVersion: "0.147.0",
      }),
    });
  });

  await page.goto("/settings/codex");
  const settings = page.locator("caffold-settings-codex-page");
  await expect(settings).toContainText("Detected version");
  await expect(settings).toContainText("0.146.1");
  await expect(settings).toContainText("Restart required");
  expect(statusRequests).toBe(1);

  await settings.getByRole("button", { name: "Restart runtime" }).click();
  const dialog = page.getByRole("dialog", { name: "Restart Codex runtime?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("other Codex clients");
  const dialogHost = page.locator(
    "caffold-task-workspace > caffold-codex-runtime-restart-dialog",
  );
  const dialogHostNode = await dialogHost.elementHandle();
  const scroller = settings.locator(".settings-content-scroll");
  const scrollerNode = await scroller.elementHandle();
  const scrollBefore = await scroller.evaluate((element) => {
    element.scrollTop = Math.min(40, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  await settings.evaluate((element) => {
    element.snapshot = {
      ...element.snapshot,
      status: {
        ...element.snapshot.status,
        readiness: {
          ...element.snapshot.status.readiness,
          diagnosticMessage: "The canonical status was refreshed while confirmation stayed open.",
        },
      },
    };
  });
  await expect(dialog).toBeVisible();
  expect(await dialogHostNode.evaluate((element) => (
    element.isConnected &&
    element === document.querySelector("caffold-task-workspace > caffold-codex-runtime-restart-dialog")
  ))).toBe(true);
  expect(await scrollerNode.evaluate((element) => (
    element.isConnected && element.scrollTop
  ))).toBe(scrollBefore);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(restartRequests).toBe(0);

  const refresh = settings.getByRole("button", { name: "Refresh" });
  await refresh.focus();
  const refreshNode = await refresh.elementHandle();
  await settings.evaluate((element) => {
    element.snapshot = { ...element.snapshot };
  });
  expect(await refreshNode.evaluate((element) => (
    element.isConnected && document.activeElement === element
  ))).toBe(true);

  await settings.getByRole("button", { name: "Restart runtime" }).click();
  await dialog.getByRole("button", { name: "Restart Codex" }).click();
  await expect(settings.getByRole("button", { name: "Restarting…" })).toBeDisabled();

  releaseRestart();
  await expect(settings).toContainText("Codex runtime restarted.");
  await expect(settings.locator(".settings-codex-repair")).toBeHidden();
  await expect(settings).toContainText("App-server runtime");
  await expect(settings.locator(".settings-details")).toContainText("0.147.0");
  expect(restartRequests).toBe(1);
  expect(statusRequests).toBe(2);
});

test("keeps Codex Settings actionable when runtime restart fails", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus({
        readiness: {
          ...mockCodexStatus().readiness,
          state: "restartRequired",
          blocksTaskOperations: true,
          reasonCode: "runtimeVersionMismatch",
          diagnosticMessage: "The installed Codex version differs from the running runtime.",
          runningAppServerVersion: "0.146.1",
        },
      })),
    }),
  );
  await page.route(/\/api\/codex\/restart(?:\?|$)/, (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "codex_app_server_error",
          message: "Codex runtime could not be restarted.",
        },
      }),
    }),
  );

  await page.goto("/settings/codex");
  const settings = page.locator("caffold-settings-codex-page");
  await settings.getByRole("button", { name: "Restart runtime" }).click();
  await page.getByRole("dialog", { name: "Restart Codex runtime?" })
    .getByRole("button", { name: "Restart Codex" })
    .click();

  await expect(settings).toContainText("Codex runtime could not be restarted.");
  await expect(settings.getByRole("button", { name: "Restart runtime" })).toBeEnabled();
});

test("shows what the Claude installation is on its Settings page", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/settings/claude");
  const settings = page.locator("caffold-settings-claude-page");

  await expect(settings).toContainText("2.1.239 (Claude Code)");
  await expect(settings).toContainText("user@example.com · claude.ai");
  await expect(settings).toContainText("Max");

  await expect(settings).toContainText("Session");
  await expect(settings).toContainText("4% used");
  await expect(settings).toContainText("Weekly · Fable");
  await expect(settings).toContainText("24% used");

  await expect(settings).toContainText("Running · pid 4242");
  await expect(settings).toContainText("Sessions");
  await expect(settings).toContainText("10 min");
});

test("a source that could not answer costs its block and no more", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.route(/\/api\/claude\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        mockClaudeStatus({
          executable: undefined,
          usage: undefined,
          runner: undefined,
          problems: {
            executable: "could not run claude",
            usage: "claude did not answer within 30 seconds",
            runner: "the runner did not answer within 30 seconds",
          },
        }),
      ),
    }),
  );

  await page.goto("/settings/claude");
  const settings = page.locator("caffold-settings-claude-page");

  await expect(settings).toContainText("Unavailable — could not run claude", {
    timeout: 10_000,
  });
  await expect(settings).toContainText(
    "user@example.com · claude.ai",
  );
  await expect(settings).toContainText(
    "Unavailable — claude did not answer within 30 seconds",
  );
  await expect(settings).toContainText(
    "Unavailable — the runner did not answer within 30 seconds",
  );
});

test("explicitly restarts the Claude runner from its Settings item", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let restartRequests = 0;
  let statusRequests = 0;
  await page.route(/\/api\/claude\/status(?:\?|$)/, (route) => {
    statusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        mockClaudeStatus(
          restartRequests > 0 ? { runner: { running: true, pid: 5151 } } : {},
        ),
      ),
    });
  });
  await page.route(/\/api\/claude\/restart(?:\?|$)/, (route) => {
    restartRequests += 1;
    expect(route.request().method()).toBe("POST");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        protocol_version: 1,
        runner_version: "0.7.2",
        pid: 5151,
        socket: "/tmp/claude-runner.sock",
        sessions: 0,
        idle_timeout_secs: 600,
      }),
    });
  });

  await page.goto("/settings/claude");
  const settings = page.locator("caffold-settings-claude-page");
  await expect(settings).toContainText("Restarting stops the runner");
  await expect(settings).toContainText("Running · pid 4242");

  await settings.getByRole("button", { name: "Restart runtime" }).click();
  const dialog = page.getByRole("dialog", { name: "Restart Claude runtime?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("ends every running Claude turn");
  await dialog.getByRole("button", { name: "Restart Claude" }).click();

  await expect(settings).toContainText("Claude runner restarted");
  expect(restartRequests).toBe(1);
  await expect(settings).toContainText("Running · pid 5151", {
    timeout: 10_000,
  });
  expect(statusRequests).toBeGreaterThanOrEqual(2);
  await expect(settings.getByRole("button", { name: "Restart runtime" })).toBeEnabled();
});

test("keeps the Claude Settings item actionable when the restart fails", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.route(/\/api\/claude\/restart(?:\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "claude_runtime_unavailable",
          message: "The Claude runner went on answering after it was asked to stop.",
        },
      }),
    }),
  );

  await page.goto("/settings/claude");
  const settings = page.locator("caffold-settings-claude-page");
  await settings.getByRole("button", { name: "Restart runtime" }).click();
  await page.getByRole("dialog", { name: "Restart Claude runtime?" })
    .getByRole("button", { name: "Restart Claude" })
    .click();

  await expect(settings).toContainText("went on answering");
  await expect(settings.getByRole("button", { name: "Restart runtime" })).toBeEnabled();
});

test("enables, lists, removes, and explicitly revokes notification installations", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installPushBrowserMock(page);
  let currentClientId = "";
  let currentState = "unknown";
  let installations = [
    {
      clientId: "00000000-0000-4000-8000-000000000099",
      installationLabel: "Firefox 141 on Linux · workstation",
      createdAtMs: 1_750_000_000_000,
      updatedAtMs: 1_750_000_100_000,
    },
    {
      clientId: "00000000-0000-4000-8000-000000000098",
      installationLabel: "Safari 18 on iOS · phone",
      createdAtMs: 1_750_000_000_000,
      updatedAtMs: 1_750_000_100_000,
    },
  ];
  let upserts = 0;
  const removals = [];
  await page.route(/\/api\/push\/(?:config|installations)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/push/config") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ publicKey: "BEl6Q2FmZm9sZC10ZXN0LWtleQ" }),
      });
    }
    if (request.method() === "GET") {
      currentClientId = url.searchParams.get("clientId");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ currentState, installations }),
      });
    }
    const clientId = decodeURIComponent(url.pathname.split("/").at(-1));
    if (request.method() === "PUT") {
      upserts += 1;
      const body = request.postDataJSON();
      expect(body.endpoint).toBe("https://push.example.test/current");
      expect(body.keys).toEqual({ p256dh: "browser-public", auth: "browser-auth" });
      const summary = {
        clientId,
        installationLabel: body.installationLabel,
        createdAtMs: 1_750_000_200_000,
        updatedAtMs: 1_750_000_200_000,
      };
      currentState = "subscribed";
      installations = [
        summary,
        ...installations.filter((item) => item.clientId !== clientId),
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(summary),
      });
    }
    expect(request.method()).toBe("DELETE");
    removals.push(clientId);
    installations = installations.filter((item) => item.clientId !== clientId);
    if (clientId === currentClientId) {
      currentState = "revoked";
    }
    return route.fulfill({ status: 204 });
  });

  await page.goto("/settings/notifications");
  const settings = page.locator("caffold-settings-notifications-page");
  await expect(settings).toContainText("Disabled");
  await expect(settings).toContainText("Firefox 141 on Linux");
  await expect(settings.getByText("2 browsers", { exact: true })).toBeVisible();
  await expect(settings).not.toContainText("Best-effort delivery");
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await captureReviewScreenshot(page, testInfo, "settings-notifications-disabled");

  const firefox = settings.locator(".settings-installation-list article", {
    hasText: "Firefox 141 on Linux",
  });
  await firefox.getByRole("button", { name: "Remove" }).click();
  await expect(firefox).toHaveCount(0);
  await expect(settings.getByText("1 browser", { exact: true })).toBeVisible();

  const safari = settings.locator(".settings-installation-list article", {
    hasText: "Safari 18 on iOS",
  });
  await safari.getByRole("button", { name: "Remove" }).click();
  await expect(safari).toHaveCount(0);
  await expect(settings.getByText("0 browsers", { exact: true })).toBeVisible();

  await settings.getByRole("button", { name: "Enable" }).click();
  await expect(settings).toContainText("Subscribed");
  await expect(settings).toContainText(
    "This browser will receive notifications for terminal task turns.",
  );
  await expect(settings).not.toContainText("best-effort notifications");
  await expect(settings).toContainText("This browser");
  await expect(settings.getByText("1 browser", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__pushMock.permissionCalls)).toBe(1);
  expect(upserts).toBe(1);
  await captureReviewScreenshot(page, testInfo, "settings-notifications-subscribed");

  await settings.getByRole("button", { name: "Disable" }).click();
  await expect(settings).toContainText("Disabled");
  await expect(settings).toContainText("No browsers are currently subscribed.");
  await expect.poll(() => page.evaluate(() => window.__pushMock.unsubscribeCalls)).toBe(1);
  expect(removals).toEqual([
    "00000000-0000-4000-8000-000000000099",
    "00000000-0000-4000-8000-000000000098",
    currentClientId,
  ]);

  await page.goto("/settings/appearance");
  await page.goto("/settings/notifications");
  await expect(settings).toContainText("Disabled");
  expect(upserts).toBe(1);
});

test("honors a remote revocation tombstone without silently re-registering", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installPushBrowserMock(page, {
    permission: "granted",
    initialSubscription: true,
  });
  let upserts = 0;
  await page.route(/\/api\/push\/installations/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ currentState: "revoked", installations: [] }),
      });
    }
    if (route.request().method() === "PUT") {
      upserts += 1;
    }
    return route.fulfill({ status: 204 });
  });

  await page.goto("/settings/notifications");
  const settings = page.locator("caffold-settings-notifications-page");
  await expect(settings).toContainText("Disabled");
  await expect.poll(() => page.evaluate(() => window.__pushMock.unsubscribeCalls)).toBe(1);
  expect(upserts).toBe(0);
  expect(await page.evaluate(() => window.__pushMock.subscribeCalls)).toBe(0);
});

test("explains missing app-server capabilities in Codex Settings", { tag: "@all-viewports" }, async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus({
        readiness: {
          ...mockCodexStatus().readiness,
          state: "unsupportedInstall",
          blocksTaskOperations: true,
          reasonCode: "appServerCommandsUnavailable",
          diagnosticMessage: "The required app-server daemon command is unavailable.",
          managedExecutable: null,
          runningAppServerVersion: null,
        },
      })),
    }),
  );

  await page.goto("/settings/codex");

  const settings = page.locator("caffold-settings-codex-page");
  await expect(settings.locator(".settings-codex-repair")).toContainText(
    "lacks the app-server daemon commands Caffold uses",
  );
  await expect(settings).toContainText("appServerCommandsUnavailable");
  await expect(settings.getByRole("button", { name: "Refresh" })).toBeEnabled();
});

test("returns from Settings to the canonical Tasks home", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    }),
  );

  await page.goto("/settings");
  const settingsWorkspace = page.locator("caffold-settings-workspace");
  if (testInfo.project.name === "phone") {
    await expect(settingsWorkspace).toBeHidden();
  } else {
    await expect(settingsWorkspace).toBeVisible();
  }
  await expect(page.locator("caffold-settings-navigator")).toBeVisible();

  await page
    .locator('.task-workspace-navigation [data-workspace-mode="tasks"]')
    .click();

  await expect(page).toHaveURL("/");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(tasksPage.locator(".task-new-form")).toBeVisible();
});

test("gives every Settings route one page title and landmark hierarchy", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const routes = [
    ["/settings/appearance", "Appearance", "caffold-settings-appearance-page"],
    ["/settings/files", "Files", "caffold-settings-files-page"],
    ["/settings/notifications", "Notifications", "caffold-settings-notifications-page"],
    ["/settings/remote-access", "Remote Access", "caffold-settings-remote-access-page"],
    ["/settings/codex", "Codex", "caffold-settings-codex-page"],
    ["/settings/about", "About Caffold", "caffold-settings-about-page"],
  ];

  for (const [path, title, pageSelector] of routes) {
    await page.goto(path);

    await expect(page.locator(pageSelector)).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("main main")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { level: 1, name: title }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: title })).toBeVisible();
    await expect(
      page.locator('nav[aria-label="Settings sections"]'),
    ).toHaveCount(1);
  }
});

test("reflows Settings from the detail pane width at maximum Interface scale", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const shouldStack = testInfo.project.name !== "desktop";

  await page.goto("/settings/appearance");
  const appearance = page.locator("caffold-settings-appearance-page");
  await setRange(range(appearance, "interfaceScalePercent"), 120);
  const settingsDetailFontSize = await appearance
    .locator(".settings-field-copy > span:not(.settings-field-label)")
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);
  await expect(
    appearance.locator(".settings-range-control output").first(),
  ).toHaveCSS("font-size", settingsDetailFontSize);
  const appearanceMetrics = await settingsSurfaceMetrics(appearance, {
    row: ".settings-interface-group .settings-field",
    leading: ".settings-field-copy",
    trailing: ".settings-range-control",
    pageAction: ".settings-reset-all",
    contextAction:
      'button[data-action="reset-setting"][data-setting="interfaceScalePercent"]',
  });
  expect(appearanceMetrics.overflowX).toBe(false);
  expect(appearanceMetrics.stacked).toBe(shouldStack);
  expectSettingsActionTiers(appearanceMetrics, true);
  const appearanceLayout = await appearance.evaluate((element) => {
    const rect = (selector) =>
      element.querySelector(selector).getBoundingClientRect();
    const interfaceCopy = rect(
      ".settings-interface-group .settings-field-copy",
    );
    const interfaceControl = rect(
      ".settings-interface-group .settings-range-control",
    );
    const typefaceSelect = rect(".settings-typeface-control select");
    const typefacePreview = rect(".settings-typeface-preview");
    const conversationControl = rect(
      '[data-setting="conversationTextPx"]',
    );
    const textPreview = rect(".settings-text-preview");
    return {
      interfaceTopDifference: Math.abs(
        interfaceCopy.top - interfaceControl.top,
      ),
      interfaceLeftDifference: Math.abs(
        interfaceCopy.left - interfaceControl.left,
      ),
      typefacePreviewLeftDifference: Math.abs(
        typefaceSelect.left - typefacePreview.left,
      ),
      textPreviewLeftDifference: Math.abs(
        conversationControl.left - textPreview.left,
      ),
    };
  });
  if (shouldStack) {
    expect(appearanceLayout.interfaceTopDifference).toBeGreaterThan(1);
    expect(appearanceLayout.interfaceLeftDifference).toBeLessThanOrEqual(1);
  } else {
    expect(appearanceLayout.interfaceTopDifference).toBeLessThanOrEqual(1);
  }
  expect(appearanceLayout.typefacePreviewLeftDifference).toBeLessThanOrEqual(1);
  expect(appearanceLayout.textPreviewLeftDifference).toBeLessThanOrEqual(1);
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-appearance-roles-interface-120",
  );

  await page.goto("/settings/files");
  const files = page.locator("caffold-settings-files-page");
  const filesMetrics = await files.evaluate((element) => {
    const option = element.querySelector(".settings-files-options label");
    const copy = element.querySelector(".settings-files-option-copy");
    return {
      overflowX: element.scrollWidth > element.clientWidth,
      optionOverflowX: option.scrollWidth > option.clientWidth,
      copyOverflowX: copy.scrollWidth > copy.clientWidth,
    };
  });
  expect(filesMetrics).toEqual({
    overflowX: false,
    optionOverflowX: false,
    copyOverflowX: false,
  });
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-files-roles-interface-120",
  );

  await page.goto("/settings/codex");
  const codex = page.locator("caffold-settings-codex-page");
  const codexMetrics = await settingsSurfaceMetrics(codex, {
    row: ".settings-details > div",
    leading: "dt",
    trailing: "dd",
    pageAction: '.settings-content-section > header [data-action="refresh-codex-status"]',
  });
  expect(codexMetrics.overflowX).toBe(false);
  expect(codexMetrics.stacked).toBe(shouldStack);
  expectSettingsActionTiers(codexMetrics);
  await expect(codex.locator(".settings-details dd").first()).toHaveCSS(
    "font-size",
    settingsDetailFontSize,
  );
  await expect(codex.locator(".settings-usage-row strong").first()).toHaveCSS(
    "font-size",
    settingsDetailFontSize,
  );
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-codex-roles-interface-120",
  );

  await page.goto("/settings/about");
  const about = page.locator("caffold-settings-about-page");
  const aboutMetrics = await settingsSurfaceMetrics(about, {
    row: ".settings-details > div",
    leading: "dt",
    trailing: "dd",
    pageAction: '[data-action="copy-diagnostics"]',
  });
  expect(aboutMetrics.overflowX).toBe(false);
  expect(aboutMetrics.stacked).toBe(shouldStack);
  expectSettingsActionTiers(aboutMetrics);
  await expect(about.locator(".settings-details dd").first()).toHaveCSS(
    "font-size",
    settingsDetailFontSize,
  );
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-about-roles-interface-120",
  );
});

test("persists file ordering and keeps it across appearance reset", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    ({ key }) => {
      if (sessionStorage.getItem("settings-seeded")) {
        return;
      }
      sessionStorage.setItem("settings-seeded", "true");
      localStorage.setItem(
        key,
        JSON.stringify({
          fileTreeSize: "large",
          taskListSize: "compact",
          taskDetailSize: "large",
          codeSize: "default",
          fileSortMode: "invalid",
        }),
      );
    },
    { key: SETTINGS_KEY },
  );

  await page.goto("/settings/files");
  const filesPage = page.locator("caffold-settings-files-page");
  const foldersFirst = filesPage.locator('input[value="folders-first"]');
  const byName = filesPage.locator('input[value="name"]');
  await expect(filesPage).toBeVisible();
  await expect(
    page.locator("caffold-settings-workspace .settings-workspace-detail-header"),
  ).toBeVisible();
  await expect(foldersFirst).toBeChecked();
  await expect(byName).not.toBeChecked();

  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toEqual({
      themeMode: "system",
      typefacePreset: "d2-coding",
      interfaceScalePercent: 100,
      conversationTextPx: 14,
      codeTextPx: 13,
      fileSortMode: "folders-first",
    });

  await byName.check();
  await expect(byName).toBeChecked();
  await expect.poll(() => page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)).fileSortMode,
    SETTINGS_KEY,
  )).toBe("name");
  await page.reload();
  await expect(filesPage.locator('input[value="name"]')).toBeChecked();

  await page.goto("/settings/appearance");
  const appearance = page.locator("caffold-settings-appearance-page");
  await setRange(range(appearance, "interfaceScalePercent"), 120);
  await appearance.getByRole("button", { name: "Reset all" }).click();
  await expect.poll(() => page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)).fileSortMode,
    SETTINGS_KEY,
  )).toBe("name");
  await page.goto("/settings/files");
  await expect(filesPage.locator('input[value="name"]')).toBeChecked();
  await captureReviewScreenshot(page, testInfo, "settings-files-name");
});

test("selects, persists, and resolves System, Light, and Dark themes", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/appearance");

  const appearance = page.locator("caffold-settings-appearance-page");
  const system = appearance.getByRole("radio", { name: "System" });
  const light = appearance.getByRole("radio", { name: "Light" });
  const dark = appearance.getByRole("radio", { name: "Dark" });
  const resetTheme = appearance.locator('button[data-action="reset-theme"]');

  await expect(system).toBeChecked();
  await expectThemeState(page, { mode: "system", resolvedTheme: "dark" });
  await expect(resetTheme).toBeDisabled();
  await expect(resetTheme).toBeHidden();
  const systemDarkStyles = await representativeThemeStyles(page);
  await captureReviewScreenshot(page, testInfo, "settings-theme-system-dark");

  await light.check();
  await expect(light).toBeChecked();
  await expectThemeState(page, { mode: "light", resolvedTheme: "light" });
  await expect(resetTheme).toBeEnabled();
  await expect(resetTheme).toBeVisible();
  const lightStyles = await representativeThemeStyles(page);
  await captureReviewScreenshot(page, testInfo, "settings-theme-light");

  for (const key of Object.keys(lightStyles)) {
    expect(
      lightStyles[key],
      `${key} should differ between representative Light and Dark states`,
    ).not.toBe(systemDarkStyles[key]);
  }

  await dark.check();
  await expectThemeState(page, { mode: "dark", resolvedTheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expectThemeState(page, { mode: "dark", resolvedTheme: "dark" });
  await page.reload();
  await expect(dark).toBeChecked();
  await expectThemeState(page, { mode: "dark", resolvedTheme: "dark" });

  await system.check();
  await expectThemeState(page, { mode: "system", resolvedTheme: "light" });
  await expect(resetTheme).toBeDisabled();
  await expect(resetTheme).toBeHidden();
  await page.emulateMedia({ colorScheme: "dark" });
  await expectThemeState(page, { mode: "system", resolvedTheme: "dark" });
});

test("updates independent ranges live without replacing their DOM", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  await expect(settingsPage).toBeVisible();

  const interfaceRange = range(settingsPage, "interfaceScalePercent");
  const conversationRange = range(settingsPage, "conversationTextPx");
  const codeRange = range(settingsPage, "codeTextPx");
  const resetAll = settingsPage.getByRole("button", { name: "Reset all" });
  await expect(resetAll).toBeVisible();
  await expect(resetAll).toBeDisabled();
  await expect(resetAll.locator(".settings-reset-all-icon")).toHaveCount(1);
  await expect(interfaceRange).toHaveAttribute("min", "90");
  await expect(interfaceRange).toHaveAttribute("max", "120");
  await expect(interfaceRange).toHaveAttribute("step", "5");
  await expect(conversationRange).toHaveAttribute("min", "13");
  await expect(conversationRange).toHaveAttribute("max", "20");
  await expect(codeRange).toHaveAttribute("min", "12");
  await expect(codeRange).toHaveAttribute("max", "20");
  const settingsSmallText = settingsPage
    .locator(".settings-field-copy > span:not(.settings-field-label)")
    .first();
  await expect(settingsSmallText).toHaveCSS("font-size", "14px");
  await setRange(interfaceRange, 90);
  await expect(settingsSmallText).toHaveCSS("font-size", "14px");
  await setRange(interfaceRange, 100);
  const inlineResets = settingsPage.locator(".settings-inline-reset");
  await expect(inlineResets).toHaveCount(5);
  for (const reset of await inlineResets.all()) {
    await expect(reset).toBeHidden();
  }

  const responsiveDefaults = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    narrow: matchMedia("(max-width: 520px)").matches,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    targetFloor: getComputedStyle(document.documentElement)
      .getPropertyValue("--interface-target-floor")
      .trim(),
  }));
  const touchInterface = responsiveDefaults.coarse || responsiveDefaults.narrow;
  expect(responsiveDefaults.rootFontSize).toBe(touchInterface ? "17px" : "16px");
  expect(responsiveDefaults.touchAction).toBe("manipulation");
  expect(responsiveDefaults.targetFloor).toBe(touchInterface ? "40px" : "0px");
  await setRange(interfaceRange, 105);
  const settingsControlTiers = await settingsPage.evaluate((element) => {
    const tokenHeight = (token) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;height:var(${token})`;
      document.body.append(probe);
      const value = probe.getBoundingClientRect().height;
      probe.remove();
      return value;
    };
    const height = (selector) =>
      element.querySelector(selector).getBoundingClientRect().height;
    const visualHeight = (selector) => {
      const control = element.querySelector(selector);
      const box = control.getBoundingClientRect();
      const inset = Number.parseFloat(
        getComputedStyle(control, "::before").top,
      );
      return box.height - inset * 2;
    };
    return {
      regularHit: tokenHeight("--interface-control-hit-size"),
      regularVisual: tokenHeight("--interface-control-visual-size"),
      compactVisual: tokenHeight("--interface-compact-visual-size"),
      resetAllVisual: visualHeight(".settings-reset-all"),
      resetOneVisual: visualHeight(
        'button[data-setting="interfaceScalePercent"]',
      ),
    };
  });
  expect(settingsControlTiers.resetAllVisual).toBeCloseTo(
    settingsControlTiers.regularVisual,
    1,
  );
  expect(settingsControlTiers.resetOneVisual).toBeCloseTo(
    settingsControlTiers.compactVisual,
    1,
  );
  await setRange(interfaceRange, 100);
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "14px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "13px",
  );

  await interfaceRange.evaluate((element) => {
    element.dataset.instanceMarker = "stable";
  });
  await interfaceRange.focus();
  await interfaceRange.press("ArrowRight");
  await expect(interfaceRange).toHaveValue("105");
  await expect(interfaceRange).toHaveAttribute("data-instance-marker", "stable");
  await expect(interfaceRange).toBeFocused();
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "14px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "13px",
  );
  const interfaceReset = settingsPage.getByRole("button", {
    name: "Reset interface size",
  });
  await expect(interfaceReset).toBeVisible();
  await expect(interfaceReset).toHaveAttribute("title", "Reset interface size");
  await expect(interfaceReset.locator(".settings-reset-icon")).toHaveCount(1);

  await setRange(conversationRange, 20);
  await setRange(codeRange, 18);
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "20px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "18px",
  );
  await expect(
    settingsPage.getByRole("button", { name: "Reset conversation text" }),
  ).toBeVisible();
  await expect(
    settingsPage.getByRole("button", { name: "Reset code text" }),
  ).toBeVisible();

  const semanticProbe = await page.evaluate(() => {
    const github = document.createElement("caffold-github-markdown");
    github.setHtml("<p>Conversation <code>code</code></p>");
    document.body.append(github);
    const githubBody = github.shadowRoot.querySelector("p");
    const githubCode = github.shadowRoot.querySelector("code");

    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    document.body.append(composer);
    const textarea = composer.querySelector("textarea");
    const modelButton = composer.querySelector(".task-model-button");

    const result = {
      githubBody: getComputedStyle(githubBody).fontSize,
      githubCode: getComputedStyle(githubCode).fontSize,
      textarea: getComputedStyle(textarea).fontSize,
      modelButton: getComputedStyle(modelButton).fontSize,
    };
    github.remove();
    composer.remove();
    return result;
  });
  expect(semanticProbe.githubBody).toBe("20px");
  expect(semanticProbe.githubCode).toBe("18px");
  expect(semanticProbe.textarea).toBe("20px");
  expect(semanticProbe.modelButton).not.toBe("20px");

  await expect(settingsPage.locator(".settings-interface-preview")).toHaveCount(
    0,
  );
  await expect(settingsPage.locator(".settings-typeface-preview")).toHaveCount(
    1,
  );
  await expect(settingsPage.locator(".settings-text-preview")).toHaveCount(1);
  await expect(settingsPage.locator(".settings-conversation-preview")).toHaveCount(
    1,
  );
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCount(1);

  if (touchInterface) {
    for (const control of [
      settingsPage.locator(".settings-reset-all"),
      interfaceReset,
    ]) {
      const box = await control.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  }

  await captureReviewScreenshot(page, testInfo, "settings-appearance");
  await page.reload();
  await expect(interfaceRange).toHaveValue("105");
  await expect(conversationRange).toHaveValue("20");
  await expect(codeRange).toHaveValue("18");

  await settingsPage
    .locator(
      'button[data-action="reset-setting"][data-setting="conversationTextPx"]',
    )
    .click();
  await expect(conversationRange).toHaveValue("14");
  await expect(
    settingsPage.locator(
      'button[data-action="reset-setting"][data-setting="conversationTextPx"]',
    ),
  ).toBeHidden();
  await expect(interfaceRange).toHaveValue("105");
  await expect(codeRange).toHaveValue("18");

  await settingsPage.locator('button[data-action="reset-appearance"]').click();
  await expect(interfaceRange).toHaveValue("100");
  await expect(conversationRange).toHaveValue("14");
  await expect(codeRange).toHaveValue("13");
  for (const reset of await inlineResets.all()) {
    await expect(reset).toBeHidden();
  }
});

test("switches and persists the local typeface presets", { tag: "@all-viewports" }, async ({ page }) => {
  await page.goto("/settings/appearance");

  const settingsPage = page.locator("caffold-settings-appearance-page");
  const select = settingsPage.locator("select[data-typeface-setting]");
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select.locator("option")).toHaveText([
    "D2 Coding",
    "System Mono",
  ]);
  await expect(select).not.toContainText("Noto Sans Mono CJK KR");
  await expect(select).not.toContainText("Included");
  await expect(select).not.toContainText("No download");
  await expect(select).toHaveValue("d2-coding");
  await expect(select).not.toHaveAttribute("aria-describedby", /.+/);
  await expect(settingsPage.locator("[data-typeface-description]")).toHaveCount(
    0,
  );
  const typefacePreview = settingsPage.locator(".settings-typeface-preview");
  await expect(typefacePreview.locator("span")).toHaveText(
    "Latin · 한글 · 漢字 · ひらがな · カタカナ · 123",
  );
  await expect(typefacePreview.locator("code")).toHaveText(
    'const tree = "├─ src/main.rs";',
  );
  expect(
    await typefacePreview.evaluate((preview) => {
      const [specimen, code] = preview.children;
      const specimenBounds = specimen.getBoundingClientRect();
      const codeBounds = code.getBoundingClientRect();
      return codeBounds.top > specimenBounds.top;
    }),
  ).toBe(true);
  const resetFont = settingsPage.locator('button[data-action="reset-typeface"]');
  await expect(resetFont).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "d2-coding",
  );

  await select.selectOption("system-mono");
  await expect(typefacePreview.locator("span")).toHaveText(
    "Latin · 한글 · 漢字 · ひらがな · カタカナ · 123",
  );
  await expect(resetFont).toBeVisible();
  await expect(
    settingsPage.getByRole("button", { name: "Reset font" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "system-mono",
  );
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toMatchObject({ typefacePreset: "system-mono" });

  await settingsPage.getByRole("button", { name: "Reset font" }).click();
  await expect(select).toHaveValue("d2-coding");
  await expect(resetFont).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "d2-coding",
  );
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toMatchObject({
      typefacePreset: "d2-coding",
    });
});

test("applies extreme values to the retained Review code viewer", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  await setRange(range(settingsPage, "interfaceScalePercent"), 120);
  await setRange(range(settingsPage, "conversationTextPx"), 13);
  await setRange(range(settingsPage, "codeTextPx"), 20);

  const viewer = await page.evaluateHandle(() => {
    const element = document.createElement("caffold-review-file-viewer");
    element.style.cssText = "position:fixed;inset:0;z-index:1000;background:var(--surface)";
    element.setFile({
      path: "src/example.rs",
      name: "example.rs",
      size: 24,
      modifiedMs: null,
      content: "fn example() {}",
      languageHint: "rust",
    });
    document.body.append(element);
    return element;
  });
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "text-size-adjust",
    "100%",
  );
  const fileToolbarTiers = await page.evaluate(() => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.cssText =
      "position:fixed;height:var(--interface-compact-hit-size)";
    document.body.append(tokenProbe);
    const compact = tokenProbe.getBoundingClientRect().height;
    tokenProbe.remove();
    const height = (selector) =>
      document.querySelector(selector).getBoundingClientRect().height;
    return {
      compact,
      info: height("caffold-review-file-viewer .viewer-info-button"),
    };
  });
  expect(fileToolbarTiers.info).toBeCloseTo(fileToolbarTiers.compact, 1);

  await page.locator("caffold-review-file-viewer").evaluate((element) => {
    element.setDiff({
      path: "src/example.rs",
      repoRelativePath: "src/example.rs",
      kind: "Working tree",
      repository: { rootPath: "src" },
      diff: "@@ -1 +1 @@\n-old line\n+new line",
    });
  });
  await expect(page.locator("caffold-diff-viewer .diff-lines")).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(page.locator("caffold-diff-viewer .diff-lines")).toHaveCSS(
    "text-size-adjust",
    "100%",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await viewer.dispose();
});

test("keeps mixed surfaces reflowed across appearance extremes", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  const combinations = [
    [100, 15, 13],
    [90, 13, 12],
    [120, 20, 20],
    [90, 20, 20],
    [120, 13, 12],
  ];

  for (const [interfaceValue, conversationValue, codeValue] of combinations) {
    await setRange(range(settingsPage, "interfaceScalePercent"), interfaceValue);
    await setRange(range(settingsPage, "conversationTextPx"), conversationValue);
    await setRange(range(settingsPage, "codeTextPx"), codeValue);

    await expect(
      settingsPage.locator(".settings-conversation-message p").first(),
    ).toHaveCSS("font-size", `${conversationValue}px`);
    await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
      "font-size",
      `${codeValue}px`,
    );
    await expect
      .poll(() =>
        settingsPage.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      )
      .toBe(true);
  }

  await setRange(range(settingsPage, "interfaceScalePercent"), 120);
  await setRange(range(settingsPage, "conversationTextPx"), 20);
  await setRange(range(settingsPage, "codeTextPx"), 20);
  const mixedMetrics = await page.evaluate(() => {
    const host = document.createElement("section");
    host.style.cssText =
      "position:fixed;inset:0;z-index:100;background:var(--surface);overflow:auto;padding:1rem";
    document.body.append(host);

    const conversation = document.createElement("caffold-task-conversation");
    host.append(conversation);
    conversation.innerHTML = `
      <article class="task-approval-card">
        <header><h3>Approval</h3><p class="task-approval-reason">Review the requested command before continuing.</p></header>
        <pre>cargo test --all-targets</pre>
        <div class="task-approval-actions">
          <button class="task-secondary-button">Decline</button>
          <button class="task-primary-button">Approve</button>
        </div>
      </article>
    `;

    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    host.append(composer);

    const github = document.createElement("caffold-github-markdown");
    github.setHtml("<p>Long-form review <code>const value = 1;</code></p>");
    host.append(github);

    const approval = conversation.querySelector(".task-approval-card");
    const approvalText = approval.querySelector("p");
    const approvalCode = approval.querySelector("pre");
    const textarea = composer.querySelector("textarea");
    const send = composer.querySelector(".task-primary-action-button");
    const githubText = github.shadowRoot.querySelector("p");
    const githubCode = github.shadowRoot.querySelector("code");
    const metric = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        height: box.height,
        right: box.right,
      };
    };
    const result = {
      viewportWidth: innerWidth,
      documentOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      approvalText: metric(approvalText),
      approvalCode: metric(approvalCode),
      textarea: metric(textarea),
      send: metric(send),
      githubText: metric(githubText),
      githubCode: metric(githubCode),
    };
    host.remove();
    return result;
  });
  expect(mixedMetrics.documentOverflow).toBe(false);
  expect(mixedMetrics.approvalText.fontSize).toBe("20px");
  expect(mixedMetrics.approvalCode.fontSize).toBe("20px");
  expect(mixedMetrics.textarea.fontSize).toBe("20px");
  expect(mixedMetrics.githubText.fontSize).toBe("20px");
  expect(mixedMetrics.githubCode.fontSize).toBe("20px");
  for (const control of [mixedMetrics.send]) {
    expect(control.height).toBeGreaterThanOrEqual(
      testInfo.project.name === "desktop" ? 38 : 40,
    );
    expect(control.right).toBeLessThanOrEqual(mixedMetrics.viewportWidth);
  }

  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 640, height: 400 });
    await expect
      .poll(() =>
        settingsPage.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});

test("keeps model picker chrome compact and scales it only with Interface", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  const interfaceRange = range(settingsPage, "interfaceScalePercent");
  const conversationRange = range(settingsPage, "conversationTextPx");
  const codeRange = range(settingsPage, "codeTextPx");

  await page.evaluate(() => {
    const host = document.createElement("section");
    host.dataset.appearancePickerProbe = "";
    host.style.cssText =
      "position:fixed;inset:0;z-index:100;background:var(--surface);overflow:auto";
    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    host.append(composer);
    document.body.append(host);
  });

  const composer = page.locator(
    "[data-appearance-picker-probe] caffold-task-composer",
  );
  const modelButton = composer.getByRole("button", {
    name: /Choose model/,
  });
  await expect(modelButton).toContainText("5.6 Sol");

  await setRange(interfaceRange, 90);
  await setRange(conversationRange, 13);
  await setRange(codeRange, 12);
  await modelButton.click();
  const popover = composer.getByRole("menu", {
    name: /Model.*options/,
  });
  await expect(popover).toBeVisible();
  const compact = await modelPickerMetrics(composer);
  await expect(modelButton).toHaveText("5.6 Sol · low");
  await expect(
    composer.getByRole("button", { name: "Choose approval mode" }),
  ).toHaveText("Auto review");
  expect(compact.modelButtonFontSize / compact.rootFontSize).toBeCloseTo(
    0.75,
    2,
  );
  expect(compact.permissionButtonFontSize / compact.rootFontSize).toBeCloseTo(
    0.75,
    2,
  );
  expect(compact.titleFontSize / compact.rootFontSize).toBeCloseTo(0.875, 2);
  expect(compact.toolbarPadding / compact.rootFontSize).toBeCloseTo(0.25, 2);
  expect(compact.toolbarGap / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.popoverPadding / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.optionPadding / compact.rootFontSize).toBeCloseTo(0.375, 2);
  expect(compact.optionGap / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.modelButtonIconCount).toBe(0);
  expect(compact.permissionButtonIconCount).toBe(0);
  expect(compact.modelButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(compact.permissionButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(compact.modelButtonOverflow).toBe(false);
  expect(compact.permissionButtonOverflow).toBe(false);
  expect(compact.modelPickerDeadSpace).toBeLessThanOrEqual(1);
  expect(compact.chipGap).toBeGreaterThanOrEqual(0);
  expect(compact.chipGap).toBeLessThanOrEqual(compact.toolbarGap + 1);
  expectComposerIconsCentered(compact);

  await setRange(conversationRange, 20);
  await setRange(codeRange, 20);
  const contentAxesChanged = await modelPickerMetrics(composer);
  expect(stableModelPickerMetrics(contentAxesChanged)).toEqual(
    stableModelPickerMetrics(compact),
  );

  await setRange(interfaceRange, 120);
  const spacious = await modelPickerMetrics(composer);
  const interfaceRatio = spacious.rootFontSize / compact.rootFontSize;
  expect(interfaceRatio).toBeCloseTo(4 / 3, 2);
  for (const property of [
    "modelButtonFontSize",
    "permissionButtonFontSize",
    "titleFontSize",
    "toolbarPadding",
    "toolbarGap",
    "popoverPadding",
    "optionPadding",
    "optionGap",
  ]) {
    expect(spacious[property] / compact[property]).toBeCloseTo(interfaceRatio, 2);
  }
  expect(spacious.modelButtonHeight).toBeGreaterThanOrEqual(
    compact.modelButtonHeight,
  );
  expect(compact.modelButtonHeight).toBeCloseTo(compact.compactVisualSize, 1);
  expect(spacious.modelButtonHeight).toBeCloseTo(spacious.compactVisualSize, 1);
  expect(spacious.optionHeight).toBeGreaterThanOrEqual(compact.optionHeight);
  expect(compact.optionHeight).toBeGreaterThanOrEqual(
    minimumModelOptionHeight(compact) - 0.01,
  );
  expect(spacious.optionHeight).toBeGreaterThanOrEqual(
    minimumModelOptionHeight(spacious) - 0.01,
  );
  expect(spacious.modelButtonOverflow).toBe(false);
  expect(spacious.permissionButtonOverflow).toBe(false);
  expect(spacious.toolbarOverflow).toBe(false);
  expect(spacious.modelPickerDeadSpace).toBeLessThanOrEqual(1);
  expect(spacious.chipGap).toBeGreaterThanOrEqual(0);
  expect(spacious.chipGap).toBeLessThanOrEqual(spacious.toolbarGap + 1);
  expectComposerIconsCentered(spacious);
  expect(compact.overflowX).toBe(false);
  expect(spacious.overflowX).toBe(false);
});

function range(settingsPage, name) {
  return settingsPage.locator(`input[type="range"][data-setting="${name}"]`);
}

function minimumModelOptionHeight(metrics) {
  return Math.max(metrics.rootFontSize * 2.125, metrics.targetFloor - 2);
}

async function setRange(locator, value) {
  await locator.evaluate((element, nextValue) => {
    element.value = `${nextValue}`;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function installPushBrowserMock(
  page,
  { permission = "default", initialSubscription = false } = {},
) {
  await page.addInitScript(({ permission, initialSubscription }) => {
    const state = {
      permission,
      permissionCalls: 0,
      subscription: null,
      subscribeCalls: 0,
      unsubscribeCalls: 0,
    };
    const createSubscription = () => ({
      endpoint: "https://push.example.test/current",
      expirationTime: null,
      toJSON() {
        return { keys: { p256dh: "browser-public", auth: "browser-auth" } };
      },
      async unsubscribe() {
        state.unsubscribeCalls += 1;
        state.subscription = null;
        return true;
      },
    });
    if (initialSubscription) {
      state.subscription = createSubscription();
    }
    window.__pushMock = state;
    class MockNotification {
      static get permission() {
        return state.permission;
      }

      static async requestPermission() {
        state.permissionCalls += 1;
        state.permission = "granted";
        return state.permission;
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
    const pushManager = {
      async getSubscription() {
        return state.subscription;
      },
      async subscribe() {
        state.subscribeCalls += 1;
        state.subscription = createSubscription();
        return state.subscription;
      },
    };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      configurable: true,
      get: () => pushManager,
    });
  }, { permission, initialSubscription });
}

async function settingsSurfaceMetrics(surface, selectors) {
  return surface.evaluate((element, requested) => {
    const number = (value) => Number.parseFloat(value) || 0;
    const tokenHeight = (token) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;height:var(${token})`;
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    };
    const actionMetric = (selector) => {
      if (!selector) {
        return null;
      }
      const action = element.querySelector(selector);
      const box = action.getBoundingClientRect();
      const inset = number(getComputedStyle(action, "::before").top);
      return {
        height: box.height,
        visualHeight: box.height - inset * 2,
      };
    };
    const row = element.querySelector(requested.row);
    const leading = row.querySelector(requested.leading).getBoundingClientRect();
    const trailing = row.querySelector(requested.trailing).getBoundingClientRect();
    const scroll = element.querySelector(
      ".settings-scroll, .settings-content-scroll",
    );

    return {
      overflowX:
        element.scrollWidth > element.clientWidth ||
        scroll.scrollWidth > scroll.clientWidth,
      stacked: trailing.top >= leading.bottom - 1,
      regularHit: tokenHeight("--interface-control-hit-size"),
      regularVisual: tokenHeight("--interface-control-visual-size"),
      compactHit: tokenHeight("--interface-compact-hit-size"),
      compactVisual: tokenHeight("--interface-compact-visual-size"),
      pageAction: actionMetric(requested.pageAction),
      contextAction: actionMetric(requested.contextAction),
    };
  }, selectors);
}

function expectSettingsActionTiers(metrics, hasContextAction = false) {
  expect(metrics.pageAction.height).toBeCloseTo(metrics.regularHit, 1);
  expect(metrics.pageAction.visualHeight).toBeCloseTo(metrics.regularVisual, 1);
  if (hasContextAction) {
    expect(metrics.contextAction.height).toBeCloseTo(metrics.compactHit, 1);
    expect(metrics.contextAction.visualHeight).toBeCloseTo(
      metrics.compactVisual,
      1,
    );
  }
}

async function modelPickerMetrics(composer) {
  return composer.evaluate((element) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const toolbar = element.querySelector(".task-composer-toolbar");
    const modelButton = element.querySelector(".task-model-button");
    const permissionButton = element.querySelector(".task-permission-button");
    const popover = element.querySelector(".task-model-popover");
    const option = popover.querySelector(".task-model-option");
    const title = option.querySelector("strong");
    const toolbarStyle = getComputedStyle(toolbar);
    const popoverStyle = getComputedStyle(popover);
    const optionStyle = getComputedStyle(option);
    const modelButtonStyle = getComputedStyle(modelButton);
    const permissionButtonStyle = getComputedStyle(permissionButton);
    const modelPickerRect = modelButton.parentElement.getBoundingClientRect();
    const modelButtonRect = modelButton.getBoundingClientRect();
    const permissionButtonRect = permissionButton.getBoundingClientRect();
    const number = (value) => Number.parseFloat(value) || 0;
    const tokenHeight = (token) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;height:var(${token})`;
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    };
    const iconGeometry = [
      ["send", element.querySelector(".task-primary-action-button"), element.querySelector(".task-primary-action-icon")],
    ].map(([name, button, icon]) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon?.getBoundingClientRect();
      const glyphBox = icon?.getBBox?.();
      const viewBox = icon?.viewBox?.baseVal;
      return {
        name,
        tagName: icon?.tagName?.toLowerCase() ?? "",
        outerAspectDelta: Math.abs(iconBox.width - iconBox.height),
        buttonCenterDeltaY: Math.abs(
          iconBox.top + iconBox.height / 2 - (buttonBox.top + buttonBox.height / 2),
        ),
        glyphCenterDeltaX: Math.abs(
          glyphBox.x + glyphBox.width / 2 - (viewBox.x + viewBox.width / 2),
        ),
        glyphCenterDeltaY: Math.abs(
          glyphBox.y + glyphBox.height / 2 - (viewBox.y + viewBox.height / 2),
        ),
      };
    });
    return {
      rootFontSize: number(rootStyle.fontSize),
      targetFloor: number(rootStyle.getPropertyValue("--interface-target-floor")),
      compactVisualSize: tokenHeight("--interface-compact-visual-size"),
      titleFontSize: number(getComputedStyle(title).fontSize),
      modelButtonFontSize: number(getComputedStyle(modelButton).fontSize),
      permissionButtonFontSize: number(
        getComputedStyle(permissionButton).fontSize,
      ),
      modelButtonBackground: modelButtonStyle.backgroundColor,
      permissionButtonBackground: permissionButtonStyle.backgroundColor,
      modelButtonIconCount: modelButton.querySelectorAll("svg").length,
      permissionButtonIconCount: permissionButton.querySelectorAll("svg").length,
      modelButtonOverflow: modelButton.scrollWidth > modelButton.clientWidth,
      permissionButtonOverflow:
        permissionButton.scrollWidth > permissionButton.clientWidth,
      modelPickerDeadSpace: modelPickerRect.width - modelButtonRect.width,
      chipGap: permissionButtonRect.left - modelButtonRect.right,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      toolbarPadding: number(toolbarStyle.paddingTop),
      toolbarGap: number(toolbarStyle.columnGap),
      modelButtonHeight: modelButton.getBoundingClientRect().height,
      popoverPadding: number(popoverStyle.paddingTop),
      optionPadding: number(optionStyle.paddingTop),
      optionGap: number(optionStyle.columnGap),
      optionHeight: option.getBoundingClientRect().height,
      iconGeometry,
      overflowX:
        popover.scrollWidth > popover.clientWidth ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

function stableModelPickerMetrics(metrics) {
  const {
    modelButtonBackground: _modelButtonBackground,
    permissionButtonBackground: _permissionButtonBackground,
    ...stableMetrics
  } = metrics;
  return stableMetrics;
}

function expectComposerIconsCentered(metrics) {
  expect(metrics.iconGeometry).toHaveLength(1);
  for (const icon of metrics.iconGeometry) {
    expect(icon.tagName, `${icon.name} must use an SVG icon`).toBe("svg");
    expect(icon.outerAspectDelta, `${icon.name} must use a square slot`).toBeLessThanOrEqual(
      0.1,
    );
    expect(
      icon.buttonCenterDeltaY,
      `${icon.name} must be vertically centered in its control`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      icon.glyphCenterDeltaX,
      `${icon.name} glyph must be centered in its SVG view box`,
    ).toBeLessThanOrEqual(0.75);
    expect(
      icon.glyphCenterDeltaY,
      `${icon.name} glyph must be centered in its SVG view box`,
    ).toBeLessThanOrEqual(0.75);
  }
}

async function expectThemeState(page, { mode, resolvedTheme }) {
  const expectedColor = resolvedTheme === "dark" ? "#1b1b1b" : "#ffffff";
  await expect(page.locator("html")).toHaveAttribute("data-theme", resolvedTheme);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    expectedColor,
  );
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const settings = JSON.parse(localStorage.getItem(key));
        return {
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          themeMode: settings.themeMode,
        };
      }, SETTINGS_KEY),
    )
    .toEqual({ colorScheme: resolvedTheme, themeMode: mode });
}

async function representativeThemeStyles(page) {
  return page.evaluate(async () => {
    await import("/assets/components/diff-viewer.js");

    const review = document.createElement("caffold-task-review");
    review.style.cssText =
      "position:fixed;inset:auto auto 0 -10000px;width:20rem;height:10rem";
    document.body.append(review);
    review.innerHTML = `
      <p class="task-review-git-notice">Review warning</p>
      <p class="task-review-error">Review error</p>
    `;

    const diff = document.createElement("caffold-diff-viewer");
    diff.style.cssText =
      "position:fixed;inset:auto auto 0 -10000px;width:20rem;height:10rem";
    document.body.append(diff);
    diff.setDiff({
      diff: "@@ -1 +1 @@\n-old line\n+new line",
    });

    const colorPair = (element) => {
      const style = getComputedStyle(element);
      return `${style.color}|${style.backgroundColor}`;
    };
    const result = {
      settings: colorPair(
        document.querySelector("caffold-settings-appearance-page"),
      ),
      themeSelection: colorPair(
        document.querySelector(
          ".settings-theme-control label:has(input:checked) > span",
        ),
      ),
      reviewWarning: colorPair(review.querySelector(".task-review-git-notice")),
      reviewDanger: colorPair(review.querySelector(".task-review-error")),
      code: colorPair(document.querySelector(".settings-code-preview")),
      diffAdded: colorPair(diff.querySelector(".diff-row-added")),
      diffRemoved: colorPair(diff.querySelector(".diff-row-removed")),
    };
    review.remove();
    diff.remove();
    return result;
  });
}
