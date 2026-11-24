import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  badgeAtRowEndMiddle,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
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
  const cards = taskReview.getByRole("navigation", { name: "Changed files" });

  await expect(cards).toBeVisible();
  const [cardsBox, buttonBox] = await Promise.all([
    cards.boundingBox(),
    openButton.boundingBox(),
  ]);
  expect(cardsBox.y + cardsBox.height).toBeLessThanOrEqual(buttonBox.y);

  if (testInfo.project.name === "phone") {
    return;
  }
  // Opening the card changes nothing in the file under it: the same room,
  // and the cards where they were.
  const room = await floatingConversationRoom(taskReview);
  await openButton.click();
  await expect(card).toBeVisible();
  expect(await floatingConversationRoom(taskReview)).toBe(room);
  expect(await cards.boundingBox()).toEqual(cardsBox);
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
