import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockCodexStatus,
} from "../support/browser-defaults.js";
import {
  actionHintDialog,
  activateActionHint,
} from "../support/action-hints.js";
import { taskDetailFixture } from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("selects a Section and opens fixed-directory Task creation", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const task = {
    id: "thread_section_entry",
    threadId: "thread_section_entry",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section entry Task",
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section entry summary",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto("/");
  const section = page.locator(
    'caffold-active-task-list .task-repository-select[data-section-id="fixture-section-1"]',
  );
  const sectionHeader = page.locator(
    'caffold-active-task-list caffold-active-task-section[data-section-id="fixture-section-1"] > .task-repository-header',
  );
  const sectionCount = sectionHeader.locator(".task-repository-count");
  await expect(section).toBeVisible();
  await expect(section).toHaveJSProperty("tagName", "BUTTON");
  await expect.poll(() => sectionCount.evaluate((count) => {
    const bounds = count.getBoundingClientRect();
    return document
      .elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      )
      ?.closest(".task-repository-select")?.tagName ?? "";
  })).toBe("BUTTON");
  await activateActionHint(
    page,
    /Open section: home$/,
  );

  await expect(page).toHaveURL("/?section=fixture-section-1");
  await expect(section).toHaveAttribute("aria-current", "page");
  const selectionPresentation = await section.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.background = "var(--selection-bg)";
    document.body.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(element.parentElement);
    return {
      actualBackground: style.backgroundColor,
      borderLeftWidth: style.borderLeftWidth,
      expectedBackground,
    };
  });
  expect(selectionPresentation.actualBackground).toBe(
    selectionPresentation.expectedBackground,
  );
  expect(selectionPresentation.borderLeftWidth).toBe("0px");
  const detail = page.locator("caffold-detail-layout");
  await expect(detail.locator("caffold-section-detail-summary h2")).toHaveText(
    "frontend/tests/e2e/fixtures/home",
  );
  await expect(detail.locator("caffold-section-detail textarea[name=prompt]")).toBeVisible();
  await expect(detail.locator("caffold-section-detail")).toContainText(
    "frontend/tests/e2e/fixtures/home",
  );
  await expect(
    detail.locator('caffold-section-detail [data-composer-action="browse-cwd"]'),
  ).toHaveCount(0);
  await expect(
    detail.locator("caffold-section-github-shortcuts"),
  ).toBeHidden();
  await expect(
    detail.locator("caffold-segmented-control[data-detail-view-switch]"),
  ).toBeHidden();
});

test("offers GitHub work shortcuts from repository Task creation", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const repository = { rootPath, branch: "main", dirty: false };
  const github = {
    owner: "panarch",
    name: "caffold",
    nameWithOwner: "panarch/caffold",
    url: "https://github.com/panarch/caffold",
  };
  const task = {
    id: "thread_section_github_shortcuts",
    threadId: "thread_section_github_shortcuts",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section GitHub shortcuts",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath: `${rootPath}/.caffold-worktrees/github-shortcuts`,
      repositoryRootPath: rootPath,
      branch: "feature/github-shortcuts",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section GitHub shortcuts",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(rootPath);
    return route.fulfill({
      json: {
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        issues: [],
        page: 1,
        perPage: 50,
        totalIssues: 0,
        totalPages: 0,
        hasPrevious: false,
        hasNext: false,
      },
    })
  );

  await page.goto("/?section=fixture-section-1");
  const detail = page.locator("caffold-detail-layout");
  const conversationShortcuts = detail.locator(
    "caffold-section-conversation-shortcuts",
  );
  const shortcuts = detail.locator("caffold-section-github-shortcuts");
  await expect(conversationShortcuts).toBeVisible();
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "panarch/caffold",
  );
  await expect(shortcuts.getByRole("button")).toHaveText([
    "Issues",
    "Pull Requests",
  ]);

  const composerPanel = detail.locator(
    "caffold-section-detail .task-composer-panel",
  );
  const expectedGap = await page.evaluate(() =>
    window.innerWidth <= 959 ? 10 : 14
  );
  const measureAlignment = async () => {
    const [composerBox, conversationBox, shortcutBox] = await Promise.all([
      composerPanel.boundingBox(),
      conversationShortcuts.boundingBox(),
      shortcuts.boundingBox(),
    ]);
    if (!composerBox || !conversationBox || !shortcutBox) {
      return null;
    }
    return {
      conversationLeft: Math.abs(conversationBox.x - composerBox.x),
      conversationRight: Math.abs(
        conversationBox.x + conversationBox.width - composerBox.x - composerBox.width,
      ),
      shortcutLeft: Math.abs(shortcutBox.x - conversationBox.x),
      shortcutRight: Math.abs(
        shortcutBox.x + shortcutBox.width - conversationBox.x - conversationBox.width,
      ),
      composerGap: conversationBox.y - composerBox.y - composerBox.height,
      shortcutGap: shortcutBox.y - conversationBox.y - conversationBox.height,
    };
  };
  await expect.poll(async () => {
    const alignment = await measureAlignment();
    return alignment
      ? Math.max(
        alignment.conversationLeft,
        alignment.conversationRight,
        alignment.shortcutLeft,
        alignment.shortcutRight,
      )
      : Infinity;
  }).toBeLessThanOrEqual(0.5);
  await expect.poll(async () => {
    const alignment = await measureAlignment();
    return alignment ? Math.abs(alignment.composerGap - expectedGap) : Infinity;
  }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const alignment = await measureAlignment();
    return alignment ? Math.abs(alignment.shortcutGap - expectedGap) : Infinity;
  }).toBeLessThanOrEqual(1);

  const [issuesBox, pullsBox] = await Promise.all([
    shortcuts.getByRole("button", { name: "Issues" }).boundingBox(),
    shortcuts.getByRole("button", { name: "Pull Requests" }).boundingBox(),
  ]);
  expect(issuesBox).not.toBeNull();
  expect(pullsBox).not.toBeNull();
  if (!issuesBox || !pullsBox) {
    throw new Error("GitHub shortcut rows did not render");
  }
  expect(pullsBox.y).toBeGreaterThanOrEqual(issuesBox.y + issuesBox.height);

  await activateActionHint(page, /Open GitHub Issues$/);
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=github&tool=issues",
  );
  await expect(detail.locator("caffold-github-issues-list-page")).toBeVisible();
});

