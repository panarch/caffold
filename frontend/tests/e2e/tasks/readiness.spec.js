import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import {
  installBrowserDefaults,
  mockCodexStatus,
} from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
} from "../support/task-fixtures.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";

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

function cachedTask(threadId = "thread_cached_while_blocked") {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("notLoaded"),
    title: "Cached Task identity",
    preview: "",
    cwd: "Workspace/caffold",
    cwdPath: "Workspace/caffold",
    relativeCwd: "",
    worktree: null,
    createdMs: 1,
    updatedMs: 2,
    recencyMs: 2,
    conversationAvailable: false,
  };
}

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection() })
  );
});

for (const [state, heading] of BLOCKING_STATES) {
  test(`shows the canonical ${state} Task setup surface`, { tag: "@all-viewports" }, async ({
    context,
    page,
  }) => {
    if (state === "unsupportedInstall") {
      await context.route("https://learn.chatgpt.com/docs/codex/cli", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Official Codex CLI guide</title>",
        }),
      );
    }
    await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(statusFor(state)),
      }),
    );

    // The setup card sits beside the new-Task surface — over nothing, and
    // however much it has to say, the composer below stays reachable.
    await page.goto("/tasks/new");
    const setup = page.locator(`.codex-readiness-card[data-readiness-state="${state}"]`);
    await expect(setup).toBeVisible();
    await expect(setup.getByRole("heading", { name: heading })).toBeVisible();
    await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
    await expect(setup.getByRole("button", { name: "Open Settings" })).toBeEnabled();
    await expect(page.locator("caffold-codex-readiness-recovery")).toHaveAttribute(
      "data-presentation",
      "beside",
    );
    const composerField = page.locator("caffold-task-new textarea");
    await expect(composerField).toBeVisible();
    await expect(composerField).toBeEnabled();
    const viewport = page.viewportSize();
    const composerBox = await composerField.boundingBox();
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(
      viewport.height,
    );
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
      const guide = setup.getByRole("link", {
        name: "Official Codex CLI guide",
      });
      await expect(guide).toBeVisible();
      if (state === "unsupportedInstall") {
        await revealActionTarget(page, guide);
        const popupPromise = page.waitForEvent("popup");
        await activateActionHint(
          page,
          /Open Official Codex CLI guide in a new tab$/,
        );
        const popup = await popupPromise;
        await expect(popup).toHaveURL(
          "https://learn.chatgpt.com/docs/codex/cli",
        );
        await popup.close();
      }
    }
    if (state === "updateRequired") {
      await expect(setup).toContainText("Required official update command");
      const copy = setup.getByRole("button", { name: "Copy command" });
      const copyNode = await copy.elementHandle();
      await revealActionTarget(page, copy);
      await activateActionHint(page, /Copy command$/);
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
    if (state === "updateRequired") {
      await verifyReadinessScrollIsolation(page);
    }
  });
}

test("a blocked Codex holds nothing on the Tasks home", { tag: "@all-viewports" }, async ({ page }) => {
  let taskRequests = 0;
  const cached = cachedTask();
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("updateRequired")),
    }),
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskRequests += 1;
    return route.fulfill({ json: activeTaskProjection([cached]) });
  });

  await page.goto("/");

  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
  const cachedRow = page.locator(
    `caffold-active-task-list .task-row[data-thread-id="${cached.threadId}"]`,
  );
  await expect(cachedRow).toContainText("Cached Task identity");
  await expect(cachedRow).toBeEnabled();
  await expect.poll(() => taskRequests).toBe(1);
});

test("identifies a standalone install without required daemon commands", { tag: "@all-viewports" }, async ({ page }) => {
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

test("keeps the stable Task shell while readiness is checking", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
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
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
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
  await expect(navigatorMessage).toHaveText("Loading...");
  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  // A status nobody has loaded yet blocks nothing: the other agent is not
  // Codex's to hold, and an operation tried too early is the server's to
  // refuse.
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
  await expect(
    page.getByText("Codex setup required.", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => taskRequests).toBe(1);
  await captureReviewScreenshot(
    page,
    testInfo,
    "codex-readiness-checking-task-shell",
  );

  releaseStatus();
  await expect(recovery).toBeHidden();
  await expect(navigatorMessage).toHaveText("Loading...");

  releaseTasks();
  await expect(navigatorMessage).toHaveText("No Caffold tasks yet.");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
});

test("waits for explicit route activation when readiness settles first", { tag: "@all-viewports" }, async ({ page }) => {
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

test("a readiness load failure is not presented as a setup requirement", { tag: "@all-viewports" }, async ({ page }) => {
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
  await expect(page.locator("caffold-codex-readiness-recovery")).toHaveAttribute(
    "data-presentation",
    "beside",
  );
  await expect(
    page.getByRole("heading", { name: "Codex readiness could not be checked" }),
  ).toBeVisible();
  await expect(
    page.locator("caffold-active-task-list .task-section-message"),
  ).toHaveText("No Caffold tasks yet.");
  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
  await expect(
    page.getByText("Codex setup required.", { exact: true }),
  ).toHaveCount(0);
  // The shell keeps retrying the failed status check, and each pass may
  // reload the list — the list is no longer held while status is unknown.
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("a failed Task-store migration has its own explicit retry lifecycle", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let retryRequests = 0;
  let retried = false;
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) => {
    const status = mockCodexStatus();
    if (!retried) {
      status.taskStoreReadiness = {
        state: "failed",
        blocksTaskOperations: true,
        diagnosticMessage: "Staged v5 validation failed.",
      };
    }
    return route.fulfill({ json: status });
  });
  await page.route(/\/api\/task-store\/migration\/retry$/, (route) => {
    retryRequests += 1;
    retried = true;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });

  await page.goto("/");

  const setup = page.locator(
    '[data-readiness-state="taskStore-failed"]',
  );
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "Task data upgrade failed" }),
  ).toBeVisible();
  await expect(setup).toContainText("Staged v5 validation failed.");
  await verifyReadinessScrollIsolation(page);
  await revealActionTarget(
    page,
    setup.getByRole("button", { name: "Retry Task setup" }),
  );
  await activateActionHint(page, /Retry Task setup$/);

  await expect.poll(() => retryRequests).toBe(1);
  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
});

