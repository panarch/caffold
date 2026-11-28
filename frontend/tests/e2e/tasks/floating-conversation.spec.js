import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  badgeAtRowEndMiddle,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { isScrolledToBottom } from "../support/task-fixtures.js";
import {
  floatingConversationRoom,
  openCompletedTaskForReview,
} from "../support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

// Opens the completed Task's Working Tree at planner.rs, whose short diff ends
// with the adjacent file cards.
async function openWorkingTreeFile(page, options = {}) {
  const opened = await openCompletedTaskForReview(page, options);
  const { tasksPage, taskReview } = opened;
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(viewer).toContainText("new planner behavior");
  const floating = page.locator("caffold-task-detail-floating-conversation");
  return {
    ...opened,
    viewer,
    floating,
    openButton: floating.getByRole("button", { name: "Show the conversation" }),
    card: floating.locator(".floating-conversation-card"),
    header: floating.locator(".floating-conversation-header"),
    taskDetail: page.locator("caffold-task-detail"),
  };
}

// Records in the page, as each one starts, every request that marks a Task
// seen.
async function recordSeenMarks(page) {
  await page.addInitScript(() => {
    window.__seenMarks = [];
    const fetchBefore = window.fetch;
    window.fetch = (input, init = {}) => {
      const url = new URL(
        input instanceof Request ? input.url : `${input}`,
        window.location.href,
      );
      if (
        `${init.method ?? "GET"}`.toUpperCase() === "PUT" &&
        url.pathname.endsWith("/seen")
      ) {
        window.__seenMarks.push(url.pathname);
      }
      return fetchBefore.call(window, input, init);
    };
  });
}

function seenMarks(page) {
  return page.evaluate(() => window.__seenMarks);
}

// The server records the mark and answers with the Task seen.
async function answerSeenMarks(page, taskScenario) {
  await page.route(`**/api/tasks/${taskScenario.threadId}/seen`, (route) =>
    route.fulfill({ json: { ...taskScenario.task, unseen: false } }),
  );
}

// The Task's state as its viewers hear it from the server, renamed so the
// header shows when Task Detail has taken it.
async function emitTaskState(page, taskScenario, { revision, title, unseen }) {
  await page.evaluate(
    (state) =>
      window.__caffoldTaskSse.source(state.threadId).emit("task-state", state),
    {
      threadId: taskScenario.threadId,
      revision,
      task: { ...taskScenario.task, title, unseen },
    },
  );
  // Task Detail decides whether to mark the Task seen as it takes the state,
  // before the header draws the new title.
  await expect(page.locator(".task-detail-summary")).toContainText(title);
}

// A turn of the open Task finishes behind the folded card.
function finishTurnUnseen(page, taskScenario) {
  return emitTaskState(page, taskScenario, {
    revision: 50,
    title: "Planner changes reviewed",
    unseen: true,
  });
}

// A phone's sheet slides up as it opens; geometry is read once it is in place.
function settled(locator) {
  return locator.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

// The elements under a point, through every open shadow root.
function hitTags(page, x, y) {
  return page.evaluate(
    ([pointX, pointY]) => {
      const tags = [];
      let element = document.elementFromPoint(pointX, pointY);
      while (element) {
        tags.push(element.tagName);
        const inner = element.shadowRoot?.elementFromPoint(pointX, pointY);
        element = inner && inner !== element ? inner : null;
      }
      return tags;
    },
    [x, y],
  );
}

// The element that has focus, through every open shadow root.
function deepFocus(page) {
  return page.evaluate(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active
      ? { tag: active.tagName, className: `${active.className ?? ""}` }
      : null;
  });
}

// The Detail body the card floats in, the root size, and the card's inset
// from the body's edges.
async function bodyRoom(page) {
  const [body, rem] = await Promise.all([
    page.locator("caffold-detail-layout .detail-layout-body").boundingBox(),
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ]);
  return { body, rem, inset: 0.75 * rem };
}

