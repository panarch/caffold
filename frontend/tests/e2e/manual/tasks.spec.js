import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualRepository,
  installManualTasks,
  MANUAL_SECTION_ID,
  MANUAL_TASKS,
  MANUAL_UPLOAD_PROMPT,
  attachManualUploadFiles,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualTasks(page);
  await installManualRepository(page);
});

test("a finished Task shows its answer, plan, and Sections", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
  const task = MANUAL_TASKS.darkTheme;
  await page.goto(`/tasks/${task.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(tasksPage.locator(".task-detail-heading")).toContainText(task.title);
  await expect(
    tasksPage.locator('caffold-task-assistant-message[data-message-phase="final"]'),
  ).toContainText("Dark theme is ready to review");
  await expect(
    tasksPage.locator("caffold-task-current-plan .task-current-plan-strip"),
  ).toHaveAttribute("data-presentation", "ready");
  if (testInfo.project.name === "desktop") {
    const navigator = page.locator("caffold-task-navigator");
    await expect(
      navigator.locator("caffold-active-task-list .task-repository-header"),
    ).toHaveText([
      /lumen/, /lumen-api/, /launch/,
    ]);
    await expect(
      navigator.locator(`.task-row[data-thread-id="${task.threadId}"] .task-row-worktree`),
    ).toBeVisible();
  }
  await captureReviewScreenshot(page, testInfo, "task-conversation");
});

test("work details list the command and the changed files", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

  const conversation = page.locator("caffold-task-conversation");
  await conversation.getByText("3 updates").click();
  await expect(conversation).toContainText("npm test -- settings");
  await expect(conversation).toContainText("src/settings/ThemePicker.tsx");
  // Scrolled to the end, the answer clears the plan floating above the Composer.
  await conversation.locator(":scope > .task-conversation-scroll").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await captureReviewScreenshot(page, testInfo, "task-work-details");
});

test("New Task shows the worktree guide", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/tasks/new?cwd=Workspace%2Flumen");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  await expect(form).toContainText("Workspace/lumen");
  await expect(page.getByText("Prepare this task in an isolated worktree.", { exact: false })).toBeVisible();
  await expect(page.getByText("Now review PR #123.")).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "new-task");
});

test("New Task groups the models by agent", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/tasks/new?cwd=Workspace%2Flumen");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  await form.getByRole("button", { name: /^Choose model/ }).click();
  const menu = form.locator(".task-model-popover");
  await expect(menu.locator(".task-provider-option")).toHaveText([
    "Codex", "Claude", "Grok",
  ]);
  await expect(menu.locator('section[aria-label="Reasoning level"]')).toBeVisible();
  await expect(menu.locator('section[aria-label="Speed"]')).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "new-task-model-picker");
});

test("attached files wait in the Composer", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto("/tasks/new?cwd=Workspace%2Flumen");

  const form = page.locator('.task-new-form[data-task-form="create"]');
  await form.locator("textarea[name='prompt']").fill(MANUAL_UPLOAD_PROMPT);
  await attachManualUploadFiles(form);
  await expect(form.getByRole("button", { name: "Attach files" })).toBeVisible();
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(form.getByRole("button", { name: "Preview upload-stall.png" })).toBeVisible();
  await expect(form.locator(".task-composer-file")).toHaveCount(1);
  await expect(form.locator(".task-composer-file")).toContainText("upload.log");
  await expect(form.getByRole("button", { name: /^Remove / })).toHaveCount(2);
  await captureReviewScreenshot(page, testInfo, "composer-attachments");
});

test("a sent prompt shows its pictures and lists its attached files", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.uploadsReview.threadId}`);

  const message = page.locator("caffold-task-user-message").first();
  await expect(message).toContainText("Attached files:");
  await expect(message).toContainText(".caffold/uploads/20260924-134012-k3v9/upload.log");
  await expect(message.locator(".task-message-attachment")).toHaveCount(1);
  await expect(
    page.locator('caffold-task-assistant-message[data-message-phase="final"]'),
  ).toContainText("The last chunk is never acknowledged");
  await page.locator("caffold-task-conversation > .task-conversation-scroll").evaluate((scroller) => {
    scroller.scrollTop = 0;
  });
  await captureReviewScreenshot(page, testInfo, "conversation-attachments");
});

