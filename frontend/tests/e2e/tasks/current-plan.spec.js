import { expect, test } from "@playwright/test";
import {
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  openTaskWithBootstrap,
} from "../support/task-fixtures.js";

const fixtureHome = fileURLToPath(new URL("../fixtures/home/", import.meta.url));

test.afterEach(async ({}, testInfo) => {
  rmSync(workspacePath(testInfo), { recursive: true, force: true });
});

test("floats ignored current documents above the stable composer and updates the open checklist", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const workspace = prepareWorkspace(testInfo);
  await installTaskApiFixture(page);
  const detail = detailFor("thread-1", workspace.logicalPath);
  await installTaskDetails(page, [detail]);

  await page.goto(`/tasks/thread-1?cwd=${encodeURIComponent(workspace.logicalPath)}`);
  const absentResponse = currentPlanResponse(page, workspace.logicalPath);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  expect((await (await absentResponse).json()).status).toBe("absent");

  const currentPlan = page.locator("caffold-task-current-plan");
  const strip = currentPlan.locator(".task-current-plan-strip");
  await expect(strip).toBeHidden();
  await expect
    .poll(() =>
      currentPlan.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(0);

  const composer = page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden])',
  );
  const prompt = composer.getByRole("textbox", { name: "Follow-up prompt" });
  await expect(prompt).toBeVisible();
  await prompt.fill("Keep this draft while plan files change.");
  await prompt.focus();
  await composer.evaluate((element) => {
    element.stableCurrentPlanProbe = true;
  });
  const layoutWithoutPlan = await composer.evaluate((element) => {
    const composer = element.getBoundingClientRect();
    const scroller = document.querySelector(
      "caffold-task-detail:not([hidden]) .task-conversation-scroll",
    );
    return {
      composerTop: composer.top,
      composerBottom: composer.bottom,
      conversationPaddingBottom: Number.parseFloat(
        getComputedStyle(scroller).paddingBottom,
      ),
    };
  });

  const planTitle =
    "Coordinate current plan documents without exposing native agent Plan mode";
  writeCurrentDocuments(workspace.absolutePath, {
    plan: `# ${planTitle}\n\nThe agent keeps this document in Markdown.\n`,
    checklist: checklistMarkdown(64, 2),
  });
  const readyResponse = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(page, workspace.logicalPath, {
    paths: [`${workspace.logicalPath}/.caffold/plans/current`],
  });
  expect((await (await readyResponse).json()).status).toBe("ready");

  await expect(strip).toBeVisible();
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    planTitle,
  );
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "2 / 64",
  );
  const planButton = currentPlan.getByRole("button", { name: /^Open plan:/ });
  const checklistButton = currentPlan.getByRole("button", {
    name: /^Open checklist:/,
  });
  await expect(planButton).toHaveAttribute("aria-label", `Open plan: ${planTitle}`);
  await expect(checklistButton).toHaveAttribute(
    "aria-label",
    "Open checklist: 2 of 64 complete",
  );
  await expect(
    planButton.locator(".task-current-plan-document-icon-svg"),
  ).toBeVisible();
  await expect(strip.getByText("Current plan", { exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue("Keep this draft while plan files change.");
  await expect(prompt).toBeFocused();
  expect(
    await composer.evaluate((element) => element.stableCurrentPlanProbe),
  ).toBe(true);

  const compactLayout = await currentPlan.evaluate((element) => {
    const strip = element.querySelector(".task-current-plan-strip");
    const plan = element.querySelector('[data-current-plan-action="plan"]');
    const checklist = element.querySelector(
      '[data-current-plan-action="checklist"]',
    );
    const icon = element.querySelector("[data-current-plan-document-icon]");
    const title = element.querySelector("[data-current-plan-title]");
    const progress = element.querySelector("[data-current-plan-progress]");
    const composer = document.querySelector(
      'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden])',
    );
    const composerPanel = composer.querySelector(".task-composer-panel");
    const composerDock = element.closest(".task-follow-up-composer-dock");
    const conversationScroll = document.querySelector(
      "caffold-task-detail:not([hidden]) .task-conversation-scroll",
    );
    const stripBox = strip.getBoundingClientRect();
    const planBox = plan.getBoundingClientRect();
    const checklistBox = checklist.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const progressBox = progress.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const composerDockBox = composerDock.getBoundingClientRect();
    const stripStyle = getComputedStyle(strip);
    return {
      stripHeight: stripBox.height,
      planHeight: planBox.height,
      checklistHeight: checklistBox.height,
      stripWidth: stripBox.width,
      composerWidth: composerBox.width,
      composerTop: composerBox.top,
      composerBottom: composerBox.bottom,
      composerDockHeight: composerDockBox.height,
      composerHeight: composerBox.height,
      planComposerGap: composerBox.top - stripBox.bottom,
      currentPlanPosition: getComputedStyle(element).position,
      conversationPaddingBottom: Number.parseFloat(
        getComputedStyle(conversationScroll).paddingBottom,
      ),
      stripBorderRadius: stripStyle.borderRadius,
      composerBorderRadius: getComputedStyle(composerPanel).borderRadius,
      stripBoxShadow: stripStyle.boxShadow,
      planLeadingSpace: iconBox.left - planBox.left,
      planTrailingSpace: planBox.right - titleBox.right,
      checklistLeadingSpace: progressBox.left - checklistBox.left,
      checklistTrailingSpace: checklistBox.right - progressBox.right,
    };
  });
  expect(
    Math.abs(compactLayout.stripHeight - compactLayout.planHeight),
  ).toBeLessThanOrEqual(2.1);
  expect(
    Math.abs(compactLayout.stripHeight - compactLayout.checklistHeight),
  ).toBeLessThanOrEqual(2.1);
  expect(compactLayout.planLeadingSpace).toBeGreaterThanOrEqual(8);
  expect(compactLayout.planTrailingSpace).toBeGreaterThanOrEqual(8);
  expect(compactLayout.checklistLeadingSpace).toBeGreaterThanOrEqual(8);
  expect(compactLayout.checklistTrailingSpace).toBeGreaterThanOrEqual(8);
  expect(compactLayout.currentPlanPosition).toBe("absolute");
  expect(compactLayout.planComposerGap).toBeGreaterThanOrEqual(0);
  expect(compactLayout.planComposerGap).toBeLessThanOrEqual(12);
  expect(compactLayout.conversationPaddingBottom).toBeGreaterThan(
    compactLayout.stripHeight,
  );
  expect(compactLayout.conversationPaddingBottom).toBeCloseTo(
    layoutWithoutPlan.conversationPaddingBottom,
    1,
  );
  expect(compactLayout.composerDockHeight).toBeCloseTo(
    compactLayout.composerHeight,
    1,
  );
  expect(compactLayout.composerTop).toBeCloseTo(
    layoutWithoutPlan.composerTop,
    1,
  );
  expect(compactLayout.composerBottom).toBeCloseTo(
    layoutWithoutPlan.composerBottom,
    1,
  );
  expect(compactLayout.stripBorderRadius).toBe(
    compactLayout.composerBorderRadius,
  );
  expect(compactLayout.stripBoxShadow).not.toBe("none");
  if (testInfo.project.name === "desktop") {
    expect(compactLayout.stripWidth).toBeLessThan(compactLayout.composerWidth);
  }
  await captureReviewScreenshot(page, testInfo, "tasks-current-plan-floating");

  const title = currentPlan.locator("[data-current-plan-title]");
  await title.evaluate((element) => {
    element.equivalentProjectionProbe = true;
  });
  const equivalentResponse = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [`${workspace.logicalPath}/.caffold/plans/current/PLAN.md`] },
  );
  await equivalentResponse;
  expect(
    await title.evaluate((element) => element.equivalentProjectionProbe),
  ).toBe(true);

  const planFileResponse = fileResponse(
    page,
    `${workspace.logicalPath}/.caffold/plans/current/PLAN.md`,
  );
  await planButton.click();
  await planFileResponse;
  const dialog = currentPlan.locator("caffold-current-plan-document-dialog dialog");
  await expect(dialog).toHaveAttribute("open", "");
  const dialogPath = dialog.locator("[data-current-plan-dialog-path]");
  await expect(dialogPath).toHaveText(".caffold/plans/current/PLAN.md");
  await expect(dialogPath).toHaveAttribute(
    "title",
    `${workspace.logicalPath}/.caffold/plans/current/PLAN.md`,
  );
  const closeButton = dialog.getByRole("button", { name: "Close document" });
  await expect(
    closeButton.locator(".current-plan-document-close-icon"),
  ).toBeVisible();
  await expect
    .poll(() =>
      closeButton.evaluate((button) => {
        const { width, height } = button.getBoundingClientRect();
        return Math.abs(width - height);
      }),
    )
    .toBeLessThan(1);
  await expect(dialog.locator(".markdown-preview-body h1")).toHaveText(planTitle);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(planButton).toBeFocused();

  const backdropFileResponse = fileResponse(
    page,
    `${workspace.logicalPath}/.caffold/plans/current/PLAN.md`,
  );
  await planButton.click();
  await backdropFileResponse;
  await expect(dialog).toHaveAttribute("open", "");
  await page.mouse.click(1, 1);
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(planButton).toBeFocused();

  const checklistPath = `${workspace.logicalPath}/.caffold/plans/current/CHECKLIST.md`;
  const checklistFileResponse = fileResponse(page, checklistPath);
  await checklistButton.click();
  await checklistFileResponse;
  const preview = dialog.locator("caffold-markdown-preview");
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  await expect(preview.locator('input[type="checkbox"]')).toHaveCount(64);
  await expect
    .poll(() =>
      preview
        .locator('input[type="checkbox"]')
        .evaluateAll((checkboxes) => checkboxes.every((checkbox) => checkbox.disabled)),
    )
    .toBe(true);
  const previewScroll = await preview.evaluate((element) => {
    element.stableCurrentPlanPreviewProbe = true;
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(previewScroll).toBeGreaterThan(0);

  writeCurrentDocuments(workspace.absolutePath, {
    plan: `# ${planTitle}\n\nThe agent keeps this document in Markdown.\n`,
    checklist: checklistMarkdown(64, 3, "Live checkpoint"),
  });
  const refreshedProjection = currentPlanResponse(page, workspace.logicalPath);
  const refreshedChecklist = fileResponse(page, checklistPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [checklistPath] },
  );
  await Promise.all([refreshedProjection, refreshedChecklist]);
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "3 / 64",
  );
  await expect(preview.getByText("Live checkpoint", { exact: true })).toBeVisible();
  expect(
    await preview.evaluate(
      (element) => element.stableCurrentPlanPreviewProbe === true,
    ),
  ).toBe(true);
  expect(await preview.evaluate((element) => element.scrollTop)).toBe(
    previewScroll,
  );

  const layout = await currentPlan.evaluate((element) => {
    const strip = element.querySelector(".task-current-plan-strip");
    const title = element.querySelector("[data-current-plan-title]");
    const box = strip.getBoundingClientRect();
    const dialog = element.querySelector("dialog").getBoundingClientRect();
    return {
      stripLeft: box.left,
      stripRight: box.right,
      titleClipped: title.scrollWidth > title.clientWidth,
      viewportWidth: window.innerWidth,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogLeft: dialog.left,
      dialogRight: dialog.right,
    };
  });
  expect(layout.stripLeft).toBeGreaterThanOrEqual(0);
  expect(layout.stripRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.horizontalOverflow).toBe(false);
  expect(layout.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(layout.dialogRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  if (testInfo.project.name === "phone") {
    expect(layout.titleClipped).toBe(true);
  }
  await captureReviewScreenshot(page, testInfo, "tasks-current-plan-checklist");

  unlinkSync(join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"));
  const unreadableProjection = currentPlanResponse(page, workspace.logicalPath);
  const unreadableChecklist = fileResponse(page, checklistPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [checklistPath] },
  );
  expect((await (await unreadableProjection).json()).status).toBe("problem");
  expect((await unreadableChecklist).status()).toBe(404);
  await expect(dialog.locator("[data-current-plan-dialog-error]")).toBeVisible();

  writeFileSync(
    join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"),
    checklistMarkdown(64, 3, "Recovered checkpoint"),
  );
  const restoredProjection = currentPlanResponse(page, workspace.logicalPath);
  const restoredChecklist = fileResponse(page, checklistPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [checklistPath] },
  );
  expect((await (await restoredProjection).json()).status).toBe("ready");
  await restoredChecklist;
  await expect(dialog.locator("[data-current-plan-dialog-error]")).toBeHidden();
  await expect(
    preview.getByText("Recovered checkpoint", { exact: true }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(checklistButton).toBeFocused();

  writeFileSync(
    join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"),
    "# Empty checklist\n\nNo task-list items yet.\n",
  );
  const emptyProjection = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { overflow: true, paths: [] },
  );
  expect((await (await emptyProjection).json()).status).toBe("ready");
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "No checklist items",
  );
  await expect(strip).toHaveAttribute("data-complete", "false");

  writeFileSync(
    join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"),
    checklistMarkdown(3, 3),
  );
  const completeProjection = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [`${workspace.logicalPath}/.caffold/plans/current`] },
  );
  expect((await (await completeProjection).json()).status).toBe("ready");
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "3 / 3",
  );
  await expect(strip).toHaveAttribute("data-complete", "true");
  await expect(strip).toBeVisible();

  unlinkSync(join(workspace.absolutePath, ".caffold/plans/current/PLAN.md"));
  unlinkSync(join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"));
  const removedProjection = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [`${workspace.logicalPath}/.caffold/plans/current`] },
  );
  expect((await (await removedProjection).json()).status).toBe("absent");
  await expect(strip).toBeHidden();
  await expect
    .poll(() =>
      currentPlan.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBe(0);
  await expect(prompt).toHaveValue("Keep this draft while plan files change.");
  expect(
    await composer.evaluate((element) => element.stableCurrentPlanProbe),
  ).toBe(true);
});

