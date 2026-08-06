import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { sep } from "node:path";

import { resolveCodexBin } from "./codex-bin.mjs";

const SPARK_MODEL = "gpt-5.3-codex-spark";
const MULTIMODAL_MODEL = "gpt-5.6-luna";
const LIVE_REASONING_EFFORT = "low";
const PASTED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const liveThreadIds = new Set();

function runCodex(args, { timeout = 120_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexBin(), args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const append = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`Codex CLI output exceeded ${maxBuffer} bytes`));
      }
      return next;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Codex CLI timed out after ${timeout}ms\n${stderr}`));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      finish(
        new Error(
          `Codex CLI exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${stderr}`,
        ),
      );
    });

    // `codex exec` appends piped stdin even when PROMPT is provided. Closing it
    // prevents live tests from waiting forever for nonexistent extra input.
    child.stdin.end();
  });
}

function liveCwd() {
  if (process.env.CAFFOLD_LIVE_CWD) {
    return process.env.CAFFOLD_LIVE_CWD;
  }

  return process.cwd().split(sep).filter(Boolean).join("/");
}

async function chooseModel(taskForm, model, effort = LIVE_REASONING_EFFORT) {
  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const modelOption = taskForm.locator(`[data-model="${model}"]`);
  await expect(modelOption, `Codex model ${model} should be available`).toBeVisible();
  await modelOption.click();
  await expect(taskForm.locator('input[name="model"]')).toHaveValue(model);

  await taskForm.getByRole("button", { name: "Choose model and reasoning" }).click();
  const effortOption = taskForm.locator(`[data-effort="${effort}"]`);
  await expect(
    effortOption,
    `Reasoning effort ${effort} should be available for ${model}`,
  ).toBeVisible();
  await effortOption.click();
  await expect(taskForm.locator('input[name="effort"]')).toHaveValue(effort);
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

async function threadViewerLeases(page, threadId) {
  const response = await page.request.get("/api/codex/status");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return (
    payload.diagnostics?.threadSessions?.activeSessions?.find(
      (session) => session.threadId === threadId,
    )?.viewerLeases ?? 0
  );
}

async function archiveLiveThread(request, threadId) {
  const response = await request.post(`/api/tasks/${threadId}/archive`);
  if (response.status() === 200) {
    liveThreadIds.delete(threadId);
    return;
  }

  const body = await response.text();
  throw new Error(`failed to archive live thread ${threadId}: HTTP ${response.status()} ${body}`);
}

test.afterEach(async ({ request }) => {
  for (const threadId of [...liveThreadIds]) {
    await archiveLiveThread(request, threadId);
  }
});

async function submitPromptAndExpectAccepted(page, threadId, submit) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/api/tasks/${threadId}/prompts`
    );
  });
  await submit();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.status(), `prompt response: ${body}`).toBe(200);
  const payload = JSON.parse(body);
  expect(payload.threadId).toBe(threadId);
  return payload;
}

