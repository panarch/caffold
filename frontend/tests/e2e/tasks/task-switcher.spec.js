import { expect, test } from "@playwright/test";
import {
  enterActionHints,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { TASK_PERMISSION_FIXTURE } from "../support/task-api-fixture.js";
import {
  activeListTask,
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

const NOW = 1_781_000_000_000;

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("opens the recent Task list from a Task and moves to the chosen one", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const tasks = switcherTasks();
  await installSwitcherFixture(page, tasks);
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();

  const dialog = await openSwitcher(page);
  await expect(dialog.locator(".task-switcher-row-title")).toHaveText([
    "Middle task",
    "Oldest task",
    "Working task, finished long ago",
  ]);

  await expect(dialog.locator(".task-switcher-row-context")).toHaveText([
    "a-deliberately-long-section-name-for-clipping",
    "home",
    "home",
  ]);
  await captureReviewScreenshot(page, testInfo, "task-switcher");

  const code = await hintCode(
    page,
    "Open task: Middle task in a-deliberately-long-section-name-for-clipping",
  );
  expect(code).toMatch(/^[A-Z]$/);
  expect(await badgesClearTitles(dialog, page)).toBe(true);
  await page.keyboard.type(code.toLowerCase());

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/switcher_middle$/);
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(page.locator(".tasks-detail-pane")).toBeFocused();
});

test("keeps the order it opened with while Tasks keep moving", { tag: "@desktop" }, async ({
  page,
}) => {
  const tasks = switcherTasks();
  await installSwitcherFixture(page, tasks);
  await page.goto("/tasks");

  const dialog = await openSwitcher(page);
  await expect(dialog.locator(".task-switcher-row-title")).toHaveText([
    "Middle task",
    "Oldest task",
    "Working task, finished long ago",
  ]);
  const middle = dialog.locator('[data-thread-id="switcher_middle"]');
  await expect(middle.locator(".task-switcher-row-status")).toHaveCount(0);

  await page.evaluate((updated) => {
    window.__taskListEventSource.emit("task-updated", updated);
  }, activeListTask({
    ...tasks[1],
    ...canonicalTaskState("active"),
    recencyMs: NOW + 10_000,
    updatedMs: NOW + 10_000,
    lastCompletedMs: NOW + 10_000,
  }));

  await expect(middle.locator(".task-switcher-row-status")).toHaveCount(1);
  await expect(dialog.locator(".task-switcher-row-title")).toHaveText([
    "Middle task",
    "Oldest task",
    "Working task, finished long ago",
  ]);
});

test("stays out of Settings, which never loads the Task list", { tag: "@desktop" }, async ({
  page,
}) => {
  let taskListRequests = 0;
  await installSwitcherFixture(page, switcherTasks(), {
    onTaskListRequest: () => {
      taskListRequests += 1;
    },
  });
  await page.goto("/settings");
  await expect(page.locator("caffold-settings-workspace")).toBeVisible();
  expect(taskListRequests).toBe(0);

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("t");

  await expect(page.locator("caffold-task-switcher-dialog > dialog"))
    .toBeHidden();
});

test("reports an unloaded Task list instead of calling it empty", { tag: "@desktop" }, async ({
  page,
}) => {
  const release = deferredTaskList();
  await installSwitcherFixture(page, switcherTasks(), {
    holdTaskList: release.promise,
  });
  await page.goto("/tasks");

  const dialog = await openSwitcher(page, { hints: false });
  await expect(dialog.locator(".task-switcher-empty")).toHaveText(
    "Active tasks have not loaded.",
  );

  release.resolve();
  await expect(dialog.locator(".task-switcher-row-title")).toHaveText([
    "Middle task",
    "Oldest task",
    "Working task, finished long ago",
  ]);
  await expect(dialog.locator(".task-switcher-empty")).toBeHidden();
});

test("reopens at the newest Task after being scrolled and closed", { tag: "@desktop" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, manySwitcherTasks(40));
  await page.goto("/tasks");

  const dialog = await openSwitcher(page);
  const scrollport = dialog.locator(".task-switcher-scroll");
  await scrollport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await scrollport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openSwitcher(page);

  expect(await scrollport.evaluate((element) => element.scrollTop)).toBe(0);
});