// Drags the card's resize handle by the given distance.
async function dragHandle(page, handle, dx, dy) {
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test("shows the conversation button only on screens that show a file", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { tasksPage, openButton, floating } = await openWorkingTreeFile(page);
  await expect(openButton).toBeVisible();

  await tasksPage.getByRole("button", { name: "Branch", exact: true }).click();
  await expect(openButton).toBeVisible();

  // On the Conversation screen the conversation is the screen itself.
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(openButton).toBeHidden();
  await expect(floating).toHaveAttribute("data-presentation", "docked");
  await expect(page.locator("caffold-task-conversation")).toBeVisible();
});

test("opens the Task's own conversation over the file without moving the code", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { viewer, openButton, card, header, taskDetail, floating } =
    await openWorkingTreeFile(page);
  await taskDetail.evaluate((element) => {
    element.dataset.floatingProbe = "kept";
  });
  const line = viewer.locator("caffold-diff-viewer").getByText("new planner behavior");
  const [viewerBefore, lineBefore] = await Promise.all([
    viewer.boundingBox(),
    line.boundingBox(),
  ]);

  await openButton.click();
  await expect(card).toBeVisible();
  await settled(card);
  await expect(openButton).toBeHidden();
  await expect(floating).toHaveAttribute("data-open", "");
  // The same Task area shows in the card, with its conversation awake.
  await expect(taskDetail).toHaveAttribute("data-floating-probe", "kept");
  await expect(taskDetail.locator("caffold-task-conversation")).toBeVisible();
  await expect(taskDetail.locator("caffold-task-composer")).toBeVisible();
  // The person opened it to read, so their focus waits on its header, whose
  // title carries the conversation's icon.
  await expect(header).toBeFocused();
  await expect(header.locator(".floating-conversation-title-icon")).toBeVisible();

  const [viewerAfter, lineAfter] = await Promise.all([
    viewer.boundingBox(),
    line.boundingBox(),
  ]);
  expect(viewerAfter).toEqual(viewerBefore);
  expect(lineAfter).toEqual(lineBefore);

  const viewport = page.viewportSize();
  const cardBox = await card.boundingBox();
  if (testInfo.project.name === "phone") {
    // A sheet over the whole screen, with the keyboard left down.
    expect(cardBox.x).toBe(0);
    expect(cardBox.width).toBe(viewport.width);
    expect(Math.abs(cardBox.y + cardBox.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(cardBox.y).toBeLessThan(24);
    expect((await deepFocus(page))?.tag).not.toBe("TEXTAREA");
    // A phone does not resize it.
    await expect(floating.locator(".floating-conversation-resize")).toHaveCount(0);
    // It covers the Detail header and the workspace's corner controls.
    expect(await hitTags(page, viewport.width / 2, cardBox.y + 30)).toContain(
      "CAFFOLD-TASK-DETAIL-FLOATING-CONVERSATION",
    );
    expect(await hitTags(page, 24, cardBox.y + 30)).toContain(
      "CAFFOLD-TASK-DETAIL-FLOATING-CONVERSATION",
    );
  } else {
    // A card at the bottom right of the Detail body. Until the person
    // resizes it, it takes a third of the body's width and two thirds of its
    // height, never less than 25rem by 32.5rem: a desktop's width and a
    // foldable's size stay at those.
    const { body, rem, inset } = await bodyRoom(page);
    expect(Math.abs(body.x + body.width - (cardBox.x + cardBox.width) - inset)).toBeLessThanOrEqual(1);
    expect(Math.abs(body.y + body.height - (cardBox.y + cardBox.height) - inset)).toBeLessThanOrEqual(1);
    expect(Math.abs(cardBox.width - Math.min(
      Math.max(25 * rem, body.width / 3),
      body.width - 2 * inset,
    ))).toBeLessThanOrEqual(1);
    expect(Math.abs(cardBox.height - Math.min(
      Math.max(32.5 * rem, (body.height * 2) / 3),
      body.height - 2 * inset,
    ))).toBeLessThanOrEqual(1);
  }
});

// Task Detail hears of an opening only once the card shows: WebKit drops a
// hidden scrollport's position and reports the drop as a scroll. Drawn for the
// first time in the card, the conversation then keeps following its end while
// its Markdown lengthens it.
test("opens at the end of the conversation, telling Task Detail once the card shows", { tag: ["@desktop", "@phone", "@webkit"] }, async ({
  page,
}) => {
  // The smallest card, so the conversation scrolls in it.
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:floating-conversation-size",
      JSON.stringify({ width: 340, height: 340 }),
    );
  });
  const { openButton, card, header, viewer } = await openWorkingTreeFile(page);
  // After a reload the conversation has never been on screen.
  await page.reload();
  await expect(viewer).toContainText("new planner behavior");
  await page.evaluate(() => {
    window.__toldWithCardShown = [];
    document.addEventListener("caffold:floating-conversation-change", (event) => {
      const floating = event.composedPath()[0];
      window.__toldWithCardShown.push([
        event.detail.open,
        floating.shadowRoot.querySelector(".floating-conversation-card").checkVisibility(),
      ]);
    });
  });
  const scroller = page.locator("caffold-task-conversation .task-conversation-scroll");

  await openButton.click();
  await expect(card).toBeVisible();
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
  expect(await scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(100);
  await header.click();
  await expect(card).toBeHidden();
  // A fold is told at once, while the conversation still shows its place.
  expect(await page.evaluate(() => window.__toldWithCardShown)).toEqual([
    [true, true],
    [false, true],
  ]);
});

