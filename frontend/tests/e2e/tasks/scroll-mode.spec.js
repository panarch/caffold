import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  openTaskWithBootstrap,
} from "../support/task-fixtures.js";

const fixtureHome = fileURLToPath(new URL("../fixtures/home/", import.meta.url));

test.afterEach(async ({}, testInfo) => {
  rmSync(workspacePath(testInfo), { recursive: true, force: true });
});

test("selects and scrolls only the registered surface", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);

  const taskList = page.locator(".task-list-scroll");
  const conversation = page.locator(".task-conversation-scroll");
  const selector = scrollSelector(page);
  const workspaceHud = scrollHud(page);
  const entryOwner = page.locator(".task-workspace-surface");
  await entryOwner.focus();
  const before = await scrollPositions(page);
  await page.keyboard.press("s");

  if (testInfo.project.name === "phone") {
    await expect(selector).toBeHidden();
    await expect(workspaceHud).toContainText("Scroll: Conversation");
    const step = await conversation.evaluate((element) =>
      Math.max(1, Math.round(element.clientHeight * 0.1))
    );
    await page.keyboard.press("k");
    await expect.poll(() => conversation.evaluate((element) => element.scrollTop))
      .toBe(Math.max(0, before.conversation - step));
    expect(await taskList.evaluate((element) => element.scrollTop)).toBe(
      before.taskList,
    );
  } else {
    await expect(selector).toBeVisible();
    const badges = selector.locator("button[data-scroll-surface-code]");
    await expect(badges).toHaveCount(2);
    expect(await badges.evaluateAll((elements) =>
      elements.map((element) => element.dataset.scrollSurfaceCode)
    )).toEqual(["A", "S"]);
    expect(new Set(await badges.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")
        .replace(/^[A-Z]+ — /, ""))
    ))).toEqual(new Set(["Task list", "Conversation"]));
    await captureReviewScreenshot(page, testInfo, "scroll-surface-selector");

    const taskBadge = selector.getByLabel(/^[A-Z]+ — Task list$/);
    const code = await taskBadge.getAttribute("data-scroll-surface-code");
    await page.keyboard.press(code.toLowerCase());
    await expect(selector).toBeHidden();
    await expect(workspaceHud).toContainText("Scroll: Task list");

    const step = await taskList.evaluate((element) =>
      Math.max(1, Math.round(element.clientHeight * 0.1))
    );
    await page.keyboard.press("j");
    await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
      .toBe(before.taskList + step);
    expect(await conversation.evaluate((element) => element.scrollTop)).toBe(
      before.conversation,
    );

    const repeated = await entryOwner.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyJ",
        key: "j",
        repeat: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(repeated).toBe(true);
    await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
      .toBe(before.taskList + step * 2);

    const halfPage = await taskList.evaluate((element) =>
      Math.max(1, Math.round(element.clientHeight * 0.5))
    );
    await page.keyboard.press("d");
    await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
      .toBe(before.taskList + step * 2 + halfPage);
    await page.keyboard.press("u");
    await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
      .toBe(before.taskList + step * 2);

    await taskList.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    const boundary = await entryOwner.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyD",
        key: "d",
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(boundary).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(before.window);
    await expect(workspaceHud).toContainText("Scroll: Task list");
  }

  await captureReviewScreenshot(page, testInfo, "scroll-mode-active");
  await page.keyboard.press("Escape");
  await expect(workspaceHud).toBeHidden();
  await expect(page.locator("caffold-app-shell")).not.toHaveAttribute(
    "data-scroll-mode",
    "active",
  );
});

test(
  "closes Scroll selection when printable input matches no surface",
  { tag: ["@desktop", "@foldable"] },
  async ({ page }) => {
    const { detail } = await installScrollFixture(page);
    await openScrollTask(page, detail);

    const opener = page.locator(".task-workspace-surface");
    const selector = scrollSelector(page);
    const hud = scrollHud(page);
    const workspace = page.locator("caffold-app-shell");
    await opener.focus();
    await page.keyboard.press("s");
    await expect(selector).toBeVisible();

    await page.keyboard.press("z");

    await expect(selector).toBeHidden();
    await expect(hud).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(workspace).toHaveAttribute(
      "data-scroll-mode-last-exit",
      "no-match",
    );

    await page.keyboard.press("s");
    await expect(selector).toBeVisible();
    await page.keyboard.press("1");
    await expect(selector).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(workspace).toHaveAttribute(
      "data-scroll-mode-last-exit",
      "no-match",
    );
  },
);

test("opens shortcut help from Scroll selection and active Scroll", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);

  const opener = page.locator(".task-workspace-surface");
  const selector = scrollSelector(page);
  const hud = scrollHud(page);
  const help = page.locator(
    "caffold-keyboard-shortcut-dialog > dialog:modal",
  );
  await opener.focus();
  await page.keyboard.press("s");

  if (testInfo.project.name !== "phone") {
    await expect(selector).toBeVisible();
    await expect(selector.locator(
      ":scope > .scroll-surface-selector-instructions",
    )).toHaveCount(0);
    await expect(selector.locator(":scope > .sr-only")).toHaveCount(3);
    await page.keyboard.press("?");
    await expect(selector).toBeHidden();
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(selector).toBeHidden();
    await expect(hud).toBeHidden();
    await expect(opener).toBeFocused();

    await page.keyboard.press("s");
    await selector.getByLabel(/^[A-Z]+ — Conversation$/).click();
  }

  await expect(hud).toContainText("Scroll: Conversation");
  await expect(hud.locator("[data-scroll-mode-shortcut-help]")).toContainText(
    "?",
  );
  await page.keyboard.press("?");
  await expect(hud).toBeHidden();
  await expect(help).toBeVisible();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "shortcut-help",
  );

  await help.getByRole("button", { name: "Close keyboard shortcuts" }).click();
  await expect(help).toBeHidden();
  await expect(hud).toBeHidden();
  await expect(opener).toBeFocused();
});

