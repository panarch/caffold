import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockCodexStatus,
} from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  installEventSourceMock,
} from "../support/task-fixtures.js";

const BLOCKING_STATES = [
  ["missing", "Install Codex to start Tasks", "Codex setup required."],
  [
    "unsupportedInstall",
    "Use the official standalone Codex",
    "Codex setup required.",
  ],
  ["updateRequired", "Update Codex to continue", "Codex update required."],
  ["signInRequired", "Sign in to Codex", "Codex sign-in required."],
  ["restartRequired", "Restart the Codex runtime", "Codex restart required."],
  ["incompatible", "Codex runtime is incompatible", "Codex unavailable."],
  ["error", "Codex runtime is unavailable", "Codex unavailable."],
];

const REASON_CODES = {
  missing: "officialStandaloneNotFound",
  unsupportedInstall: "unsupportedPathInstall",
  updateRequired: "versionBelowMinimum",
  signInRequired: "authenticationRequired",
  restartRequired: "runtimeVersionMismatch",
  incompatible: "protocolInitializationFailed",
  error: "appServerUnavailable",
};

function statusFor(state, overrides = {}) {
  const detectedVersion = state === "missing"
    ? null
    : state === "updateRequired" ? "0.146.0" : "0.147.0";
  return mockCodexStatus({
    readiness: {
      state,
      blocksTaskOperations: true,
      reasonCode: REASON_CODES[state],
      diagnosticMessage: `${state} diagnostic`,
      minimumSupportedVersion: "0.147.0",
      detectedExecutable: {
        path: state === "missing" ? null : "/opt/homebrew/bin/codex",
        version: detectedVersion,
      },
      managedExecutable: {
        path: ["missing", "unsupportedInstall", "updateRequired"].includes(state)
          ? null
          : "/Users/example/.local/bin/codex",
        version: ["missing", "unsupportedInstall", "updateRequired"].includes(state)
          ? null
          : "0.147.0",
      },
      runningAppServerVersion: ["signInRequired", "restartRequired"].includes(state)
        ? "0.146.0"
        : null,
      ...overrides,
    },
  });
}

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
});

for (const [state, heading, navigatorMessage] of BLOCKING_STATES) {
  test(`shows the canonical ${state} Task setup surface`, async ({ page }) => {
    await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(statusFor(state)),
      }),
    );

    await page.goto("/");

    const setup = page.locator(`.codex-readiness-card[data-readiness-state="${state}"]`);
    await expect(setup).toBeVisible();
    await expect(setup.getByRole("heading", { name: heading })).toBeVisible();
    await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
    await expect(setup.getByRole("button", { name: "Open Settings" })).toBeEnabled();
    await expect(page.locator("caffold-task-new")).toBeHidden();
    const newTask = page.locator("caffold-task-navigator .task-list-new-task");
    await expect(newTask).toBeDisabled();
    await expect(newTask).toHaveAttribute(
      "title",
      navigatorMessage.replace(/\.$/, ""),
    );
    await expect(
      page.locator("caffold-active-task-list .task-section-message"),
    ).toHaveText(navigatorMessage);
    await expect
      .poll(() => page.locator("caffold-task-navigator").evaluate(
        (navigator) => navigator.listState().loading,
      ))
      .toBe(false);

    if (["missing", "unsupportedInstall", "updateRequired"].includes(state)) {
      await expect(setup).toContainText("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
      await expect(setup).toContainText("0.147.0");
      await expect(setup).toContainText("background app server");
      await expect(setup).toContainText("without this app-server support");
      await expect(setup).toContainText("Caffold manages the connection automatically");
      await expect(setup).toContainText("Required official");
      await expect(setup.getByRole("link", { name: "Official Codex CLI guide" })).toBeVisible();
    }
    if (state === "updateRequired") {
      await expect(setup).toContainText("Required official update command");
      const copy = setup.getByRole("button", { name: "Copy command" });
      const copyNode = await copy.elementHandle();
      await copy.click();
      await expect(setup.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await copyNode.evaluate((element) => (
        element.isConnected && document.activeElement === element
      ))).toBe(true);
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
        "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      );
    }
    if (state === "signInRequired") {
      await expect(setup).toContainText("Run codex in a terminal");
    }
    if (state === "restartRequired") {
      await expect(setup.getByRole("button", { name: "Restart Codex" })).toBeEnabled();
      await expect(setup.getByRole("button", { name: "Open Settings" })).toBeEnabled();
    }
  });
}