test("previews a Codex thread ID and forks it into the selected Section", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const sourceThreadId = "external-codex-source";
  const childThreadId = "external-codex-child";
  const sourceTask = {
    id: "section-fork-anchor",
    threadId: "section-fork-anchor",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section fork anchor",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    lastEventSummary: "Section fork anchor",
  };
  const childTask = {
    ...sourceTask,
    id: childThreadId,
    threadId: childThreadId,
    title: "Fork of Long-running Codex work",
    preview: "Continue the established implementation direction.",
    createdMs: 30,
    updatedMs: 30,
    lastEventSummary: "Inherited answer",
  };
  const childDetail = {
    ...taskDetailFixture(),
    threadId: childThreadId,
    task: childTask,
    events: [],
    activeTopPlacement: {
      section: {
        id: "fixture-section-1",
        name: rootPath,
        repository: false,
      },
      beforeSectionId: null,
      beforeThreadId: sourceTask.threadId,
    },
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([sourceTask]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  let previewRequests = 0;
  await page.route(/\/api\/task-forks\/preview$/, async (route) => {
    previewRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      provider: "codex",
      sourceId: sourceThreadId,
    });
    await route.fulfill({
      json: {
        provider: "codex",
        sourceId: sourceThreadId,
        displayName: "Long-running Codex work",
        summary: "Continue the established implementation direction.",
        status: { type: "notLoaded" },
        cwd: "/Users/example/Workspace/other-project",
        lastActivityMs: Date.UTC(2026, 7, 28, 3, 20),
        recentHistory: [
          { role: "user", text: "Keep the conversation context.\nDo not copy files." },
          { role: "assistant", text: "I will preserve the conversation only." },
        ],
      },
    });
  });
  let observeFork;
  const forkObserved = new Promise((resolve) => {
    observeFork = resolve;
  });
  let releaseFork;
  const forkGate = new Promise((resolve) => {
    releaseFork = resolve;
  });
  let forkRequests = 0;
  await page.route(/\/api\/task-forks$/, async (route) => {
    forkRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      provider: "codex",
      sourceId: sourceThreadId,
      sectionId: "fixture-section-1",
    });
    observeFork();
    await forkGate;
    await route.fulfill({ json: childDetail });
  });

  await page.goto("/?section=fixture-section-1");
  const shortcuts = page.locator("caffold-section-conversation-shortcuts");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole("heading")).toHaveText("Existing conversations");
  await expect(shortcuts).toContainText(
    "Create a Task here with an existing conversation's history.",
  );
  const openButton = shortcuts.getByRole("button", {
    name: "Fork from Codex thread ID",
  });
  await expect(openButton).toBeEnabled();
  await openButton.click();

  const dialog = page.getByRole("dialog", { name: "Fork a Codex thread" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".conversation-fork-target dd")).toHaveText(rootPath);
  let threadIdInput = dialog.locator("#conversation-fork-thread-id");
  await expect(threadIdInput).toBeFocused();
  await page.keyboard.press("f");
  await expect(threadIdInput).toHaveValue("f");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(threadIdInput).toHaveValue("f");
  await expect(dialog.getByRole("button", {
    name: "Cancel",
    exact: true,
  })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openButton).toBeFocused();

  await openButton.click();
  await expect(dialog).toBeVisible();
  threadIdInput = dialog.locator("#conversation-fork-thread-id");
  await expect(threadIdInput).toBeFocused();
  await threadIdInput.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "ㅎ",
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      isComposing: true,
      key: "Escape",
    }));
  });
  await expect(threadIdInput).toBeFocused();
  await expect(dialog).toBeVisible();
  await threadIdInput.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "ㅎ",
    }));
  });
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", {
    name: "Cancel",
    exact: true,
  })).toBeFocused();
  await page.keyboard.press("f");
  const initialHint = actionHintDialog(page);
  await expect(initialHint).toBeVisible();
  await expect(
    initialHint.getByRole("button", { name: / — Focus Thread ID$/ }),
  ).toBeVisible();
  await expect(
    initialHint.getByRole("button", { name: / — Cancel$/ }),
  ).toBeVisible();
  await expect(
    initialHint.getByRole("button", { name: / — Preview thread$/ }),
  ).toHaveCount(0);
  const inputCode = await initialHint.getByRole("button", {
    name: / — Focus Thread ID$/,
  }).getAttribute("data-action-hint-code");
  expect(inputCode).toBeTruthy();
  await page.keyboard.type(inputCode.toLowerCase());
  await expect(initialHint).toBeHidden();
  await expect(threadIdInput).toBeFocused();
  await threadIdInput.fill(`codex://threads/${sourceThreadId}`);
  expect(previewRequests).toBe(0);
  await expect(dialog.getByRole("button", {
    name: "Fork task",
    exact: true,
  })).toBeDisabled();
  await threadIdInput.press("Enter");

  await expect(dialog.locator("[data-fork-preview='name']")).toHaveText(
    "Long-running Codex work",
  );
  await expect(dialog.locator("[data-fork-preview='status']")).toHaveText(
    "Live status unavailable",
  );
  await expect(dialog.locator(".conversation-fork-unavailable-reason")).toBeHidden();
  await expect(dialog.locator("[data-fork-preview='cwd']")).toHaveText(
    "/Users/example/Workspace/other-project",
  );
  await expect(dialog.locator(".conversation-fork-summary")).toContainText(
    "Continue the established implementation direction.",
  );
  await expect(dialog.locator(".conversation-fork-history-list article")).toHaveCount(2);
  await expect(dialog.locator(".conversation-fork-history-list")).toContainText(
    "Keep the conversation context.\nDo not copy files.",
  );
  expect(previewRequests).toBe(1);

  const forkButton = dialog.locator("[data-fork-dialog-action='fork']");
  await expect(forkButton).toBeEnabled();
  const forkBody = dialog.locator(".conversation-fork-body");
  await forkBody.evaluate((element) => {
    element.style.height = "120px";
    element.style.maxHeight = "120px";
  });
  await expect.poll(() => forkBody.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await forkButton.focus();
  await page.keyboard.press("s");
  const forkHud = dialog.locator(
    "caffold-keyboard-navigation-presentation caffold-scroll-mode-hud",
  );
  await expect(forkHud).toContainText("Scroll: Fork preview");
  await page.keyboard.press("j");
  await expect.poll(() => forkBody.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(forkHud).toBeHidden();
  await expect(dialog).toBeVisible();
  await forkBody.evaluate((element) => {
    if (element.scrollTop === 0) {
      return;
    }
    return new Promise((resolve) => {
      element.addEventListener("scroll", () => resolve(), { once: true });
      element.scrollTop = 0;
    });
  });

  await page.keyboard.press("f");
  const topHint = actionHintDialog(page);
  await expect(topHint).toBeVisible();
  for (const name of [
    / — Focus Thread ID$/,
    / — Cancel$/,
    / — Fork task$/,
  ]) {
    await expect(topHint.getByRole("button", { name })).toBeVisible();
  }
  await expect(topHint.getByRole("button", {
    name: / — Preview thread$/,
  })).toHaveCount(testInfo.project.name === "phone" ? 0 : 1);
  await page.keyboard.press("Escape");

  const previewButton = dialog.getByRole("button", {
    name: "Preview thread",
    exact: true,
  });
  await previewButton.evaluate((button) => {
    const scrollport = button.closest(".conversation-fork-body");
    if (!scrollport) {
      throw new Error("Fork preview button lost its owning scrollport");
    }
    const before = scrollport.scrollTop;
    let settle;
    let onScroll;
    const settled = new Promise((resolve) => {
      settle = resolve;
      onScroll = () => resolve();
      scrollport.addEventListener("scroll", onScroll, { once: true });
    });
    button.scrollIntoView({ block: "nearest" });
    if (scrollport.scrollTop === before) {
      scrollport.removeEventListener("scroll", onScroll);
      settle();
    }
    return settled;
  });
  await page.keyboard.press("f");
  const readyHint = actionHintDialog(page);
  await expect(readyHint).toBeVisible();
  for (const name of [
    / — Preview thread$/,
    / — Cancel$/,
    / — Fork task$/,
  ]) {
    await expect(readyHint.getByRole("button", { name })).toBeVisible();
  }
  await captureReviewScreenshot(
    page,
    testInfo,
    "conversation-fork-dialog-action-hints",
  );
  const forkCode = await readyHint.getByRole("button", {
    name: / — Fork task$/,
  }).getAttribute("data-action-hint-code");
  expect(forkCode).toBeTruthy();
  await page.keyboard.type(forkCode.toLowerCase());
  await expect(readyHint).toBeHidden();
  await forkObserved;
  await expect(forkButton).toHaveText("Forking…");
  await expect(forkButton).toBeDisabled();
  await expect(dialog.getByRole("button", {
    name: "Cancel",
    exact: true,
  })).toBeDisabled();
  await expect(threadIdInput).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releaseFork();

  await expect(page).toHaveURL(new RegExp(`/tasks/${childThreadId}$`));
  await expect(page.locator("caffold-task-detail-summary h2")).toHaveText(
    "Fork of Long-running Codex work",
  );
  await expect(page.locator("caffold-task-navigator .task-row-title")).toHaveText([
    "Fork of Long-running Codex work",
    "Section fork anchor",
  ]);
  expect(forkRequests).toBe(1);
});