test("folds from its header and with Escape", { tag: "@server-steady" }, async ({ page }) => {
  const { openButton, card, header, taskDetail } = await openWorkingTreeFile(page);

  await openButton.click();
  await expect(card).toBeVisible();
  await header.click();
  await expect(card).toBeHidden();
  await expect(openButton).toBeFocused();

  // Opened from the keyboard, the header shows its focus with the fill its
  // hover has, not an outline the card's corners would cut.
  await page.mouse.move(0, 0);
  await openButton.press("Enter");
  await expect(header).toBeFocused();
  expect(await header.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outline: style.outlineStyle,
      filled: style.backgroundColor !== "rgba(0, 0, 0, 0)",
    };
  })).toEqual({ focusVisible: true, outline: "none", filled: true });
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(openButton).toBeFocused();

  // In the Composer, Escape first leaves it for the card's header, then
  // folds the card.
  await openButton.press("Enter");
  await taskDetail.locator(".task-follow-up-form textarea").focus();
  await expect.poll(async () => (await deepFocus(page))?.tag).toBe("TEXTAREA");
  await page.keyboard.press("Escape");
  await expect(header).toBeFocused();
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(openButton).toBeFocused();
});

test("leaves Escape to a menu open in the card", { tag: "@server-steady" }, async ({ page }) => {
  const { openButton, card, taskDetail } = await openWorkingTreeFile(page);

  await openButton.click();
  await expect(card).toBeVisible();
  const options = taskDetail.locator(".task-follow-up-form caffold-task-turn-options");
  await options.locator(".task-model-button").click();
  const menu = options.locator(".task-model-popover");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(card).toBeVisible();
});

test("keeps the conversation open between file screens and folds it elsewhere", { tag: "@server-changes" }, async ({
  page,
}) => {
  const { tasksPage, taskReview, openButton, card } = await openWorkingTreeFile(page);

  await openButton.click();
  await expect(card).toBeVisible();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="lib.rs"]')
    .click();
  await expect(page).toHaveURL(/review\?file=lib\.rs/);
  await expect(card).toBeVisible();
  await tasksPage.getByRole("button", { name: "Branch", exact: true }).click();
  await expect(card).toBeVisible();

  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await expect(openButton).toBeVisible();
  await expect(card).toBeHidden();

  await openButton.click();
  await expect(card).toBeVisible();
  await page.reload();
  await expect(openButton).toBeVisible();
  await expect(card).toBeHidden();
});

test("folds the phone sheet when the route moves under it", { tag: "@phone" }, async ({ page }) => {
  const { taskReview, openButton, card } = await openWorkingTreeFile(page);

  await openButton.click();
  await expect(card).toBeVisible();
  await page.goBack();
  await expect(card).toBeHidden();
  await expect(taskReview.locator(".task-review-navigator-pane")).toBeVisible();
});