test("identifies a standalone install without required daemon commands", async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("unsupportedInstall", {
        reasonCode: "appServerCommandsUnavailable",
        diagnosticMessage: "The required app-server daemon command is unavailable.",
        detectedExecutable: {
          path: "/Users/example/.local/bin/codex",
          version: "0.147.0",
        },
      })),
    }),
  );

  await page.goto("/");

  const setup = page.locator('[data-readiness-state="unsupportedInstall"]');
  await expect(setup.getByRole("heading", {
    name: "Install a compatible Codex CLI",
  })).toBeVisible();
  await expect(setup).toContainText("does not include the runtime support");
  await expect(setup).toContainText("official standalone Codex CLI");
});

test("keeps the stable Task shell while readiness is checking", async ({ page }, testInfo) => {
  let releaseStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  let releaseTasks;
  const tasksGate = new Promise((resolve) => {
    releaseTasks = resolve;
  });
  let taskRequests = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, async (route) => {
    await statusGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    });
  });
  await page.route(/\/api\/tasks(?:\/archived)?(?:\?|$)/, async (route) => {
    taskRequests += 1;
    await tasksGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    });
  });

  await page.goto("/");
  const recovery = page.locator("caffold-codex-readiness-recovery");
  await expect(recovery).toBeHidden();
  await expect(page.locator(".task-workspace-master-pane")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Settings" })).toHaveCount(0);
  expect(await page.locator("caffold-task-new").evaluate(
    (element) => element.hidden,
  )).toBe(false);
  const navigatorMessage = page.locator(
    "caffold-active-task-list .task-section-message",
  );
  await expect(navigatorMessage).toHaveText("Checking Codex readiness…");
  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  await expect(newTask).toBeDisabled();
  await expect(newTask).toHaveAttribute("title", "Checking Codex readiness…");
  await expect(
    page.getByText("Codex setup required.", { exact: true }),
  ).toHaveCount(0);
  expect(taskRequests).toBe(0);
  await captureReviewScreenshot(
    page,
    testInfo,
    "codex-readiness-checking-task-shell",
  );

  releaseStatus();
  await expect(recovery).toBeHidden();
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
  await expect(navigatorMessage).toHaveText("Loading...");

  releaseTasks();
  await expect(navigatorMessage).toHaveText("No Caffold tasks yet.");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
});

test("waits for explicit route activation when readiness settles first", async ({ page }) => {
  await page.goto("/");

  const routeOpens = await page.evaluate(async (status) => {
    const Workspace = customElements.get("caffold-task-workspace");
    const workspace = new Workspace();
    workspace.ensureRendered();
    workspace.codexRuntimeRestartDialog.close = () => {};
    workspace.prepareRoute = () => {};
    let opens = 0;
    workspace.tasksPage.openRoute = async () => {
      opens += 1;
      return null;
    };

    workspace.setCodexStatusSnapshot({
      phase: "loaded",
      status,
      error: "",
    });
    const beforeActivation = opens;
    await workspace.openRoute({ kind: "tasks" });
    return { beforeActivation, afterActivation: opens };
  }, mockCodexStatus());

  expect(routeOpens).toEqual({
    beforeActivation: 0,
    afterActivation: 1,
  });
});

test("a readiness load failure is not presented as a setup requirement", async ({ page }) => {
  let taskRequests = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "readiness unavailable",
    }),
  );
  await page.route(/\/api\/tasks(?:\/archived)?(?:\?|$)/, (route) => {
    taskRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    });
  });

  await page.goto("/");

  await expect(
    page.locator('[data-readiness-state="checkFailed"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Codex readiness could not be checked" }),
  ).toBeVisible();
  await expect(
    page.locator("caffold-active-task-list .task-section-message"),
  ).toHaveText("Codex readiness check failed.");
  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  await expect(newTask).toBeDisabled();
  await expect(newTask).toHaveAttribute("title", "Codex readiness check failed");
  await expect(
    page.getByText("Codex setup required.", { exact: true }),
  ).toHaveCount(0);
  expect(taskRequests).toBe(0);
});

