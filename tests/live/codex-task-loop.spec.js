import { expect, test } from "@playwright/test";
import { sep } from "node:path";

const LOW_COST_MODEL = "gpt-5.4-mini";

function liveCwd() {
  if (process.env.CAFFOLD_LIVE_CWD) {
    return process.env.CAFFOLD_LIVE_CWD;
  }

  return process.cwd().split(sep).filter(Boolean).join("/");
}

async function chooseLowCostModel(taskForm) {
  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const modelOption = taskForm.locator(`[data-model="${LOW_COST_MODEL}"]`);
  await expect(modelOption).toBeVisible();
  await modelOption.click();

  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const lowEffort = taskForm.locator('[data-effort="low"]');
  await expect(lowEffort).toBeVisible();
  await lowEffort.click();
}

test("creates and resumes a real Codex task through Caffold", async ({ page }) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-live-initial-${marker}`;
  const followUpReply = `caffold-live-follow-up-${marker}`;

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseLowCostModel(newTaskForm);

  await newTaskForm.getByRole("textbox", { name: "New task prompt" }).fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await newTaskForm.getByRole("textbox", { name: "New task prompt" }).press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+\?cwd=/);

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"]',
  );
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  const createdTask = tasksPage.locator(".task-row", { hasText: initialReply });
  await expect(createdTask).toBeVisible();
  await createdTask.click();
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  await chooseLowCostModel(followUpForm);
  const followUpPrompt = followUpForm.getByRole("textbox", { name: "Follow-up prompt" });
  await followUpPrompt.fill(
    `Reply with exactly ${followUpReply}. Do not modify files or run commands.`,
  );
  await followUpPrompt.press("Enter");

  await expect(followUpPrompt).toBeFocused();
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: followUpReply }),
  ).toBeVisible();
  await expect(assistantMessages.filter({ hasText: followUpReply })).toBeVisible();
});