test("closes the whole surface on one Escape and returns focus", { tag: "@desktop" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks");

  const dialog = await openSwitcher(page);
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(hintDialog(page)).toBeHidden();
  await expect(page.locator(".task-workspace-surface")).toBeFocused();
});

test("says an empty active list is empty instead of doing nothing", { tag: "@desktop" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, []);
  await page.goto("/tasks");
  await expect(page.locator("caffold-task-new")).toBeVisible();

  const dialog = await openSwitcher(page, { hints: false });

  await expect(dialog.locator(".task-switcher-empty")).toHaveText(
    "No active tasks.",
  );
  await expect(dialog.locator(".task-switcher-item")).toHaveCount(0);
});

test("keeps every row on one line at the narrowest supported width", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(page.locator("caffold-task-navigator")).toBeHidden();

  const dialog = await openSwitcher(page);

  const layout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll(".task-switcher-row")].map((row) => {
      const title = row.querySelector(".task-switcher-row-title");
      const context = row.querySelector(".task-switcher-row-context");
      const style = getComputedStyle(title);
      return {
        withinDialog: row.getBoundingClientRect().right <= bounds.right + 1,
        clipsTitle:
          style.whiteSpace === "nowrap" && style.textOverflow === "ellipsis",
        titleHeight: Math.round(title.getBoundingClientRect().height),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        contextWidth: Math.round(context.getBoundingClientRect().width),
        contextContentWidth: context.scrollWidth,
        contextClipped: context.scrollWidth > context.clientWidth,
        contextRight: Math.round(context.getBoundingClientRect().right),
      };
    });
  });
  expect(layout).toHaveLength(3);
  expect(layout.every((row) => row.withinDialog)).toBe(true);
  expect(layout.every((row) => row.clipsTitle)).toBe(true);
  // A wrapped title would make its row taller than the short ones.
  expect(new Set(layout.map((row) => row.titleHeight)).size).toBe(1);
  // A short Section takes only the width it needs and hands the rest back.
  expect(layout[1].contextWidth).toBeLessThanOrEqual(
    layout[1].contextContentWidth + 1,
  );
  expect(layout[2].contextWidth).toBeLessThanOrEqual(
    layout[2].contextContentWidth + 1,
  );
  // A long one stops at the cap and clips instead of crowding the title out.
  expect(layout[0].contextClipped).toBe(true);
  expect(layout[0].titleWidth).toBeGreaterThan(0);
  // A fixed indicator column keeps every Section label in one line.
  expect(new Set(layout.map((row) => row.contextRight)).size).toBe(1);
  await captureReviewScreenshot(page, testInfo, "task-switcher");
});

test("jumps to another Task from the single visible pane", { tag: "@phone" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(page.locator("caffold-task-navigator")).toBeHidden();

  const dialog = await openSwitcher(page);
  const code = await hintCode(page, "Open task: Working task, finished long ago in home");
  await page.keyboard.type(code.toLowerCase());

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/switcher_newest$/);
  await expect(page.locator("caffold-task-detail")).toBeVisible();
});

test("hands a long list to Scroll mode and gives the rows it reveals new codes", { tag: "@desktop" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, manySwitcherTasks(40));
  await page.goto("/tasks");

  const dialog = await openSwitcher(page);
  const firstLabels = await visibleHintLabels(page);
  expect(firstLabels.length).toBeGreaterThan(0);

  await page.keyboard.press("s");

  // One declared surface, so Scroll starts on it without asking which.
  await expect(switcherHud(page)).toBeVisible();
  await expect(switcherScrollSelector(page)).toBeHidden();
  await expect(hintDialog(page)).toBeHidden();

  const scrollport = dialog.locator(".task-switcher-scroll");
  expect(await scrollport.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("d");
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await page.keyboard.press("f");
  await expect(hintDialog(page)).toBeVisible();
  expect(await visibleHintLabels(page)).not.toEqual(firstLabels);
});