test("selects nested Conversation code and table scrollports and cancels a lost axis", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  detail.events.at(-1).payload.text = nestedConversationMarkdown();
  detail.events.at(-1).payload.phase = "final";
  await openScrollTask(page, detail);

  const workspace = page.locator("caffold-app-shell");
  const entryOwner = page.locator(".task-workspace-surface");
  const conversation = page.locator(".task-conversation-scroll");
  const codeBlock = page.locator(
    "caffold-task-assistant-message caffold-task-markdown-code-block",
  ).last();
  const code = codeBlock.locator("pre");
  const table = page.locator(
    "caffold-task-assistant-message .markdown-table-scroll",
  ).last();
  const selector = scrollSelector(page);
  const hud = scrollHud(page);
  await expect(codeBlock).toHaveAttribute("data-code-wrap", "off");
  await expect.poll(() => code.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  )).toBe(true);
  await expect.poll(() => table.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  )).toBe(true);

  await entryOwner.focus();
  await page.keyboard.press("s");
  await expect(selector).toBeVisible();
  await expect(selector.getByLabel(/^[A-Z]+ — Conversation$/)).toBeVisible();
  await expect(
    selector.getByLabel(/^[A-Z]+ — text code block 1$/i),
  ).toBeVisible();
  await expect(
    selector.getByLabel(/^[A-Z]+ — Markdown table 1$/),
  ).toBeVisible();
  const selectorGeometry = await scrollSelectorBadgeGeometry(selector);
  expect(selectorGeometry.viewportEscapes).toEqual([]);
  expect(selectorGeometry.fullOverlaps).toEqual([]);
  await captureReviewScreenshot(
    page,
    testInfo,
    "scroll-mode-conversation-nested-selector",
  );

  const conversationBefore = await conversation.evaluate(
    (element) => element.scrollTop,
  );
  await selector.getByLabel(/^[A-Z]+ — text code block 1$/i).click();
  await expect(hud).toContainText(/Scroll: text code block 1/i);
  await expect(hud.locator("[data-scroll-mode-shortcut-help]")).toContainText(
    "?",
  );
  await page.keyboard.press("l");
  await expect.poll(() => code.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(await table.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(
    conversationBefore,
  );
  await captureReviewScreenshot(
    page,
    testInfo,
    "scroll-mode-conversation-horizontal-hud",
  );
  await page.keyboard.press("Escape");

  await entryOwner.focus();
  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Markdown table 1$/).click();
  await expect(hud).toContainText("Scroll: Markdown table 1");
  await page.keyboard.press("l");
  await expect.poll(() => table.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  await entryOwner.focus();
  await page.keyboard.press("s");
  await expect(selector).toBeVisible();
  await codeBlock.evaluate((element) => element.toggleWrap());
  await expect(codeBlock).toHaveAttribute("data-code-wrap", "on");
  await expect(selector).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "snapshot-invalidated",
  );
  await expect(hud).toBeHidden();

  await entryOwner.focus();
  await page.keyboard.press("s");
  await expect(selector).toBeVisible();
  await expect(
    selector.getByLabel(/^[A-Z]+ — text code block 1$/i),
  ).toHaveCount(0);
  await expect(
    selector.getByLabel(/^[A-Z]+ — Markdown table 1$/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("cancels the frozen selector when Task list topology loses eligibility", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail, tasks } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const owner = page.locator(".task-workspace-surface");
  const selector = scrollSelector(page);
  const workspace = page.locator("caffold-app-shell");
  await owner.focus();
  await page.keyboard.press("s");
  await expect(selector).toBeVisible();

  await removeTaskListOverflow(page, tasks);

  await expect(selector).toBeHidden();
  await expect(owner).toBeFocused();
  await expect(workspace).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "snapshot-invalidated",
  );
  await expect(scrollHud(page)).toBeHidden();
});

test("switches active Scroll to fresh Action Hints with F", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const workspace = page.locator("caffold-app-shell");
  const selector = scrollSelector(page);
  const hud = scrollHud(page);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Conversation$/).click();
  await expect(hud.locator("[data-scroll-mode-shortcut-help]")).toContainText(
    "?",
  );

  await page.keyboard.press("f");

  await expect(hud).toBeHidden();
  await expect(selector).toBeHidden();
  await expect(workspace).not.toHaveAttribute("data-scroll-mode", "active");
  await expect(workspace).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "action-hints",
  );
  const hints = actionHintDialog(page);
  await expect(hints).toBeVisible();
  await expect(hints.locator("button[data-action-hint-code]").first())
    .toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hints).toBeHidden();
});

test("keeps the exact active Task list through content patches and exits when it stops overflowing", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail, tasks } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const owner = page.locator(".task-workspace-surface");
  const selector = scrollSelector(page);
  const taskList = page.locator(".task-list-scroll");
  const workspace = page.locator("caffold-app-shell");
  await owner.focus();
  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Task list$/).click();
  await expect(scrollHud(page)).toContainText("Scroll: Task list");
  await taskList.evaluate((element) => {
    window.__scrollModeBoundTaskList = element;
  });

  const updatedTask = {
    ...tasks[1],
    title: "Scroll Task content patch",
  };
  await page.evaluate((task) => {
    window.__taskListSource.emit("task-updated", task);
  }, updatedTask);
  await expect(page.locator(
    `.task-row[data-thread-id="${updatedTask.threadId}"] .task-row-title`,
  )).toHaveText(updatedTask.title);
  expect(await taskList.evaluate((element) =>
    element === window.__scrollModeBoundTaskList
  )).toBe(true);
  const before = await taskList.evaluate((element) => element.scrollTop);
  await page.keyboard.press("j");
  await expect.poll(() => taskList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
  await expect(scrollHud(page)).toContainText("Scroll: Task list");

  await removeTaskListOverflow(page, tasks);

  await expect(scrollHud(page)).toBeHidden();
  await expect(workspace).not.toHaveAttribute("data-scroll-mode", "active");
  await expect(workspace).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "binding-invalidated",
  );
  await expect(scrollSelector(page)).toBeHidden();
});

