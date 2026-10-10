import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockCaffoldUpdate,
} from "./support/browser-defaults.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  createdTaskResponse,
  installEventSourceMock,
  mockAgentModels,
} from "./support/task-fixtures.js";
import { taskDetailFixture } from "./support/task-api-fixture.js";

const UPDATE_DIRECTORY =
  "Users/me/Library/Application Support/Caffold/data/caffold-updates";
const COMMAND =
  '"/Applications/Caffold Server.app/Contents/Resources/caffold" update --app "/Applications/Caffold Server.app" --data-dir "/Users/me/Library/Application Support/Caffold/data" --port 5178';
const RELEASE_URL = "https://github.com/panarch/caffold/releases/tag/v0.18.3";

const AVAILABLE = mockCaffoldUpdate({
  latestRelease: { version: "0.18.3", url: RELEASE_URL },
  updateAvailable: true,
  updateTask: { cwd: UPDATE_DIRECTORY, command: COMMAND },
});

const ROLLED_BACK = {
  id: "20261004T121000.000Z",
  startedAt: "2026-10-04T12:08:00Z",
  finishedAt: "2026-10-04T12:10:00Z",
  fromVersion: "0.18.2",
  toVersion: "0.18.3",
  startedFromMenuBar: false,
  outcome: "rolledBack",
  reason: "0.18.3 could not start",
};

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
  await installEventSourceMock(page, { autoOpen: true });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([]) }),
  );
});

/** Answers the update status with whatever `answer.status` holds when asked. */
async function answerUpdates(page, status) {
  const answer = { status };
  await page.route(/\/api\/caffold\/update(?:\?|$)/, (route) =>
    route.fulfill({ json: answer.status }),
  );
  return answer;
}

function updatesSection(page) {
  return page.locator("caffold-settings-about-page .settings-about-updates");
}

test("About tells whether a newer Caffold exists and how the last update ended", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await answerUpdates(page, { ...AVAILABLE, lastAttempt: ROLLED_BACK });
  await page.goto("/settings/about");
  // This browser has not seen the rollback yet, so it is told first.
  await page
    .getByRole("dialog", { name: "Caffold update was rolled back" })
    .getByRole("button", { name: "OK" })
    .click();

  const updates = updatesSection(page);
  await expect(updates.getByRole("heading", { name: "Updates" })).toBeVisible();
  await expect(updates.locator("[data-updates-summary]")).toHaveText(
    "Caffold 0.18.3 is available. The menu-bar app can also update it.",
  );
  await expect(updates.locator("[data-updates-version]")).toHaveText("0.18.2");
  const latest = updates.locator("[data-updates-latest] a");
  await expect(latest).toHaveText("0.18.3");
  await expect(latest).toHaveAttribute("href", RELEASE_URL);
  const last = updates.locator("[data-updates-last]");
  await expect(last).toContainText(
    "Rolled back to 0.18.2 — 0.18.3 could not start · ",
  );
  await expect(last).toHaveAttribute("data-state", "negative");
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(await last.evaluate((element) => getComputedStyle(element).color))
    .toBe(danger);
  await expect(updates.getByRole("button", { name: "Update Caffold" })).toBeEnabled();

  const about = page.locator("caffold-settings-about-page");
  await expect(about.getByRole("heading", { name: "This window" })).toBeVisible();
  await expect(about.locator("caffold-settings-detail-list")).not.toContainText("Version");
  await expect(about.locator("caffold-settings-detail-list")).toContainText("UI build");

  await captureReviewScreenshot(page, testInfo, "about-updates-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureReviewScreenshot(page, testInfo, "about-updates-dark");
});

test("About says each update state and offers the action that fits it", { tag: "@viewport-independent" }, async ({ page }) => {
  const answer = await answerUpdates(page, mockCaffoldUpdate());
  await page.goto("/settings/about");
  const updates = updatesSection(page);
  const summary = updates.locator("[data-updates-summary]");
  const button = updates.getByRole("button");
  const check = ["Check for Updates", true];

  for (const [status, expected, [action, enabled]] of [
    [mockCaffoldUpdate(), "Caffold is up to date.", check],
    [
      { ...AVAILABLE, updateTask: undefined },
      "Caffold 0.18.3 is available. Install it from the release page.",
      check,
    ],
    [
      {
        version: "0.18.2",
        releaseError: "GitHub answered HTTP 403 Forbidden.",
        updateAvailable: false,
      },
      "Caffold could not check for updates.\nGitHub answered HTTP 403 Forbidden.",
      check,
    ],
    [
      {
        ...AVAILABLE,
        runningAttempt: {
          id: "20261004T121000.000Z",
          startedAt: "2026-10-04T12:10:00Z",
          fromVersion: "0.18.2",
          startedFromMenuBar: true,
          outcome: "running",
        },
      },
      "Updating to Caffold 0.18.3…",
      ["Update Caffold", false],
    ],
    [
      AVAILABLE,
      "Caffold 0.18.3 is available. The menu-bar app can also update it.",
      ["Update Caffold", true],
    ],
  ]) {
    answer.status = status;
    await page.reload();
    await expect(summary).toHaveText(expected);
    await expect(button).toHaveText(action);
    if (enabled) {
      await expect(button).toBeEnabled();
    } else {
      await expect(button).toBeDisabled();
    }
  }
  await expect(updates.locator("[data-updates-last-row]")).toBeHidden();
});

