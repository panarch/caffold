import { expect, test } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { CodexDaemonClient } from "./codex-daemon-client.mjs";
import {
  assertLiveModelPolicy,
  buildLiveUsageReport,
  collectTestUsage,
  formatLiveUsageReport,
  LIVE_MODEL_POLICY,
  mergeLiveUsageReports,
} from "./codex-live-usage.mjs";

const SPARK_MODEL = LIVE_MODEL_POLICY.models.spark;
const FAST_MODEL = LIVE_MODEL_POLICY.models.fast;
const MULTIMODAL_MODEL = LIVE_MODEL_POLICY.models.multimodal;
const LIVE_REASONING_EFFORT = LIVE_MODEL_POLICY.reasoningEffort;
const PASTED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const liveThreadIds = new Set();
const measuredThreadModels = new Map();
const liveUsageTests = [];
let liveUsageBefore;
let liveUsageRunId;
let liveUsageStartedAt;

function trackLiveThread(threadId, scenario, model) {
  assertLiveModelPolicy({
    scenario,
    model,
    effort: LIVE_REASONING_EFFORT,
  });
  liveThreadIds.add(threadId);
  measuredThreadModels.set(threadId, model);
}

async function readCodexStatus(request) {
  const response = await request.get("/api/codex/status");
  const body = await response.text();
  expect(response.status(), `Codex status response: ${body}`).toBe(200);
  return JSON.parse(body);
}

async function readSettledCodexStatus(request) {
  let status = await readCodexStatus(request);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await readCodexStatus(request);
  }
  return status;
}

function taskNavigator(page) {
  return page.locator("caffold-task-navigator");
}

function liveCwd() {
  if (process.env.CAFFOLD_LIVE_CWD) {
    return process.env.CAFFOLD_LIVE_CWD;
  }

  return process.cwd().split(sep).filter(Boolean).join("/");
}