test("brings the chosen Task into view in the Task list", { tag: "@desktop" }, async ({
  page,
}) => {
  // The Task list keeps its own order, so the newest Task sits at its bottom.
  await installSwitcherFixture(page, manySwitcherTasks(40));
  await page.goto("/tasks");
  const listScroll = page.locator("caffold-task-navigator .task-list-scroll");
  await expect(listScroll).toBeVisible();
  expect(await listScroll.evaluate((element) => element.scrollTop)).toBe(0);

  const dialog = await openSwitcher(page);
  const code = await hintCode(page, "Open task: Task 0 in home");
  await page.keyboard.type(code.toLowerCase());
  await expect(dialog).toBeHidden();

  await expect.poll(() => listScroll.evaluate((element) => {
    const row = element.querySelector('.task-row[aria-current="true"]');
    if (!row) {
      return null;
    }
    const view = element.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  })).toBe(true);
});

test("shows each row the time the list is ordered by", { tag: "@desktop" }, async ({
  page,
}) => {
  // Opening a Task moves its recency to now, so recency must not decide this.
  await installSwitcherFixture(page, [
    switcherTask("looked_at_just_now", "Looked at just now, finished long ago", {
      recencyMs: NOW,
      lastCompletedMs: NOW - 5 * 24 * 60 * 60 * 1000,
    }),
    switcherTask("finished_recently", "Finished an hour ago", {
      recencyMs: NOW - 60 * 60 * 1000,
      lastCompletedMs: NOW - 60 * 60 * 1000,
    }),
  ]);
  await page.goto("/tasks");

  const dialog = await openSwitcher(page);
  await expect(dialog.locator(".task-switcher-row-title")).toHaveText([
    "Finished an hour ago",
    "Looked at just now, finished long ago",
  ]);
  const times = await dialog.locator(".task-switcher-row-time")
    .evaluateAll((elements) => elements.map((element) => element.dateTime));

  // Read top to bottom, the column never goes backwards.
  expect(times).toHaveLength(2);
  expect(new Date(times[0]).getTime())
    .toBeGreaterThan(new Date(times[1]).getTime());
});