test("Check for Updates asks GitHub now and offers the update it finds", { tag: "@desktop" }, async ({ page }) => {
  const updated = mockCaffoldUpdate({
    lastAttempt: {
      id: "20261004T121000.000Z",
      startedAt: "2026-10-04T12:08:00Z",
      finishedAt: "2026-10-04T12:10:00Z",
      fromVersion: "0.18.1",
      toVersion: "0.18.2",
      startedFromMenuBar: false,
      outcome: "succeeded",
    },
  });
  await answerUpdates(page, updated);
  const checkStarted = Promise.withResolvers();
  const githubAnswered = Promise.withResolvers();
  let checks = 0;
  await page.route(/\/api\/caffold\/update\/check(?:\?|$)/, async (route) => {
    checks += 1;
    expect(route.request().method()).toBe("POST");
    checkStarted.resolve();
    await githubAnswered.promise;
    await route.fulfill({ json: { ...AVAILABLE, lastAttempt: updated.lastAttempt } });
  });
  await page.goto("/settings/about");

  const updates = updatesSection(page);
  const summary = updates.locator("[data-updates-summary]");
  const button = updates.getByRole("button");
  const settings = page.locator(
    'caffold-task-workspace-navigation button[data-workspace-mode="settings"]',
  );
  const unclipped = () => button.evaluate((element) => element.scrollWidth <= element.clientWidth);
  await expect(summary).toHaveText("Caffold is up to date.");
  await expect(button).toHaveText("Check for Updates");
  expect(await unclipped()).toBe(true);
  await expect(settings).not.toHaveAttribute("data-update-available", "");

  await button.click();
  await checkStarted.promise;
  // The last answer stays on show while GitHub is asked.
  await expect(summary).toHaveText("Checking for updates…");
  await expect(button).toHaveText("Check for Updates");
  await expect(button).toBeDisabled();
  await expect(updates.locator("[data-updates-latest]")).toHaveText("0.18.2");
  await expect(updates.locator("[data-updates-last]")).toContainText("Updated to 0.18.2");

  githubAnswered.resolve();
  await expect(summary).toHaveText(
    "Caffold 0.18.3 is available. The menu-bar app can also update it.",
  );
  await expect(button).toHaveText("Update Caffold");
  await expect(button).toBeEnabled();
  expect(await unclipped()).toBe(true);
  await expect(updates.locator("[data-updates-latest]")).toHaveText("0.18.3");
  await expect(settings).toHaveAttribute("data-update-available", "");
  expect(checks).toBe(1);
});

test("marks Settings and About with the green dot while a newer Caffold exists", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const answer = await answerUpdates(page, AVAILABLE);
  await page.goto("/settings");

  const settings = page.locator(
    'caffold-task-workspace-navigation button[data-workspace-mode="settings"]',
  );
  await expect(settings).toHaveAttribute("data-update-available", "");
  await expect(settings).toHaveAttribute(
    "aria-label",
    "Settings — Caffold update available",
  );
  const about = page.locator(
    'caffold-settings-navigator-item button[data-settings-section="about"]',
  );
  await expect(about).toHaveAttribute("data-update-available", "");
  await expect(about).toHaveAttribute(
    "aria-label",
    "About Caffold — update available",
  );

  const expected = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.width = "var(--interface-space-3)";
    probe.style.background = "var(--success)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const value = { width: style.width, background: style.backgroundColor };
    probe.remove();
    return value;
  });
  for (const icon of [
    settings.locator("[data-workspace-navigation-icon]"),
    about.locator(".settings-navigator-item-icon-slot"),
  ]) {
    const dot = await icon.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        width: style.width,
        height: style.height,
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        position: style.position,
        animation: style.animationName,
      };
    });
    expect(dot).toEqual({
      width: expected.width,
      height: expected.width,
      background: expected.background,
      radius: "50%",
      position: "absolute",
      animation: "none",
    });
  }

  await captureReviewScreenshot(page, testInfo, "update-dot-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureReviewScreenshot(page, testInfo, "update-dot-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // The dot stays inside the icon's width, so it never crowds the label.
  for (const [icon, label] of [
    [
      settings.locator("[data-workspace-navigation-icon]"),
      settings.locator(":scope > span:not([data-workspace-navigation-icon])"),
    ],
    [
      about.locator(".settings-navigator-item-icon-slot"),
      about.locator(".settings-navigator-item-label"),
    ],
  ]) {
    const iconBox = await icon.boundingBox();
    const labelBox = await label.boundingBox();
    const dotRight = await icon.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element, "::after");
      return box.right - parseFloat(style.right);
    });
    expect(dotRight).toBeLessThanOrEqual(iconBox.x + iconBox.width + 0.5);
    expect(labelBox.x - dotRight).toBeGreaterThan(0);
  }

  answer.status = mockCaffoldUpdate();
  await page.reload();
  await expect(page.locator("caffold-settings-about-page [data-updates-summary]"))
    .toHaveText("Caffold is up to date.");
  await expect(settings).not.toHaveAttribute("data-update-available", "");
  await expect(about).not.toHaveAttribute("data-update-available", "");
});

