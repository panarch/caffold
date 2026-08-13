import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "./support/task-fixtures.js";
import { openCompletedTaskForReview } from "./support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockCodexModels(page);
});

test("navigates Settings as responsive master-detail pages with browser history", async ({
  page,
}, testInfo) => {
  await page.goto("/settings");

  const taskWorkspace = page.locator("caffold-task-workspace");
  const workspace = page.locator("caffold-settings-workspace");
  const listPane = taskWorkspace.locator(".task-workspace-master-pane");
  const detailPane = taskWorkspace.locator(".task-workspace-detail-pane");
  const navigation = taskWorkspace.locator(".task-workspace-navigation");
  const appearance = taskWorkspace.locator(
    'button[data-settings-section="appearance"]',
  );

  await expect(listPane).toBeVisible();
  await expect(navigation).toBeVisible();
  const workspaceBrand = taskWorkspace.locator(
    "caffold-settings-navigator caffold-workspace-brand",
  );
  await expect(workspaceBrand.locator(".workspace-brand-title")).toHaveText(
    "Caffold",
  );
  await expect(workspaceBrand.locator(".workspace-brand-icon")).toHaveAttribute(
    "src",
    "/assets/icons/favicon-32.png",
  );
  await expect(taskWorkspace.getByText("Local to this browser")).toHaveCount(0);
  const settingsHeaderTypography = await taskWorkspace.evaluate((element) => {
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const brandTitle = element.querySelector(
      "caffold-settings-navigator .workspace-brand-title",
    );
    const brandIcon = element.querySelector(
      "caffold-settings-navigator .workspace-brand-icon",
    );
    const detailTitle = element.querySelector(
      ".settings-workspace-detail-header h1",
    );
    return {
      rootFontSize,
      brandTitleSize: Number.parseFloat(getComputedStyle(brandTitle).fontSize),
      brandIconWidth: Number.parseFloat(getComputedStyle(brandIcon).width),
      brandIconOffsetY: new DOMMatrixReadOnly(
        getComputedStyle(brandIcon).transform,
      ).m42,
      detailTitleSize: Number.parseFloat(getComputedStyle(detailTitle).fontSize),
    };
  });
  expect(settingsHeaderTypography.brandTitleSize).toBeCloseTo(
    settingsHeaderTypography.rootFontSize * 0.8125,
    2,
  );
  expect(settingsHeaderTypography.detailTitleSize).toBeCloseTo(
    settingsHeaderTypography.brandTitleSize,
    2,
  );
  expect(settingsHeaderTypography.brandIconWidth).toBeCloseTo(
    settingsHeaderTypography.rootFontSize * 1.25,
    2,
  );
  expect(settingsHeaderTypography.brandIconOffsetY).toBeCloseTo(
    settingsHeaderTypography.rootFontSize * -0.0625,
    2,
  );
  const rootGeometry = await taskWorkspace.evaluate((element) => {
    const list = element.querySelector(".task-workspace-master-pane");
    const navigator = element.querySelector("caffold-settings-navigator");
    const navigationHost = element.querySelector(
      "caffold-task-workspace-navigation",
    );
    const navigation = element.querySelector(".task-workspace-navigation");
    const detail = element.querySelector(".task-workspace-detail-pane");
    const navigatorHeader = element.querySelector(
      ".settings-navigator-header",
    );
    const detailHeader = element.querySelector(
      ".settings-workspace-detail-header",
    );
    const masterDetail = element.querySelector(".task-workspace-master-detail");
    const listRect = list.getBoundingClientRect();
    const navigatorRect = navigator.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    const navigatorHeaderRect = navigatorHeader.getBoundingClientRect();
    const detailHeaderRect = detailHeader.getBoundingClientRect();
    const masterDetailRect = masterDetail.getBoundingClientRect();
    return {
      ownedByList: navigationHost.parentElement === list,
      position: getComputedStyle(navigation).position,
      contentEndsAboveNavigation:
        navigatorRect.bottom <= navigationRect.top + 1,
      navigationEndsWithList:
        Math.abs(navigationRect.bottom - listRect.bottom) <= 1,
      detailFillsWorkspace:
        getComputedStyle(detail).display === "none" ||
        Math.abs(detailRect.height - masterDetailRect.height) <= 1,
      settingsHeadersAlign:
        detailHeader.hidden ||
        Math.abs(navigatorHeaderRect.height - detailHeaderRect.height) <= 1,
    };
  });
  expect(rootGeometry).toEqual({
    ownedByList: true,
    position: "static",
    contentEndsAboveNavigation: true,
    navigationEndsWithList: true,
    detailFillsWorkspace: true,
    settingsHeadersAlign: true,
  });
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-workspace-header-chrome",
  );
  if (testInfo.project.name === "phone") {
    await expect(workspace).toHaveAttribute("data-settings-view", "list");
    await expect(detailPane).toBeHidden();
    await expect(
      workspace.locator("caffold-settings-appearance-page"),
    ).toBeHidden();
  } else {
    await expect(workspace).toHaveAttribute("data-settings-view", "detail");
    await expect(detailPane).toBeVisible();
    await expect(
      workspace.locator("caffold-settings-appearance-page"),
    ).toBeVisible();
    await expect(appearance).toHaveAttribute("aria-current", "");
  }

  await appearance.click();
  await expect(page).toHaveURL("/settings/appearance");
  await expect(workspace).toHaveAttribute("data-settings-view", "detail");
  await expect(workspace.locator("caffold-settings-appearance-page")).toBeVisible();
  if (testInfo.project.name === "phone") {
    await expect(listPane).toBeHidden();
    await expect(navigation).toBeHidden();
    await expect(
      workspace.getByRole("button", { name: "Back to settings" }),
    ).toBeVisible();
  } else {
    await expect(listPane).toBeVisible();
    await expect(navigation).toBeVisible();
  }

  await page.goBack();
  await expect(page).toHaveURL("/settings");
  if (testInfo.project.name === "phone") {
    await expect(workspace).toHaveAttribute("data-settings-view", "list");
    await expect(listPane).toBeVisible();
    await expect(navigation).toBeVisible();
  } else {
    await expect(workspace).toHaveAttribute("data-settings-view", "detail");
    await expect(
      workspace.locator("caffold-settings-appearance-page"),
    ).toBeVisible();
  }
  await page.goForward();
  await expect(page).toHaveURL("/settings/appearance");
  await expect(workspace.locator("caffold-settings-appearance-page")).toBeVisible();
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
  }

  await page.goto("/settings/codex");
  await expect(workspace.locator("caffold-settings-codex-page")).toBeVisible();
  await page.goto("/settings/about");
  await expect(workspace.locator("caffold-settings-about-page")).toBeVisible();

  if (testInfo.project.name === "phone") {
    await workspace.getByRole("button", { name: "Back to settings" }).click();
  } else {
    await navigation.locator('[data-workspace-mode="settings"]').click();
  }
  await expect(page).toHaveURL("/settings");
  if (testInfo.project.name === "phone") {
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
    await expect(navigation).toBeVisible();
  } else {
    await expect(
      workspace.locator("caffold-settings-appearance-page"),
    ).toBeVisible();
  }
});

