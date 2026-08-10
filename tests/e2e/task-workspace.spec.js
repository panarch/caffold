import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import {
  canonicalTaskState,
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
  const rootGeometry = await taskWorkspace.evaluate((element) => {
    const list = element.querySelector(".task-workspace-master-pane");
    const navigator = element.querySelector("caffold-settings-navigator");
    const navigationHost = element.querySelector(
      "caffold-task-workspace-navigation",
    );
    const navigation = element.querySelector(".task-workspace-navigation");
    const detail = element.querySelector(".task-workspace-detail-pane");
    const masterDetail = element.querySelector(".task-workspace-master-detail");
    const listRect = list.getBoundingClientRect();
    const navigatorRect = navigator.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
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
    };
  });
  expect(rootGeometry).toEqual({
    ownedByList: true,
    position: "static",
    contentEndsAboveNavigation: true,
    navigationEndsWithList: true,
    detailFillsWorkspace: true,
  });
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
  } else {
    await expect(navigation).toBeVisible();
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

  await tasksPage
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  if (testInfo.project.name === "phone") {
    await expect(navigation).toBeHidden();
  } else {
    await expect(navigation).toBeVisible();
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
        body: JSON.stringify({ tasks: [task], nextCursor: null }),
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