test("folds the phone sheet from its header and the dimmed sliver above it", { tag: "@phone" }, async ({ page }) => {
  const { openButton, card, header } = await openWorkingTreeFile(page);

  await openButton.click();
  await expect(card).toBeVisible();
  await settled(card);
  // No grip promises a pull the sheet does not answer.
  await expect(card.locator(".floating-conversation-handle")).toHaveCount(0);
  await header.click();
  await expect(card).toBeHidden();
  await expect(openButton).toBeVisible();

  await openButton.click();
  await expect(card).toBeVisible();
  await settled(card);
  const sheet = await card.boundingBox();
  await page.mouse.click(sheet.x + sheet.width / 2, sheet.y / 2);
  await expect(card).toBeHidden();
});

test("keeps the end of a file clear of the button, and the same with the card open", { tag: ["@desktop", "@phone"] }, async ({
  page,
}, testInfo) => {
  const { taskReview, openButton, card } = await openWorkingTreeFile(page);
  // The band of file cards reaches the bottom under the button; the cards in
  // it end above the button.
  const fileCard = taskReview
    .getByRole("navigation", { name: "Changed files" })
    .locator(".viewer-adjacent-file")
    .first();

  await expect(fileCard).toBeVisible();
  const [fileCardBox, buttonBox] = await Promise.all([
    fileCard.boundingBox(),
    openButton.boundingBox(),
  ]);
  expect(fileCardBox.y + fileCardBox.height).toBeLessThanOrEqual(buttonBox.y);

  if (testInfo.project.name === "phone") {
    return;
  }
  // Opening the card changes nothing in the file under it: the same room,
  // and the cards where they were.
  const room = await floatingConversationRoom(taskReview);
  await openButton.click();
  await expect(card).toBeVisible();
  expect(await floatingConversationRoom(taskReview)).toBe(room);
  expect(await fileCard.boundingBox()).toEqual(fileCardBox);
});

test("keeps the end of a phone's file list clear of the button", { tag: "@phone" }, async ({ page }) => {
  const opened = await openCompletedTaskForReview(page, {
    configureReview: (review) => {
      review.largeChangeSet = true;
    },
  });
  await opened.tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const files = opened.taskReview.locator(
    'caffold-git-diff-changes-tree button[data-file-tree-kind="file"]',
  );
  await expect(files.first()).toBeVisible();
  const scroller = opened.taskReview.locator("caffold-git-diff-changes-tree caffold-file-tree");
  await scroller.evaluate((tree) => {
    const scrollport = tree.shadowRoot.querySelector(".file-tree-scroll");
    scrollport.scrollTop = scrollport.scrollHeight;
  });
  const openButton = page
    .locator("caffold-task-detail-floating-conversation")
    .getByRole("button", { name: "Show the conversation" });
  await expect(openButton).toBeVisible();
  const [lastBox, buttonBox] = await Promise.all([
    files.last().boundingBox(),
    openButton.boundingBox(),
  ]);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(buttonBox.y);
});

// Whether the middle of `box` shows the open card rather than the file screen:
// what Detail shows there is the component or the Task Detail held in it.
async function cardOnTop(page, box) {
  const tags = await hitTags(page, box.x + box.width / 2, box.y + box.height / 2);
  const inDetail = tags[tags.indexOf("CAFFOLD-DETAIL-LAYOUT") + 1];
  return [
    "CAFFOLD-TASK-DETAIL-FLOATING-CONVERSATION",
    "CAFFOLD-TASK-DETAIL",
  ].includes(inDetail);
}

test("draws the card over the controls the file screen raises", { tag: "@desktop" }, async ({
  page,
}) => {
  // As large as the body allows, over the list, its switch, and the pane
  // resizer beside it.
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:floating-conversation-size",
      JSON.stringify({ width: 4000, height: 4000 }),
    );
  });
  const { openButton, card, taskReview } = await openWorkingTreeFile(page);
  await openButton.click();
  await expect(card).toBeVisible();

  const axis = taskReview.locator(".task-review-navigator-axis");
  const resizer = taskReview.locator("caffold-split-view caffold-pane-resizer");
  for (const control of [axis, resizer]) {
    await expect(control).toBeVisible();
    expect(await cardOnTop(page, await control.boundingBox())).toBe(true);
  }
});