test("Codex remains the visible cause while migration waits for it", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const cached = cachedTask("thread_cached_waiting_migration");
  const status = statusFor("updateRequired");
  status.taskStoreReadiness = {
    state: "waitingForCodex",
    blocksTaskOperations: true,
    diagnosticMessage: "Task-store migration is waiting for Codex.",
  };
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({ json: status })
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([cached]) })
  );

  await page.goto("/");

  const setup = page.locator('[data-readiness-state="updateRequired"]');
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "Update Codex to continue" }),
  ).toBeVisible();
  await expect(setup.getByRole("button", { name: "Retry Task setup" }))
    .toBeEnabled();
  await expect(
    page.locator(
      `.task-row[data-thread-id="${cached.threadId}"]`,
    ),
  ).toContainText("Cached Task identity");
});

test("Retry transitions from setup into the ready Task surface", { tag: "@all-viewports" }, async ({ page }) => {
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
  await expect.poll(() => taskRequests).toBeGreaterThan(0);

  ready = true;
  await revealActionTarget(
    page,
    page.getByRole("button", { name: "Retry" }),
  );
  await activateActionHint(page, /Retry$/);

  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("restarts a stale Codex runtime directly from Task setup", { tag: "@all-viewports" }, async ({ page }) => {
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

  await revealActionTarget(page, restart);
  await activateActionHint(page, /Restart Codex$/);
  const dialog = page.getByRole("dialog", { name: "Restart Codex runtime?" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(
    "caffold-task-workspace > caffold-codex-runtime-restart-dialog",
  )).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(restartRequests).toBe(0);

  await revealActionTarget(page, restart);
  await activateActionHint(page, /Restart Codex$/);
  await dialog.getByRole("button", { name: "Restart Codex" }).click();

  await expect(page.locator(".codex-readiness-surface")).toBeHidden();
  await expect(page.locator("caffold-task-new .task-new-form")).toBeVisible();
  expect(restartRequests).toBe(1);
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("a blocking transition releases the Task list and disables existing actions", { tag: "@all-viewports" }, async ({
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
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
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

  // Codex blocking is Codex's alone: the list keeps working, its stream
  // stays open, and archived actions go to the server, whose refusal is the
  // true answer rather than a guess made here.
  await expect(activeRow).toBeEnabled();
  await expect(
    archivedRow.locator('[data-task-action="restore-archived-task"]'),
  ).toBeEnabled();
  await expect(
    archivedRow.locator('[data-task-action="delete-archived-task"]'),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__readinessEventSources
          .filter((source) => source.url.includes("/api/tasks/stream"))
          .some((source) => source.readyState !== 2),
      ),
    )
    .toBe(true);

  await page.route(/\/api\/tasks\/thread_ready_archived\/restore$/, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "codex_readiness_blocked",
          message: "updateRequired diagnostic",
        },
      },
    }),
  );
  await navigator.evaluate(async (element) => {
    await element.restoreThread("thread_ready_archived");
  });
  await expect.poll(() => mutationRequests.length).toBeGreaterThan(0);
  await expect(archivedRow).toContainText("updateRequired diagnostic");
});

test("a Task-store takeover hands the open Task back when it clears", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const detail = taskDetailFixture();
  await installTaskApiFixture(page);
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const composer = page.locator(".task-follow-up-form textarea");
  await expect(composer).toBeVisible();

  const takeover = mockCodexStatus();
  takeover.taskStoreReadiness = {
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "Staged v5 validation failed.",
  };
  await page.evaluate((status) => {
    document.querySelector("caffold-task-workspace").setCodexStatusSnapshot({
      phase: "loaded",
      status,
      error: "",
    });
  }, takeover);
  await expect(
    page.locator('[data-readiness-state="taskStore-failed"]'),
  ).toBeVisible();
  await expect(composer).toBeHidden();

  await page.evaluate((status) => {
    document.querySelector("caffold-task-workspace").setCodexStatusSnapshot({
      phase: "loaded",
      status,
      error: "",
    });
  }, mockCodexStatus());

  await expect(
    page.locator('[data-readiness-state="taskStore-failed"]'),
  ).toBeHidden();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
});