test("Retry transitions from setup into the ready Task surface", async ({ page }) => {
  let ready = false;
  let taskRequests = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(ready ? mockCodexStatus() : statusFor("updateRequired")),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    });
  });

  await page.goto("/");
  await expect(page.locator('[data-readiness-state="updateRequired"]')).toBeVisible();
  expect(taskRequests).toBe(0);

  ready = true;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("restarts a stale Codex runtime directly from Task setup", async ({ page }) => {
  let restarted = false;
  let restartRequests = 0;
  let taskRequests = 0;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        restarted ? mockCodexStatus() : statusFor("restartRequired"),
      ),
    }),
  );
  await page.route(/\/api\/codex\/restart(?:\?|$)/, (route) => {
    restartRequests += 1;
    restarted = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "restarted" }),
    });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    });
  });

  await page.goto("/");
  const setup = page.locator('[data-readiness-state="restartRequired"]');
  const restart = setup.getByRole("button", { name: "Restart Codex" });
  await expect(restart).toBeVisible();
  const primaryColors = await restart.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--primary-action-bg)";
    probe.style.color = "var(--primary-action-fg)";
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const value = {
      expectedBackground: expected.backgroundColor,
      expectedColor: expected.color,
    };
    probe.remove();
    return {
      background: style.backgroundColor,
      color: style.color,
      ...value,
    };
  });
  expect(primaryColors.background).toBe(primaryColors.expectedBackground);
  expect(primaryColors.color).toBe(primaryColors.expectedColor);

  await restart.click();
  const dialog = page.getByRole("dialog", { name: "Restart Codex runtime?" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(
    "caffold-task-workspace > caffold-codex-runtime-restart-dialog",
  )).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(restartRequests).toBe(0);

  await restart.click();
  await dialog.getByRole("button", { name: "Restart Codex" }).click();

  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  expect(restartRequests).toBe(1);
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("a blocking transition releases the Task list and disables existing actions", async ({
  page,
}) => {
  await installEventSourceMock(page, {
    registryKey: "__readinessEventSources",
    autoOpen: true,
  });
  const now = Date.now();
  const task = (threadId, title) => ({
    id: threadId,
    threadId,
    title,
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    conversationAvailable: true,
  });
  const activeTask = task("thread_ready_active", "Ready active Task");
  const archivedTask = task("thread_ready_archived", "Ready archived Task");
  const mutationRequests = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([activeTask])),
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [archivedTask], nextCursor: null }),
    }),
  );
  page.on("request", (request) => {
    if (/\/(restore|delete)$/.test(new URL(request.url()).pathname)) {
      mutationRequests.push(request.url());
    }
  });

  await page.goto("/");

  const navigator = page.locator("caffold-task-navigator");
  const activeRow = navigator.locator(
    '.task-row[data-thread-id="thread_ready_active"]',
  );
  const archivedRow = navigator.locator(
    '.task-archived-row[data-thread-id="thread_ready_archived"]',
  );
  await expect(activeRow).toBeEnabled();
  await expect(archivedRow.getByRole("button", { name: /Restore/ })).toBeEnabled();
  await expect(archivedRow.getByRole("button", { name: /Delete/ })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__readinessEventSources.some((source) =>
          source.url.includes("/api/tasks/stream"),
        ),
      ),
    )
    .toBe(true);

  await page.evaluate((status) => {
    document.querySelector("caffold-task-workspace").setCodexStatusSnapshot({
      phase: "loaded",
      status,
      error: "",
    });
  }, statusFor("updateRequired"));

  await expect(page.locator('[data-readiness-state="updateRequired"]')).toBeVisible();
  await expect(activeRow).toBeDisabled();
  await expect(activeRow).toHaveAttribute("title", "Codex update required");
  await expect(
    archivedRow.locator('[data-task-action="restore-archived-task"]'),
  ).toBeDisabled();
  await expect(
    archivedRow.locator('[data-task-action="delete-archived-task"]'),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__readinessEventSources
          .filter((source) => source.url.includes("/api/tasks/stream"))
          .every((source) => source.readyState === 2),
      ),
    )
    .toBe(true);

  await navigator.evaluate(async (element) => {
    await element.restoreThread("thread_ready_archived");
    await element.deleteThread("thread_ready_archived");
  });
  expect(mutationRequests).toEqual([]);
});