test("creates and resumes a real Codex task through Caffold with Spark", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-live-initial-${marker}`;
  const markdownHeading = `Caffold live Markdown ${marker}`;
  const markdownInline = `inline-${marker}`;
  const markdownFence = `fenced-${marker}`;
  const commandOutput = `caffold-command-${marker}`;
  const followUpReply = `caffold-live-follow-up-${marker}`;
  const steeredReply = `caffold-live-steered-${marker}`;
  const completedClickReply = `caffold-live-completed-click-${marker}`;
  const externalReply = `caffold-live-external-${marker}`;
  const externalCommandOutput = `caffold-live-external-command-${marker}`;

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseModel(newTaskForm, SPARK_MODEL);

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  liveThreadIds.add(threadId);

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"]',
  );
  const finalAssistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"]',
  );
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  await page.goto("/tasks");
  const createdTask = tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(createdTask).toBeVisible();
  await createdTask.click();
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  const secondPage = await page.context().newPage();
  await secondPage.goto(`/tasks/${threadId}`);
  await expect(
    secondPage
      .locator('caffold-tasks-page .task-message[data-message-role="assistant"]')
      .filter({ hasText: initialReply }),
  ).toBeVisible();
  await expect
    .poll(() => threadViewerLeases(page, threadId), { timeout: 10_000 })
    .toBe(2);
  await secondPage.close();
  await expect
    .poll(() => threadViewerLeases(page, threadId), { timeout: 10_000 })
    .toBe(1);

  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  await chooseModel(followUpForm, SPARK_MODEL);
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
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpPrompt.press("Enter"),
  );
  await expect(followUpPrompt).toBeFocused();

  const markdownMessage = assistantMessages.filter({ hasText: markdownHeading });
  await expect(markdownMessage).toBeVisible();
  await expect(markdownMessage.locator("h2")).toHaveText(markdownHeading);
  await expect(markdownMessage.locator("li code")).toHaveText(markdownInline);
  await expect(markdownMessage.locator("pre code")).toHaveText(markdownFence);

  await followUpPrompt.fill(
    `You must use the command execution tool to run this exact read-only command: /bin/sh -c 'printf ${commandOutput}; sleep 20'. Do not skip or simulate the tool call. After the command finishes, reply with exactly ${followUpReply}. Do not modify files.`,
  );
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpPrompt.press("Enter"),
  );

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

  await followUpPrompt.fill(
    `Continue the current turn. After the running command finishes, reply with exactly ${steeredReply}. Do not modify files.`,
  );
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpForm.getByRole("button", { name: "Send prompt" }).click(),
  );
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: steeredReply }),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-command").last()).toContainText(
    commandOutput,
    { timeout: 60_000 },
  );

  await page.goto("/tasks");
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

  await expect(finalAssistantMessages.filter({ hasText: steeredReply })).toBeVisible();
  await expect(activeTurn).toHaveCount(0);
  const completedWork = tasksPage.locator(".task-turn-work").last();
  const finalResponse = finalAssistantMessages.filter({ hasText: steeredReply });
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

  await page.goto("/tasks");
  await expect(createdTask).toHaveAttribute("data-task-status", "idle");
  await createdTask.click();
  await expect(markdownMessage).toBeVisible();
  await expect(finalResponse).toBeVisible();
  await expect(
    tasksPage.locator(".task-turn-work").last().locator(":scope > details"),
  ).not.toHaveAttribute("open", "");

  await expect(followUpForm).toHaveAttribute("data-thread-id", threadId);
  await followUpPrompt.fill(
    `Reply with exactly ${completedClickReply}. Do not modify files or run commands.`,
  );
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpForm.getByRole("button", { name: "Send prompt" }).click(),
  );
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: completedClickReply }),
  ).toBeVisible();
  await expect(finalAssistantMessages.filter({ hasText: completedClickReply })).toBeVisible();
  await expect(activeTurn).toHaveCount(0);

  const externalRun = runCodex(
    [
      "exec",
      "resume",
      "--all",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-m",
      SPARK_MODEL,
      "-c",
      `model_reasoning_effort="${LIVE_REASONING_EFFORT}"`,
      threadId,
      `You must use the command execution tool to run this exact read-only command: /bin/sh -c 'printf ${externalCommandOutput}; sleep 20'. Do not skip or simulate the tool call. After the command finishes, reply with exactly ${externalReply}. Do not modify files.`,
    ],
  );

  await externalRun;
  await expect(finalAssistantMessages.filter({ hasText: externalReply })).toBeVisible({
    timeout: 15_000,
  });

  await archiveLiveThread(page.request, threadId);
  await expect(
    tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0, { timeout: 5_000 });
  await page.goto("/tasks");
  await expect(tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
});

test("renames a newly created Caffold task through the dynamic tool", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const requestedName = `Caffold dynamic rename ${marker}`;
  const reply = `caffold-live-renamed-${marker}`;

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseModel(newTaskForm, SPARK_MODEL);

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Rename the current Caffold task to exactly "${requestedName}" using the rename_current_thread tool. You must call the tool; do not merely say it was renamed. After the tool succeeds, reply with exactly ${reply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  liveThreadIds.add(threadId);

  await expect(
    tasksPage
      .locator('.task-message[data-message-role="assistant"][data-message-phase="final"]')
      .filter({ hasText: reply }),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/tasks/${threadId}`);
      if (!response.ok()) {
        return false;
      }
      const detail = await response.json();
      return detail.events?.some(
        (event) =>
          event.type === "work_status" &&
          event.payload?.itemType === "dynamicToolCall" &&
          event.payload?.lifecycle === "completed",
      );
    })
    .toBe(true);
  await expect(tasksPage.locator(".task-detail-heading h2")).toHaveText(requestedName);

  await page.goto("/tasks");
  const renamedTask = tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(renamedTask.locator(".task-row-title")).toHaveText(requestedName);

  await archiveLiveThread(page.request, threadId);
  await page.goto("/tasks");
  await expect(
    tasksPage
      .locator('.task-list-section[data-task-section="managed"]')
      .locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0);
  await expect(
    tasksPage
      .locator('.task-list-section[data-task-section="archived"]')
      .locator(`.task-archived-row[data-thread-id="${threadId}"] .task-row-title`),
  ).toHaveText(requestedName);
});