test("keeps non-idle and unknown previews read-only and cancels an in-flight preview", { tag: "@desktop" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const task = {
    id: "section-active-preview",
    threadId: "section-active-preview",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section active preview",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    lastEventSummary: "Section active preview",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  let observeSlowPreview;
  const slowPreviewObserved = new Promise((resolve) => {
    observeSlowPreview = resolve;
  });
  let releaseSlowPreview;
  const slowPreviewGate = new Promise((resolve) => {
    releaseSlowPreview = resolve;
  });
  let finishSlowPreview;
  const slowPreviewFinished = new Promise((resolve) => {
    finishSlowPreview = resolve;
  });
  let previewRequests = 0;
  await page.route(/\/api\/task-forks\/preview$/, async (route) => {
    previewRequests += 1;
    const { sourceId } = route.request().postDataJSON();
    if (sourceId === "missing-thread") {
      return route.fulfill({
        status: 404,
        json: {
          error: {
            code: "task_fork_source_unresolved",
            message: "Codex could not resolve that Thread ID",
          },
        },
      });
    }
    if (sourceId === "slow-thread") {
      observeSlowPreview();
      await slowPreviewGate;
      try {
        return await route.fulfill({
          json: {
            provider: "codex",
            sourceId,
            displayName: "Slow external work",
            summary: null,
            status: { type: "idle" },
            cwd: "/workspace/slow",
            lastActivityMs: null,
            recentHistory: [],
          },
        });
      } finally {
        finishSlowPreview();
      }
    }
    return route.fulfill({
      json: {
        provider: "codex",
        sourceId,
        displayName: sourceId === "unknown-thread"
          ? "Unknown external work"
          : "Active external work",
        summary: null,
        status: sourceId === "unknown-thread"
          ? { type: "unknown" }
          : { type: "active", activeFlags: [] },
        cwd: "/workspace/active",
        lastActivityMs: null,
        recentHistory: [],
      },
    });
  });

  await page.goto("/?section=fixture-section-1");
  const openButton = page.getByRole("button", {
    name: "Fork from Codex thread ID",
  });
  await openButton.click();
  const dialog = page.getByRole("dialog", { name: "Fork a Codex thread" });
  const input = dialog.getByLabel("Thread ID");
  await input.fill("active-external-thread");
  expect(previewRequests).toBe(0);
  await dialog.getByRole("button", { name: "Preview thread" }).click();
  await expect(dialog.locator("[data-fork-preview='status']")).toHaveText("Active");
  await expect(dialog).toContainText(
    "Forking is unavailable while the Codex thread is active.",
  );
  await expect(dialog.getByRole("button", { name: "Fork task" })).toBeDisabled();

  await input.fill("missing-thread");
  await expect(dialog.locator(".conversation-fork-preview")).toBeHidden();
  await dialog.getByRole("button", { name: "Preview thread" }).click();
  await expect(dialog).toContainText("Codex could not resolve that Thread ID");
  await expect(dialog).toBeVisible();
  await input.fill("another-thread");
  await expect(dialog).not.toContainText("Codex could not resolve that Thread ID");

  await input.fill("unknown-thread");
  await dialog.getByRole("button", { name: "Preview thread" }).click();
  await expect(dialog.locator("[data-fork-preview='status']")).toHaveText("Unknown");
  await expect(dialog).toContainText(
    "Codex reported a thread status that Caffold cannot fork.",
  );
  await expect(dialog.getByRole("button", { name: "Fork task" })).toBeDisabled();

  await input.fill("slow-thread");
  await dialog.getByRole("button", { name: "Preview thread" }).click();
  await slowPreviewObserved;
  await expect(dialog).toContainText("Loading the Codex thread…");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(openButton).toBeFocused();
  expect(previewRequests).toBe(4);
  releaseSlowPreview();
  await slowPreviewFinished;
});

test("reveals the Codex row only after capability is known and explains disabled state", { tag: "@desktop" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const task = {
    id: "section-blocked-fork",
    threadId: "section-blocked-fork",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section blocked fork",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    lastEventSummary: "Section blocked fork",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.unroute(/\/api\/codex\/status(?:\?|$)/);
  let releaseStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const blockedStatus = mockCodexStatus({
    readiness: {
      ...mockCodexStatus().readiness,
      state: "error",
      blocksTaskOperations: true,
      reasonCode: "runtimeUnavailable",
      diagnosticMessage: "Codex is reconnecting. Try again shortly.",
    },
  });
  await page.route(/\/api\/codex\/status(?:\?|$)/, async (route) => {
    await statusGate;
    await route.fulfill({ json: blockedStatus });
  });

  await page.goto("/?section=fixture-section-1");
  const shortcuts = page.locator("caffold-section-conversation-shortcuts");
  await expect(shortcuts).toBeHidden();
  releaseStatus();
  await expect(shortcuts).toBeVisible();
  const button = shortcuts.getByRole("button", {
    name: /Fork from Codex thread ID/,
  });
  await expect(button).toBeDisabled();
  await expect(shortcuts).toContainText("Codex is reconnecting. Try again shortly.");
  await expect(button).toHaveCSS("cursor", "not-allowed");
  await expect(shortcuts.getByText(/Claude/)).toHaveCount(0);
});

test("returns a missing Section route to Tasks home", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: { sections: [], unsectioned: [] } })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto("/?section=missing-section");
  await expect(page).toHaveURL("/");
});