test("Settings stays reachable while Codex setup blocks Tasks", async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("signInRequired")),
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Open Settings" }).click();

  await expect(page).toHaveURL("/settings/codex");
  await expect(page.locator("caffold-settings-codex-page")).toBeVisible();
  await expect(page.locator("caffold-settings-codex-page")).toContainText("Sign-in required");
});

test("a backend-declared nonblocking restart state keeps Tasks usable", async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("restartRequired", {
        blocksTaskOperations: false,
        runningAppServerVersion: "0.147.0",
      })),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection()),
    }),
  );

  await page.goto("/");

  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
  const workspaceSettings = page.locator(
    'caffold-task-workspace-navigation button[data-workspace-mode="settings"]',
  );
  await expect(workspaceSettings).toHaveAttribute(
    "data-codex-state",
    "attention",
  );
  await expect.poll(() => workspaceSettings.evaluate(
    (button) => getComputedStyle(button).animationName,
  )).toBe("codex-attention-pulse");

  await page.goto("/settings");

  const settingsCodex = page.locator(
    'caffold-settings-navigator button[data-settings-section="codex"]',
  );
  await expect.poll(() => workspaceSettings.evaluate(
    (button) => getComputedStyle(button).animationName,
  )).toBe("none");
  await expect(settingsCodex).toHaveAttribute("data-codex-state", "attention");
  await expect.poll(() => settingsCodex.evaluate(
    (button) => getComputedStyle(button).animationName,
  )).toBe("codex-attention-pulse");

  await settingsCodex.click();

  await expect(settingsCodex).toHaveAttribute("aria-current", "");
  await expect.poll(() => settingsCodex.evaluate(
    (button) => getComputedStyle(button).animationName,
  )).toBe("none");
});

test("Codex attention remains visible without motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("restartRequired", {
        blocksTaskOperations: false,
        runningAppServerVersion: "0.147.0",
      })),
    }),
  );

  await page.goto("/");

  const workspaceSettings = page.locator(
    'caffold-task-workspace-navigation button[data-workspace-mode="settings"]',
  );
  await expect.poll(() => workspaceSettings.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      animationName: style.animationName,
      boxShadow: style.boxShadow,
    };
  })).toEqual({
    animationName: "none",
    boxShadow: expect.not.stringMatching(/^none$/),
  });
});

test("the setup card reflows without horizontal overflow", async ({ page }, testInfo) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("updateRequired")),
    }),
  );

  await page.goto("/");
  const surface = page.locator(".codex-readiness-surface");
  await expect(surface).toBeVisible();
  const metrics = await surface.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  await captureReviewScreenshot(page, testInfo, "codex-readiness-update-required");
});

test("consumes the real backend readiness contract and gates Task creation", async ({ page }) => {
  await page.unroute(/\/api\/codex\/status(?:\?|$)/);

  await page.goto("/");

  const setup = page.locator('.codex-readiness-card[data-readiness-state="error"]');
  await expect(setup).toBeVisible();
  await expect(setup).toContainText("fake Codex does not start an app-server");

  const statusResponse = await page.request.get("/api/codex/status");
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect(status.readiness).toMatchObject({
    state: "error",
    blocksTaskOperations: true,
    reasonCode: "appServerUnavailable",
    minimumSupportedVersion: "0.147.0",
  });

  const taskResponse = await page.request.post("/api/tasks", {
    data: { prompt: "must remain blocked" },
  });
  expect(taskResponse.status()).toBe(503);
  await expect(taskResponse.json()).resolves.toMatchObject({
    error: { code: "codex_readiness_blocked" },
  });
});
