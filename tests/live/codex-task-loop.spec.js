import { expect, test } from "@playwright/test";
import { sep } from "node:path";

const PASTED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function liveCwd() {
  if (process.env.CAFFOLD_LIVE_CWD) {
    return process.env.CAFFOLD_LIVE_CWD;
  }

  return process.cwd().split(sep).filter(Boolean).join("/");
}

async function chooseLowCostModel(taskForm) {
  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const modelOptions = taskForm.locator("[data-model]");
  await expect(modelOptions.first()).toBeVisible();
  const affordableOptions = modelOptions.filter({
    hasText: /affordable|cost-efficient|ultra-fast/i,
  });
  const modelOption =
    (await affordableOptions.count()) > 0 ? affordableOptions.first() : modelOptions.last();
  await modelOption.click();

  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const lowEffort = taskForm.locator('[data-effort="low"]');
  await expect(lowEffort).toBeVisible();
  await lowEffort.click();
}

async function pasteImage(locator, name) {
  await locator.evaluate(
    (textarea, { base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], fileName, { type: "image/png" }));
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    { base64: PASTED_IMAGE_BASE64, fileName: name },
  );
}

test("creates and resumes a real Codex task through Caffold", async ({ page }) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-live-initial-${marker}`;
  const markdownHeading = `Caffold live Markdown ${marker}`;
  const markdownInline = `inline-${marker}`;
  const markdownFence = `fenced-${marker}`;
  const commandOutput = `caffold-command-${marker}`;
  const followUpReply = `caffold-live-follow-up-${marker}`;

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseLowCostModel(newTaskForm);

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await pasteImage(newTaskPrompt, `caffold-live-${marker}.png`);
  await expect(newTaskForm.locator(".task-composer-attachment img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+\?cwd=/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"]',
  );
  const finalAssistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"]',
  );
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-message[data-message-role="user"] .task-message-attachment img',
    ),
  ).toBeVisible();

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  const createdTask = tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(createdTask).toBeVisible();
  await createdTask.click();
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  await chooseLowCostModel(followUpForm);
  const followUpPrompt = followUpForm.getByRole("textbox", { name: "Follow-up prompt" });
  await followUpPrompt.fill(
    [
      "Reply with exactly this Markdown and nothing else:",
      `## ${markdownHeading}`,
      `- \`${markdownInline}\``,
      "```text",
      markdownFence,
      "```",
    ].join("\n"),
  );
  await followUpPrompt.press("Enter");
  await expect(followUpPrompt).toBeFocused();

  const markdownMessage = assistantMessages.filter({ hasText: markdownHeading });
  await expect(markdownMessage).toBeVisible();
  await expect(markdownMessage.locator("h2")).toHaveText(markdownHeading);
  await expect(markdownMessage.locator("li code")).toHaveText(markdownInline);
  await expect(markdownMessage.locator("pre code")).toHaveText(markdownFence);

  await followUpPrompt.fill(
    `You must use the command execution tool to run this exact read-only command: /bin/sh -c 'printf ${commandOutput}; sleep 20'. Do not skip or simulate the tool call. After the command finishes, reply with exactly ${followUpReply}. Do not modify files.`,
  );
  await followUpPrompt.press("Enter");

  await expect(followUpPrompt).toBeFocused();
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: followUpReply }),
  ).toBeVisible();
  const activeTurn = tasksPage.locator(".task-turn-active");
  await expect(activeTurn).toHaveCount(1, { timeout: 15_000 });
  await expect(activeTurn).toBeVisible({ timeout: 15_000 });
  await expect(activeTurn.locator(".task-turn-active-state")).not.toHaveText("");
  const activeDuration = await activeTurn.locator(".task-turn-active-duration").textContent();
  await expect
    .poll(() => activeTurn.locator(".task-turn-active-duration").textContent())
    .not.toBe(activeDuration);
  await expect(tasksPage.locator(".task-command").last()).toContainText(
    commandOutput,
    { timeout: 60_000 },
  );

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  await expect(createdTask).toBeVisible();
  await createdTask.click();
  if (await activeTurn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await expect(activeTurn.locator(".task-turn-active-duration")).toContainText(
      "Working for",
    );
    await expect(activeTurn.locator(".task-turn-active-state")).not.toHaveText("");
  }

  const approval = tasksPage.locator(".task-approval-card").last();
  if (await approval.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await approval.getByRole("button", { name: "Accept", exact: true }).click();
  }

  await expect(finalAssistantMessages.filter({ hasText: followUpReply })).toBeVisible();
  await expect(activeTurn).toHaveCount(0);
  const completedWork = tasksPage.locator(".task-turn-work").last();
  const finalResponse = finalAssistantMessages.filter({ hasText: followUpReply });
  const completedWorkDetails = completedWork.locator(":scope > details");
  await expect(completedWork).toContainText("Worked for");
  await expect(completedWorkDetails).not.toHaveAttribute("open", "");
  await expect(finalResponse).toHaveCount(1);
  await expect
    .poll(() =>
      finalResponse.evaluate((response) =>
        response.previousElementSibling?.classList.contains("task-turn-work"),
      ),
    )
    .toBe(true);
  await completedWorkDetails.locator(":scope > summary").click();
  await expect(completedWork).toContainText(commandOutput);

  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  await expect(createdTask).toHaveAttribute("data-task-status", "idle");
  await createdTask.click();
  await expect(markdownMessage).toBeVisible();
  await expect(finalResponse).toBeVisible();
  await expect(
    tasksPage.locator(".task-turn-work").last().locator(":scope > details"),
  ).not.toHaveAttribute("open", "");

  const archiveResponse = await page.request.post(`/api/tasks/${threadId}/archive`);
  expect(archiveResponse.status()).toBe(204);
  await page.goto(`/tasks?cwd=${encodeURIComponent(cwd)}`);
  await expect(tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
});
