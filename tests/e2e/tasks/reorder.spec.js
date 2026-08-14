import { expect, test } from "@playwright/test";
import { installBrowserDefaults, mockCodexStatus } from "../support/browser-defaults.js";
import {
  captureReviewScreenshot,
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
});

function task(threadId, title, cwdPath = "/workspace/one") {
  const now = Date.now();
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: cwdPath,
    cwdPath,
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: `${title} summary`,
  };
}

function projection(order, { recovery = [], secondSection = [] } = {}) {
  return {
    sections: [
      {
        id: "section-one",
        name: "/workspace/one",
        repository: false,
        tasks: order,
      },
      ...(secondSection.length
        ? [{
            id: "section-two",
            name: "/workspace/two",
            repository: false,
            tasks: secondSection,
          }]
        : []),
    ],
    unsectioned: recovery,
  };
}

function moveBefore(order, threadId, beforeThreadId) {
  const next = order.filter((item) => item.threadId !== threadId);
  const taskToMove = order.find((item) => item.threadId === threadId);
  const index = beforeThreadId
    ? next.findIndex((item) => item.threadId === beforeThreadId)
    : next.length;
  next.splice(index, 0, taskToMove);
  return next;
}

async function threadOrder(page, sectionId = "section-one") {
  return page
    .locator(
      `caffold-active-task-list .task-repository-group[data-task-repository-key="${sectionId}"] > .task-list > li`,
    )
    .evaluateAll((rows) => rows.map((row) => row.dataset.threadId));
}