test("opens from the Task list header by pointer and closes with its X", { tag: "@desktop" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  const opener = listSwitcherOpener(page);
  await expect(switcherOpeners(page)).toHaveCount(1);
  await expect(opener).toBeVisible();

  await opener.click();

  const dialog = page.locator("caffold-task-switcher-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(hintDialog(page)).toBeHidden();
  const rows = dialog.locator(".task-switcher-row");
  await expect(rows.first()).toHaveAccessibleName(
    "Open task: Middle task in a-deliberately-long-section-name-for-clipping",
  );
  await expect(rows.first()).toBeFocused();

  await dialog.getByRole("button", { name: "Close task switcher" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("hands the Hint session to the switcher when its opener is chosen by Hint", { tag: "@desktop" }, async ({
  page,
}) => {
  const tasks = switcherTasks();
  await installSwitcherFixture(page, tasks);
  await page.goto("/tasks/switcher_oldest");
  // Hints wait for a loading Task, so this one has to finish loading.
  await emitTaskDetailBootstrap(page, switcherTaskDetail(tasks[2]));
  await expect(page.locator(".task-conversation-pane")).toBeVisible();
  await waitForActionHintTarget(page, "Switch task");

  const workspaceHints = await enterActionHints(page);
  const badge = workspaceHints.getByLabel(/ — Switch task$/);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());

  await expect(page.locator("caffold-task-switcher-dialog > dialog"))
    .toBeVisible();
  await expect(hintDialog(page)).toBeVisible();
  await hintCode(page, "Close task switcher");
  await hintCode(
    page,
    "Open task: Middle task in a-deliberately-long-section-name-for-clipping",
  );
});

test("keeps the only opener in the Task list header beside a Task on a wide touch screen", { tag: "@foldable" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(switcherOpeners(page)).toHaveCount(1);
  await expect(listSwitcherOpener(page)).toBeVisible();
  await expect(routeSwitcherOpener(page)).toBeHidden();

  await listSwitcherOpener(page).tap();
  const dialog = page.locator("caffold-task-switcher-dialog > dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: /^Open task: Middle task/ })
    .tap();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/switcher_middle$/);
  await expect(page.locator("caffold-task-detail")).toBeVisible();
});

test("offers no opener on a code surface, where the Task list is not shown", { tag: "@foldable" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest/review");
  const workspace = page.locator("caffold-task-workspace");
  await expect(workspace).toHaveAttribute("data-tasks-view", "detail");
  await expect(workspace).toHaveAttribute(
    "data-task-detail-presentation",
    "code",
  );
  await expect(page.locator("caffold-task-navigator")).toBeHidden();

  await expect(switcherOpeners(page)).toHaveCount(0);
});

test("keeps one opener, in the Task list header or beside Back", { tag: "@phone" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks");
  await expect(page.locator("caffold-task-navigator")).toBeVisible();
  await expect(switcherOpeners(page)).toHaveCount(1);
  await expect(listSwitcherOpener(page)).toBeVisible();

  for (const url of ["/tasks/switcher_oldest", "/tasks/new"]) {
    await page.goto(url);
    await expect(page.locator("caffold-task-navigator"), url).toBeHidden();
    await expect(page.locator(".task-workspace-back"), url).toBeVisible();
    await expect(switcherOpeners(page), url).toHaveCount(1);
    await expect(routeSwitcherOpener(page), url).toBeVisible();
  }
});

test("opens beside Back by tap, closes with its X, and jumps to the chosen Task", { tag: "@phone" }, async ({
  page,
}) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  const opener = routeSwitcherOpener(page);
  const dialog = page.locator("caffold-task-switcher-dialog > dialog");

  await opener.tap();
  await expect(dialog).toBeVisible();
  await expect(hintDialog(page)).toBeHidden();
  await dialog.getByRole("button", { name: "Close task switcher" }).tap();
  await expect(dialog).toBeHidden();

  await opener.tap();
  await dialog
    .getByRole("button", { name: /^Open task: Working task, finished long ago/ })
    .tap();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/switcher_newest$/);
  await expect(page.locator("caffold-task-detail")).toBeVisible();
});

test("stands beside Back the way the Task list header spaces its own buttons", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
  await installSwitcherFixture(page, switcherTasks());
  await page.goto("/tasks");
  await expect(listSwitcherOpener(page)).toBeVisible();
  const headerGap = await page
    .locator("caffold-task-navigator .task-list-primary-actions")
    .evaluate((actions) => {
      const switcher = actions
        .querySelector(":scope > .task-list-switcher")
        .getBoundingClientRect();
      const reorder = actions
        .querySelector(":scope > .task-list-reorder")
        .getBoundingClientRect();
      return reorder.left - switcher.right;
    });

  await page.goto("/tasks/switcher_oldest");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(routeSwitcherOpener(page)).toBeVisible();
  const layout = await page.locator("caffold-task-workspace").evaluate(
    (workspace) => {
      const back = workspace
        .querySelector(".task-workspace-back")
        .getBoundingClientRect();
      const switcher = workspace
        .querySelector(".task-workspace-switcher")
        .getBoundingClientRect();
      const title = workspace
        .querySelector("caffold-task-detail-summary h2")
        .getBoundingClientRect();
      const center = (box) => box.top + box.height / 2;
      return {
        gap: switcher.left - back.right,
        sizes: [back.width, back.height, switcher.width, switcher.height],
        controlCenterDelta: Math.abs(center(back) - center(switcher)),
        titleCenterDelta: Math.abs(center(switcher) - center(title)),
        titleClearance: title.left - switcher.right,
      };
    },
  );

  expect(layout.gap).toBeCloseTo(headerGap, 1);
  expect(new Set(layout.sizes).size).toBe(1);
  expect(layout.controlCenterDelta).toBeLessThanOrEqual(0.5);
  expect(layout.titleCenterDelta).toBeLessThanOrEqual(2);
  expect(layout.titleClearance).toBeGreaterThan(0);
  await captureReviewScreenshot(page, testInfo, "task-switcher-route-control");
});

test("draws its header the way the Markdown preview draws its header", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const tasks = switcherTasks();
  await installSwitcherFixture(page, tasks);
  await page.goto("/tasks/switcher_oldest");
  // The Markdown preview lives in a loaded Task's conversation.
  await emitTaskDetailBootstrap(page, switcherTaskDetail(tasks[2]));
  await expect(page.locator(".task-conversation-pane")).toBeVisible();

  const preview = page.locator("caffold-task-markdown-preview-dialog");
  await preview.evaluate((element) =>
    element.openMarkdown({ markdown: "# Reference" }));
  const previewDialog = page.locator(
    "caffold-task-markdown-preview-dialog > dialog",
  );
  await expect(previewDialog).toBeVisible();
  const reference = await dialogHeaderGeometry(previewDialog, {
    header: ".task-markdown-preview-header",
    title: ".task-markdown-preview-title",
    close: ".task-markdown-preview-close",
  });
  await previewDialog
    .getByRole("button", { name: "Close Markdown preview" })
    .click();
  await expect(previewDialog).toBeHidden();

  await switcherOpeners(page).click();
  const dialog = page.locator("caffold-task-switcher-dialog > dialog");
  await expect(dialog).toBeVisible();
  const header = await dialogHeaderGeometry(dialog, {
    header: ".task-switcher-header",
    title: ".task-switcher-title",
    close: ".task-switcher-close",
  });

  expect(header).toEqual(reference);
  await captureReviewScreenshot(page, testInfo, "task-switcher-header");
});