test("keeps a repository Section draft while switching shared surfaces", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const markdownPath = `${rootPath}/README.md`;
  const markdownContent = "# Fixture Home\n\nSection Markdown Preview.\n";
  const task = {
    id: "thread_repository_section",
    threadId: "thread_repository_section",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Repository Section Task",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath: "frontend/tests/e2e/fixtures/home/.caffold-worktrees/repository-section",
      repositoryRootPath: rootPath,
      branch: "feature/section-detail",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Repository Section summary",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const requestedPath = new URL(route.request().url()).searchParams.get("path");
    if (requestedPath !== rootPath) {
      return route.continue();
    }
    return route.fulfill({
      json: {
        root: rootPath,
        path: rootPath,
        git: { rootPath, branch: "main", dirty: false },
        entries: [{
          name: "README.md",
          path: markdownPath,
          kind: "file",
          isSymlink: false,
          supported: true,
          gitIgnored: false,
          size: markdownContent.length,
          modifiedMs: null,
          git: null,
        }],
      },
    });
  });
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    const requestedPath = new URL(route.request().url()).searchParams.get("path");
    if (requestedPath !== markdownPath) {
      return route.continue();
    }
    return route.fulfill({
      json: {
        path: markdownPath,
        name: "README.md",
        size: markdownContent.length,
        modifiedMs: null,
        languageHint: "markdown",
        content: markdownContent,
      },
    });
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    const requestedPath = new URL(route.request().url()).searchParams.get("path");
    if (requestedPath !== rootPath) {
      return route.continue();
    }
    return route.fulfill({
      json: {
        repository: { rootPath, branch: "main", dirty: false },
        files: [],
        additions: 0,
        deletions: 0,
      },
    });
  });

  await page.goto("/");
  await page.locator(
    'caffold-active-task-list .task-repository-select[data-section-id="fixture-section-1"]',
  ).click();

  const detail = page.locator("caffold-detail-layout");
  const switcher = detail.locator(
    "caffold-segmented-control[data-detail-view-switch]",
  );
  await expect(switcher).toBeVisible();
  await expect(switcher.locator("button")).toHaveText([
    "New Task",
    "Working Tree",
    "Branch",
  ]);
  await expect(detail.locator("caffold-task-detail-git")).toBeVisible();
  await expect(detail.locator("caffold-task-detail-github")).toBeVisible();
  if (await page.evaluate(() => window.innerWidth > 520)) {
    const rightAlignment = await detail.evaluate((element) => {
      const header = element.querySelector(".detail-layout-summary");
      const visibleActionButtons = [
        ...element.querySelectorAll(".detail-layout-actions button"),
      ].filter((button) => button.getBoundingClientRect().width > 0);
      const rightmostButton = visibleActionButtons.reduce((rightmost, button) =>
        button.getBoundingClientRect().right > rightmost.getBoundingClientRect().right
          ? button
          : rightmost
      );
      const headerBox = header.getBoundingClientRect();
      const buttonBox = rightmostButton.getBoundingClientRect();
      return {
        headerPaddingRight: Number.parseFloat(
          getComputedStyle(header).paddingRight,
        ),
        rightInset: headerBox.right - buttonBox.right,
      };
    });
    expect(
      Math.abs(rightAlignment.rightInset - rightAlignment.headerPaddingRight),
    ).toBeLessThanOrEqual(0.5);
  }

  const prompt = detail.locator("caffold-section-detail textarea[name=prompt]");
  await prompt.evaluate((textarea) => {
    textarea.value = "Preserve this Section draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await activateActionHint(page, /Open Working Tree$/);
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=review",
  );
  await expect(detail.locator(".detail-review-slot")).toBeVisible();

  const review = detail.locator("caffold-task-review");
  await review.getByRole("button", { name: "Files", exact: true }).click();
  await review
    .locator(`caffold-file-navigator button[data-file-tree-path="${markdownPath}"]`)
    .click();
  await review.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=review&nav=files&view=preview&file=README.md",
  );
  await expect(review.locator(".markdown-preview-body h1")).toHaveText("Fixture Home");

  await switcher.locator('button[data-segmented-value="new"]').click();
  await expect(page).toHaveURL("/?section=fixture-section-1");
  await expect(prompt).toHaveValue("Preserve this Section draft");

  await switcher.locator('button[data-segmented-value="working"]').click();
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=review&nav=files&view=preview&file=README.md",
  );
  await expect(review.locator(".markdown-preview-body h1")).toHaveText("Fixture Home");
});