test("reorders by keyboard, preserves row geometry, and persists across reloads", async ({
  page,
}, testInfo) => {
  await mockCodexModels(page);
  let order = [
    task("thread-a", "Alpha"),
    task("thread-b", "Bravo"),
    task("thread-c", "Charlie"),
  ];
  const secondSection = [task("thread-d", "Delta", "/workspace/two")];
  const recovery = [{
    ...task("thread-recovery", "Recovery"),
    conversationAvailable: false,
    recovery: { reason: "threadMissing" },
  }];
  const moves = [];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order, { recovery, secondSection })),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    moves.push({ threadId, ...body });
    order = moveBefore(order, threadId, body.beforeThreadId);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  const navigator = page.locator("caffold-task-navigator");
  const toggle = navigator.getByRole("button", { name: "Reorder Tasks" });
  const firstRow = navigator.locator('.task-row[data-thread-id="thread-a"]');
  await expect(firstRow).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "tasks-reorder-normal");
  const normalMetrics = await firstRow.evaluate((row) => {
    const title = row.querySelector(".task-row-title").getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return { height: bounds.height, titleLeft: title.left, titleWidth: title.width };
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const headerActionGap = await navigator.evaluate((element) => {
    const [reorder, create] = element.querySelectorAll(
      ".task-list-primary-actions > .task-list-header-action",
    );
    const reorderBounds = reorder.getBoundingClientRect();
    const createBounds = create.getBoundingClientRect();
    const reorderStyle = getComputedStyle(reorder, "::before");
    const createStyle = getComputedStyle(create, "::before");
    const reorderRightInset = Number.parseFloat(reorderStyle.right) || 0;
    const createLeftInset = Number.parseFloat(createStyle.left) || 0;
    return createBounds.left + createLeftInset -
      (reorderBounds.right - reorderRightInset);
  });
  expect(headerActionGap).toBeGreaterThanOrEqual(8);
  await expect(toggle.evaluate((button) =>
    button.compareDocumentPosition(
      button.parentElement.querySelector(".task-list-new-task"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING
  )).resolves.toBeTruthy();

  const entryMotion = await toggle.evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const navigator = button.closest("caffold-task-navigator");
    const count = navigator.querySelector(".task-repository-count");
    const icon = navigator.querySelector(".task-reorder-handle-icon");
    return {
      countOpacity: getComputedStyle(count).opacity,
      countTransitionDuration: getComputedStyle(count).transitionDuration,
      iconTransitions: icon.getAnimations()
        .map((animation) => animation.transitionProperty)
        .filter(Boolean)
        .sort(),
    };
  });
  expect(entryMotion).toEqual({
    countOpacity: "0",
    countTransitionDuration: "0s",
    iconTransitions: ["opacity", "translate"],
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const toggleMotion = await toggle
    .locator(".task-action-icon")
    .evaluate((icon) =>
      [...icon.children].map((part) => {
        const style = getComputedStyle(part);
        const animation = part.getAnimations().find(
          (candidate) => candidate.animationName === "task-reorder-arrow-shift",
        );
        return {
          duration: animation?.effect.getTiming().duration,
          iterations: animation?.effect.getTiming().iterations,
          keyframeOffsets: animation?.effect.getKeyframes().map(
            (keyframe) => keyframe.offset,
          ),
          offset: style.getPropertyValue("--task-reorder-arrow-offset").trim(),
        };
      })
    );
  expect(toggleMotion).toEqual([
    {
      duration: 1500,
      iterations: Infinity,
      keyframeOffsets: [0, 0.333333, 0.666667, 1],
      offset: "3px",
    },
    {
      duration: 1500,
      iterations: Infinity,
      keyframeOffsets: [0, 0.333333, 0.666667, 1],
      offset: "3px",
    },
    {
      duration: 1500,
      iterations: Infinity,
      keyframeOffsets: [0, 0.333333, 0.666667, 1],
      offset: "-3px",
    },
    {
      duration: 1500,
      iterations: Infinity,
      keyframeOffsets: [0, 0.333333, 0.666667, 1],
      offset: "-3px",
    },
  ]);
  await expect(toggle.evaluate((button) => {
    const navigator = button.closest("caffold-task-navigator");
    const icon = button.querySelector(":scope > .task-action-icon");
    const animation = icon.firstElementChild.getAnimations()[0];
    navigator.render();
    const renderedIcon = button.querySelector(":scope > .task-action-icon");
    return {
      sameAnimation:
        animation === renderedIcon.firstElementChild.getAnimations()[0],
      sameIcon: icon === renderedIcon,
    };
  })).resolves.toEqual({ sameAnimation: true, sameIcon: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle.locator(".task-action-icon").evaluate((icon) =>
    [...icon.children].flatMap((part) => part.getAnimations()).length
  )).resolves.toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    navigator.locator(
      '.task-repository-group[data-task-repository-key="section-one"] .task-reorder-handle',
    ),
  ).toHaveCount(3);
  await expect(
    navigator.locator(
      '.task-repository-group[data-task-repository-key="section-two"] .task-reorder-handle',
    ),
  ).toHaveCount(1);
  await expect(
    navigator.locator(
      '.task-repository-group[data-task-repository-key="unsectioned"] .task-reorder-handle',
    ),
  ).toHaveCount(0);
  await expect(
    navigator.locator('.task-row[data-thread-id="thread-a"] .task-row-meta'),
  ).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "tasks-reorder-active");
  const handleAlignment = await navigator
    .locator('.task-row[data-thread-id="thread-a"]')
    .evaluate((row) => {
      const indicators = row.querySelector(".task-row-indicators")
        .getBoundingClientRect();
      const handle = row.querySelector(".task-reorder-handle")
        .getBoundingClientRect();
      const handleIcon = row.querySelector(".task-reorder-handle-icon")
        .getBoundingClientRect();
      return {
        iconCenter: handleIcon.left + handleIcon.width / 2,
        indicatorCenter: indicators.left + indicators.width / 2,
        handleLeft: handle.left,
        handleRight: handle.right,
        indicatorLeft: indicators.left,
        indicatorRight: indicators.right,
      };
    });
  expect(Math.abs(handleAlignment.iconCenter - handleAlignment.indicatorCenter))
    .toBeLessThan(0.6);
  expect(Math.abs(handleAlignment.handleLeft - handleAlignment.indicatorLeft))
    .toBeLessThan(0.6);
  expect(Math.abs(handleAlignment.handleRight - handleAlignment.indicatorRight))
    .toBeLessThan(0.6);
  const reorderMetrics = await navigator
    .locator('.task-row[data-thread-id="thread-a"]')
    .evaluate((row) => {
      const title = row.querySelector(".task-row-title").getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return { height: bounds.height, titleLeft: title.left, titleWidth: title.width };
    });
  expect(reorderMetrics).toEqual(normalMetrics);
  expect(Math.round(reorderMetrics.height)).toBe(
    testInfo.project.name === "desktop" ? 32 : 36,
  );
  await expect(navigator.evaluate((element) =>
    element.scrollWidth <= element.clientWidth
  )).resolves.toBe(true);
  const returnMotion = await toggle.evaluate(async (button) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const navigator = button.closest("caffold-task-navigator");
    const count = navigator.querySelector(".task-repository-count");
    const indicators = navigator.querySelector(
      ".task-row-indicators:not(.task-row-reorder-slot)",
    );
    const transitionProperties = (element) => element.getAnimations()
      .map((animation) => animation.transitionProperty)
      .filter(Boolean)
      .sort();
    return {
      countTransitionDuration: getComputedStyle(count).transitionDuration,
      countTransitions: transitionProperties(count),
      indicatorTransitionDuration: getComputedStyle(indicators).transitionDuration,
      indicatorTransitions: transitionProperties(indicators),
    };
  });
  expect(returnMotion).toEqual({
    countTransitionDuration: "0.12s",
    countTransitions: ["opacity"],
    indicatorTransitionDuration: "0.12s",
    indicatorTransitions: ["opacity"],
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await navigator.locator("caffold-active-task-list").evaluate((list, update) => {
    list.handleStreamEvent("task-updated", {
      data: JSON.stringify(update),
    });
  }, {
    ...order[0],
    ...canonicalTaskState("active", {
      turnId: "turn-alpha",
      startedAtMs: Date.now(),
      latestTurnStatus: "inProgress",
    }),
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(
    navigator.locator('.task-row[data-thread-id="thread-a"] .task-reorder-handle'),
  ).toBeVisible();
  await expect(
    navigator.locator('.task-row[data-thread-id="thread-a"] .task-status-spinner'),
  ).toHaveCount(0);
  order = order.map((item) =>
    item.threadId === "thread-a"
      ? { ...item, ...canonicalTaskState("notLoaded") }
      : item
  );

  const bravoHandle = navigator.getByRole("button", {
    name: /Reorder Bravo\./,
  });
  await page.waitForTimeout(180);
  const activeList = navigator.locator("caffold-active-task-list");
  await activeList.evaluate((element) => {
    const group = element.querySelector(
      '.task-repository-group[data-task-repository-key="section-one"]',
    );
    const rows = [...group.querySelectorAll(":scope > .task-list > li")];
    const components = rows.map((row) =>
      row.querySelector(":scope > caffold-active-task-row")
    );
    const handles = components.map((component) =>
      component.querySelector(".task-reorder-handle")
    );
    const handleIcons = handles.map((handle) =>
      handle.querySelector(".task-reorder-handle-icon")
    );
    const taskList = group.querySelector(":scope > .task-list");
    element.__reorderDom = {
      group,
      header: group.querySelector(":scope > .task-repository-header"),
      label: group.querySelector(":scope > .task-repository-header > .task-repository-label"),
      count: group.querySelector(":scope > .task-repository-header > .task-repository-count"),
      rows: Object.fromEntries(rows.map((row) => [row.dataset.threadId, row])),
      components: Object.fromEntries(
        rows.map((row, index) => [row.dataset.threadId, components[index]]),
      ),
      handles: Object.fromEntries(
        rows.map((row, index) => [row.dataset.threadId, handles[index]]),
      ),
      handleIcons: Object.fromEntries(
        rows.map((row, index) => [row.dataset.threadId, handleIcons[index]]),
      ),
      transitionRestarts: 0,
      addedRows: [],
      removedRows: [],
    };
    for (const icon of handleIcons) {
      icon.addEventListener("transitionrun", () => {
        element.__reorderDom.transitionRestarts += 1;
      });
    }
    new MutationObserver((records) => {
      for (const record of records) {
        element.__reorderDom.addedRows.push(
          ...[...record.addedNodes]
            .filter((node) => node instanceof HTMLElement)
            .map((row) => row.dataset.threadId),
        );
        element.__reorderDom.removedRows.push(
          ...[...record.removedNodes]
            .filter((node) => node instanceof HTMLElement)
            .map((row) => row.dataset.threadId),
        );
      }
    }).observe(taskList, { childList: true });
  });
  await bravoHandle.focus();
  await bravoHandle.press("ArrowUp");
  await expect.poll(() => moves).toEqual([
    { threadId: "thread-b", beforeThreadId: "thread-a" },
  ]);
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-a",
    "thread-c",
  ]);
  await expect(activeList.evaluate((element) => {
    const group = element.querySelector(
      '.task-repository-group[data-task-repository-key="section-one"]',
    );
    const stable = element.__reorderDom;
    const rows = [...group.querySelectorAll(":scope > .task-list > li")];
    return {
      group: group === stable.group,
      header: group.querySelector(":scope > .task-repository-header") === stable.header,
      label: group.querySelector(":scope > .task-repository-header > .task-repository-label") === stable.label,
      count: group.querySelector(":scope > .task-repository-header > .task-repository-count") === stable.count,
      rows: rows.every((row) => row === stable.rows[row.dataset.threadId]),
      components: rows.every((row) =>
        row.querySelector(":scope > caffold-active-task-row") ===
          stable.components[row.dataset.threadId]
      ),
      handles: rows.every((row) =>
        row.querySelector(".task-reorder-handle") ===
          stable.handles[row.dataset.threadId]
      ),
      handleIcons: rows.every((row) =>
        row.querySelector(".task-reorder-handle-icon") ===
          stable.handleIcons[row.dataset.threadId]
      ),
      transitionRestarts: stable.transitionRestarts,
      addedRows: stable.addedRows,
      removedRows: stable.removedRows,
    };
  })).resolves.toEqual({
    group: true,
    header: true,
    label: true,
    count: true,
    rows: true,
    components: true,
    handles: true,
    handleIcons: true,
    transitionRestarts: 0,
    addedRows: ["thread-b"],
    removedRows: ["thread-b"],
  });
  await expect(
    navigator.locator(".task-reorder-announcement"),
  ).toContainText("Bravo moved to position 1 of 3 in one.");
  await expect(bravoHandle).toBeFocused();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(navigator.locator(".task-reorder-handle")).toHaveCount(0);
  await expect(
    navigator.locator('.task-row[data-thread-id="thread-a"] .task-status-spinner'),
  ).toBeVisible();
  await page.reload();
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-a",
    "thread-c",
  ]);
  const reloadedToggle = page.locator(
    "caffold-task-navigator .task-list-reorder",
  );
  await reloadedToggle.click();
  await page.getByRole("button", { name: "New Task" }).click();
  await expect(reloadedToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/\/tasks\/new/);
});