test("reflows the Settings root without changing its route", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "One browser project covers the responsive root transition.",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");

  const workspace = page.locator("caffold-settings-workspace");
  const taskWorkspace = page.locator("caffold-task-workspace");
  const listPane = taskWorkspace.locator(".task-workspace-master-pane");
  const detailPane = taskWorkspace.locator(".task-workspace-detail-pane");
  const appearancePage = workspace.locator(
    "caffold-settings-appearance-page",
  );

  await expect(workspace).toHaveAttribute("data-settings-view", "list");
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeHidden();
  await expect(page).toHaveURL("/settings");

  await page.setViewportSize({ width: 933, height: 704 });
  await expect(workspace).toHaveAttribute("data-settings-view", "detail");
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeVisible();
  await expect(appearancePage).toBeVisible();
  await expect(page).toHaveURL("/settings");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace).toHaveAttribute("data-settings-view", "list");
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeHidden();
  await expect(appearancePage).toBeHidden();
  await expect(page).toHaveURL("/settings");
});

test("shares navigation pane resizing across Tasks and Settings", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await installTaskRoutes(page, workspaceTask());
  await page.goto("/");

  const taskWorkspace = page.locator("caffold-task-workspace");
  const navigationPane = taskWorkspace.locator(".task-workspace-master-pane");
  const detailPane = taskWorkspace.locator(".task-workspace-detail-pane");
  const separator = taskWorkspace.locator(".task-workspace-master-resizer");
  const navigation = taskWorkspace.locator(".task-workspace-navigation");

  await expect(separator).toHaveCount(1);
  await expect(separator).toHaveAttribute("role", "separator");
  await expect(separator).toHaveAttribute(
    "aria-label",
    "Resize navigation pane",
  );
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuemin", "280");

  if (testInfo.project.name === "phone") {
    await expect(separator).toBeHidden();
    await navigation.locator('[data-workspace-mode="settings"]').click();
    await expect(page).toHaveURL("/settings");
    await expect(separator).toBeHidden();
    await taskWorkspace
      .locator('button[data-settings-section="about"]')
      .click();
    await expect(page).toHaveURL("/settings/about");
    await expect(separator).toBeHidden();
    return;
  }

  await expect(
    taskWorkspace.getByRole("separator", { name: "Resize navigation pane" }),
  ).toBeVisible();
  await separator.evaluate((element) => {
    element.dataset.identityMarker = "shared-navigation-resizer";
  });
  const maximumWidth = Number(await separator.getAttribute("aria-valuemax"));
  expect(maximumWidth).toBe(
    Math.min(520, page.viewportSize().width - 520),
  );

  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "396");
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "380");
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "280");
  await separator.press("End");
  await expect(separator).toHaveAttribute(
    "aria-valuenow",
    `${maximumWidth}`,
  );
  await separator.press("Home");

  const tasksSeparatorBox = await separator.boundingBox();
  expect(tasksSeparatorBox).not.toBeNull();
  await page.mouse.move(
    tasksSeparatorBox.x + tasksSeparatorBox.width / 2,
    tasksSeparatorBox.y + tasksSeparatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    tasksSeparatorBox.x + tasksSeparatorBox.width / 2 + 64,
    tasksSeparatorBox.y + tasksSeparatorBox.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "344");

  await navigation.locator('[data-workspace-mode="settings"]').click();
  await expect(page).toHaveURL("/settings");
  await expect(
    taskWorkspace.getByRole("separator", { name: "Resize navigation pane" }),
  ).toBeVisible();
  await expect(separator).toHaveAttribute(
    "data-identity-marker",
    "shared-navigation-resizer",
  );
  await expect(separator).toHaveAttribute("aria-orientation", "vertical");
  await expect(separator).toHaveAttribute("aria-valuemin", "280");
  await expect(separator).toHaveAttribute(
    "aria-valuemax",
    `${maximumWidth}`,
  );
  await expect(separator).toHaveAttribute("aria-valuenow", "344");
  await expect
    .poll(() =>
      navigationPane.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBe(344);

  const settingsSeparatorBox = await separator.boundingBox();
  expect(settingsSeparatorBox).not.toBeNull();
  await page.mouse.move(
    settingsSeparatorBox.x + settingsSeparatorBox.width / 2,
    settingsSeparatorBox.y + settingsSeparatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    settingsSeparatorBox.x + settingsSeparatorBox.width / 2 + 32,
    settingsSeparatorBox.y + settingsSeparatorBox.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "376");

  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "392");
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "376");
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "280");
  await separator.press("End");
  await expect(separator).toHaveAttribute(
    "aria-valuenow",
    `${maximumWidth}`,
  );
  await separator.press("ArrowLeft");
  const sharedWidth = maximumWidth - 16;
  await expect(separator).toHaveAttribute(
    "aria-valuenow",
    `${sharedWidth}`,
  );

  await taskWorkspace
    .locator('button[data-settings-section="about"]')
    .click();
  await expect(page).toHaveURL("/settings/about");
  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", `${sharedWidth}`);

  for (const interfaceScalePercent of [90, 120]) {
    await page.evaluate(async (value) => {
      const { setAppearanceRangeSetting } = await import("/assets/settings.js");
      setAppearanceRangeSetting("interfaceScalePercent", value);
    }, interfaceScalePercent);
    const geometry = await taskWorkspace.evaluate((element) => {
      const navigationPane = element.querySelector(
        ".task-workspace-master-pane",
      );
      const detailPane = element.querySelector(".task-workspace-detail-pane");
      const separator = element.querySelector(
        ".task-workspace-master-resizer",
      );
      const navigationBounds = navigationPane.getBoundingClientRect();
      const separatorBounds = separator.getBoundingClientRect();
      return {
        detailWidth: detailPane.getBoundingClientRect().width,
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        navigationWidth: Math.round(navigationBounds.width),
        separatorCenterOffset:
          separatorBounds.left + separatorBounds.width / 2 -
          navigationBounds.right,
      };
    });
    expect(geometry.hasHorizontalOverflow).toBe(false);
    expect(geometry.navigationWidth).toBe(sharedWidth);
    expect(geometry.detailWidth).toBeGreaterThanOrEqual(520);
    expect(Math.abs(geometry.separatorCenterOffset)).toBeLessThanOrEqual(0.5);
  }
  await captureReviewScreenshot(
    page,
    testInfo,
    "settings-shared-navigation-resizer",
  );

  await navigation.locator('[data-workspace-mode="tasks"]').click();
  await expect(page).toHaveURL("/");
  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuenow", `${sharedWidth}`);
  await expect
    .poll(() =>
      navigationPane.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBe(sharedWidth);
  await expect(detailPane).toBeVisible();
});