test("an approval request waits in the conversation", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.flakyCheckout.threadId}`);

  const card = page.locator('.task-approval-card[data-approval-id="checkout-repeat"]');
  await expect(card).toContainText("npx playwright test tests/e2e/checkout.spec.ts --repeat-each=20");
  await expect(card.getByRole("button")).toHaveText([
    "Allow", "Allow for this session", "Deny", "Deny and Stop",
  ]);
  await captureReviewScreenshot(page, testInfo, "approval-card");
});

test("the approval-mode list includes Ask Jev first", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  await form.getByRole("button", { name: "Choose approval mode" }).click();
  const menu = form.getByRole("menu", { name: "Approval modes" });
  await expect(menu.locator(".task-permission-option")).toHaveCount(4);
  await expect(menu).toContainText("Ask Jev first");
  await captureReviewScreenshot(page, testInfo, "approval-modes");
});

test("the plan's title and count sit above the Composer", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

  await expect(
    page.locator('caffold-task-assistant-message[data-message-phase="final"]'),
  ).toContainText("Open Working Tree to review the four changed files.");
  const strip = page.locator("caffold-task-current-plan .task-current-plan-strip");
  await expect(strip).toHaveAttribute("data-presentation", "ready");
  await expect(strip).toContainText("Dark theme for Settings");
  await expect(strip).toContainText("5 / 5");
  const pane = await page.locator("caffold-task-conversation").boundingBox();
  const plan = await strip.boundingBox();
  const composer = await page.locator('.task-follow-up-form[data-task-form="follow-up"]').boundingBox();
  const top = plan.y - 16;
  await captureReviewScreenshot(page, testInfo, "current-plan", {
    clip: {
      x: pane.x,
      y: top,
      width: pane.width,
      height: composer.y + composer.height + 8 - top,
    },
  });
});

test("the Checklist opens from the plan above the Composer", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

  const currentPlan = page.locator("caffold-task-current-plan");
  await currentPlan.getByRole("button", { name: "Open checklist: 5 of 5 complete" }).click();
  const dialog = currentPlan.locator("caffold-current-plan-document-dialog > dialog");
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog.locator("caffold-markdown-preview")).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(dialog).toContainText("Run the settings test suite");
  await captureReviewScreenshot(page, testInfo, "current-plan-checklist");
});

test("Task details shows the worktree and holds Fork task and Archive task", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.darkTheme.threadId}`);

  const archived = page.locator("caffold-archived-task-list");
  await expect(archived.getByRole("button", { name: /^Restore / })).toHaveCount(2);
  await expect(archived.getByRole("button", { name: /^Delete / })).toHaveCount(2);

  await page.getByRole("button", { name: /^Task details/ }).click();
  const details = page.locator(".task-detail-popover");
  await expect(details).toBeVisible();
  await expect(details).toContainText(MANUAL_TASKS.darkTheme.worktree.branch);
  await expect(details.getByRole("button", { name: "Fork task" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Archive task" })).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "task-details");
});

test("the prompts a Task settled open from its details", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/tasks/${MANUAL_TASKS.pagination.threadId}`);

  await page.getByRole("button", { name: /^Task details/ }).click();
  await page.getByRole("button", { name: "What your prompts settled" }).click();
  const dialog = page.locator("caffold-task-permission-instructions-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "never touch config/production.yml",
  );
  await expect(dialog.locator(".task-permission-instructions-text")).toContainText(
    "reset the local database",
  );
  await expect(dialog.getByRole("button", { name: "Forget these" })).toBeEnabled();
  await captureReviewScreenshot(page, testInfo, "permission-instructions");
});

test("a Section opens New Task in its directory", { tag: "@desktop" }, async ({ page }, testInfo) => {
  await page.goto(`/?section=${MANUAL_SECTION_ID}`);

  const detail = page.locator("caffold-detail-layout");
  await expect(detail.locator("caffold-section-detail .task-composer-panel")).toBeVisible();
  await expect(detail.locator("caffold-section-conversation-shortcuts")).toContainText(
    "Existing conversations",
  );
  await expect(
    detail.locator("caffold-section-github-shortcuts").getByRole("button"),
  ).toHaveText(["Issues", "Pull Requests"]);
  await captureReviewScreenshot(page, testInfo, "section-detail");
});