test("replaces the New Task context when a selected Section path changes", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const sectionId = "section-path-rebind";
  const task = {
    id: "thread_section_path_rebind",
    threadId: "thread_section_path_rebind",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section path rebind",
    cwd: "frontend/tests/e2e/fixtures/home",
    cwdPath: "frontend/tests/e2e/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section path rebind",
  };
  let projection = {
    sections: [{
      id: sectionId,
      name: "frontend/tests/e2e/fixtures/home",
      repository: true,
      tasks: [task],
    }],
    unsectioned: [],
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: projection })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  let staleStatusRoute = null;
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "frontend/tests/e2e/fixtures/home") {
      staleStatusRoute = route;
      return;
    }
    expect(path).toBe("frontend/tests/e2e/fixtures/other");
    return route.fulfill({
      json: {
        repository: { rootPath: path, branch: "main", dirty: false },
        github: {
          owner: "fixture",
          name: "other",
          nameWithOwner: "fixture/other",
          url: "https://github.com/fixture/other",
        },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });

  await page.goto(`/?section=${sectionId}`);
  const sectionDetail = page.locator("caffold-section-detail");
  const shortcuts = sectionDetail.locator(
    "caffold-section-github-shortcuts",
  );
  const prompt = sectionDetail.locator("textarea[name=prompt]");
  await expect(sectionDetail).toContainText("frontend/tests/e2e/fixtures/home");
  await expect.poll(() => Boolean(staleStatusRoute)).toBe(true);
  await expect(shortcuts).toBeHidden();
  await prompt.fill("Discard this stale Section draft");

  projection = {
    sections: [{
      id: sectionId,
      name: "frontend/tests/e2e/fixtures/other",
      repository: true,
      tasks: [task],
    }],
    unsectioned: [],
  };
  await page.locator("caffold-active-task-list").evaluate((list) => {
    void list.loadTasks({ force: true });
  });

  await expect(page).toHaveURL(`/?section=${sectionId}`);
  await expect(sectionDetail).toContainText("frontend/tests/e2e/fixtures/other");
  await expect(sectionDetail.locator("textarea[name=prompt]")).toHaveValue("");
  await expect.poll(() =>
    sectionDetail.locator("caffold-task-create").evaluate((taskCreate) => taskCreate.cwd)
  ).toBe("frontend/tests/e2e/fixtures/other");
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "fixture/other",
  );

  await staleStatusRoute.fulfill({
    json: {
      repository: {
        rootPath: "frontend/tests/e2e/fixtures/home",
        branch: "main",
        dirty: false,
      },
      github: {
        owner: "fixture",
        name: "home",
        nameWithOwner: "fixture/home",
        url: "https://github.com/fixture/home",
      },
      ghAvailable: true,
      authenticated: true,
      issuesAvailable: true,
      pullsAvailable: true,
      message: null,
    },
  });
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "fixture/other",
  );
});