test("clamps the shared navigation pane across the desktop boundary", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "One browser project covers explicit window-resize clamping.",
  );

  await installEventSourceMock(page);
  await installTaskRoutes(page, workspaceTask());
  await page.goto("/settings/about");

  const taskWorkspace = page.locator("caffold-task-workspace");
  const navigationPane = taskWorkspace.locator(".task-workspace-master-pane");
  const detailPane = taskWorkspace.locator(".task-workspace-detail-pane");
  const separator = taskWorkspace.locator(".task-workspace-master-resizer");

  await separator.focus();
  await separator.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "520");

  await page.setViewportSize({ width: 1000, height: 704 });
  await expect(separator).toHaveAttribute("aria-valuemax", "480");
  await expect(separator).toHaveAttribute("aria-valuenow", "480");
  const constrainedLayout = await taskWorkspace.evaluate((element) => ({
    detailWidth: element
      .querySelector(".task-workspace-detail-pane")
      .getBoundingClientRect().width,
    hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
    navigationWidth: element
      .querySelector(".task-workspace-master-pane")
      .getBoundingClientRect().width,
  }));
  expect(constrainedLayout.hasHorizontalOverflow).toBe(false);
  expect(constrainedLayout.navigationWidth).toBeCloseTo(480, 1);
  expect(constrainedLayout.detailWidth).toBeGreaterThanOrEqual(520);

  await page.setViewportSize({ width: 899, height: 704 });
  await expect(separator).toBeHidden();
  await expect(navigationPane).toBeHidden();
  await expect(detailPane).toBeVisible();
  expect(
    await taskWorkspace.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);

  await page.setViewportSize({ width: 900, height: 704 });
  await expect(separator).toBeVisible();
  await expect(separator).toHaveAttribute("aria-valuemax", "380");
  await expect(separator).toHaveAttribute("aria-valuenow", "380");
  await expect(navigationPane).toBeVisible();
  await expect(detailPane).toBeVisible();
  const boundaryLayout = await taskWorkspace.evaluate((element) => ({
    detailWidth: element
      .querySelector(".task-workspace-detail-pane")
      .getBoundingClientRect().width,
    hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
    navigationWidth: element
      .querySelector(".task-workspace-master-pane")
      .getBoundingClientRect().width,
  }));
  expect(boundaryLayout).toEqual({
    detailWidth: 520,
    hasHorizontalOverflow: false,
    navigationWidth: 380,
  });
});