test("draws the card over a foldable's list drawer and its shade", { tag: "@foldable" }, async ({
  page,
}) => {
  // Wide enough to reach over the drawer, short of the strip that opens it.
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:floating-conversation-size",
      JSON.stringify({ width: 700, height: 4000 }),
    );
  });
  const { openButton, card, taskReview } = await openWorkingTreeFile(page);
  await openButton.click();
  await expect(card).toBeVisible();
  await taskReview.locator("caffold-split-view .split-view-strip").click();
  const drawer = taskReview.locator("caffold-split-view .split-view-list");
  await expect(taskReview.locator(".task-review-navigator-pane")).toBeVisible();
  await settled(drawer);

  const [drawerBox, cardBox] = await Promise.all([
    drawer.boundingBox(),
    card.boundingBox(),
  ]);
  const overlap = {
    x: cardBox.x,
    y: Math.max(drawerBox.y, cardBox.y),
    width: drawerBox.x + drawerBox.width - cardBox.x,
    height: Math.min(drawerBox.y + drawerBox.height, cardBox.y + cardBox.height) -
      Math.max(drawerBox.y, cardBox.y),
  };
  expect(overlap.width).toBeGreaterThan(20);
  expect(await cardOnTop(page, overlap)).toBe(true);
  // The shade over the file stops at the card too.
  expect(await cardOnTop(page, {
    x: cardBox.x + cardBox.width - 40,
    y: cardBox.y + cardBox.height - 40,
    width: 0,
    height: 0,
  })).toBe(true);
});

test("draws the folded button see-through and the open card opaque", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { openButton, card } = await openWorkingTreeFile(page);
  const alpha = (locator) =>
    locator.evaluate((element) => {
      const probe = document.createElement("canvas").getContext("2d");
      probe.fillStyle = getComputedStyle(element).backgroundColor;
      probe.fillRect(0, 0, 1, 1);
      return probe.getImageData(0, 0, 1, 1).data[3] / 255;
    });

  const buttonAlpha = await alpha(openButton);
  expect(buttonAlpha).toBeGreaterThan(0.8);
  expect(buttonAlpha).toBeLessThan(0.9);
  expect(await openButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await openButton.click();
  await expect(card).toBeVisible();
  expect(await alpha(card)).toBe(1);
});

test("puts a still green dot on the folded button while the Task's finished turn is unseen", { tag: "@server-changes" }, async ({
  page,
}) => {
  await recordSeenMarks(page);
  const { taskScenario, openButton } = await openWorkingTreeFile(page);
  // The dot the button draws, against the Task list's dot and the button's
  // circle.
  const dot = () =>
    openButton.evaluate((button) => {
      const after = getComputedStyle(button, "::after");
      const probe = document.createElement("span");
      probe.style.display = "block";
      probe.style.width = "var(--interface-space-5)";
      probe.style.background = "var(--success)";
      probe.style.boxShadow = "0 0 0 2px var(--surface)";
      button.append(probe);
      const listDot = getComputedStyle(probe);
      const matches = {
        size: after.width === listDot.width && after.height === listDot.width,
        color: after.backgroundColor === listDot.backgroundColor,
        ring: after.boxShadow === listDot.boxShadow,
      };
      probe.remove();
      const border = Number.parseFloat(getComputedStyle(button).borderTopWidth);
      const inner = button.getBoundingClientRect().width - border * 2;
      const width = Number.parseFloat(after.width);
      // Before its transform the dot sits at the button's center; the
      // transform carries it up and right at 45° to a pixel inside the middle
      // of the border line.
      const { m41: x, m42: y } =
        after.transform === "none"
          ? new DOMMatrixReadOnly()
          : new DOMMatrixReadOnly(after.transform);
      const reach = Math.hypot(x, y);
      const lineMiddle = inner / 2 + border / 2;
      return {
        drawn: after.content !== "none",
        ...matches,
        centered:
          Number.parseFloat(after.top) + Number.parseFloat(after.marginTop) + width / 2 === inner / 2 &&
          Number.parseFloat(after.left) + Number.parseFloat(after.marginLeft) + width / 2 === inner / 2,
        diagonal: x > 0 && y < 0 && Math.abs(x + y) < 0.01,
        pixelInsideTheLine: Math.abs(reach - (lineMiddle - 1)) < 0.01,
        animation: after.animationName,
      };
    });
  await expect(openButton).toHaveAccessibleName("Show the conversation");
  expect((await dot()).drawn).toBe(false);

  await finishTurnUnseen(page, taskScenario);

  await expect(openButton).toHaveAccessibleName(
    "Show the conversation — completed, not viewed",
  );
  await expect(openButton).toHaveAttribute(
    "title",
    "Show the conversation — completed, not viewed",
  );
  expect(await dot()).toEqual({
    drawn: true,
    size: true,
    color: true,
    ring: true,
    centered: true,
    diagonal: true,
    pixelInsideTheLine: true,
    animation: "none",
  });
  // Neither the folded card nor the file behind it shows the conversation.
  expect(await seenMarks(page)).toEqual([]);

  // Seen here or on another device, the server tells the Task's viewers at
  // the next revision.
  await emitTaskState(page, taskScenario, {
    revision: 51,
    title: "Planner changes seen",
    unseen: false,
  });
  await expect(openButton).toHaveAccessibleName("Show the conversation");
  expect((await dot()).drawn).toBe(false);
});