test("starts pointer reordering only from a handle and keeps moves inside a Section", async ({
  page,
}) => {
  let order = [
    task("thread-a", "Alpha"),
    task("thread-b", "Bravo"),
    task("thread-c", "Charlie"),
  ];
  const secondSection = [task("thread-d", "Delta", "/workspace/two")];
  const moves = [];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order, { secondSection })),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    moves.push({ threadId, ...body });
    order = moveBefore(order, threadId, body.beforeThreadId);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  const alphaRow = page.locator('.task-row[data-thread-id="thread-a"]');
  const charlieRow = page.locator('.task-row[data-thread-id="thread-c"]');
  await charlieRow.dragTo(alphaRow);
  expect(moves).toEqual([]);
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-a",
    "thread-b",
    "thread-c",
  ]);

  await page.getByRole("button", { name: "Reorder Tasks" }).click();
  const handle = page.getByRole("button", { name: /Reorder Charlie\./ });
  const handleBounds = await handle.boundingBox();
  const alphaBounds = await alphaRow.boundingBox();
  await page.mouse.move(
    handleBounds.x + 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await expect(handle.evaluate((element) =>
    Boolean(element.closest("caffold-active-task-row").pointerGesture)
  )).resolves.toBe(true);
  await page.mouse.move(
    alphaBounds.x + alphaBounds.width / 2,
    alphaBounds.y + 2,
    { steps: 5 },
  );
  await expect(page.locator("caffold-active-task-list").evaluate((element) => ({
    threadId: element.dragState?.threadId,
    beforeThreadId: element.dragState?.beforeThreadId,
  }))).resolves.toEqual({
    threadId: "thread-c",
    beforeThreadId: "thread-a",
  });
  await page.mouse.up();
  await expect.poll(() => moves).toEqual([
    { threadId: "thread-c", beforeThreadId: "thread-a" },
  ]);
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-c",
    "thread-a",
    "thread-b",
  ]);
  await expect.poll(() => threadOrder(page, "section-two")).toEqual([
    "thread-d",
  ]);
});