test("recovers a partial active-turn plan after its Watch subscription resumes", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const workspace = prepareWorkspace(testInfo);
  const currentDirectory = join(
    workspace.absolutePath,
    ".caffold/plans/current",
  );
  mkdirSync(currentDirectory, { recursive: true });
  writeFileSync(join(currentDirectory, "PLAN.md"), "# Active turn plan\n");
  await installTaskApiFixture(page);
  const detail = detailFor("thread-1", workspace.logicalPath, { running: true });
  await installTaskDetails(page, [detail]);

  await page.goto(`/tasks/thread-1?cwd=${encodeURIComponent(workspace.logicalPath)}`);
  const problemResponse = currentPlanResponse(page, workspace.logicalPath);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  expect((await (await problemResponse).json()).status).toBe("problem");

  const currentPlan = page.locator("caffold-task-current-plan");
  await expect(currentPlan.locator(".task-current-plan-strip")).toBeVisible();
  await expect(currentPlan.locator("[data-current-plan-notice]")).toContainText(
    "CHECKLIST.md",
  );
  await expect(
    currentPlan.getByRole("button", { name: /^Open checklist:/ }),
  ).toBeHidden();

  writeFileSync(join(currentDirectory, "CHECKLIST.md"), "- [ ] Observe active work\n");
  const readyResponse = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    { paths: [`${workspace.logicalPath}/.caffold/plans/current/CHECKLIST.md`] },
  );
  expect((await (await readyResponse).json()).status).toBe("ready");
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    "Active turn plan",
  );
  await expect(
    currentPlan.getByRole("button", { name: /^Open plan:/ }),
  ).toBeEnabled();

  await emitWatchError(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
  );
  await expect(currentPlan.locator("[data-current-plan-notice]")).toContainText(
    "Plan updates unavailable",
  );
  const recoveredResponse = currentPlanResponse(page, workspace.logicalPath);
  await emitWatchReady(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
  );
  expect((await (await recoveredResponse).json()).status).toBe("ready");
  await expect(currentPlan.locator("[data-current-plan-notice]")).toBeHidden();
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "0 / 1",
  );
});