test("shares code, click, and native keyboard selection without background leakage", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const entryOwner = page.locator(".task-workspace-surface");
  const selector = scrollSelector(page);
  const taskList = page.locator(".task-list-scroll");
  const conversation = page.locator(".task-conversation-scroll");
  await entryOwner.focus();

  await page.keyboard.press("s");
  await expect(selector).toBeVisible();
  const beforeLeakProbe = await scrollPositions(page);
  const conversationBox = await conversation.boundingBox();
  await page.mouse.move(
    conversationBox.x + conversationBox.width / 2,
    conversationBox.y + conversationBox.height / 2,
  );
  await page.mouse.wheel(0, 320);
  expect(await scrollPositions(page)).toEqual(beforeLeakProbe);
  await expect(selector).toBeVisible();
  const touchPolicy = await selector.evaluate((dialog) => {
    const dispatch = (count) => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: Array.from({ length: count }, () => ({})),
      });
      dialog.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { pan: dispatch(1), pinch: dispatch(2) };
  });
  expect(touchPolicy).toEqual({ pan: true, pinch: false });

  const selectorPopover = await openTestPopover(page, "selector");
  await expect(selector).toBeHidden();
  await expect(selectorPopover).toBeVisible();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "interaction-owner",
  );
  await selectorPopover.evaluate((element) => element.remove());
  await expect(entryOwner).toBeFocused();

  await page.keyboard.press("s");
  await expect(selector).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(selector).toBeHidden();
  await expect(entryOwner).toBeFocused();

  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Conversation$/).click();
  await expect(scrollHud(page)).toContainText("Scroll: Conversation");
  const activePopover = await openTestPopover(page, "active");
  await expect(scrollHud(page)).toBeHidden();
  await expect(activePopover).toBeVisible();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-scroll-mode-last-exit",
    "interaction-owner",
  );
  await activePopover.evaluate((element) => element.remove());

  await page.keyboard.press("s");
  const taskListCode = await surfaceCode(selector, "Task list");
  await page.keyboard.press("Tab");
  const focusedCode = await selector.locator("button:focus").getAttribute(
    "data-scroll-surface-code",
  );
  await page.keyboard.press("Enter");
  await expect(selector).toBeHidden();
  await expect(scrollHud(page)).toContainText(
    focusedCode === taskListCode
      ? "Scroll: Task list"
      : "Scroll: Conversation",
  );
  await page.keyboard.press("Escape");

  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Conversation$/).focus();
  await page.keyboard.press("Space");
  await expect(scrollHud(page)).toContainText("Scroll: Conversation");
  await page.keyboard.press("Escape");

  await page.keyboard.press("s");
  await taskList.evaluate((element) => {
    element.scrollTop += 1;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(selector).toBeHidden();
  await expect(entryOwner).toBeFocused();
});

test("keeps keyboard scrolling on the Conversation native anchor path", { tag: "@desktop" }, async ({
  page,
}) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const selector = scrollSelector(page);
  const conversation = page.locator(".task-conversation-scroll");
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await selector.getByLabel(/^[A-Z]+ — Conversation$/).click();
  await page.keyboard.press("k");
  const beforeUpdate = await conversation.evaluate((element) => element.scrollTop);
  await expect.poll(() => page.locator("caffold-task-conversation").evaluate(
    (element, threadId) => element.scrollByThread.get(threadId)?.atBottom,
    detail.threadId,
  )).toBe(false);

  await page.evaluate(({ threadId, event }) => {
    window.__taskDetailSource.emit("task-event", {
      threadId,
      revision: 2,
      eventRevision: 2,
      event,
    });
  }, {
    threadId: detail.threadId,
    event: messageEvent(
      detail.threadId,
      "scroll-live-update",
      "Live update while keyboard reading",
      500,
    ),
  });
  await expect(page.locator("caffold-tasks-page")).toContainText(
    "Live update while keyboard reading",
  );
  await expect.poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(beforeUpdate);
  await expect(scrollHud(page)).toContainText("Scroll: Conversation");
});

test("scrolls a mouse-open retained Model popover and preserves native Escape", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  await page.route("**/api/agent/models", (route) =>
    route.fulfill({
      json: {
        models: Array.from({ length: 18 }, (_, index) => ({
          provider: "codex",
          model: `gpt-scroll-${index + 1}`,
          displayName: `GPT Scroll Model ${index + 1}`,
          description: `Scrollable model option ${index + 1}`,
          isDefault: index === 0,
          defaultEffort: "medium",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          supportsFastMode: true,
        })),
        unavailable: [],
      },
    })
  );
  await openScrollTask(page, detail);

  const modelButton = page.locator(
    "caffold-task-detail .task-follow-up-form .task-model-button",
  );
  const modelPopover = page.locator(
    "caffold-task-detail .task-follow-up-form .task-model-popover",
  );
  const popoverHud = modelPopover.locator(
    "caffold-scroll-mode-hud .scroll-mode-status",
  );
  await modelButton.click();
  await expect(modelPopover).toBeVisible();
  await expect.poll(() => modelPopover.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  const before = await modelPopover.evaluate((element) => element.scrollTop);

  await page.keyboard.press("s");
  await expect(scrollSelector(page)).toBeHidden();
  await expect(popoverHud).toContainText("Scroll: Model options");
  await expect(scrollHud(page)).toBeHidden();
  await captureReviewScreenshot(
    page,
    testInfo,
    "scroll-mode-model-popover",
  );
  await page.keyboard.press("j");
  await expect.poll(() => modelPopover.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);

  await page.keyboard.press("Escape");
  await expect(popoverHud).toBeHidden();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelPopover).toBeHidden();
});