test("marks the Task seen once the card opens", { tag: "@server-changes" }, async ({
  page,
}) => {
  await recordSeenMarks(page);
  const { taskScenario, openButton, card } = await openWorkingTreeFile(page);
  await answerSeenMarks(page, taskScenario);
  await finishTurnUnseen(page, taskScenario);
  await expect(openButton).toHaveAttribute("data-unseen", "");
  expect(await seenMarks(page)).toEqual([]);

  await openButton.click();

  await expect(card).toBeVisible();
  await expect
    .poll(() => seenMarks(page))
    .toEqual([`/api/tasks/${taskScenario.threadId}/seen`]);
});

test("marks the Task seen on reaching the Conversation screen", { tag: "@server-changes" }, async ({
  page,
}) => {
  await recordSeenMarks(page);
  const { taskScenario, tasksPage, openButton } = await openWorkingTreeFile(page);
  await answerSeenMarks(page, taskScenario);
  await finishTurnUnseen(page, taskScenario);
  await expect(openButton).toHaveAttribute("data-unseen", "");
  expect(await seenMarks(page)).toEqual([]);

  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();

  await expect(openButton).toBeHidden();
  await expect
    .poll(() => seenMarks(page))
    .toEqual([`/api/tasks/${taskScenario.threadId}/seen`]);
});

test("reaches the button, the card's header, and its resize handle with Action Hints", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { openButton, card, header, floating } = await openWorkingTreeFile(page);
  await expect(openButton).toBeVisible();

  await activateActionHint(page, "Show the conversation");
  await expect(card).toBeVisible();
  // The header's badge sits at its end, clear of its title.
  const dialog = await enterActionHints(page);
  await expect.poll(() => badgeAtRowEndMiddle(
    dialog.getByRole("button", { name: / — Fold the conversation$/ }),
    header,
  )).toEqual({ atEnd: true, middle: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await activateActionHint(page, "Resize the conversation");
  await expect(floating.locator(".floating-conversation-resize")).toBeFocused();
  await activateActionHint(page, "Fold the conversation");
  await expect(card).toBeHidden();
});

test("keeps C on the button and the header however long the file list", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { openButton, card } = await openWorkingTreeFile(page, {
    configureReview: (review) => {
      review.largeChangeSet = true;
    },
  });
  await expect(openButton).toBeVisible();
  const codeOf = async (label) => {
    const dialog = await enterActionHints(page);
    const code = await dialog
      .getByRole("button", { name: new RegExp(` — ${label}$`) })
      .getAttribute("data-action-hint-code");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    return code;
  };

  expect(await codeOf("Show the conversation")).toBe("C");
  await openButton.click();
  await expect(card).toBeVisible();
  expect(await codeOf("Fold the conversation")).toBe("C");
});