test("uses the Task cwd instead of its managed worktree root", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const workspace = prepareWorkspace(testInfo);
  const nestedAbsolutePath = join(workspace.absolutePath, "packages/app");
  const nestedLogicalPath = `${workspace.logicalPath}/packages/app`;
  mkdirSync(nestedAbsolutePath, { recursive: true });
  writeCurrentDocuments(nestedAbsolutePath, {
    plan: "# Nested Task plan\n",
    checklist: "- [x] Use the agent cwd\n",
  });

  await installTaskApiFixture(page);
  const detail = detailFor("thread-1", nestedLogicalPath);
  detail.task.worktree = {
    rootPath: workspace.logicalPath,
    repositoryRootPath: workspace.logicalPath,
    branch: "issue-255-plan-documents-ui",
    headSha: "fixture-head",
    relativeCwd: "packages/app",
    linked: true,
  };
  await installTaskDetails(page, [detail]);

  await page.goto(`/tasks/thread-1?cwd=${encodeURIComponent(workspace.logicalPath)}`);
  const cwdProjection = currentPlanResponse(page, nestedLogicalPath);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  expect((await (await cwdProjection).json()).status).toBe("ready");

  const currentPlan = page.locator("caffold-task-current-plan");
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    "Nested Task plan",
  );
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "1 / 1",
  );
  const planPath = `${nestedLogicalPath}/.caffold/plans/current/PLAN.md`;
  const planResponse = fileResponse(page, planPath);
  await currentPlan.getByRole("button", { name: /^Open plan:/ }).click();
  await planResponse;
  const dialog = currentPlan.locator("caffold-current-plan-document-dialog dialog");
  await expect(dialog.locator("[data-current-plan-dialog-path]")).toHaveText(
    "packages/app/.caffold/plans/current/PLAN.md",
  );
  await expect(dialog.locator("[data-current-plan-dialog-path]")).toHaveAttribute(
    "title",
    planPath,
  );
});