test("scrolls the Current Plan preview inside its modal and preserves native Escape", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const workspace = prepareWorkspace(testInfo);
  writeCurrentDocuments(workspace.absolutePath, {
    plan: longNestedMarkdown("Plan", 80),
    checklist: checklistMarkdown(120, "Initial checklist"),
  });
  await installCurrentPlanFileFixture(page, workspace);
  const { detail } = await installScrollFixture(page, {
    cwd: workspace.logicalPath,
    useCurrentPlanServer: true,
  });
  await page.goto(`/tasks/${detail.threadId}?cwd=${encodeURIComponent(workspace.logicalPath)}`);
  const projection = currentPlanResponse(page, workspace.logicalPath);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  await projection;

  const currentPlan = page.locator("caffold-task-current-plan");
  const checklistButton = currentPlan.getByRole("button", {
    name: /^Open checklist:/,
  });
  const planButton = currentPlan.getByRole("button", {
    name: /^Open plan:/,
  });
  await expect(checklistButton).toBeVisible();
  const checklistPath = `${workspace.logicalPath}/.caffold/plans/current/CHECKLIST.md`;
  const initialFile = fileResponse(page, checklistPath);
  await openCurrentPlanDocumentWithHint(page, /Open checklist:/);
  await initialFile;
  const dialog = currentPlan.locator(
    "caffold-current-plan-document-dialog > dialog",
  );
  const preview = dialog.locator("caffold-markdown-preview");
  const modalHud = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation caffold-scroll-mode-hud",
  );
  const modalSelector = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation " +
      "caffold-scroll-surface-selector > dialog:modal",
  );
  await expect(dialog).toHaveAttribute("open", "");
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  await page.keyboard.press("f");
  const modalHint = actionHintDialog(page);
  await expect(modalHint).toBeVisible();
  await expect(
    modalHint.getByRole("button", { name: / — Close document$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modalHint).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");
  const backgroundBefore = await scrollPositions(page);

  await page.keyboard.press("s");
  await expect(scrollSelector(page)).toBeHidden();
  await expect(modalHud).toContainText("Scroll: Checklist document");
  await expect(scrollHud(page)).toBeHidden();
  const previewStep = await preview.evaluate((element) =>
    Math.max(1, Math.round(element.clientHeight * 0.1))
  );
  await page.keyboard.press("j");
  await expect.poll(() => preview.evaluate((element) => element.scrollTop))
    .toBe(previewStep);
  expect(await scrollPositions(page)).toEqual(backgroundBefore);
  await captureReviewScreenshot(page, testInfo, "scroll-mode-current-plan");

  await page.evaluate(() => {
    const competing = document.createElement("dialog");
    competing.dataset.scrollModeCompetingModal = "";
    competing.append(document.createElement("button"));
    document.body.append(competing);
    competing.showModal();
  });
  const competingModal = page.locator(
    "dialog[data-scroll-mode-competing-modal]",
  );
  await expect(competingModal).toBeVisible();
  await expect(modalHud).toBeHidden();
  await competingModal.evaluate((element) => {
    element.close();
    element.remove();
  });
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("s");
  await expect(modalHud).toContainText("Scroll: Checklist document");

  await dialog.getByRole("button", { name: "Close document" }).click();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(modalHud).toBeHidden();
  await expect(checklistButton).toBeFocused();

  const reopenedChecklist = fileResponse(page, checklistPath);
  await checklistButton.click();
  await reopenedChecklist;
  await page.keyboard.press("s");
  await expect(modalHud).toContainText("Scroll: Checklist document");
  await page.keyboard.press("Escape");
  await expect(modalHud).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(checklistButton).toBeFocused();

  const planPath = `${workspace.logicalPath}/.caffold/plans/current/PLAN.md`;
  const planFile = fileResponse(page, planPath);
  await openCurrentPlanDocumentWithHint(page, /Open plan:/);
  await planFile;
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  const planCode = preview.locator("pre");
  const planTable = preview.locator(".markdown-preview-table-scroll");
  await expect.poll(() => planCode.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  )).toBe(true);
  await expect.poll(() => planTable.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  )).toBe(true);
  await page.keyboard.press("s");
  await expect(modalSelector).toBeVisible();
  const planBadges = modalSelector.locator(
    "button[data-scroll-surface-code]",
  );
  await expect(planBadges).toHaveCount(3);
  expect(new Set(await planBadges.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")
      .replace(/^[A-Z]+ — /, ""))
  ))).toEqual(new Set([
    "Plan document",
    "Plan document code block 1",
    "Plan document Markdown table 1",
  ]));
  await expect(modalSelector.getByLabel(/ — Task list$/)).toHaveCount(0);
  await expect(modalSelector.getByLabel(/ — Conversation$/)).toHaveCount(0);
  await captureReviewScreenshot(
    page,
    testInfo,
    "scroll-mode-current-plan-nested-selector",
  );
  const backgroundBeforeNested = await scrollPositions(page);
  const previewLeftBefore = await preview.evaluate((element) => element.scrollLeft);
  await modalSelector.getByLabel(
    /^[A-Z]+ — Plan document code block 1$/,
  ).click();
  await expect(modalHud).toContainText(
    "Scroll: Plan document code block 1",
  );
  await expect(modalHud.locator("[data-scroll-mode-shortcut-help]")).toContainText(
    "?",
  );
  await page.keyboard.press("l");
  await expect.poll(() => planCode.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(await planTable.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await preview.evaluate((element) => element.scrollLeft)).toBe(
    previewLeftBefore,
  );
  expect(await scrollPositions(page)).toEqual(backgroundBeforeNested);
  await captureReviewScreenshot(
    page,
    testInfo,
    "scroll-mode-current-plan-horizontal-hud",
  );
  const documentDialog = currentPlan.locator(
    "caffold-current-plan-document-dialog",
  );
  await documentDialog.evaluate((element) => element.deactivate());
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(modalHud).toBeHidden();

  const replacementPlanFile = fileResponse(page, planPath);
  await planButton.click();
  await replacementPlanFile;
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  await page.keyboard.press("s");
  await expect(modalSelector).toBeVisible();
  const replacementChecklistFile = fileResponse(page, checklistPath);
  await documentDialog.evaluate((element, path) => {
    const opener = element.closest("caffold-task-current-plan")?.querySelector(
      '[data-current-plan-action="checklist"]',
    );
    element.openDocument({
      label: "Checklist",
      document: { name: "CHECKLIST.md", path },
      displayPath: path,
      opener,
    });
  }, checklistPath);
  await replacementChecklistFile;
  await expect(modalSelector).toBeHidden();
  await expect(modalHud).toBeHidden();
  await expect(dialog.getByRole("heading", {
    exact: true,
    name: "Checklist",
  })).toBeVisible();
  await expect(preview).toContainText("Initial checklist");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(checklistButton).toBeFocused();

  const refreshedFile = fileResponse(page, checklistPath);
  await checklistButton.click();
  await refreshedFile;
  await page.keyboard.press("s");
  await page.keyboard.press("j");
  const beforeRefresh = await preview.evaluate((element) => element.scrollTop);
  writeCurrentDocuments(workspace.absolutePath, {
    plan: longMarkdown("Plan", 80),
    checklist: checklistMarkdown(130, "Refreshed checklist"),
  });
  const refreshedProjection = currentPlanResponse(page, workspace.logicalPath);
  const refreshedPreview = fileResponse(page, checklistPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    {
    paths: [checklistPath],
    },
  );
  await Promise.all([refreshedProjection, refreshedPreview]);
  await expect(preview).toContainText("Refreshed checklist");
  await expect(modalHud).toBeHidden();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop))
    .toBe(beforeRefresh);
  await page.keyboard.press("s");
  await expect(modalHud).toContainText("Scroll: Checklist document");

  writeCurrentDocuments(workspace.absolutePath, {
    plan: "# Short Plan\n",
    checklist: "# Short Checklist\n\nNo scrolling needed.\n",
  });
  const shortProjection = currentPlanResponse(page, workspace.logicalPath);
  const shortPreview = fileResponse(page, checklistPath);
  await emitWatchChange(
    page,
    `${workspace.logicalPath}/.caffold/plans/current`,
    {
    paths: [checklistPath],
    },
  );
  await Promise.all([shortProjection, shortPreview]);
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true);
  await expect(modalHud).toBeHidden();
  const consumed = await dialog.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyS",
      key: "s",
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(consumed).toBe(false);
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");

  const shortPlanFile = fileResponse(page, planPath);
  await planButton.click();
  await shortPlanFile;
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true);
  const shortPlanConsumed = await dialog.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyS",
      key: "s",
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(shortPlanConsumed).toBe(false);
  await page.keyboard.press("Escape");
});