test("uses the Section's last composer settings for its next Task request", { tag: "@desktop" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const sectionId = "section-composer-seed";
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const task = {
    id: "thread_section_composer_seed",
    threadId: "thread_section_composer_seed",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section composer seed",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section composer seed",
  };
  const projection = {
    sections: [{
      id: sectionId,
      name: rootPath,
      repository: false,
      composerSettings: {
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
      tasks: [task],
    }],
    unsectioned: [],
  };
  let createdBody = null;
  let promptBody = null;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      createdBody = route.request().postDataJSON();
      return route.fulfill({
        json: taskDetailFixture({
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          fastMode: true,
        }),
      });
    }
    return route.fulfill({ json: projection });
  });
  await page.route("**/api/tasks/*/prompts", (route) => {
    promptBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: "thread-1",
        turnId: "turn-section-composer-seed",
        userMessageId: "message-section-composer-seed",
        steered: false,
      },
    });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto(`/?section=${sectionId}`);
  const form = page.locator('caffold-section-detail .task-new-form[data-task-form="create"]');
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  await form.getByRole("textbox", { name: "New task prompt" }).fill("Use the Section settings");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");

  await expect.poll(() => createdBody).not.toBeNull();
  expect(createdBody).toMatchObject({
    cwd: rootPath,
    titleSource: "Use the Section settings",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
  });
  await expect.poll(() => promptBody).not.toBeNull();
  expect(promptBody).toMatchObject({
    prompt: "Use the Section settings",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
    activeTurnId: null,
  });
});