test("rejects a stale plan refresh when Task context changes", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const workspace = prepareWorkspace(testInfo);
  const firstCwd = `${workspace.logicalPath}/first`;
  const secondCwd = `${workspace.logicalPath}/second`;
  mkdirSync(join(workspace.absolutePath, "first"), { recursive: true });
  mkdirSync(join(workspace.absolutePath, "second"), { recursive: true });
  await installTaskApiFixture(page);
  const firstDetail = detailFor("thread-1", firstCwd);
  const secondDetail = detailFor("thread-2", secondCwd, { running: true });
  await installTaskDetails(page, [firstDetail, secondDetail]);

  let firstReads = 0;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    markRefreshStarted = resolve;
  });
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let markRefreshSettled;
  const refreshSettled = new Promise((resolve) => {
    markRefreshSettled = resolve;
  });
  await page.route(/\/api\/current-plan(?:\?|$)/, async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("path");
    if (cwd !== firstCwd) {
      return route.fulfill({ json: projectionFor(secondCwd, "Second plan", 2, 4) });
    }
    firstReads += 1;
    if (firstReads === 1) {
      return route.fulfill({ json: projectionFor(firstCwd, "First plan", 1, 4) });
    }
    markRefreshStarted();
    await refreshGate;
    try {
      await route.fulfill({
        json: projectionFor(firstCwd, "Stale first plan", 4, 4),
      });
    } catch {
      // The production request is expected to abort when Task context changes.
    } finally {
      markRefreshSettled();
    }
  });

  await page.goto(`/tasks/thread-1?cwd=${encodeURIComponent(firstCwd)}`);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), firstDetail);
  const currentPlan = page.locator("caffold-task-current-plan");
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    "First plan",
  );
  await currentPlan.evaluate((element) => {
    element.stableTaskSwitchProbe = true;
  });

  await emitWatchChange(page, firstCwd, {
    paths: [`${firstCwd}/.caffold/plans/current/CHECKLIST.md`],
  });
  await refreshStarted;

  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), secondDetail);
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    "Second plan",
  );
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "2 / 4",
  );
  expect(
    await currentPlan.evaluate((element) => element.stableTaskSwitchProbe),
  ).toBe(true);
  await expect.poll(() => watchSourceState(page, firstCwd)).toBe(2);
  await expect
    .poll(() => watchSourceState(page, secondCwd))
    .not.toBe(2);

  releaseRefresh();
  await refreshSettled;
  await expect(currentPlan.locator("[data-current-plan-title]")).toHaveText(
    "Second plan",
  );
  await expect(currentPlan.locator("[data-current-plan-progress]")).toHaveText(
    "2 / 4",
  );
});

