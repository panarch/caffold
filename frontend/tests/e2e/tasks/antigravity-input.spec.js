import { expect, test } from "@playwright/test";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  emitTaskDetailBootstrap,
  captureReviewScreenshot,
  pasteImage,
  routeTaskUploads,
} from "../support/task-fixtures.js";

async function setup(page) {
  await installTaskApiFixture(page, {
    permissions: {
      defaultMode: "default",
      options: [
        {
          mode: "default",
          label: "Default",
          description: "Ask before tools",
          allowed: true,
          dangerous: false,
        },
      ],
    },
  });
  await page.route("**/api/agent/models", (route) =>
    route.fulfill({
      json: {
        models: [
          {
            provider: "antigravity",
            model: "gemini-3.8-flash",
            displayName: "Gemini 3.8 Flash",
            isDefault: true,
            defaultEffort: "low",
            efforts: ["low", "high"],
            supportsFastMode: false,
          },
        ],
        unavailable: [],
      },
    }),
  );
  const detail = {
    ...taskDetailFixture({ model: "gemini-3.8-flash", reasoningEffort: "low" }),
    provider: "antigravity",
    permissionMode: "default",
  };
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.goto("/tasks/thread-1");
  await emitTaskDetailBootstrap(page, detail);
  const composer = page
    .locator("caffold-task-composer")
    .filter({ has: page.locator(".task-follow-up-form") });
  const prompt = composer.locator('textarea[name="prompt"]');
  await expect(prompt).toBeVisible();
  return { detail, composer, prompt };
}

test("ordinary optimistic prompt and uploads stay visible before the request returns", { tag: "@all-viewports" }, async ({ page }, info) => {
  const { composer, prompt } = await setup(page);
  let releaseUpload, releasePrompt;
  const upload = new Promise(resolve => { releaseUpload = resolve; });
  const response = new Promise(resolve => { releasePrompt = resolve; });
  const sent = await routeTaskUploads(page, { respond: () => upload });
  let requests = 0;
  await page.route("**/api/tasks/thread-1/prompts", async route => {
    requests++;
    await response;
    await route.fulfill({ json: { threadId: "thread-1", turnId: "acp:display:turn", userMessageId: "acp:display:turn:prompt", steered: false } });
  });
  const message = page.locator('caffold-task-conversation .task-message[data-message-role="user"]');
  try {
    await prompt.fill("Inspect this image");
    await pasteImage(prompt);
    await prompt.press("Enter");
    await expect.poll(() => sent.uploads.length).toBe(1);
    await expect(message).toContainText("Inspect this image");
    await expect(message.locator(".task-user-message-delivery")).toHaveText(/^Uploading/);
    await expect(message.locator(".task-message-attachment")).toHaveCount(1);
    await expect(composer.locator(".task-composer-request-notice")).toHaveCount(0);
    await captureReviewScreenshot(page, info, "antigravity-prompt-upload");
    releaseUpload();
    await expect.poll(() => requests).toBe(1);
    await expect(message).toContainText("Inspect this image");
    await prompt.fill("My next draft");
    await pasteImage(prompt);
    releasePrompt();
    await expect(composer.locator("form")).toHaveAttribute("aria-busy", "false");
    await expect(prompt).toHaveValue("My next draft");
    await expect(composer.locator(".task-composer-attachment")).toHaveCount(1);
    await expect(message.locator(".task-user-message-delivery")).toHaveText("Accepted - syncing...");
  } finally {
    releaseUpload(); releasePrompt();
  }
});

test("running Antigravity accepts steering and keeps Stop available when the draft is empty", { tag: "@all-viewports" }, async ({ page }, info) => {
  const { detail, composer, prompt } = await setup(page);
  const running = { ...detail, task: taskDetailFixture({ running: true }).task, revision: 2, eventRevision: 2 };
  const sent = [];
  let stops = 0;
  await routeTaskUploads(page);
  await page.route("**/api/tasks/thread-1/prompts", route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { threadId: "thread-1", turnId: "acp:display:turn", userMessageId: "acp:display:turn:prompt:2", steered: true } });
  });
  await page.route("**/api/tasks/thread-1/interrupt", route => { stops++; return route.fulfill({ json: {} }); });
  await page.evaluate(state => window.__caffoldTaskSse.source(state.threadId).emit("task-state", state), running);
  const primary = composer.locator(".task-primary-action-button");
  await expect(primary).toHaveAttribute("aria-label", "Stop current turn");
  await prompt.fill("Include this in the running work");
  await pasteImage(prompt);
  await expect(primary).toHaveAttribute("aria-label", "Send prompt");
  await prompt.press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  await expect(prompt).toHaveValue("");
  await expect(composer.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(primary).toHaveAttribute("aria-label", "Stop current turn");
  await captureReviewScreenshot(page, info, "antigravity-steering");
  await primary.click();
  await expect.poll(() => stops).toBe(1);
});