async function openSwitcher(page, { hints = true } = {}) {
  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(surface).toBeFocused();
  await page.keyboard.press("t");
  const dialog = page.locator("caffold-task-switcher-dialog > dialog");
  await expect(dialog).toBeVisible();
  if (hints) {
    await expect(hintDialog(page)).toBeVisible();
  }
  return dialog;
}

function hintDialog(page) {
  return page.locator(
    "caffold-task-switcher-dialog caffold-action-hint-dialog > dialog",
  );
}

function hintBadges(page) {
  return hintDialog(page).locator("button[data-action-hint-code]");
}

async function visibleHintLabels(page) {
  return hintBadges(page).evaluateAll((badges) =>
    badges.map((badge) => badge.getAttribute("aria-label")));
}

/**
 * Every row's badge sits in the leading gutter, clear of the title it names.
 *
 * The gutter is what keeps the two apart, so this checks the gap rather than
 * which side the badge chose. Close has a badge too, so each row finds its
 * own by name.
 */
async function badgesClearTitles(dialog, page) {
  const rows = await dialog.locator(".task-switcher-row").evaluateAll(
    (elements) => elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      titleStart: element
        .querySelector(".task-switcher-row-title")
        .getBoundingClientRect().left,
    })),
  );
  const badges = await hintBadges(page).evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.getAttribute("aria-label"),
      right: element.getBoundingClientRect().right,
    })));
  return rows.every(({ label, titleStart }) => {
    const badge = badges.find((candidate) =>
      candidate.label.endsWith(` — ${label}`));
    return Boolean(badge) && badge.right <= titleStart;
  });
}

async function hintCode(page, accessibleName) {
  const badge = hintDialog(page).getByLabel(accessibleName);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  return code;
}

/** Every opener a person can see right now; hidden ones are not buttons to them. */
function switcherOpeners(page) {
  return page
    .locator("caffold-task-workspace")
    .getByRole("button", { name: "Switch task", exact: true });
}

function listSwitcherOpener(page) {
  return page.locator(
    "caffold-task-navigator .task-list-primary-header .task-list-switcher",
  );
}

function routeSwitcherOpener(page) {
  return page.locator(
    "caffold-task-workspace > .task-workspace-route-controls > .task-workspace-switcher",
  );
}