test("starts an update Task from About in the update directory", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
  await answerUpdates(page, AVAILABLE);
  const earlier = {
    ...taskDetailFixture().task,
    id: "thread-earlier-update",
    threadId: "thread-earlier-update",
    title: "Update Caffold to 0.18.2",
    cwd: UPDATE_DIRECTORY,
    cwdPath: UPDATE_DIRECTORY,
  };
  const projection = activeTaskProjection([earlier]);
  projection.sections[0].composerSettings = {
    model: "gpt-5.6-sol",
    effort: "low",
    fastMode: false,
    permissionMode: "fullAccess",
  };
  const created = {
    ...taskDetailFixture(),
    threadId: "thread-update",
    task: {
      ...taskDetailFixture().task,
      id: "thread-update",
      threadId: "thread-update",
      title: "Update Caffold to 0.18.3",
      cwd: UPDATE_DIRECTORY,
      cwdPath: UPDATE_DIRECTORY,
    },
  };
  const creates = [];
  const prompts = [];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      creates.push(route.request().postDataJSON());
      return route.fulfill({
        json: createdTaskResponse(created, {
          section: { id: "fixture-section-1", name: UPDATE_DIRECTORY, repository: false },
        }),
      });
    }
    return route.fulfill({ json: projection });
  });
  await page.route(/\/api\/tasks\/thread-update(?:\?|$)/, (route) =>
    route.fulfill({ json: created }),
  );
  await page.route(/\/api\/tasks\/thread-update\/prompts(?:\?|$)/, (route) => {
    prompts.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        threadId: "thread-update",
        turnId: "turn-update",
        userMessageId: "message-update",
        steered: false,
      },
    });
  });
  // The Section's settings come from the Task list, which loads with Tasks.
  await page.goto("/tasks");
  await expect(page.getByText("Update Caffold to 0.18.2")).toBeVisible();
  await page
    .locator('caffold-task-workspace-navigation button[data-workspace-mode="settings"]')
    .click();
  await page.getByRole("button", { name: /^About Caffold/ }).click();

  const opener = updatesSection(page).getByRole("button", { name: "Update Caffold" });
  await opener.click();
  const dialog = page.locator("caffold-update-task-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Update Caffold to 0.18.3" }))
    .toBeVisible();
  await expect(dialog).toContainText(
    "An agent runs the update in a new Task. If 0.18.3 does not start, the previous version is restored.",
  );
  await expect(dialog).toContainText(
    "Running Tasks keep going while Caffold restarts. Claude sessions stop if it takes more than 10 minutes. Open terminals close.",
  );
  await expect(dialog).toContainText(
    "To let the agent recover Caffold even if the restore fails, choose the mode that allows everything (Full access or Allow all).",
  );
  // The update Section's last turn chose Full access, so this one starts there.
  await expect(dialog.locator(".task-permission-button")).toContainText("Full access");

  // The same geometry as Start Task: 34rem wide, or the phone's width.
  const viewport = page.viewportSize();
  const rem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const width = (await dialog.boundingBox()).width;
  const expectedWidth = testInfo.project.name === "phone"
    ? viewport.width - rem
    : Math.min(34 * rem, viewport.width - 2 * rem);
  expect(Math.abs(width - expectedWidth)).toBeLessThan(1);
  await captureReviewScreenshot(page, testInfo, "update-task-dialog-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureReviewScreenshot(page, testInfo, "update-task-dialog-dark");
  await page.emulateMedia({ colorScheme: "light" });

  const start = dialog.getByRole("button", { name: "Start Update" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect.poll(() => creates.length).toBe(1);
  expect(creates[0].cwd).toBe(UPDATE_DIRECTORY);
  expect(creates[0].permissionMode).toBe("fullAccess");
  expect(creates[0].titleSource).toContain(
    'Name this Task exactly "Update Caffold to 0.18.3".',
  );
  expect(creates[0].titleSource).toContain(COMMAND);
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0].prompt).toBe(creates[0].titleSource);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/thread-update$/);
});
