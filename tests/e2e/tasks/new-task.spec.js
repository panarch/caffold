import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  captureReviewScreenshot,
  openHeaderActionGroup,
  pasteImage,
  stabilizeDynamicText,
  taskPresentation,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("creates a task with responsive composer controls and canonical approval state", async ({
  page,
}, testInfo) => {
  const scenario = await installTaskLoopFixture(page);
  const { contextPath, threadId } = scenario;
  const touchInterface = testInfo.project.name !== "desktop";
  await page.goto(`/files?cwd=${encodeURIComponent(contextPath)}`);
  const codexPopover = await openHeaderActionGroup(page, "codex");
  await codexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL("/tasks");
  const codexWorkspace = page.locator("caffold-codex-workspace");
  await expect(codexWorkspace).toBeVisible();
  await expect
    .poll(() =>
      codexWorkspace.evaluate((element) => element.parentElement?.tagName.toLowerCase()),
    )
    .toBe("caffold-app-shell");
  const appShellBox = await page.locator("caffold-app-shell").boundingBox();
  const codexWorkspaceBox = await codexWorkspace.boundingBox();
  expect(Math.round(codexWorkspaceBox?.y ?? -1)).toBe(Math.round(appShellBox?.y ?? -2));
  expect(Math.round(codexWorkspaceBox?.height ?? -1)).toBe(
    Math.round(appShellBox?.height ?? -2),
  );
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "list",
  );
  await expect(page.locator("caffold-tasks-page")).toContainText("No Caffold tasks yet.");

  const emptyNewTaskButton = page
    .locator("caffold-tasks-page .tasks-empty")
    .getByRole("button", { name: "New Task", exact: true });
  await test.step("keeps shared task controls stable", async () => {
    expect(await taskPresentation(emptyNewTaskButton)).toEqual(
      expect.objectContaining({
        alignItems: "center",
        backgroundColor: "rgb(221, 239, 232)",
        borderColor: "rgb(159, 201, 187)",
        borderRadius: "5px",
        borderWidth: "1px",
        color: "rgb(22, 124, 92)",
        display: "inline-grid",
        minHeight: touchInterface ? "40px" : "32px",
        padding: "5px 10px",
      }),
    );
    expect(
      await taskPresentation(
        page.locator(
          'caffold-tasks-page .tasks-header [data-task-action="open-settings"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: "5px",
        borderWidth: "1px",
        display: "grid",
        height: touchInterface ? 40 : 32,
        padding: "0px",
        width: touchInterface ? 40 : 32,
      }),
    );
  });
  await emptyNewTaskButton.click();
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(contextPath)}`);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "new",
  );
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-list"]'),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page .tasks-header h1")).toHaveText(
    "New Task",
  );
  const newTaskHeaderMetrics = await page.evaluate(() => {
    const closeButton = document
      .querySelector("caffold-codex-workspace .codex-workspace-close")
      .getBoundingClientRect();
    const title = document
      .querySelector("caffold-tasks-page .tasks-header h1")
      .getBoundingClientRect();
    return {
      closeRight: closeButton.right,
      titleLeft: title.left,
    };
  });
  expect(newTaskHeaderMetrics.titleLeft).toBeGreaterThanOrEqual(
    newTaskHeaderMetrics.closeRight + 8,
  );
  const newTaskComposer = page.locator("caffold-tasks-page .task-new-form");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("GPT-5.6-Sol");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Light");
  await newTaskComposer.locator(".task-model-button").click();
  const modelPopover = page.locator("caffold-tasks-page .task-model-popover");
  await expect(modelPopover).toBeVisible();
  const modelPopoverMetrics = await newTaskComposer.evaluate((form) => {
    const button = form.querySelector(".task-model-button").getBoundingClientRect();
    const panel = form.querySelector(".task-composer-panel").getBoundingClientRect();
    const popover = form.querySelector(".task-model-popover").getBoundingClientRect();
    const firstDescription = form.querySelector(".task-model-option small");
    const descriptionStyle = firstDescription
      ? window.getComputedStyle(firstDescription)
      : null;
    return {
      buttonBottom: button.bottom,
      buttonLeft: button.left,
      panelBottom: panel.bottom,
      panelLeft: panel.left,
      panelRight: panel.right,
      backdropVisible: Boolean(
        form.querySelector(".task-model-backdrop") &&
          window.getComputedStyle(form.querySelector(".task-model-backdrop")).display !==
            "none",
      ),
      popoverBottom: popover.bottom,
      popoverLeft: popover.left,
      popoverRight: popover.right,
      popoverTop: popover.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      descriptionWhiteSpace: descriptionStyle?.whiteSpace ?? "",
    };
  });
  expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportWidth - 9,
  );
  expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverBottom).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportHeight - 9,
  );
  expect(modelPopoverMetrics.descriptionWhiteSpace).not.toBe("nowrap");
  if (testInfo.project.name !== "phone") {
    expect(modelPopoverMetrics.backdropVisible).toBe(false);
    expect(
      Math.abs(modelPopoverMetrics.popoverLeft - modelPopoverMetrics.buttonLeft),
    ).toBeLessThanOrEqual(2);
    expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(
      modelPopoverMetrics.buttonBottom + 6,
    );
    expect(
      modelPopoverMetrics.popoverTop - modelPopoverMetrics.buttonBottom,
    ).toBeLessThanOrEqual(14);
  } else {
    expect(modelPopoverMetrics.backdropVisible).toBe(true);
    expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
    expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
      modelPopoverMetrics.viewportWidth - 9,
    );
    expect(
      modelPopoverMetrics.viewportHeight - modelPopoverMetrics.popoverBottom,
    ).toBeLessThanOrEqual(14);
    await newTaskComposer.locator(".task-model-backdrop").click({
      position: { x: 8, y: 8 },
    });
    await expect(modelPopover).toBeHidden();
    await newTaskComposer.locator(".task-model-button").click();
    await expect(modelPopover).toBeVisible();
  }
  await captureReviewScreenshot(page, testInfo, "tasks-model-popover");
  await expect(modelPopover.locator('[data-effort="xhigh"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="max"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="ultra"]')).toBeVisible();
  await modelPopover.locator('[data-effort="xhigh"]').click();
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Extra High");
  const newPromptTextarea = newTaskComposer.locator('textarea[name="prompt"]');
  const initialTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      rows: textarea.getAttribute("rows"),
    };
  });
  expect(initialTextareaMetrics.rows).toBe("2");

  await newPromptTextarea.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const expandedTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      clientHeight: textarea.clientHeight,
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      overflowY: styles.overflowY,
      scrollHeight: textarea.scrollHeight,
    };
  });
  expect(expandedTextareaMetrics.height).toBeGreaterThan(
    initialTextareaMetrics.height + 20,
  );
  expect(expandedTextareaMetrics.height).toBeLessThanOrEqual(
    expandedTextareaMetrics.maxHeight + 2,
  );
  expect(expandedTextareaMetrics.scrollHeight).toBeGreaterThan(
    expandedTextareaMetrics.clientHeight,
  );
  expect(expandedTextareaMetrics.overflowY).toBe("auto");

  await newPromptTextarea.fill("Inspect the planner changes");
  await pasteImage(newPromptTextarea, "planner-layout.png");
  const newTaskAttachment = page.locator(
    'form[data-task-form="create"] .task-composer-attachment',
  );
  await expect(newTaskAttachment).toHaveCount(1);
  await expect(newTaskAttachment.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await newTaskAttachment.getByRole("button", { name: "Remove planner-layout.png" }).click();
  await expect(newTaskAttachment).toHaveCount(0);
  await pasteImage(newPromptTextarea, "planner-layout.png");
  await expect(newTaskAttachment).toHaveCount(1);
  const newTaskFormState = await page.locator("caffold-tasks-page").evaluate((element) => {
    const form = element.querySelector('form[data-task-form="create"]');
    return {
      data: Object.fromEntries(new FormData(form).entries()),
      valid: form.checkValidity(),
    };
  });
  expect(newTaskFormState).toEqual({
    data: {
      effort: "xhigh",
      model: "gpt-5.6-sol",
      permissionMode: "approveForMe",
      prompt: "Inspect the planner changes",
    },
    valid: true,
  });
  await page.locator('caffold-tasks-page textarea[name="prompt"]').press("Enter");

  await expect.poll(() => scenario.createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveCount(1);
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(tasksPage).toContainText("Inspect the planner changes");
  await expect(tasksPage).toContainText("Thread thread_1");
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main · src");
  await expect(tasksPage.locator(".task-conversation")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary h2")).toHaveCSS(
    "font-size",
    touchInterface ? "17px" : "16px",
  );
  await expect(tasksPage.locator(".task-detail-meta")).toHaveCSS(
    "font-size",
    touchInterface ? "12.75px" : "12px",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).toContainText(
    "Inspect the planner changes",
  );
  const userAttachments = tasksPage.locator(".task-message-attachment");
  await expect(userAttachments).toHaveCount(2);
  await expect(userAttachments.nth(0).locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(userAttachments.nth(0).locator("figcaption")).toContainText(
    "planner-layout.png",
  );
  await expect(userAttachments.nth(1).locator("img")).toBeVisible();
  await expect(userAttachments.nth(1).locator("img")).toHaveAttribute(
    "src",
    /\/api\/task-image\?path=%2Ftmp%2Fplanner-layout\.png$/,
  );
  await expect(userAttachments.nth(1).locator("figcaption")).toContainText(
    "server-reference.png",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "Files mentioned by the user",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "/tmp/planner-layout.png",
  );
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"] .task-message-content'),
  ).toHaveCSS("font-size", "15px");
  await expect(tasksPage).toContainText("Command Approval");
  await expect(tasksPage).toContainText("cargo test");
  await expect(tasksPage).toContainText("Run the test suite");
  await expect(tasksPage.locator(".task-conversation .task-approval-flow")).toHaveCount(1);
  await expect(tasksPage.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  await test.step("keeps detail, conversation, and composer presentation stable", async () => {
    const phone = testInfo.project.name === "phone";
    expect(await taskPresentation(tasksPage.locator(".task-detail-summary"))).toEqual(
      expect.objectContaining({
        alignItems: "center",
        borderWidth: "0px 0px 1px",
        display: "grid",
        padding: phone ? "7px 8px" : "12px 14px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-detail-summary .task-status-chip[data-status="waiting_for_approval"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 248, 231)",
        borderColor: "rgb(223, 197, 143)",
        borderRadius: "999px",
        borderWidth: "1px",
        color: "rgb(127, 86, 0)",
        display: "grid",
        height: 22,
        padding: "0px",
        width: 22,
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-approval-card button[data-task-action="approval"][data-decision="accept"]',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        alignItems: "center",
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: "5px",
        borderWidth: "1px",
        color: "rgb(22, 124, 92)",
        display: "grid",
        minHeight: touchInterface ? "40px" : "32px",
        padding: "5px 10px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(
          '.task-message[data-message-role="user"] .task-message-content',
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(238, 242, 239)",
        borderRadius: "18px",
        fontSize: "15px",
        lineHeight: "22.05px",
        overflowWrap: "anywhere",
        padding: "10px 14px",
      }),
    );
    expect(
      await taskPresentation(
        tasksPage.locator(".task-follow-up-form .task-composer-panel"),
      ),
    ).toEqual(
      expect.objectContaining({
        backgroundColor: "rgb(255, 255, 255)",
        borderRadius: phone ? "16px" : "18px",
        borderWidth: "1px",
        display: "grid",
        overflow: "visible",
      }),
    );
  });
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-presentation-contract-active",
  );
  await expect
    .poll(() => tasksPage.evaluate((element) => element.selectedThreadId))
    .toBe(threadId);
  await expect
    .poll(() =>
      tasksPage
        .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
        .evaluate((button) => ({
          action: button.dataset.taskAction,
          approvalId: button.dataset.approvalId,
          decision: button.dataset.decision,
        })),
    )
    .toEqual({ action: "approval", approvalId: "approval_1", decision: "accept" });

});