test("keeps the first prompt when the created Task opens before creation answers", { tag: "@desktop" }, async ({
  page,
}) => {
  await installEventSourceMock(page, {
    registryKey: "__sectionCreateHandoffSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
  const sectionId = "section-create-handoff";
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const createdThreadId = "thread_section_create_handoff";
  const seedTask = {
    id: "thread_section_create_handoff_seed",
    threadId: "thread_section_create_handoff_seed",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section create handoff seed",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now() - 1,
    updatedMs: Date.now() - 1,
    lastEventSummary: "Section create handoff seed",
  };
  const createdTask = {
    id: createdThreadId,
    threadId: createdThreadId,
    ...canonicalTaskState("idle"),
    title: "Keep this first prompt",
    preview: "Keep this first prompt",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    recencyMs: Date.now(),
    lastEventSummary: null,
    unseen: false,
  };
  const placement = {
    section: {
      id: sectionId,
      name: rootPath,
      repository: false,
    },
  };
  const createdDetail = {
    ...taskDetailFixture({
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    }),
    threadId: createdThreadId,
    task: createdTask,
    activeTopPlacement: placement,
  };
  const projection = {
    sections: [{
      id: sectionId,
      name: rootPath,
      repository: false,
      tasks: [seedTask],
    }],
    unsectioned: [],
  };
  let resolveCreateRequested;
  let releaseCreateResponse;
  const createRequested = new Promise((resolve) => {
    resolveCreateRequested = resolve;
  });
  const createResponseReleased = new Promise((resolve) => {
    releaseCreateResponse = resolve;
  });
  let promptRequests = 0;
  let promptBody = null;

  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ json: projection });
    }
    expect(route.request().postDataJSON()).toMatchObject({
      cwd: rootPath,
      titleSource: "Keep this first prompt",
    });
    resolveCreateRequested();
    await createResponseReleased;
    return route.fulfill({ json: createdDetail });
  });
  await page.route(
    new RegExp(`/api/tasks/${createdThreadId}(?:\\?|$)`),
    (route) => route.fulfill({ json: createdDetail }),
  );
  await page.route("**/api/tasks/*/prompts", (route) => {
    promptRequests += 1;
    promptBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        threadId: createdThreadId,
        turnId: "turn-section-create-handoff",
        userMessageId: "message-section-create-handoff",
        steered: false,
      },
    });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto(`/?section=${sectionId}`);
  await expect.poll(() => page.evaluate(() =>
    window.__sectionCreateHandoffSources.some((source) =>
      source.url.startsWith("/api/tasks/stream")
    )
  )).toBe(true);
  const sectionPrompt = page.locator(
    'caffold-section-detail textarea[name="prompt"]',
  );
  await sectionPrompt.fill("Keep this first prompt");
  await sectionPrompt.press("Enter");
  await createRequested;

  await page.evaluate(({ task, placement }) => {
    const source = window.__sectionCreateHandoffSources.find((candidate) =>
      candidate.url.startsWith("/api/tasks/stream")
    );
    source.emit("task-placed-at-top", { task, placement });
  }, { task: createdTask, placement });
  const createdTaskRow = page.locator(
    `caffold-active-task-row .task-row[data-thread-id="${createdThreadId}"]`,
  );
  await expect(createdTaskRow).toBeVisible();
  await createdTaskRow.click();
  await expect(page).toHaveURL(`/tasks/${createdThreadId}`);
  await expect(page.locator("caffold-section-detail caffold-task-create")).toHaveCount(0);

  releaseCreateResponse();

  await expect.poll(() => promptRequests).toBe(1);
  expect(promptBody).toMatchObject({
    prompt: "Keep this first prompt",
    activeTurnId: null,
  });
});