function prepareWorkspace(testInfo) {
  const absolutePath = workspacePath(testInfo);
  mkdirSync(absolutePath, { recursive: true });
  writeFileSync(join(absolutePath, ".gitignore"), ".caffold/\n");
  return {
    absolutePath,
    logicalPath: relative(fixtureHome, absolutePath).split(sep).join("/"),
  };
}

function workspacePath(testInfo) {
  const slug = [
    process.pid,
    testInfo.workerIndex,
    testInfo.project.name,
    testInfo.title,
  ]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return join(fixtureHome, "src", ".caffold-e2e", slug);
}

function detailFor(threadId, cwd, { running = false } = {}) {
  const detail = taskDetailFixture({ running });
  detail.threadId = threadId;
  detail.task = {
    ...detail.task,
    id: threadId,
    threadId,
    title: `Plan fixture ${threadId}`,
    cwd,
    cwdPath: cwd,
  };
  return detail;
}

async function installTaskDetails(page, details) {
  const byThread = new Map(details.map((detail) => [detail.threadId, detail]));
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: activeTaskProjection(details.map((detail) => detail.task)),
    }),
  );
  await page.route(/\/api\/tasks\/[^/?]+(?:\?|$)/, (route) => {
    const threadId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/")[3],
    );
    const detail = byThread.get(threadId);
    return detail
      ? route.fulfill({ json: detail })
      : route.continue();
  });
}