test("leaves editing, composition, modifiers, settings Off, and external owners untouched", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const prompt = page.getByRole("textbox", { name: "Follow-up prompt" });
  await prompt.focus();
  await page.keyboard.press("s");
  await expect(prompt).toHaveValue("s");
  await expect(scrollSelector(page)).toBeHidden();
  await expect(scrollHud(page)).toBeHidden();

  await prompt.evaluate((textarea) => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "ㅎ",
    }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyS",
      isComposing: true,
      key: "ㄴ",
    }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      isComposing: true,
      key: "Escape",
    }));
  });
  await expect(prompt).toBeFocused();
  await prompt.evaluate((textarea) => {
    textarea.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "ㅎ",
    }));
  });
  await page.keyboard.press("Escape");

  const owner = page.locator(".task-workspace-surface");
  await owner.focus();
  const modified = await owner.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyS",
      ctrlKey: true,
      key: "s",
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(modified).toBe(false);

  await owner.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyS",
      key: "ㄴ",
    }));
  });
  if (testInfo.project.name === "phone") {
    await expect(scrollHud(page)).toContainText("Scroll: Conversation");
  } else {
    await expect(scrollSelector(page)).toBeVisible();
  }
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("caffold:settings-change", {
      detail: { settings: { actionHintsEnabled: false } },
    }));
  });
  await expect(scrollSelector(page)).toBeHidden();
  await expect(scrollHud(page)).toBeHidden();

  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.dataset.scrollModeExternalOwner = "";
    const button = document.createElement("button");
    button.textContent = "External owner";
    dialog.append(button);
    document.body.append(dialog);
    dialog.showModal();
    button.focus();
  });
  const externalDialog = page.locator("dialog[data-scroll-mode-external-owner]");
  await page.keyboard.press("s");
  await expect(externalDialog).toBeVisible();
  await expect(scrollSelector(page)).toBeHidden();
  await expect(scrollHud(page)).toBeHidden();
  await page.keyboard.press("Escape");
  await externalDialog.evaluate((dialog) => dialog.remove());

  const modelButton = page.locator(
    "caffold-task-detail .task-follow-up-form .task-model-button",
  );
  await modelButton.click();
  const modelPopover = page.locator(
    "caffold-task-detail .task-follow-up-form .task-model-popover",
  );
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("s");
  await expect(modelPopover).toBeVisible();
  await expect(scrollSelector(page)).toBeHidden();
  await page.keyboard.press("Escape");

  await page.goto("/settings/keyboard");
  const setting = page.getByRole("switch", { name: "Keyboard navigation" });
  await setting.uncheck();
  await page.goto(`/tasks/${detail.threadId}?cwd=${encodeURIComponent(detail.task.cwd)}`);
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await expect(scrollSelector(page)).toBeHidden();
  await expect(scrollHud(page)).toBeHidden();
});