test("falls back stale Section settings and applies targeted updates without reloading", { tag: "@desktop" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { registryKey: "__sectionComposerSources" });
  await mockAgentModels(page);
  const sectionId = "section-composer-update";
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const task = {
    id: "thread_section_composer_update",
    threadId: "thread_section_composer_update",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section composer update",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section composer update",
  };
  let taskListReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskListReads += 1;
    return route.fulfill({
      json: {
        sections: [{
          id: sectionId,
          name: rootPath,
          repository: false,
          composerSettings: {
            model: "retired-model",
            effort: "retired-effort",
            fastMode: false,
          },
          tasks: [task],
        }],
        unsectioned: [],
      },
    });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto(`/?section=${sectionId}`);
  const form = page.locator('caffold-section-detail .task-new-form[data-task-form="create"]');
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("low");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect.poll(() => page.evaluate(() =>
    window.__sectionComposerSources.some((source) =>
      source.url.startsWith("/api/tasks/stream")
    )
  )).toBe(true);

  await page.evaluate((id) => {
    const source = window.__sectionComposerSources.find((candidate) =>
      candidate.url.startsWith("/api/tasks/stream")
    );
    source.emit("section-composer-settings", {
      sectionId: id,
      composerSettings: {
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
    });
  }, sectionId);

  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  expect(taskListReads).toBe(1);
});

test("clears shared repository context when the selected Section loses capability", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { registryKey: "__sectionDetailWatchSources" });
  await mockAgentModels(page);
  const sectionId = "section-context-rebind";
  const rootPath = "frontend/tests/e2e/fixtures/home";
  const repository = { rootPath, branch: "main", dirty: false };
  const task = {
    id: "thread_section_context_rebind",
    threadId: "thread_section_context_rebind",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section context rebind",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath,
      repositoryRootPath: rootPath,
      branch: "main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section context rebind",
  };
  let projection = {
    sections: [{ id: sectionId, name: rootPath, repository: true, tasks: [task] }],
    unsectioned: [],
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: projection })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      },
    })
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        baseRef: "origin/main",
        headRef: "main",
        additions: 0,
        deletions: 0,
        files: [],
      },
    })
  );

  await page.goto(
    `/?section=${sectionId}&surface=git&tool=compare&base=origin%2Fmain&head=main`,
  );
  const git = page.locator("caffold-task-git-layout");
  await expect(git).toBeVisible();
  await expect.poll(() =>
    git.evaluate((layout) => ({
      active: layout.active,
      rootPath: layout.repository?.rootPath ?? null,
    }))
  ).toEqual({ active: true, rootPath });

  projection = {
    sections: [{
      id: sectionId,
      name: rootPath,
      repository: false,
      tasks: [{ ...task, worktree: null }],
    }],
    unsectioned: [],
  };
  await page.locator("caffold-active-task-list").evaluate((list) => {
    void list.loadTasks({ force: true });
  });

  await expect(page).toHaveURL(`/?section=${sectionId}`);
  await expect(page.locator("caffold-section-detail")).toBeVisible();
  await expect(git).toBeHidden();
  await expect.poll(() =>
    git.evaluate((layout) => ({
      active: layout.active,
      rootPath: layout.repository?.rootPath ?? null,
      watchScopePath: layout.watchScopePath ?? null,
    }))
  ).toEqual({ active: false, rootPath: null, watchScopePath: null });
});
