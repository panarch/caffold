import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installAgentCatalog } from "../support/agent-catalog-fixture.js";
import {
  installBrowserDefaults,
  mockCodexStatus,
  mockTaskStoreStatus,
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
  "missing",
  "unsupportedInstall",
  "updateRequired",
  "signInRequired",
  "restartRequired",
  "incompatible",
  "error",
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

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection() })
  );
});

// Codex is one agent among several: being blocked marks no surface outside
// its own Settings page and Tasks.
for (const state of BLOCKING_STATES) {
  test(`a ${state} Codex adds nothing to New Task or the navigation`, { tag: "@desktop" }, async ({
    page,
  }) => {
    await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
      route.fulfill({ json: statusFor(state) }),
    );

    await page.goto("/tasks/new");
    await codexStatusApplied(page, state);

    await expect.poll(() => presentedTaskPaneChildren(page)).toEqual([
      "caffold-task-new",
    ]);
    await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
    const navigation = page.locator("caffold-task-workspace-navigation");
    const settings = navigation.locator('button[data-workspace-mode="settings"]');
    await expect(settings).toHaveAccessibleName("Settings");
    await expectLooksLike(
      settings,
      navigation.locator('button[data-workspace-mode="notes"]'),
    );
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
  await expect(page.locator(".task-workspace-master-pane")).toBeVisible();
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
  await expect.poll(() => taskRequests).toBe(1);
  await captureReviewScreenshot(
    page,
    testInfo,
    "codex-readiness-checking-task-shell",
  );

  releaseStatus();
  await codexStatusApplied(page, "ready");
  await expect.poll(() => presentedTaskPaneChildren(page)).toEqual([
    "caffold-task-new",
  ]);
  await expect(navigatorMessage).toHaveText("Loading...");

  releaseTasks();
  await expect(navigatorMessage).toHaveText("No Caffold tasks yet.");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
});

test("waits for explicit route activation when readiness settles first", { tag: "@all-viewports" }, async ({ page }) => {
  const stylesRequested = Promise.withResolvers();
  const releaseStyles = Promise.withResolvers();
  await page.route("**/assets/component-styles/compact-icon-button.css", async (route) => {
    stylesRequested.resolve();
    await releaseStyles.promise;
    await route.continue();
  });
  let routeOpens;
  try {
    await page.goto("/");
    await stylesRequested.promise;
    [routeOpens] = await Promise.all([
      page.evaluate(async (status) => {
        const Workspace = await customElements.whenDefined("caffold-task-workspace");
        // The shell defines itself after its own shared styles, and only a
        // booted shell keeps this second workspace's route work in the page.
        await customElements.whenDefined("caffold-app-shell");
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
      }, mockCodexStatus()),
      (async () => {
        expect(await page.evaluate(() => Boolean(customElements.get("caffold-task-workspace")))).toBe(false);
        releaseStyles.resolve();
      })(),
    ]);
  } finally {
    releaseStyles.resolve();
  }

  expect(routeOpens).toEqual({
    beforeActivation: 0,
    afterActivation: 1,
  });
});

test("a readiness load failure leaves the Tasks home as it is", { tag: "@all-viewports" }, async ({ page }) => {
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

  await expect.poll(() => page.evaluate(() =>
    document.querySelector("caffold-task-workspace")
      ?.codexStatusSnapshotValue?.phase ?? null,
  )).toBe("failed");
  await expect.poll(() => presentedTaskPaneChildren(page)).toEqual([
    "caffold-task-new",
  ]);
  await expect(
    page.locator("caffold-active-task-list .task-section-message"),
  ).toHaveText("No Caffold tasks yet.");
  const newTask = page.locator("caffold-task-navigator .task-list-new-task");
  await expect(newTask).toBeEnabled();
  await expect(newTask).toHaveAttribute("title", "New Task");
  // The shell keeps retrying the failed status check, and each pass may
  // reload the list — the list is no longer held while status is unknown.
  await expect.poll(() => taskRequests).toBeGreaterThan(0);
});