test("keeps selector and HUD visible at appearance and zoom extremes", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  const { detail } = await installScrollFixture(page);
  await openScrollTask(page, detail);
  const devtools = await context.newCDPSession(page);
  const owner = page.locator(".task-workspace-surface");

  for (const [index, scenario] of [
    { interfaceScalePercent: 90, pageScaleFactor: 1, themeMode: "light" },
    { interfaceScalePercent: 120, pageScaleFactor: 1.25, themeMode: "dark" },
  ].entries()) {
    await page.evaluate(async ({ interfaceScalePercent, themeMode }) => {
      const { setAppearanceRangeSetting, setThemeMode } = await import(
        "/assets/settings.js"
      );
      setAppearanceRangeSetting("interfaceScalePercent", interfaceScalePercent);
      setThemeMode(themeMode);
    }, scenario);
    await devtools.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: scenario.pageScaleFactor,
    });
    await expect.poll(() => page.evaluate(
      () => window.visualViewport?.scale ?? 1,
    )).toBeCloseTo(scenario.pageScaleFactor, 2);
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));

    await owner.focus();
    await page.keyboard.press("s");
    if (testInfo.project.name === "phone") {
      await expect(scrollHud(page)).toContainText("Scroll: Conversation");
    } else {
      await expect(scrollSelector(page)).toBeVisible();
      const selectorVisual = await captureScrollPresentation(page, "selector");
      expect(
        selectorVisual.viewportEscapes,
        JSON.stringify(selectorVisual),
      ).toEqual([]);
      expect(
        Math.abs(
          selectorVisual.badgeGeometry.width -
            selectorVisual.badgeGeometry.height,
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          selectorVisual.badgeGeometry.width -
            selectorVisual.badgeGeometry.visualSize,
        ),
      ).toBeLessThanOrEqual(1);
      expect(selectorVisual.badgeGeometry.hitWidth).toBeGreaterThanOrEqual(
        Math.max(
          selectorVisual.badgeGeometry.width,
          selectorVisual.badgeGeometry.targetFloor,
        ) - 1,
      );
      expect(selectorVisual.badgeGeometry.hitHeight).toBeGreaterThanOrEqual(
        Math.max(
          selectorVisual.badgeGeometry.height,
          selectorVisual.badgeGeometry.targetFloor,
        ) - 1,
      );
      expect(selectorVisual.contrastRatio).toBeGreaterThanOrEqual(4.5);
      expect(selectorVisual.outlineWidth).toBeGreaterThanOrEqual(2);
    }

    if (index === 0) {
      await devtools.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: 1.1,
      });
      await expect(scrollSelector(page)).toBeHidden();
      await expect(scrollHud(page)).toBeHidden();
      await devtools.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: scenario.pageScaleFactor,
      });
      await expect.poll(() => page.evaluate(
        () => window.visualViewport?.scale ?? 1,
      )).toBeCloseTo(scenario.pageScaleFactor, 2);
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));
      await owner.focus();
      await page.keyboard.press("s");
    }

    if (testInfo.project.name !== "phone") {
      await expect(scrollSelector(page)).toBeVisible();
      await scrollSelector(page).getByLabel(/^[A-Z]+ — Task list$/).click();
    }
    await expect(scrollHud(page)).toBeVisible();
    const hudVisual = await captureScrollPresentation(page, "hud");
    expect(
      hudVisual.viewportEscapes,
      JSON.stringify(hudVisual),
    ).toEqual([]);
    expect(hudVisual.contrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(hudVisual.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(hudVisual.pointerEvents).toBe("none");
    expect(hudVisual.helpPointerEvents).toBe("none");
    expect(hudVisual.cornerInset.right).toBeCloseTo(8, 0);
    expect(hudVisual.cornerInset.top).toBeCloseTo(8, 0);
    expect(hudVisual.scale).toBeCloseTo(scenario.pageScaleFactor, 2);
    if (index === 1) {
      await captureReviewScreenshot(
        page,
        testInfo,
        "scroll-mode-appearance-max-zoom",
      );
    }
    await page.keyboard.press("Escape");
  }
});

function scrollSelector(page) {
  return page.locator("caffold-scroll-surface-selector > dialog:modal");
}

function actionHintDialog(page) {
  return page.locator("caffold-action-hint-dialog > dialog:modal");
}

function scrollHud(page) {
  return page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
}

async function scrollSelectorBadgeGeometry(selector) {
  return selector.locator("button[data-scroll-surface-code]").evaluateAll(
    (badges) => {
      const viewport = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      };
      const records = badges.map((badge) => ({
        code: badge.dataset.scrollSurfaceCode,
        rect: badge.getBoundingClientRect().toJSON(),
      }));
      const viewportEscapes = records.flatMap(({ code, rect }) =>
        rect.left < viewport.left - 1 ||
          rect.top < viewport.top - 1 ||
          rect.right > viewport.right + 1 ||
          rect.bottom > viewport.bottom + 1
          ? [code]
          : []
      );
      const fullOverlaps = [];
      for (let left = 0; left < records.length; left += 1) {
        for (let right = left + 1; right < records.length; right += 1) {
          const first = records[left];
          const second = records[right];
          const overlapWidth = Math.max(
            0,
            Math.min(first.rect.right, second.rect.right) -
              Math.max(first.rect.left, second.rect.left),
          );
          const overlapHeight = Math.max(
            0,
            Math.min(first.rect.bottom, second.rect.bottom) -
              Math.max(first.rect.top, second.rect.top),
          );
          const overlapArea = overlapWidth * overlapHeight;
          const smallerArea = Math.min(
            first.rect.width * first.rect.height,
            second.rect.width * second.rect.height,
          );
          if (smallerArea > 0 && overlapArea >= smallerArea - 1) {
            fullOverlaps.push(`${first.code}:${second.code}`);
          }
        }
      }
      return { fullOverlaps, viewportEscapes };
    },
  );
}

async function openCurrentPlanDocumentWithHint(page, label) {
  const currentPlanButton = page.locator(
    "caffold-task-current-plan button:not([disabled])",
  ).first();
  await currentPlanButton.focus();
  await expect(currentPlanButton).toBeFocused();
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^.+ — Open plan:/ }))
    .toBeVisible();
  await expect(dialog.getByRole("button", { name: /^.+ — Open checklist:/ }))
    .toBeVisible();
  const target = dialog.getByRole("button", { name: label });
  const code = await target.getAttribute("data-action-hint-code");
  expect(code).toBeTruthy();
  await page.keyboard.type(code.toLowerCase());
  await expect(dialog).toBeHidden();
}