function writeCurrentDocuments(workspace, { plan, checklist }) {
  const current = join(workspace, ".caffold/plans/current");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "PLAN.md"), plan);
  writeFileSync(join(current, "CHECKLIST.md"), checklist);
}

function checklistMarkdown(total, completed, extra = "") {
  const midpoint = Math.ceil(total / 2);
  const items = Array.from({ length: total }, (_, index) => {
    const label = index === total - 1 && extra ? extra : `Checklist item ${index + 1}`;
    return `- [${index < completed ? "x" : " "}] ${label}`;
  });
  return [
    "# Implementation checklist",
    "",
    "## Backend",
    "",
    ...items.slice(0, midpoint),
    "",
    "## Frontend",
    "",
    ...items.slice(midpoint),
    "",
  ].join("\n");
}

function projectionFor(cwd, title, completed, total) {
  const current = `${cwd}/.caffold/plans/current`;
  return {
    status: "ready",
    watchPath: cwd,
    plan: {
      title,
      completed,
      total,
      planDocument: {
        path: `${current}/PLAN.md`,
        name: "PLAN.md",
        size: 10,
        modifiedMs: 1,
      },
      checklistDocument: {
        path: `${current}/CHECKLIST.md`,
        name: "CHECKLIST.md",
        size: 10,
        modifiedMs: 1,
      },
    },
    problems: [],
  };
}

function currentPlanResponse(page, cwd) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/current-plan" && url.searchParams.get("path") === cwd;
  });
}

function fileResponse(page, path) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/file" && url.searchParams.get("path") === path;
  });
}

async function emitWatchChange(page, path, change) {
  await expect.poll(() => watchSourceState(page, path)).not.toBe(null);
  await page.evaluate(({ path, change }) => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.channel === "watch" &&
        candidate.context === path &&
        candidate.readyState !== 2,
    );
    source.emit("change", {
      revision: 1,
      gitStatusChanged: false,
      gitRefsChanged: false,
      overflow: false,
      ...change,
    });
  }, { path, change });
}

async function emitWatchError(page, path) {
  await expect.poll(() => watchSourceState(page, path)).not.toBe(null);
  await page.evaluate((path) => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.channel === "watch" &&
        candidate.context === path &&
        candidate.readyState !== 2,
    );
    source.emit("watch-error", { message: "Fixture Watch interruption." });
  }, path);
}

async function emitWatchReady(page, path) {
  await page.evaluate((path) => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.channel === "watch" &&
        candidate.context === path &&
        candidate.readyState !== 2,
    );
    source.emit("ready", {
      path,
      repository: true,
      revision: 2,
    });
  }, path);
}

function watchSourceState(page, path) {
  return page.evaluate((path) => {
    const sources = window.__caffoldMockEventSources?.filter(
      (candidate) => candidate.channel === "watch" && candidate.context === path,
    ) ?? [];
    return sources.length === 0 ? null : sources.at(-1).readyState;
  }, path);
}