test("reconciles an optimistic move to a newer canonical order", async ({
  page,
}) => {
  let order = [
    task("thread-a", "Alpha"),
    task("thread-b", "Bravo"),
    task("thread-c", "Charlie"),
  ];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order)),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    order = [order[0], order[2], order[1]];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Reorder Tasks" }).click();
  await page.getByRole("button", { name: /Reorder Bravo\./ }).press("ArrowUp");

  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-a",
    "thread-c",
    "thread-b",
  ]);
});

test("keeps reordering functional without state-preserving DOM moves", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "moveBefore", {
      configurable: true,
      value: undefined,
    });
  });
  let order = [
    task("thread-a", "Alpha"),
    task("thread-b", "Bravo"),
    task("thread-c", "Charlie"),
  ];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order)),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    order = moveBefore(order, threadId, body.beforeThreadId);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Reorder Tasks" }).click();
  await expect(
    page.locator("caffold-active-task-list").evaluate(
      (element) => typeof element.moveBefore,
    ),
  ).resolves.toBe("undefined");
  await page.getByRole("button", { name: /Reorder Bravo\./ }).press("ArrowUp");
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-a",
    "thread-c",
  ]);
});

test("preserves touch scrolling away from handles and drags from a handle", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "requires a touch viewport");
  let order = Array.from({ length: 24 }, (_, index) =>
    task(`thread-${index}`, `Task ${index}`)
  );
  const moves = [];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order)),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    moves.push({ threadId, ...body });
    order = moveBefore(order, threadId, body.beforeThreadId);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Reorder Tasks" }).click();
  const scroller = page.locator("caffold-task-navigator .task-list-scroll");
  const scrollerBounds = await scroller.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, x, y) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd"
        ? []
        : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
  };

  const scrollX = scrollerBounds.x + 80;
  const scrollStartY = scrollerBounds.y + scrollerBounds.height - 60;
  await touch("touchStart", scrollX, scrollStartY);
  for (const distance of [30, 70, 110, 150]) {
    await touch("touchMove", scrollX, scrollStartY - distance);
  }
  await touch("touchEnd", scrollX, scrollStartY - 150);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(moves).toEqual([]);

  await page.reload();
  await page.getByRole("button", { name: "Reorder Tasks" }).click();
  const source = page.getByRole("button", { name: /Reorder Task 2\./ });
  const target = page.locator('.task-row[data-thread-id="thread-0"]');
  const sourceBounds = await source.boundingBox();
  const targetBounds = await target.boundingBox();
  const sourceX = sourceBounds.x + 2;
  const sourceY = sourceBounds.y + sourceBounds.height / 2;
  const targetY = targetBounds.y + 2;
  await touch("touchStart", sourceX, sourceY);
  for (const ratio of [0.25, 0.5, 0.75, 1]) {
    await touch(
      "touchMove",
      sourceX,
      sourceY + (targetY - sourceY) * ratio,
    );
  }
  await touch("touchEnd", sourceX, targetY);
  await expect.poll(() => moves).toEqual([
    { threadId: "thread-2", beforeThreadId: "thread-0" },
  ]);
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-2",
    ...Array.from({ length: 24 }, (_, index) => `thread-${index}`).filter(
      (threadId) => threadId !== "thread-2",
    ),
  ]);
});