async function openTestPopover(page, id) {
  await page.evaluate((popoverId) => {
    const popover = document.createElement("div");
    popover.popover = "manual";
    popover.dataset.scrollModeTestPopover = popoverId;
    popover.textContent = `${popoverId} popover`;
    document.body.append(popover);
    popover.showPopover();
  }, id);
  return page.locator(
    `[data-scroll-mode-test-popover="${id}"]:popover-open`,
  );
}

async function surfaceCode(selector, label) {
  return selector.getByLabel(new RegExp(`^[A-Z]+ — ${label}$`))
    .getAttribute("data-scroll-surface-code");
}

async function scrollPositions(page) {
  return page.evaluate(() => ({
    taskList: document.querySelector(".task-list-scroll")?.scrollTop ?? 0,
    conversation:
      document.querySelector(".task-conversation-scroll")?.scrollTop ?? 0,
    window: window.scrollY,
  }));
}

async function captureScrollPresentation(page, kind) {
  return page.evaluate((presentationKind) => {
    const viewport = {
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
      right:
        (window.visualViewport?.offsetLeft ?? 0) +
        (window.visualViewport?.width ?? document.documentElement.clientWidth),
      bottom:
        (window.visualViewport?.offsetTop ?? 0) +
        (window.visualViewport?.height ?? document.documentElement.clientHeight),
    };
    const geometry = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        name: element.className || element.localName,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const escapes = (elements) => elements.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left < viewport.left - 1 ||
          bounds.top < viewport.top - 1 ||
          bounds.right > viewport.right + 1 ||
          bounds.bottom > viewport.bottom + 1
        ? [element.className || element.localName]
        : [];
    });
    if (presentationKind === "selector") {
      const dialog = document.querySelector(
        "caffold-scroll-surface-selector > dialog:modal",
      );
      const badge = dialog.querySelector("button[data-scroll-surface-code]");
      badge.focus();
      const badgeStyle = getComputedStyle(badge);
      const badgeBounds = badge.getBoundingClientRect();
      const hitStyle = getComputedStyle(badge, "::before");
      const inset = (value) => Number.parseFloat(value) || 0;
      const rootStyle = getComputedStyle(document.documentElement);
      const regions = [...dialog.querySelectorAll(
        ".scroll-surface-selector-region",
      )];
      const inspected = [
        ...regions,
        ...dialog.querySelectorAll("button[data-scroll-surface-code]"),
      ];
      return {
        badgeGeometry: {
          height: badgeBounds.height,
          hitHeight:
            badgeBounds.height - inset(hitStyle.top) - inset(hitStyle.bottom),
          hitWidth:
            badgeBounds.width - inset(hitStyle.left) - inset(hitStyle.right),
          targetFloor: Number.parseFloat(
            rootStyle.getPropertyValue("--interface-target-floor"),
          ) || 0,
          visualSize: Number.parseFloat(badgeStyle.minWidth),
          width: badgeBounds.width,
        },
        contrastRatio: colorContrast(
          badgeStyle.color,
          badgeStyle.backgroundColor,
        ),
        outlineWidth: Number.parseFloat(
          getComputedStyle(regions[0]).borderTopWidth,
        ),
        geometry: inspected.map(geometry),
        scale: window.visualViewport?.scale ?? 1,
        viewport,
        viewportEscapes: escapes(inspected),
      };
    }

    const host = [...document.querySelectorAll("caffold-scroll-mode-hud")]
      .find((element) => !element.hidden);
    const status = host.querySelector(".scroll-mode-status");
    const outline = host.querySelector(".scroll-mode-outline");
    const help = status.querySelector("[data-scroll-mode-shortcut-help]");
    const statusRect = status.getBoundingClientRect();
    const outlineRect = outline.getBoundingClientRect();
    const statusStyle = getComputedStyle(status);
    return {
      contrastRatio: colorContrast(
        statusStyle.color,
        statusStyle.backgroundColor,
      ),
      outlineWidth: Number.parseFloat(getComputedStyle(outline).borderTopWidth),
      pointerEvents: getComputedStyle(host).pointerEvents,
      helpPointerEvents: getComputedStyle(help).pointerEvents,
      cornerInset: {
        right: outlineRect.right - statusRect.right,
        top: statusRect.top - outlineRect.top,
      },
      geometry: [status, outline, help].map(geometry),
      scale: window.visualViewport?.scale ?? 1,
      viewport,
      viewportEscapes: escapes([status, outline, help]),
    };

    function colorContrast(foreground, background) {
      const luminance = (value) => {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const linear = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    }
  }, kind);
}

async function installScrollFixture(page, {
  cwd = "frontend/tests/e2e/fixtures/scroll-mode",
  taskCount = 44,
  eventCount = 20,
  useCurrentPlanServer = false,
} = {}) {
  await installTaskApiFixture(page);
  const tasks = scrollTasks(taskCount, cwd);
  const detail = scrollDetail(tasks[0], eventCount);
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection(tasks) })
  );
  await page.route(
    /\/api\/tasks\/(?!archived(?:[/?]|$))([^/?]+)(?:\?|$)/,
    (route) => {
      const threadId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      return route.fulfill({
        status: threadId === detail.threadId ? 200 : 404,
        json: threadId === detail.threadId
          ? detail
          : { error: "Task not found" },
      });
    },
  );
  if (!useCurrentPlanServer) {
    await page.route(/\/api\/current-plan(?:\?|$)/, (route) =>
      route.fulfill({
        json: {
          status: "absent",
          watchPath: cwd,
          plan: null,
          problems: [],
        },
      })
    );
  }
  return { detail, tasks };
}