async function chooseModel(taskForm, scenario) {
  const model = LIVE_MODEL_POLICY.models[scenario];
  const effort = LIVE_REASONING_EFFORT;
  assertLiveModelPolicy({ scenario, model, effort });
  await taskForm.getByRole("button", { name: /Choose model/ }).click();
  const modelOption = taskForm.locator(`[data-model="${model}"]`);
  await expect(modelOption, `Codex model ${model} should be available`).toBeVisible();
  await modelOption.click();
  await expect(taskForm.locator('input[name="model"]')).toHaveValue(model);

  await taskForm.getByRole("button", { name: /Choose model/ }).click();
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

async function restoreLiveThread(request, threadId) {
  const response = await request.post(`/api/tasks/${threadId}/restore`);
  const body = await response.text();
  expect(response.status(), `restore response: ${body}`).toBe(200);
  liveThreadIds.add(threadId);
  return JSON.parse(body);
}

function initializeLiveRepository(marker) {
  const relativePath = join("target", "caffold-live-fixtures", marker);
  const repository = join(process.cwd(), relativePath);
  mkdirSync(repository, { recursive: true });
  for (const args of [
    ["init"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Caffold Live Test"],
  ]) {
    execFileSync("git", ["-C", repository, ...args]);
  }
  writeFileSync(join(repository, "README.md"), "Caffold live worktree fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "Initial fixture"]);
  execFileSync("git", ["-C", repository, "branch", "-M", "main"]);
  return {
    repository,
    cwd: [liveCwd(), relativePath.split(sep).join("/")]
      .filter(Boolean)
      .join("/"),
  };
}

function initializePersistentLiveRepository(marker) {
  const relativePath = join("target", "caffold-live-fixtures", marker);
  const repository = join(process.cwd(), relativePath);
  mkdirSync(repository, { recursive: true });
  if (!existsSync(join(repository, ".git"))) {
    execFileSync("git", ["-C", repository, "init"]);
  }
  for (const args of [
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Caffold Live Test"],
  ]) {
    execFileSync("git", ["-C", repository, ...args]);
  }
  try {
    execFileSync("git", ["-C", repository, "rev-parse", "--verify", "HEAD"]);
  } catch {
    writeFileSync(join(repository, "README.md"), "Caffold live worktree fixture\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "Initial fixture"]);
  }
  execFileSync("git", ["-C", repository, "branch", "-M", "main"]);
  return {
    repository,
    cwd: [liveCwd(), relativePath.split(sep).join("/")]
      .filter(Boolean)
      .join("/"),
  };
}

function branchExists(repository, branchName) {
  try {
    execFileSync(
      "git",
      ["-C", repository, "show-ref", "--verify", `refs/heads/${branchName}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

async function runGitWithIndexRetry(repository, args) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        execFile("git", ["-C", repository, ...args], (error, _stdout, stderr) => {
          if (error) {
            error.stderr = stderr;
            reject(error);
          } else {
            resolve();
          }
        });
      });
      return;
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      if (!stderr.includes("index.lock") || attempt === 20) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test.beforeAll(async ({ request }, testInfo) => {
  liveUsageRunId = String(testInfo.project.use.baseURL);
  liveUsageStartedAt = new Date().toISOString();
  liveUsageBefore = await readCodexStatus(request);
});

test.afterEach(async ({ request }, testInfo) => {
  const errors = [];
  try {
    const status = await readCodexStatus(request);
    liveUsageTests.push({
      ...collectTestUsage({
        title: testInfo.title,
        status,
        threadModels: new Map(measuredThreadModels),
      }),
      outcome: testInfo.status,
      durationMs: testInfo.duration,
    });
  } catch (error) {
    errors.push(error);
  }
  for (const threadId of [...liveThreadIds]) {
    try {
      await archiveLiveThread(request, threadId);
    } catch (error) {
      errors.push(error);
    }
  }
  measuredThreadModels.clear();
  if (errors.length > 0) {
    throw new AggregateError(errors, "live usage measurement or teardown failed");
  }
});

test.afterAll(async ({ request }) => {
  const afterStatus = await readSettledCodexStatus(request);
  const currentReport = buildLiveUsageReport({
    runId: liveUsageRunId,
    startedAt: liveUsageStartedAt,
    finishedAt: new Date().toISOString(),
    beforeStatus: liveUsageBefore,
    afterStatus,
    tests: liveUsageTests,
  });
  const artifactPath = join(process.cwd(), "test-results", "codex-live-usage.json");
  let report = currentReport;
  if (existsSync(artifactPath)) {
    try {
      report = mergeLiveUsageReports(
        JSON.parse(readFileSync(artifactPath, "utf8")),
        currentReport,
      );
    } catch {
      // Replace an unreadable artifact with the current run's valid report.
    }
  }
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(formatLiveUsageReport(report));

  const missingPassedThreads = report.tests
    .filter((measured) => measured.outcome === "passed")
    .flatMap((measured) => measured.missingThreadIds);
  expect(
    missingPassedThreads,
    "passed live tests should expose final token usage for every tracked thread",
  ).toEqual([]);
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

async function expectLiveThreadIdle(request, threadId) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/tasks/${threadId}`);
        if (!response.ok()) {
          return false;
        }
        const detail = await response.json();
        return (
          detail.task?.threadStatus?.type === "idle" &&
          detail.task?.activeTurn == null
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function listAllCodexThreads(client, sectionId) {
  const threads = [];
  let cursor = null;
  do {
    const response = await client.request("thread/list", {
      ...(cursor ? { cursor } : {}),
      limit: 100,
      sortKey: sectionId ? "section_position" : "recency_at",
      sortDirection: sectionId ? "asc" : "desc",
      archived: false,
      useStateDbOnly: true,
      ...(sectionId ? { sectionId } : {}),
    });
    threads.push(...(response.data ?? []));
    cursor = response.nextCursor || null;
  } while (cursor);
  return threads;
}

async function listAllCodexSections(client) {
  const sections = [];
  let cursor = null;
  do {
    const response = await client.request("threadSection/list", {
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    sections.push(...(response.data ?? []));
    cursor = response.nextCursor || null;
  } while (cursor);
  return sections;
}

test("hydrates, orders, and restores Tasks through the local navigator ledger", async ({
  page,
  request,
}) => {
  const fixture = initializePersistentLiveRepository("navigator-ledger");
  const marker = `${Date.now()}`;

  const createTask = async (label) => {
    const response = await request.post("/api/tasks", {
      data: {
        cwd: fixture.cwd,
        prompt: `Reply with exactly caffold-section-${label}-${marker}. Do not modify files or run commands.`,
        model: SPARK_MODEL,
        effort: LIVE_REASONING_EFFORT,
      },
    });
    const body = await response.text();
    expect(response.status(), `create ${label} response: ${body}`).toBe(200);
    const detail = JSON.parse(body);
    expect(detail.threadId).toBeTruthy();
    expect(detail.task?.worktree?.repositoryRootPath).toBe(fixture.cwd);
    expect(detail.activeTopPlacement?.section?.id).toBeTruthy();
    expect(detail.activeTopPlacement?.section?.name).toBe(fixture.cwd);
    expect(detail.activeTopPlacement?.section?.repository).toBe(true);
    trackLiveThread(detail.threadId, "spark", SPARK_MODEL);
    return detail.threadId;
  };

  const sectionTaskIds = async (threadIds) => {
    const response = await request.get("/api/tasks");
    const body = await response.text();
    expect(response.status(), `active Task response: ${body}`).toBe(200);
    const projection = JSON.parse(body);
    const section = projection.sections.find(({ name }) => name === fixture.cwd);
    expect(section?.id).toBeTruthy();
    expect(
      projection.unsectioned.some(({ threadId }) => threadIds.includes(threadId)),
    ).toBe(false);
    return section.tasks
      .map(({ threadId }) => threadId)
      .filter((threadId) => threadIds.includes(threadId));
  };

  const firstThreadId = await createTask("first");
  const secondThreadId = await createTask("second");
  await expectLiveThreadIdle(request, firstThreadId);
  await expectLiveThreadIdle(request, secondThreadId);

  const daemonClient = await CodexDaemonClient.connect();
  try {
    const globalIds = (await listAllCodexThreads(daemonClient, null)).map(
      ({ id }) => id,
    );
    expect(globalIds).toEqual(
      expect.arrayContaining([firstThreadId, secondThreadId]),
    );
    const sectionThreadIds = [];
    for (const section of await listAllCodexSections(daemonClient)) {
      sectionThreadIds.push(
        ...(await listAllCodexThreads(daemonClient, section.id)).map(({ id }) => id),
      );
    }
    expect(sectionThreadIds).not.toContain(firstThreadId);
    expect(sectionThreadIds).not.toContain(secondThreadId);
    await daemonClient.request("thread/name/set", {
      threadId: secondThreadId,
      name: `External stale navigator name ${marker}`,
    });
  } finally {
    await daemonClient.close();
  }

  await page.goto("/tasks");
  const firstRow = taskNavigator(page).locator(
    `.task-row[data-thread-id="${firstThreadId}"]`,
  );
  const secondRow = taskNavigator(page).locator(
    `.task-row[data-thread-id="${secondThreadId}"]`,
  );
  await expect(firstRow).toHaveAttribute("data-task-status", "idle");
  await expect(secondRow).toHaveAttribute("data-task-status", "idle");
  await expect(secondRow.locator(".task-row-title")).toContainText(
    `caffold-section-second-${marker}`,
  );
  await expect(secondRow.locator(".task-row-title")).not.toContainText(
    "External stale navigator name",
  );
  await page.reload();
  await expect(firstRow).toHaveAttribute("data-task-status", "idle");
  await expect(secondRow).toHaveAttribute("data-task-status", "idle");
  await expect(secondRow.locator(".task-row-title")).toContainText(
    `caffold-section-second-${marker}`,
  );

  expect(await sectionTaskIds([firstThreadId, secondThreadId])).toEqual([
    secondThreadId,
    firstThreadId,
  ]);

  await archiveLiveThread(request, firstThreadId);
  expect(await sectionTaskIds([firstThreadId, secondThreadId])).toEqual([
    secondThreadId,
  ]);

  const restored = await restoreLiveThread(request, firstThreadId);
  expect(restored.task?.threadId).toBe(firstThreadId);
  expect(restored.activeTopPlacement?.section?.name).toBe(fixture.cwd);
  expect(restored.activeTopPlacement?.beforeThreadId).toBe(secondThreadId);
  expect(await sectionTaskIds([firstThreadId, secondThreadId])).toEqual([
    firstThreadId,
    secondThreadId,
  ]);
});

test("rechecks externally archived and deleted Codex Threads through explicit Recovery commands", async ({
  request,
}) => {
  const fixture = initializePersistentLiveRepository("thread-recovery");
  const marker = `${Date.now()}`;
  const createdResponse = await request.post("/api/tasks", {
    data: {
      cwd: fixture.cwd,
      prompt: `Reply with exactly caffold-recovery-${marker}. Do not modify files or run commands.`,
      model: SPARK_MODEL,
      effort: LIVE_REASONING_EFFORT,
    },
  });
  const createdBody = await createdResponse.text();
  expect(createdResponse.status(), `create recovery Task response: ${createdBody}`).toBe(200);
  const created = JSON.parse(createdBody);
  const threadId = created.threadId;
  expect(threadId).toBeTruthy();
  trackLiveThread(threadId, "spark", SPARK_MODEL);
  await expectLiveThreadIdle(request, threadId);

  const recoveryReason = async () => {
    const response = await request.post(
      `/api/tasks/${threadId}/recovery/recheck`,
    );
    if (!response.ok()) {
      return null;
    }
    return (await response.json()).recovery?.reason ?? null;
  };

  const daemonClient = await CodexDaemonClient.connect();
  let removed = false;
  try {
    await daemonClient.request("thread/archive", { threadId });
    liveThreadIds.delete(threadId);

    const cachedActiveResponse = await request.get("/api/tasks");
    const cachedActiveProjection = await cachedActiveResponse.json();
    expect(
      cachedActiveProjection.sections
        .flatMap((section) => section.tasks)
        .some((task) => task.threadId === threadId),
    ).toBe(true);
    await expect.poll(recoveryReason).toBe("codexArchived");

    const moveArchivedResponse = await request.post(
      `/api/tasks/${threadId}/recovery/archive`,
    );
    const moveArchivedBody = await moveArchivedResponse.text();
    expect(
      moveArchivedResponse.status(),
      `move Recovery Task to Archived response: ${moveArchivedBody}`,
    ).toBe(200);
    const archivedPageResponse = await request.get("/api/tasks/archived");
    const archivedPageBody = await archivedPageResponse.text();
    expect(
      archivedPageResponse.status(),
      `Archived Task page response: ${archivedPageBody}`,
    ).toBe(200);
    expect(
      JSON.parse(archivedPageBody).tasks.some((task) => task.threadId === threadId),
    ).toBe(true);

    const restoredFromArchived = await restoreLiveThread(request, threadId);
    expect(restoredFromArchived.task?.threadId).toBe(threadId);
    await daemonClient.request("thread/archive", { threadId });
    liveThreadIds.delete(threadId);
    await expect.poll(recoveryReason).toBe("codexArchived");

    const recoveryRestoreResponse = await request.post(
      `/api/tasks/${threadId}/recovery/restore`,
    );
    const recoveryRestoreBody = await recoveryRestoreResponse.text();
    expect(
      recoveryRestoreResponse.status(),
      `Recovery restore response: ${recoveryRestoreBody}`,
    ).toBe(200);
    const recoveryRestore = JSON.parse(recoveryRestoreBody);
    expect(recoveryRestore.task?.threadId).toBe(threadId);
    expect(recoveryRestore.activeTopPlacement?.section?.name).toBe(fixture.cwd);
    liveThreadIds.add(threadId);

    await daemonClient.request("thread/delete", { threadId });
    liveThreadIds.delete(threadId);
    await expect.poll(recoveryReason).toBe("threadMissing");

    const removeResponse = await request.post(
      `/api/tasks/${threadId}/recovery/remove`,
    );
    const removeBody = await removeResponse.text();
    expect(removeResponse.status(), `Recovery removal response: ${removeBody}`).toBe(200);
    expect(JSON.parse(removeBody).threadId).toBe(threadId);
    removed = true;

    const activeResponse = await request.get("/api/tasks");
    const activeProjection = await activeResponse.json();
    expect(
      activeProjection.sections
        .flatMap((section) => section.tasks)
        .concat(activeProjection.unsectioned)
        .some((task) => task.threadId === threadId),
    ).toBe(false);
  } finally {
    if (!removed) {
      liveThreadIds.delete(threadId);
      try {
        await daemonClient.request("thread/delete", { threadId });
      } catch {
        // The synthetic Thread may already have been deleted.
      }
      try {
        await request.post(`/api/tasks/${threadId}/recovery/remove`);
      } catch {
        // The isolated live runtime is discarded after the suite.
      }
    }
    await daemonClient.close();
  }
});

test("creates a real Codex task in Fast mode and restores the task setting", async ({
  page,
  request,
}) => {
  const marker = `${Date.now()}`;
  const reply = `caffold-live-fast-${marker}`;

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(liveCwd())}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await chooseModel(form, "fast");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");

  await form.getByRole("button", { name: /Choose model/ }).click();
  const fastOption = form.locator('[data-fast-mode="true"]');
  await expect(fastOption, `${FAST_MODEL} should advertise Fast mode`).toBeVisible();
  await fastOption.click();
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  await expect(form.locator(".task-model-fast")).toHaveAttribute("title", "Fast mode");

  const prompt = form.getByRole("textbox", { name: "New task prompt" });
  await prompt.fill(`Reply with exactly ${reply}. Do not modify files or run commands.`);
  await prompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  trackLiveThread(threadId, "fast", FAST_MODEL);

  await expect(
    tasksPage
      .locator('.task-message[data-message-role="assistant"][data-message-phase="final"]')
      .filter({ hasText: reply }),
  ).toBeVisible();
  await expectLiveThreadIdle(request, threadId);
  await expect
    .poll(async () => {
      const response = await request.get(`/api/tasks/${threadId}`);
      return response.ok() ? (await response.json()).fastMode : null;
    })
    .toBe(true);

  await page.reload();
  const followUp = tasksPage.locator('.task-follow-up-form[data-task-form="follow-up"]');
  await expect(followUp.locator('input[name="fastMode"]')).toHaveValue("true");
  await expect(followUp.locator(".task-model-fast")).toHaveAttribute("title", "Fast mode");
});

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

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const navigator = taskNavigator(page);
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseModel(newTaskForm, "spark");

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  trackLiveThread(threadId, "spark", SPARK_MODEL);

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"]',
  );
  const finalAssistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"]',
  );
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();
  await expectLiveThreadIdle(page.request, threadId);

  await page.goto("/tasks");
  const createdTask = navigator.locator(`.task-row[data-thread-id="${threadId}"]`);
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
  await chooseModel(followUpForm, "spark");
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
  await expectLiveThreadIdle(page.request, threadId);

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
  const completedWorkDetails = completedWork.locator(
    ":scope > caffold-task-work-details > details",
  );
  await expect(completedWork).toContainText("Worked for");
  await expect(completedWorkDetails).not.toHaveAttribute("open", "");
  await expect(finalResponse).toHaveCount(1);
  await expect
    .poll(() =>
      finalResponse.evaluate((response) => {
        const timeline = response.parentElement;
        const works = timeline?.querySelectorAll(".task-turn-work") ?? [];
        const work = works[works.length - 1];
        const position = work ? work.compareDocumentPosition(response) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
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
    tasksPage.locator("caffold-task-work-details").last().locator(":scope > details"),
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

  await archiveLiveThread(page.request, threadId);
  await expect(
    navigator.locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0, { timeout: 5_000 });
  await page.goto("/tasks");
  await expect(navigator.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
});

test("renames a newly created Caffold task through the dynamic tool", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const requestedName = `Caffold dynamic rename ${marker}`;
  const reply = `caffold-live-renamed-${marker}`;
  const siblingReply = `caffold-live-rename-sibling-${marker}`;

  const siblingResponse = await page.request.post("/api/tasks", {
    data: {
      cwd,
      prompt: `Reply with exactly ${siblingReply}. Do not modify files or run commands.`,
      model: SPARK_MODEL,
      effort: LIVE_REASONING_EFFORT,
    },
  });
  const siblingBody = await siblingResponse.text();
  expect(
    siblingResponse.status(),
    `create rename sibling response: ${siblingBody}`,
  ).toBe(200);
  const siblingThreadId = JSON.parse(siblingBody).threadId;
  expect(siblingThreadId).toBeTruthy();
  trackLiveThread(siblingThreadId, "spark", SPARK_MODEL);
  await expectLiveThreadIdle(page.request, siblingThreadId);

  await page.goto("/tasks");
  const navigator = taskNavigator(page);
  const siblingTask = navigator.locator(
    `.task-row[data-thread-id="${siblingThreadId}"]`,
  );
  await expect(siblingTask).toHaveAttribute("data-task-status", "idle");

  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await expect(newTaskForm).toBeVisible();
  await chooseModel(newTaskForm, "spark");

  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Rename the current Caffold task to exactly "${requestedName}" using the rename_current_thread tool. You must call the tool; do not merely say it was renamed. After the tool succeeds, reply with exactly ${reply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  trackLiveThread(threadId, "spark", SPARK_MODEL);

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
  await expect(siblingTask).toHaveAttribute("data-task-status", "idle");

  await page.goto("/tasks");
  const renamedTask = navigator.locator(`.task-row[data-thread-id="${threadId}"]`);
  await expect(renamedTask.locator(".task-row-title")).toHaveText(requestedName);

  await archiveLiveThread(page.request, threadId);
  await archiveLiveThread(page.request, siblingThreadId);
  await page.goto("/tasks");
  await expect(
    navigator
      .locator('.task-list-section[data-task-section="managed"]')
      .locator(`.task-row[data-thread-id="${threadId}"]`),
  ).toHaveCount(0);
  await expect(
    navigator
      .locator('.task-list-section[data-task-section="archived"]')
      .locator(`.task-archived-row[data-thread-id="${threadId}"] .task-row-title`),
  ).toHaveText(requestedName);
});

test("moves one dirty Spark task into a worktree and resumes the same thread", async ({
  page,
}) => {
  const marker = `${Date.now()}`;
  const fixture = initializeLiveRepository(marker);
  const branchName = `caffold/live-${marker}`;
  const preparedReply = `caffold-isolated-prepared-${marker}`;
  const continuedReply = `caffold-isolated-continued-${marker}`;
  const restoredReply = `caffold-isolated-restored-${marker}`;
  const continuationFile = `continuation-${marker}.txt`;
  let threadId;
  let fixtureCanBeRemoved = false;

  try {
    writeFileSync(join(fixture.repository, "README.md"), `dirty README ${marker}\n`);
    writeFileSync(join(fixture.repository, "staged.txt"), `staged ${marker}\n`);
    execFileSync("git", ["-C", fixture.repository, "add", "staged.txt"]);
    writeFileSync(join(fixture.repository, "untracked.txt"), `untracked ${marker}\n`);

    await page.goto(`/tasks/new?cwd=${encodeURIComponent(fixture.cwd)}`);
    const tasksPage = page.locator("caffold-tasks-page");
    const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
    await expect(newTaskForm).toBeVisible();
    await chooseModel(newTaskForm, "spark");

    const newTaskPrompt = newTaskForm.getByRole("textbox", {
      name: "New task prompt",
    });
    await newTaskPrompt.fill(
      [
        "Prepare this current task in a managed worktree.",
        "Call isolate_current_task exactly once with this exact argument:",
        `branchName: ${branchName}`,
        "includeChanges: true",
        "The tool must be your final file-affecting action. Do not run commands or edit files after it.",
        `After it succeeds, reply with exactly ${preparedReply}. Do not continue the review yet.`,
      ].join("\n"),
    );
    await newTaskPrompt.press("Enter");
    await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
    threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    expect(threadId).toBeTruthy();
    trackLiveThread(threadId, "spark", SPARK_MODEL);

    await expect(
      tasksPage
        .locator('.task-message[data-message-role="assistant"][data-message-phase="final"]')
        .filter({ hasText: preparedReply }),
    ).toBeVisible({ timeout: 120_000 });

    const initialDetailResponse = await page.request.get(`/api/tasks/${threadId}`);
    expect(initialDetailResponse.ok()).toBeTruthy();
    const initialDetail = await initialDetailResponse.json();
    const worktreePath = initialDetail.task?.cwd;
    expect(initialDetail.threadId).toBe(threadId);
    expect(worktreePath).toBeTruthy();
    expect(initialDetail.task?.worktree?.linked).toBe(true);
    expect(initialDetail.task?.worktree?.branch).toBe(branchName);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, continuationFile))).toBe(false);
    expect(
      execFileSync("git", ["-C", fixture.repository, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("main");
    expect(
      execFileSync("git", ["-C", fixture.repository, "status", "--porcelain=v1"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(
      execFileSync("git", ["-C", worktreePath, "diff", "--cached", "--name-only"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("staged.txt");
    expect(
      execFileSync("git", ["-C", worktreePath, "diff", "--name-only"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("README.md");
    expect(
      execFileSync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("untracked.txt");

    const finalMessages = tasksPage.locator(
      '.task-message[data-message-role="assistant"][data-message-phase="final"]',
    );
    const followUpForm = tasksPage.locator(
      '.task-follow-up-form[data-task-form="follow-up"]',
    );
    const followUpPrompt = followUpForm.getByRole("textbox", {
      name: "Follow-up prompt",
    });
    await followUpPrompt.fill(
      `Create ${continuationFile} in the current working directory containing exactly ${marker}, then reply with exactly ${continuedReply}.`,
    );
    const outcome = await submitPromptAndExpectAccepted(page, threadId, () =>
      followUpPrompt.press("Enter"),
    );
    expect(outcome.steered).toBe(false);
    await expect(finalMessages.filter({ hasText: continuedReply })).toBeVisible({
      timeout: 120_000,
    });
    await expectLiveThreadIdle(page.request, threadId);
    expect(existsSync(join(worktreePath, continuationFile))).toBe(true);
    expect(existsSync(join(fixture.repository, continuationFile))).toBe(false);

    await runGitWithIndexRetry(worktreePath, ["add", "-A"]);
    await runGitWithIndexRetry(worktreePath, [
      "commit",
      "-m",
      "Complete live fixture",
    ]);

    await archiveLiveThread(page.request, threadId);
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fixture.repository, branchName)).toBe(true);

    const restored = await restoreLiveThread(page.request, threadId);
    expect(restored.task?.threadId).toBe(threadId);
    expect(restored.task?.worktree?.linked).toBe(true);
    expect(restored.task?.worktree?.branch).toBe(branchName);
    expect(restored.task?.cwd).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);

    await page.goto(`/tasks/${threadId}`);
    const restoredForm = tasksPage.locator(
      '.task-follow-up-form[data-task-form="follow-up"]',
    );
    const restoredPrompt = restoredForm.getByRole("textbox", {
      name: "Follow-up prompt",
    });
    await restoredPrompt.fill(
      `Reply with exactly ${restoredReply}. Do not modify files or run commands.`,
    );
    const restoredOutcome = await submitPromptAndExpectAccepted(page, threadId, () =>
      restoredPrompt.press("Enter"),
    );
    expect(restoredOutcome.steered).toBe(false);
    await expect(finalMessages.filter({ hasText: restoredReply })).toBeVisible({
      timeout: 120_000,
    });
    await expectLiveThreadIdle(page.request, threadId);

    await archiveLiveThread(page.request, threadId);
    expect(existsSync(worktreePath)).toBe(false);
    expect(branchExists(fixture.repository, branchName)).toBe(true);
    fixtureCanBeRemoved = true;
  } finally {
    if (threadId && liveThreadIds.has(threadId)) {
      try {
        await archiveLiveThread(page.request, threadId);
      } catch {
        // Preserve the fixture when a live task is still active so its worktree
        // remains recoverable and afterEach can report the archive failure.
      }
    }
    if (fixtureCanBeRemoved || !threadId || !liveThreadIds.has(threadId)) {
      rmSync(fixture.repository, { recursive: true, force: true });
      try {
        rmdirSync(dirname(fixture.repository));
      } catch {
        // Another failed live fixture may still need the shared parent.
      }
    }
  }
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
  await chooseModel(newTaskForm, "multimodal");

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
  trackLiveThread(threadId, "multimodal", MULTIMODAL_MODEL);

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

test("reconciles a managed Spark task through a second daemon client", async ({
  page,
}) => {
  const cwd = liveCwd();
  const marker = `${Date.now()}`;
  const initialReply = `caffold-external-initial-${marker}`;
  const clickReply = `caffold-external-click-${marker}`;
  const enterReply = `caffold-external-enter-${marker}`;
  const externalReply = `caffold-external-daemon-${marker}`;
  const ambientRequest = `caffold-external-ambient-${marker}`;
  const ambientReply = `caffold-external-ambient-reply-${marker}`;
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(cwd)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const navigator = taskNavigator(page);
  const newTaskForm = tasksPage.locator('.task-new-form[data-task-form="create"]');
  await chooseModel(newTaskForm, "spark");
  const newTaskPrompt = newTaskForm.getByRole("textbox", { name: "New task prompt" });
  await newTaskPrompt.fill(
    `Reply with exactly ${initialReply}. Do not modify files or run commands.`,
  );
  await newTaskPrompt.press("Enter");
  await expect(page).toHaveURL(/\/tasks\/[^?]+$/);
  const threadId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(threadId).toBeTruthy();
  trackLiveThread(threadId, "spark", SPARK_MODEL);

  const assistantMessages = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"]',
  );
  const userMessages = tasksPage.locator('.task-message[data-message-role="user"]');
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();
  await expectLiveThreadIdle(page.request, threadId);

  const followUpForm = tasksPage.locator(
    '.task-follow-up-form[data-task-form="follow-up"]',
  );
  await expect(followUpForm).toHaveAttribute("data-thread-id", threadId);
  await chooseModel(followUpForm, "spark");
  const followUpPrompt = followUpForm.getByRole("textbox", { name: "Follow-up prompt" });

  await followUpPrompt.fill(
    `Reply with exactly ${clickReply}. Do not modify files or run commands.`,
  );
  const clickOutcome = await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpForm.getByRole("button", { name: "Send prompt" }).click(),
  );
  expect(clickOutcome.steered).toBe(false);
  await expect(userMessages.filter({ hasText: clickReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: clickReply })).toBeVisible();
  await expectLiveThreadIdle(page.request, threadId);

  await followUpPrompt.fill(
    `Reply with exactly ${enterReply}. Do not modify files or run commands.`,
  );
  const enterOutcome = await submitPromptAndExpectAccepted(page, threadId, () =>
    followUpPrompt.press("Enter"),
  );
  expect(enterOutcome.steered).toBe(false);
  await expect(followUpPrompt).toBeFocused();
  await expect(userMessages.filter({ hasText: enterReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: enterReply })).toBeVisible();
  await expectLiveThreadIdle(page.request, threadId);

  const detailResponse = await page.request.get(`/api/tasks/${threadId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const canonicalCwd = (await detailResponse.json()).task?.cwd;
  expect(canonicalCwd).toBeTruthy();

  const daemonClient = await CodexDaemonClient.connect();
  try {
    await daemonClient.resumeThread(threadId);
    await daemonClient.startTurn({
      threadId,
      cwd: canonicalCwd,
      model: SPARK_MODEL,
      effort: LIVE_REASONING_EFFORT,
      prompt: `Reply with exactly ${externalReply}. Do not modify files or run commands.`,
    });
    await expect(assistantMessages.filter({ hasText: externalReply })).toBeVisible({
      timeout: 60_000,
    });
    await expectLiveThreadIdle(page.request, threadId);

    await daemonClient.startTurn({
      threadId,
      cwd: canonicalCwd,
      model: SPARK_MODEL,
      effort: LIVE_REASONING_EFFORT,
      prompt: [
        "This block is automatically supplied ambient UI state, not part of the user's request.",
        "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
        "# In app browser:",
        "- The user has the in-app browser open with 1 tab.",
        `- Current URL: ${page.url()}`,
        "My request for Codex:",
        `${ambientRequest}. Reply with exactly ${ambientReply}. Do not modify files or run commands.`,
      ].join("\n"),
    });
    await expect(userMessages.filter({ hasText: ambientRequest })).toBeVisible({
      timeout: 60_000,
    });
    await expect(assistantMessages.filter({ hasText: ambientReply })).toBeVisible({
      timeout: 60_000,
    });
    await expectLiveThreadIdle(page.request, threadId);
    await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");
    await expect(tasksPage).not.toContainText("The user has the in-app browser open");
  } finally {
    await daemonClient.close();
  }

  await page.reload();
  await expect(assistantMessages.filter({ hasText: initialReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: clickReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: enterReply })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: externalReply })).toBeVisible();
  await expect(userMessages.filter({ hasText: ambientRequest })).toBeVisible();
  await expect(assistantMessages.filter({ hasText: ambientReply })).toBeVisible();
  await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");

  await archiveLiveThread(page.request, threadId);
  await page.goto("/tasks");
  await expect(navigator.locator(`.task-row[data-thread-id="${threadId}"]`)).toHaveCount(0);
});