test("preserves Tasks and Settings DOM while hidden task updates arrive", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    sourceKey: "__taskWorkspaceEventSource",
    autoOpen: true,
  });
  const task = workspaceTask();
  await installTaskRoutes(page, task);

  await page.goto("/tasks/new?cwd=src");
  const taskWorkspace = page.locator("caffold-task-workspace");
  const tasksPage = taskWorkspace.locator("caffold-tasks-page");
  const prompt = tasksPage.locator('.task-new-form textarea[name="prompt"]');
  const navigation = taskWorkspace.locator(".task-workspace-navigation");
  await expect(prompt).toBeVisible();
  await prompt.fill("조합 중인 입력과 화면 상태를 그대로 유지한다");
  await tasksPage.evaluate((element) => {
    element.dataset.identityMarker = "tasks-stable";
    element.querySelector('textarea[name="prompt"]').dataset.identityMarker =
      "prompt-stable";
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__taskWorkspaceEventSource)),
    )
    .toBe(true);

  const settingsButton = navigation.locator(
    'button[data-workspace-mode="settings"]',
  );
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
    await settingsButton.evaluate((button) => button.click());
  } else {
    await settingsButton.focus();
    await settingsButton.press("Enter");
  }
  await expect(page).toHaveURL("/settings");
  if (testInfo.project.name === "phone") {
    await expect(
      taskWorkspace.locator("caffold-settings-appearance-page"),
    ).toBeHidden();
  } else {
    await expect(
      taskWorkspace.locator("caffold-settings-appearance-page"),
    ).toBeVisible();
  }

  await taskWorkspace
    .locator('button[data-settings-section="appearance"]')
    .click();
  await expect(page).toHaveURL("/settings/appearance");

  const appearancePage = taskWorkspace.locator(
    "caffold-settings-appearance-page",
  );
  const interfaceRange = appearancePage.locator(
    'input[data-setting="interfaceScalePercent"]',
  );
  await appearancePage.evaluate((element) => {
    element.dataset.identityMarker = "settings-stable";
    element.querySelector('.settings-scroll').scrollTop = 96;
  });
  await interfaceRange.evaluate((element) => {
    element.dataset.identityMarker = "range-stable";
  });
  const settingsScrollTop = await appearancePage
    .locator(".settings-scroll")
    .evaluate((element) => element.scrollTop);

  await page.evaluate((updatedTask) => {
    window.__taskWorkspaceEventSource.emit("task-updated", updatedTask);
  }, {
    ...task,
    title: "Updated while Settings is visible",
    preview: "Live task update",
    updatedMs: task.updatedMs + 1_000,
    recencyMs: task.recencyMs + 1_000,
  });

  await expect(appearancePage).toHaveAttribute(
    "data-identity-marker",
    "settings-stable",
  );
  await expect(interfaceRange).toHaveAttribute(
    "data-identity-marker",
    "range-stable",
  );
  await expect
    .poll(() =>
      appearancePage
        .locator(".settings-scroll")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(settingsScrollTop);

  const tasksButton = navigation.locator('button[data-workspace-mode="tasks"]');
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
    await tasksButton.evaluate((button) => button.click());
  } else {
    await tasksButton.focus();
    await tasksButton.press("Enter");
  }
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(tasksPage).toHaveAttribute("data-identity-marker", "tasks-stable");
  await expect(prompt).toHaveAttribute("data-identity-marker", "prompt-stable");
  await expect(prompt).toHaveValue("조합 중인 입력과 화면 상태를 그대로 유지한다");
  await expect(taskWorkspace.locator("caffold-task-navigator")).toContainText(
    "Updated while Settings is visible",
  );

  await page.goBack();
  await expect(page).toHaveURL("/settings/appearance");
  await expect(appearancePage).toHaveAttribute(
    "data-identity-marker",
    "settings-stable",
  );
  await page.goForward();
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(prompt).toHaveValue("조합 중인 입력과 화면 상태를 그대로 유지한다");
});