async function openScrollTask(page, detail) {
  await page.goto(
    `/tasks/${detail.threadId}?cwd=${encodeURIComponent(detail.task.cwd)}`,
  );
  await openTaskWithBootstrap(page.locator("caffold-tasks-page"), detail);
  await expect(page.locator("caffold-tasks-page")).toContainText(
    "Scrollable conversation block 20",
  );
  await expect.poll(() => page.locator(".task-conversation-scroll").evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  const taskList = page.locator(".task-list-scroll");
  if (await taskList.isVisible()) {
    await expect.poll(() => taskList.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    )).toBe(true);
  } else {
    expect(await taskList.evaluate((element) => element.getClientRects().length))
      .toBe(0);
  }
}

async function removeTaskListOverflow(page, tasks) {
  await expect.poll(() => page.evaluate(
    () => window.__taskListSource?.readyState ?? 0,
  )).toBe(1);
  const removedThreadIds = tasks.slice(1).map(({ threadId }) => threadId);
  await page.evaluate((threadIds) => {
    for (const threadId of threadIds) {
      window.__taskListSource.emit("task-removed", {
        threadId,
        reason: "removed",
      });
    }
  }, removedThreadIds);
  await expect(page.locator(
    "caffold-active-task-list .task-row[data-thread-id]",
  )).toHaveCount(1);
  await expect.poll(() => page.locator(".task-list-scroll").evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true);
}

function scrollTasks(count, cwd) {
  const now = 1_780_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const number = `${index + 1}`.padStart(2, "0");
    const threadId = index === 0 ? "thread-1" : `scroll-task-${number}`;
    return {
      id: threadId,
      threadId,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: `Scroll Task ${number}`,
      preview: `Scroll Task ${number} preview`,
      cwd,
      cwdPath: cwd,
      relativeCwd: "",
      worktree: null,
      createdMs: now - index,
      updatedMs: now - index,
      recencyMs: now - index,
      lastCompletedMs: now - index,
      lastEventSummary: `Scroll Task ${number} complete`,
    };
  });
}

function scrollDetail(task, eventCount) {
  return {
    ...taskDetailFixture(),
    threadId: task.threadId,
    task,
    events: Array.from({ length: eventCount }, (_, index) =>
      messageEvent(
        task.threadId,
        `scroll-event-${index + 1}`,
        `Scrollable conversation block ${index + 1}. ${
          "Long keyboard scrolling content. ".repeat(14)
        }`,
        index,
      )
    ),
  };
}

function messageEvent(threadId, id, text, offset) {
  return {
    id,
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: `turn-${id}`, text },
    position: { anchorMs: 1_780_000_000_000 + offset, index: 0 },
  };
}

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

function writeCurrentDocuments(workspace, { plan, checklist }) {
  const current = join(workspace, ".caffold/plans/current");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "PLAN.md"), plan);
  writeFileSync(join(current, "CHECKLIST.md"), checklist);
}

function longMarkdown(title, count) {
  return [
    `# ${title}`,
    "",
    ...Array.from({ length: count }, (_, index) =>
      `Paragraph ${index + 1}. ${"Scrollable plan content. ".repeat(8)}`
    ),
    "",
  ].join("\n\n");
}

function longNestedMarkdown(title, count) {
  return [
    `# ${title}`,
    "",
    "```text",
    "intrinsically-wide-plan-code-segment-".repeat(16),
    "```",
    "",
    "| Owner | Intrinsically wide value |",
    "| --- | --- |",
    `| ${title} | ${"intrinsically-wide-plan-table-segment-".repeat(16)} |`,
    "",
    ...Array.from({ length: count }, (_, index) =>
      `Paragraph ${index + 1}. ${"Scrollable plan content. ".repeat(8)}`
    ),
    "",
  ].join("\n");
}

function nestedConversationMarkdown() {
  return [
    "Scrollable conversation block 20.",
    "",
    "```text",
    "intrinsically-wide-conversation-code-segment-".repeat(16),
    "```",
    "",
    "| Owner | Intrinsically wide value |",
    "| --- | --- |",
    `| Conversation | ${
      "intrinsically-wide-conversation-table-segment-".repeat(16)
    } |`,
    "",
  ].join("\n");
}

function checklistMarkdown(count, finalLabel) {
  return [
    "# Scroll checklist",
    "",
    ...Array.from({ length: count }, (_, index) =>
      `- [${index < 3 ? "x" : " "}] ${
        index === count - 1 ? finalLabel : `Checklist row ${index + 1}`
      }`
    ),
    "",
  ].join("\n");
}

function currentPlanResponse(page, cwd) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/current-plan" &&
      url.searchParams.get("path") === cwd;
  });
}

function fileResponse(page, path) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/file" && url.searchParams.get("path") === path;
  });
}

async function installCurrentPlanFileFixture(page, workspace) {
  const documents = new Map([
    [
      `${workspace.logicalPath}/.caffold/plans/current/PLAN.md`,
      join(workspace.absolutePath, ".caffold/plans/current/PLAN.md"),
    ],
    [
      `${workspace.logicalPath}/.caffold/plans/current/CHECKLIST.md`,
      join(workspace.absolutePath, ".caffold/plans/current/CHECKLIST.md"),
    ],
  ]);
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const absolutePath = documents.get(path);
    if (!absolutePath) {
      return route.continue();
    }
    const content = readFileSync(absolutePath, "utf8");
    return route.fulfill({
      json: {
        path,
        name: path.split("/").at(-1),
        size: Buffer.byteLength(content),
        modifiedMs: null,
        languageHint: "markdown",
        content,
      },
    });
  });
}

async function emitWatchChange(page, path, change) {
  await expect.poll(() => page.evaluate((watchPath) => {
    return window.__caffoldMockEventSources?.some(
      (source) =>
        source.channel === "watch" &&
        source.context === watchPath &&
        source.readyState !== 2,
    ) ?? false;
  }, path)).toBe(true);
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