test("serializes moves and restores canonical order with a retryable error", async ({
  page,
}, testInfo) => {
  const longTitle =
    "Charlie with an exceptionally long Task title that does not fit in the navigator";
  let order = [
    task("thread-a", "Alpha"),
    task("thread-b", "Bravo"),
    task("thread-c", longTitle),
  ];
  let releaseFirstMove;
  const firstMoveGate = new Promise((resolve) => {
    releaseFirstMove = resolve;
  });
  let requestCount = 0;
  let failNext = false;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order)),
    })
  );
  await page.route(/\/api\/tasks\/([^/?]+)\/reorder$/, async (route) => {
    requestCount += 1;
    const threadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const body = route.request().postDataJSON();
    if (requestCount === 1) {
      await firstMoveGate;
    }
    if (failNext) {
      failNext = false;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "task_reorder_conflict", message: "Order changed. Try again." },
        }),
      });
    }
    order = moveBefore(order, threadId, body.beforeThreadId);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, ...body, changed: true }),
    });
  });

  await page.goto("/");
  const toggle = page.locator("caffold-task-navigator .task-list-reorder");
  await toggle.click();
  const bravo = page.getByRole("button", { name: /Reorder Bravo\./ });
  const charlie = page.locator(
    'li[data-thread-id="thread-c"] .task-reorder-handle',
  );
  await bravo.press("ArrowUp");
  await expect.poll(() => requestCount).toBe(1);
  await expect(bravo).toBeDisabled();
  await charlie.dispatchEvent("keydown", { key: "ArrowUp" });
  expect(requestCount).toBe(1);
  releaseFirstMove();
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-a",
    "thread-c",
  ]);
  await expect(charlie).toBeEnabled();

  failNext = true;
  await charlie.press("ArrowUp");
  const error = page.getByRole("alert");
  await expect(error).toContainText("Move wasn't saved. Move it again to retry.");
  await expect(error.locator(".sr-only")).toContainText(longTitle);
  await expect(error).not.toContainText("Order changed. Try again.");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.locator("caffold-task-navigator").evaluate((element) =>
    element.scrollWidth <= element.clientWidth
  )).resolves.toBe(true);
  await captureReviewScreenshot(page, testInfo, "tasks-reorder-failure");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-a",
    "thread-c",
  ]);
  await charlie.press("ArrowUp");
  await expect.poll(() => threadOrder(page)).toEqual([
    "thread-b",
    "thread-c",
    "thread-a",
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps local reordering available while Codex is unavailable and exits on navigation", async ({
  page,
}) => {
  const order = [task("thread-a", "Alpha"), task("thread-b", "Bravo")];
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus({
        readiness: {
          state: "error",
          blocksTaskOperations: true,
          reasonCode: "appServerUnavailable",
          diagnosticMessage: "Codex is unavailable.",
        },
      })),
    })
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(projection(order)),
    })
  );

  await page.goto("/");
  const toggle = page.locator("caffold-task-navigator .task-list-reorder");
  await expect(toggle).toBeEnabled();
  await toggle.evaluate((button) => button.click());
  await expect(page.locator(".task-reorder-handle")).toHaveCount(2);
  await page.evaluate(() => {
    document
      .querySelector("caffold-task-workspace")
      .prepareRoute({ kind: "settings", section: "appearance" });
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