test("a Codex-run submit surfaces the server's refusal and keeps the draft", { tag: "@all-viewports" }, async ({
  page,
}) => {
  // No surface pre-guesses the submit's fate from the snapshot: the server
  // refuses a Codex-run prompt while Codex is blocked, and that refusal is
  // what the composer shows — with the draft kept for after recovery.
  const detail = taskDetailFixture();
  await installTaskApiFixture(page);
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("updateRequired")),
    }),
  );
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/prompt*", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "codex_readiness_blocked",
          message: "updateRequired diagnostic",
        },
      },
    }),
  );

  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);

  const composer = page.locator(".task-follow-up-form textarea");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.fill("carry on with the plan");
  await page
    .locator(".task-follow-up-form")
    .getByRole("button", { name: "Send prompt" })
    .click();

  await expect(
    page.locator(".task-follow-up-form .task-composer-request-error"),
  ).toContainText("updateRequired diagnostic");
  await expect(composer).toHaveValue("carry on with the plan");
});

test("a Claude Task never looks at Codex readiness", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const detail = { ...taskDetailFixture(), provider: "claude" };
  await installTaskApiFixture(page);
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("updateRequired")),
    }),
  );
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );

  let promptRequests = 0;
  await page.route("**/api/tasks/thread-1/prompt*", (route) => {
    promptRequests += 1;
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-claude-1",
        userMessageId: "message-claude-1",
        steered: false,
        startedTurn: null,
      },
    });
  });

  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);

  const composer = page.locator(".task-follow-up-form textarea");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.fill("keep going");
  await page
    .locator(".task-follow-up-form")
    .getByRole("button", { name: "Send prompt" })
    .click();

  // The submit reaches the server: nothing in front of it consulted Codex.
  await expect.poll(() => promptRequests).toBe(1);
  await expect(
    page.locator(".task-follow-up-form .task-composer-request-error"),
  ).toHaveCount(0);
});

test("Settings stays reachable while Codex setup blocks Tasks", { tag: "@all-viewports" }, async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(statusFor("signInRequired")),
    }),
  );

  await page.goto("/");
  const openSettings = page.getByRole("button", { name: "Open Settings" });
  await revealActionTarget(page, openSettings);
  await activateActionHint(page, /Open Settings$/);

  await expect(page).toHaveURL("/settings/codex");
  await expect(page.locator("caffold-settings-codex-page")).toBeVisible();
  await expect(page.locator("caffold-settings-codex-page")).toContainText("Sign-in required");
});

test("a backend-declared nonblocking restart state keeps Tasks usable", { tag: "@all-viewports" }, async ({ page }) => {
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

test("Codex attention remains visible without motion", { tag: "@all-viewports" }, async ({ page }) => {
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

test("the setup card reflows without horizontal overflow", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
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

test("consumes the real backend readiness contract and gates Task creation", { tag: "@all-viewports" }, async ({ page }) => {
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
    data: { titleSource: "must remain blocked" },
  });
  expect(taskResponse.status()).toBe(503);
  await expect(taskResponse.json()).resolves.toMatchObject({
    error: { code: "codex_readiness_blocked" },
  });
});

async function verifyReadinessScrollIsolation(page) {
  const readinessScroll = page.locator(
    "caffold-codex-readiness-recovery:not([hidden]) > .codex-readiness-surface",
  );
  await readinessScroll.evaluate((element) => {
    element.style.height = "120px";
    element.style.maxHeight = "120px";
  });
  await expect.poll(() => readinessScroll.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await readinessScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const newTaskScroll = page.locator(
    "caffold-task-new:not([hidden]) > .task-new-workspace",
  );
  const newTaskBefore = await newTaskScroll.count()
    ? await newTaskScroll.evaluate((element) => element.scrollTop)
    : null;
  const workspace = page.locator(".task-workspace-surface");
  const selector = page.locator("caffold-scroll-surface-selector > dialog");
  const hud = page.locator(
    "caffold-task-workspace > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await workspace.focus();
  await page.keyboard.press("s");
  await expect.poll(async () =>
    await selector.isVisible() || await hud.isVisible()
  ).toBe(true);
  if (await selector.isVisible()) {
    const readiness = selector.getByLabel(/^[A-Z]+ — Codex readiness$/);
    await expect(readiness).toBeVisible();
    await readiness.click();
  }
  await expect(hud).toContainText("Scroll: Codex readiness");
  await page.keyboard.press("j");
  await expect.poll(() => readinessScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  if (newTaskBefore !== null) {
    expect(await newTaskScroll.evaluate((element) => element.scrollTop)).toBe(
      newTaskBefore,
    );
  }
  await page.keyboard.press("Escape");
  await expect(hud).toBeHidden();
}

async function revealActionTarget(page, control) {
  await control.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}