test("sends image attachments through Caffold with a multimodal model", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-live-image-initial-${marker}`;
  const steeredReply = `caffold-live-image-steered-${marker}`;

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseModel(newTaskForm, MULTIMODAL_MODEL);

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `You must use the command execution tool to run this exact read-only command: /bin/sh -c 'sleep 20'. Do not skip or simulate the tool call. After it finishes, reply with exactly ${initialReply}. Do not modify files.`,
  );
  await pasteImage(newTaskPrompt, `caffold-live-create-${marker}.png`);
  await expect(newTaskForm.locator(".task-composer-attachment img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  liveThreadIds.add(threadId);

  const userMessages = tasksPage.locator('.task-message[data-message-role="user"]');
  const initialMessage = userMessages.filter({ hasText: initialReply });
  await expect(initialMessage.locator(".task-message-attachment img")).toBeVisible();

  const activeTurn = tasksPage.locator(".task-turn-active");
  await expect(activeTurn).toBeVisible({ timeout: 15_000 });
  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  const followUpPrompt = followUpForm.getByRole("textbox", {
    name: "Follow-up prompt",
  });
  await followUpPrompt.fill(
    `Continue the current turn. After the running command finishes, reply with exactly ${steeredReply}. Do not modify files.`,
  );
  await pasteImage(followUpPrompt, `caffold-live-steer-${marker}.png`);
  await expect(followUpForm.locator(".task-composer-attachment img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  const outcome = await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpForm.getByRole("button", { name: "Send prompt" }).click(),
  );
  expect(outcome.steered).toBe(true);

  const steeredMessage = userMessages.filter({ hasText: steeredReply });
  await expect(steeredMessage.locator(".task-message-attachment img")).toBeVisible();
  const approval = tasksPage.locator(".task-approval-card").last();
  if (await approval.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await approval.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="assistant"][data-message-phase="final"]')
      .filter({ hasText: steeredReply }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(activeTurn).toHaveCount(0);
});

test("opens a managed completed Spark task and keeps follow-ups canonical", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-external-initial-${marker}`;
  const clickReply = `caffold-external-click-${marker}`;
  const enterReply = `caffold-external-enter-${marker}`;
  const runningReply = `caffold-external-running-${marker}`;
  const ambientRequest = `caffold-external-ambient-${marker}`;
  const ambientReply = `caffold-external-ambient-reply-${marker}`;
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await chooseModel(newTaskForm, SPARK_MODEL);
  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  liveThreadIds.add(threadId);

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"]',
  );
  const userMessages = tasksPage.locator('.task-message[data-message-role="user"]');
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();

  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  await expect(followUpForm).toHaveAttribute("data-thread-id", threadId);
  await chooseModel(followUpForm, SPARK_MODEL);
  const followUpPrompt = followUpForm.getByRole("textbox", { name: "Follow-up prompt" });

  await followUpPrompt.fill(
    `Reply with exactly ${clickReply}. Do not modify files or run commands.`,
  );
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpForm.getByRole("button", { name: "Send prompt" }).click(),
  );
  await expect(userMessages.filter({ hasText: clickReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: clickReply })).toBeVisible();

  await followUpPrompt.fill(
    `Reply with exactly ${enterReply}. Do not modify files or run commands.`,
  );
  await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpPrompt.press("Enter"),
  );
  await expect(followUpPrompt).toBeFocused();
  await expect(userMessages.filter({ hasText: enterReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: enterReply })).toBeVisible();

  const externalRun = runCodex(
    [
      "exec",
      "resume",
      "--all",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-m",
      SPARK_MODEL,
      "-c",
      `model_reasoning_effort="${LIVE_REASONING_EFFORT}"`,
      threadId,
      `You must use the command execution tool to run this exact read-only command: /bin/sh -c 'sleep 20'. Do not skip or simulate the tool call. After it finishes, reply with exactly ${runningReply}. Do not modify files.`,
    ],
  );

  const activeTurn = tasksPage.locator(".task-turn-active");
  await externalRun;
  await expect(assistantMessages.filter({ hasText: runningReply })).toBeVisible({
    timeout: 30_000,
  });
  await expect(activeTurn).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/tasks/${threadId}`);
      if (!response.ok()) {
        return `http:${response.status()}`;
      }
      const detail = await response.json();
      return `${detail.task?.threadStatus?.type}:${Boolean(detail.task?.activeTurn)}`;
    })
    .toBe("idle:false");

  await runCodex([
    "exec",
    "resume",
    "--all",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-m",
    SPARK_MODEL,
    "-c",
    `model_reasoning_effort="${LIVE_REASONING_EFFORT}"`,
    threadId,
    [
      "This block is automatically supplied ambient UI state, not part of the user's request.",
      "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
      "# In app browser:",
      "- The user has the in-app browser open with 1 tab.",
      `- Current URL: http://127.0.0.1:5178/tasks/${threadId}`,
      "My request for Codex:",
      `${ambientRequest}. Reply with exactly ${ambientReply}. Do not modify files or run commands.`,
    ].join("\n"),
  ]);
  await expect(userMessages.filter({ hasText: ambientRequest })).toBeVisible({
    timeout: 30_000,
  });
  await expect(assistantMessages.filter({ hasText: ambientReply })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");
  await expect(tasksPage).not.toContainText("The user has the in-app browser open");

  await page.reload();
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: clickReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: enterReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: runningReply })).toBeVisible();
  await expect(userMessages.filter({ hasText: ambientRequest })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: ambientReply })).toBeVisible();
  await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");

  await archiveLiveThread(page.request, threadId);
  await expect(tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0, {
    timeout: 5_000,
  });
  await page.goto("/tasks");
  await expect(tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
});