test("a failed Task-store migration has its own explicit retry lifecycle", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let retryRequests = 0;
  let retried = false;
  await page.route(/\/api\/task-store\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: retried ? mockTaskStoreStatus() : mockTaskStoreStatus({
        state: "failed",
        blocksTaskOperations: true,
        diagnosticMessage: "Staged v5 validation failed.",
      }),
    })
  );
  await page.route(/\/api\/task-store\/migration\/retry$/, (route) => {
    retryRequests += 1;
    retried = true;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });

  await page.goto("/");

  const setup = page.locator(
    '.task-store-recovery-card[data-task-store-state="failed"]',
  );
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "Task data upgrade failed" }),
  ).toBeVisible();
  await expect(setup).toContainText("Staged v5 validation failed.");
  await verifyReadinessScrollIsolation(page, {
    scrollport: "caffold-task-store-recovery:not([hidden]) > .task-store-recovery-surface",
    label: "Task setup",
  });
  await revealActionTarget(
    page,
    setup.getByRole("button", { name: "Retry Task setup" }),
  );
  await activateActionHint(page, /Retry Task setup$/);

  await expect.poll(() => retryRequests).toBe(1);
  await expect(page.locator("caffold-task-store-recovery")).toBeHidden();
  await expect(page.locator("caffold-task-new textarea")).toBeEnabled();
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

  const setTaskStore = (readiness) => page.evaluate((value) => {
    document.querySelector("caffold-task-workspace").setTaskStoreStatusSnapshot({
      readiness: value,
      retryAvailable: value.state === "failed",
    });
  }, readiness);
  const takeover = page.locator(
    '.task-store-recovery-card[data-task-store-state="failed"]',
  );
  await setTaskStore(mockTaskStoreStatus({
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "Staged v5 validation failed.",
  }));
  await expect(takeover).toBeVisible();
  await expect(composer).toBeHidden();

  await setTaskStore(mockTaskStoreStatus());

  await expect(takeover).toBeHidden();
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
  await installAgentCatalog(page);
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

test("Settings opens its usual first page while Codex is blocked", { tag: "@all-viewports" }, async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({ json: statusFor("signInRequired") }),
  );
  // A listed Task keeps the phone home on the list, where the tabs are.
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([cachedTask()]) }),
  );

  await page.goto("/");
  await codexStatusApplied(page, "signInRequired");
  await page.locator(
    'caffold-task-workspace-navigation button[data-workspace-mode="settings"]',
  ).click();

  await expect(page).toHaveURL("/settings");
  await expect(page.locator("caffold-settings-codex-page")).toBeHidden();
  const sections = page.locator("caffold-settings-navigator");
  const codex = sections.locator('button[data-settings-section="codex"]');
  await expect(codex).toBeVisible();
  await expect(codex).toHaveAccessibleName("Codex");
  await expectLooksLike(
    codex,
    sections.locator('button[data-settings-section="claude"]'),
  );
});

test("consumes the real backend readiness contract and gates Task creation", { tag: "@all-viewports" }, async ({ page }) => {
  await page.unroute(/\/api\/codex\/status(?:\?|$)/);

  await page.goto("/");

  await codexStatusApplied(page, "error");
  await expect.poll(() => presentedTaskPaneChildren(page)).toEqual([
    "caffold-task-new",
  ]);

  const statusResponse = await page.request.get("/api/codex/status");
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect(status.readiness).toMatchObject({
    state: "error",
    blocksTaskOperations: true,
    reasonCode: "appServerUnavailable",
    minimumSupportedVersion: "0.155.1",
  });

  const taskResponse = await page.request.post("/api/tasks", {
    data: { titleSource: "must remain blocked" },
  });
  expect(taskResponse.status()).toBe(503);
  await expect(taskResponse.json()).resolves.toMatchObject({
    error: { code: "codex_readiness_blocked" },
  });
});

// Codex changes nothing outside its own surfaces, so a test waits on the
// workspace having taken the status in rather than on anything it shows.
async function codexStatusApplied(page, state) {
  await expect.poll(() => page.evaluate(() =>
    document.querySelector("caffold-task-workspace")
      ?.codexStatusSnapshotValue?.status?.readiness?.state ?? null,
  )).toBe(state);
}

async function presentedTaskPaneChildren(page) {
  return page.locator("caffold-tasks-page .tasks-detail-pane").evaluate((pane) =>
    [...pane.children]
      .filter((child) => !child.hidden)
      .map((child) => child.localName),
  );
}

// Same color and no motion as a control Codex has nothing to do with.
async function expectLooksLike(control, peer) {
  const look = (element) => {
    const style = getComputedStyle(element);
    return { color: style.color, animationName: style.animationName };
  };
  const expected = await peer.evaluate(look);
  expect(expected.animationName).toBe("none");
  await expect.poll(() => control.evaluate(look)).toEqual(expected);
}

async function verifyReadinessScrollIsolation(page, { scrollport, label }) {
  const readinessScroll = page.locator(scrollport);
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
  const selector = page.locator("caffold-scroll-surface-selector > dialog:modal");
  const hud = page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await workspace.focus();
  await page.keyboard.press("s");
  await expect.poll(async () =>
    await selector.isVisible() || await hud.isVisible()
  ).toBe(true);
  if (await selector.isVisible()) {
    const readiness = selector.getByLabel(new RegExp(`^[A-Z]+ — ${label}$`));
    await expect(readiness).toBeVisible();
    await readiness.click();
  }
  await expect(hud).toContainText(`Scroll: ${label}`);
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