test("resizes from its top left corner within the body and keeps the size on this device", { tag: "@desktop" }, async ({
  page,
}) => {
  const { openButton, card, floating, taskReview } = await openWorkingTreeFile(page);
  await openButton.click();
  await expect(card).toBeVisible();
  const handle = floating.locator(".floating-conversation-resize");
  const before = await card.boundingBox();

  // Up and left grows the card by as much each way; its bottom right corner
  // stays, and the file under it keeps the room it had.
  const room = await floatingConversationRoom(taskReview);
  await dragHandle(page, handle, -100, -80);
  const grown = await card.boundingBox();
  expect(Math.round(grown.width - before.width)).toBe(100);
  expect(Math.round(grown.height - before.height)).toBe(80);
  expect(Math.round(grown.x + grown.width)).toBe(Math.round(before.x + before.width));
  expect(Math.round(grown.y + grown.height)).toBe(Math.round(before.y + before.height));
  expect(await floatingConversationRoom(taskReview)).toBe(room);
  const { body, rem, inset } = await bodyRoom(page);

  // It stops at the body's insets, and at 20rem each way.
  await dragHandle(page, handle, -2000, -2000);
  const largest = await card.boundingBox();
  expect(Math.abs(largest.width - (body.width - 2 * inset))).toBeLessThanOrEqual(1);
  expect(Math.abs(largest.y - (body.y + inset))).toBeLessThanOrEqual(1);
  await dragHandle(page, handle, 2000, 2000);
  const smallest = await card.boundingBox();
  expect(Math.abs(smallest.width - 20 * rem)).toBeLessThanOrEqual(1);
  expect(Math.abs(smallest.height - 20 * rem)).toBeLessThanOrEqual(1);

  await page.reload();
  await openButton.click();
  await expect(card).toBeVisible();
  const kept = await card.boundingBox();
  expect(Math.abs(kept.width - 20 * rem)).toBeLessThanOrEqual(1);
  expect(Math.abs(kept.height - 20 * rem)).toBeLessThanOrEqual(1);
});

test("resizes with the arrow keys on its handle", { tag: "@server-steady" }, async ({ page }) => {
  const { openButton, card, floating } = await openWorkingTreeFile(page);
  await openButton.click();
  await expect(card).toBeVisible();
  const before = await card.boundingBox();
  const growth = async () => {
    const box = await card.boundingBox();
    return [Math.round(box.width - before.width), Math.round(box.height - before.height)];
  };

  await floating.locator(".floating-conversation-resize").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(growth).toEqual([24, 72]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect.poll(growth).toEqual([0, 48]);
  // Escape leaves the handle for the card's header; the next one folds it.
  await page.keyboard.press("Escape");
  await expect(floating.locator(".floating-conversation-header")).toBeFocused();
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("lights the corner handle and the two sides it moves under the pointer", { tag: "@desktop" }, async ({ page }) => {
  const { openButton, card, floating } = await openWorkingTreeFile(page);
  await openButton.click();
  await expect(card).toBeVisible();
  const handle = floating.locator(".floating-conversation-resize");
  const top = floating.locator('.floating-conversation-resize-side[data-side="top"]');
  const left = floating.locator('.floating-conversation-resize-side[data-side="left"]');
  const markColor = () => handle.evaluate((element) => getComputedStyle(element).color);
  const idle = await markColor();
  await expect(top).toBeHidden();
  await expect(left).toBeHidden();

  await handle.hover();
  await expect(top).toBeVisible();
  await expect(left).toBeVisible();
  expect(await markColor()).not.toBe(idle);
  // The lines run along the middle of the card's border, from its top left
  // curve to where the far corners begin to curve.
  const [box, topBox, leftBox] = await Promise.all([
    card.boundingBox(),
    top.boundingBox(),
    left.boundingBox(),
  ]);
  expect(topBox.y + topBox.height / 2).toBeCloseTo(box.y + 0.5, 0);
  expect(topBox.x).toBeCloseTo(box.x + 14, 0);
  expect(topBox.x + topBox.width).toBeCloseTo(box.x + box.width - 14, 0);
  expect(leftBox.x + leftBox.width / 2).toBeCloseTo(box.x + 0.5, 0);
  expect(leftBox.y).toBeCloseTo(box.y + 14, 0);
  expect(leftBox.y + leftBox.height).toBeCloseTo(box.y + box.height - 14, 0);

  await page.mouse.move(0, 0);
  await expect(top).toBeHidden();
  expect(await markColor()).toBe(idle);
});