test("keeps bottom navigation responsive in Conversation and hides it throughout Review", async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage } = await openCompletedTaskForReview(page);

  const navigation = page.locator(
    "caffold-task-workspace .task-workspace-navigation",
  );
  const navigationPane = page.locator(
    "caffold-task-workspace .task-workspace-master-pane",
  );
  const separator = page.locator(
    "caffold-task-workspace .task-workspace-master-resizer",
  );
  const detail = page.locator("caffold-task-detail");
  expect(
    await navigation.evaluate(
      (element) =>
        element.parentElement?.matches("caffold-task-workspace-navigation") &&
        element.parentElement.parentElement ===
          document.querySelector(
            "caffold-task-workspace .task-workspace-master-pane",
          ),
    ),
  ).toBe(true);
  await expect(detail).toBeVisible();
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
    await expect(separator).toBeHidden();
  } else {
    await expect(navigation).toBeVisible();
    await expect(navigationPane).toBeVisible();
    await expect(separator).toBeVisible();
    const geometry = await page.locator("caffold-task-workspace").evaluate((element) => {
      const list = element.querySelector(".task-workspace-master-pane");
      const navigator = element.querySelector("caffold-task-navigator");
      const navigation = element.querySelector(".task-workspace-navigation");
      const detail = element.querySelector(".task-workspace-detail-pane");
      const masterDetail = element.querySelector(".task-workspace-master-detail");
      const listRect = list.getBoundingClientRect();
      const navigatorRect = navigator.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      return {
        contentEndsAboveNavigation:
          navigatorRect.bottom <= navigationRect.top + 1,
        navigationEndsWithList:
          Math.abs(navigationRect.bottom - listRect.bottom) <= 1,
        navigationMatchesListWidth:
          Math.abs(navigationRect.width - listRect.width) <= 1,
        detailFillsWorkspace:
          Math.abs(
            detail.getBoundingClientRect().height -
              masterDetail.getBoundingClientRect().height,
          ) <= 1,
      };
    });
    expect(geometry).toEqual({
      contentEndsAboveNavigation: true,
      navigationEndsWithList: true,
      navigationMatchesListWidth: true,
      detailFillsWorkspace: true,
    });
  }

  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await expect(navigation).toBeHidden();
  await expect(navigationPane).toBeHidden();
  await expect(separator).toBeHidden();

  await tasksPage
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
    await expect(separator).toBeHidden();
  } else {
    await expect(navigation).toBeVisible();
    await expect(navigationPane).toBeVisible();
    await expect(separator).toBeVisible();
  }
});

async function installTaskRoutes(page, task) {
  await page.route("**/api/tasks**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      return route.continue();
    }
    if (url.pathname === "/api/tasks") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeTaskProjection([task])),
      });
    }
    if (url.pathname === "/api/tasks/archived") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [], nextCursor: null }),
      });
    }
    if (url.pathname === `/api/tasks/${task.threadId}`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId: task.threadId,
          syncState: "ready",
          revision: 1,
          task,
          events: [],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
        }),
      });
    }
    return route.continue();
  });
}

function workspaceTask() {
  const now = Date.now();
  const threadId = "thread_workspace_state";
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Workspace state",
    preview: "Workspace state",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now - 2_000,
    updatedMs: now - 1_000,
    recencyMs: now - 1_000,
    lastCompletedMs: now - 1_000,
    lastEventSummary: "Completed",
    unseen: false,
  };
}