/** Header boxes measured from the dialog's own edges, so widths can differ. */
async function dialogHeaderGeometry(dialog, selectors) {
  return dialog.evaluate((element, { header, title, close }) => {
    const round = (value) => Math.round(value * 100) / 100;
    const box = element.getBoundingClientRect();
    const headerBox = element.querySelector(header).getBoundingClientRect();
    const titleElement = element.querySelector(title);
    const titleBox = titleElement.getBoundingClientRect();
    const titleStyle = getComputedStyle(titleElement);
    const closeBox = element.querySelector(close).getBoundingClientRect();
    return {
      headerTop: round(headerBox.top - box.top),
      headerHeight: round(headerBox.height),
      titleStart: round(titleBox.left - box.left),
      titleCenter: round(titleBox.top + titleBox.height / 2 - headerBox.top),
      titleType: [
        titleStyle.fontSize,
        titleStyle.fontWeight,
        titleStyle.lineHeight,
      ],
      closeSize: [round(closeBox.width), round(closeBox.height)],
      closeEnd: round(box.right - closeBox.right),
      closeCenter: round(closeBox.top + closeBox.height / 2 - headerBox.top),
    };
  }, selectors);
}

const LONG_SECTION =
  "frontend/tests/e2e/fixtures/home/a-deliberately-long-section-name-for-clipping";

function switcherTasks() {
  return [
    switcherTask("switcher_newest", "Working task, finished long ago", {
      recencyMs: NOW + 3_000,
      lastCompletedMs: NOW - 500_000,
      state: canonicalTaskState("active"),
    }),
    switcherTask("switcher_middle", "Middle task", {
      recencyMs: NOW + 2_000,
      lastCompletedMs: NOW + 2_000,
      cwdPath: LONG_SECTION,
    }),
    switcherTask("switcher_oldest", "Oldest task", {
      recencyMs: NOW + 1_000,
      lastCompletedMs: NOW + 1_000,
      unseen: true,
    }),
  ];
}

function manySwitcherTasks(count) {
  return Array.from({ length: count }, (_, index) =>
    switcherTask(`switcher_${`${index}`.padStart(2, "0")}`, `Task ${index}`, {
      recencyMs: NOW - index,
      lastCompletedMs: NOW - index,
    }));
}

function switcherHud(page) {
  return page.locator(
    "caffold-task-switcher-dialog > dialog > " +
      "caffold-keyboard-navigation-presentation caffold-scroll-mode-hud",
  );
}

function switcherScrollSelector(page) {
  return page.locator(
    "caffold-task-switcher-dialog > dialog > " +
      "caffold-keyboard-navigation-presentation " +
      "caffold-scroll-surface-selector > dialog:modal",
  );
}

function switcherTask(threadId, title, {
  recencyMs,
  lastCompletedMs,
  state = canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  cwdPath = "frontend/tests/e2e/fixtures/home",
  unseen = false,
} = {}) {
  return {
    id: threadId,
    threadId,
    ...state,
    title,
    preview: `${title} preview`,
    cwd: cwdPath,
    cwdPath,
    relativeCwd: "",
    worktree: null,
    createdMs: NOW,
    updatedMs: recencyMs,
    recencyMs,
    lastCompletedMs,
    lastEventSummary: `${title} summary`,
    unseen,
  };
}

function deferredTaskList() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function installSwitcherFixture(page, tasks, {
  onTaskListRequest = () => {},
  holdTaskList = null,
} = {}) {
  await installEventSourceMock(page, {
    sourceKey: "__taskListEventSource",
    autoOpen: true,
  });
  await mockAgentModels(page);
  await page.route(/\/api\/agent\/permissions(?:\?|$)/, (route) =>
    route.fulfill({ json: TASK_PERMISSION_FIXTURE }),
  );
  await page.route(/\/api\/current-plan(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    return route.fulfill({
      json: { status: "absent", watchPath: path, plan: null, problems: [] },
    });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    onTaskListRequest();
    if (holdTaskList) {
      await holdTaskList;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    });
  });
  await page.route(
    /\/api\/tasks\/(?!archived(?:[/?]|$))([^/?]+)(?:\?|$)/,
    (route) => {
      const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
      const task = tasks.find((candidate) => candidate.threadId === threadId);
      return route.fulfill({
        status: task ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          task ? switcherTaskDetail(task) : { error: "Task not found" },
        ),
      });
    },
  );
}

function switcherTaskDetail(task) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events: [],
    fileLinks: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
    permissionMode: "approveForMe",
  };
}
