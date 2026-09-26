import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  PASTED_IMAGE_BASE64,
  UPLOAD_FOLDER_PATTERN,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  routeTaskUploads,
  withAttachedFiles,
} from "../support/task-fixtures.js";

// A prompt's files go up one at a time after Send, each on its own line of
// the message's file list, and only then is the prompt sent to name them.

const PICTURE = Buffer.from(PASTED_IMAGE_BASE64, "base64");
const LOG = Buffer.from("line one\n");

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("uploads each attached file in turn before the prompt that names them", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page);
  const gates = { "server.log": deferred(), "shot.png": deferred() };
  const sent = await routeTaskUploads(page, {
    respond: async (upload) => {
      await gates[upload.name].promise;
    },
  });
  const prompts = await routePrompts(page);

  await prompt.fill("Look at these");
  await attach(form, [
    { name: "server.log", mimeType: "text/plain", buffer: LOG },
    { name: "shot.png", mimeType: "image/png", buffer: PICTURE },
  ]);
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(form.locator(".task-composer-file")).toHaveAttribute("title", "server.log");
  await prompt.press("Enter");

  await expect.poll(() => sent.uploads.map(({ name }) => name)).toEqual(["server.log"]);
  const { folder } = sent.uploads[0];
  expect(folder).toMatch(new RegExp(`^${UPLOAD_FOLDER_PATTERN}$`));
  const paths = [
    `.caffold/uploads/${folder}/server.log`,
    `.caffold/uploads/${folder}/shot.png`,
  ];
  const words = withAttachedFiles("Look at these", paths);
  await expect(prompt).toHaveValue("");
  await expect(message.locator(".task-message-delivery")).toHaveText(/^Uploading \d+%$/);
  await expect(message.locator(".task-message-text")).toHaveText(words, {
    useInnerText: true,
  });
  await expect(message.locator(".task-message-upload-bar")).toHaveCount(2);
  await expect(message.locator(".task-message-attachment")).toHaveCount(1);
  await expect(form.locator(".task-primary-action-button")).toHaveAttribute(
    "aria-label",
    "Cancel upload",
  );

  gates["server.log"].resolve();
  await expect.poll(() => sent.uploads.map(({ name }) => name)).toEqual([
    "server.log",
    "shot.png",
  ]);
  await expect(message.locator('[data-upload-line="0"] .task-message-upload-bar')).toHaveCount(0);
  await expect(message.locator('[data-upload-line="1"] .task-message-upload-bar')).toHaveCount(1);
  expect(prompts).toEqual([]);

  gates["shot.png"].resolve();
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toMatchObject({ prompt: words, imagePaths: [paths[1]] });
  expect(sent.uploads[0].bytes.equals(LOG)).toBe(true);
  expect(sent.uploads[1].bytes.equals(PICTURE)).toBe(true);
  await expect(message.locator(".task-message-delivery")).toHaveText("Accepted - syncing...");
  await expect(message.locator(".task-message-upload-bar")).toHaveCount(0);
  expect(sent.discarded).toEqual([]);
});

test("paints how far each file has gone without drawing the message again", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page);
  const gate = deferred();
  await routeTaskUploads(page, { respond: () => gate.promise });
  await routePrompts(page);
  await prompt.fill("Look");
  await attach(form, [
    { name: "a.log", mimeType: "text/plain", buffer: LOG },
    { name: "b.log", mimeType: "text/plain", buffer: LOG },
  ]);
  await prompt.press("Enter");
  await expect(message.locator(".task-message-upload-bar")).toHaveCount(2);
  const rendered = await message.elementHandle();

  await page.evaluate(() => {
    const conversation = document.querySelector("caffold-task-conversation");
    const eventId = conversation.querySelector(
      '.task-message[data-message-role="user"]',
    ).dataset.eventId;
    conversation.setPromptUploadProgress(eventId, { percent: 42, lines: [0.75, 0] });
  });

  await expect(message.locator(".task-message-delivery")).toHaveText("Uploading 42%");
  await expect(message.locator('[data-upload-line="0"]')).toHaveCSS("--upload-progress", "0.75");
  await expect(message.locator('[data-upload-line="1"]')).toHaveCSS("--upload-progress", "0");
  expect(await rendered.evaluate((element) => element.isConnected)).toBe(true);
  gate.resolve();
});

test("keeps every line where it is while bars go and the message is confirmed", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const { detail, form, prompt, message } = await openFollowUp(page);
  const gate = deferred();
  const sent = await routeTaskUploads(page, {
    respond: async (upload) => {
      if (upload.name === "shot.png") {
        await gate.promise;
      }
    },
  });
  const prompts = await routePrompts(page);
  const longName = `release-metadata-${"with-a-deliberately-long-name-".repeat(3)}report.log`;

  await prompt.fill("Compare these two");
  await attach(form, [
    { name: longName, mimeType: "text/plain", buffer: LOG },
    { name: "shot.png", mimeType: "image/png", buffer: PICTURE },
  ]);
  await prompt.press("Enter");
  await expect(message.locator('[data-upload-line="0"] .task-message-upload-bar')).toHaveCount(0);
  await expect(message.locator('[data-upload-line="1"] .task-message-upload-bar')).toHaveCount(1);
  await page.evaluate(() => {
    const conversation = document.querySelector("caffold-task-conversation");
    const eventId = conversation.querySelector(
      '.task-message[data-message-role="user"]',
    ).dataset.eventId;
    conversation.setPromptUploadProgress(eventId, { percent: 71, lines: [1, 0.4] });
  });
  await captureReviewScreenshot(page, testInfo, "tasks-prompt-uploading");
  const uploading = await textBox(message);

  gate.resolve();
  await expect(message.locator(".task-message-delivery")).toHaveText("Accepted - syncing...");
  expect(await textBox(message)).toEqual(uploading);

  const words = prompts[0].prompt;
  await syncDetail(page, {
    ...detail,
    revision: 2,
    eventRevision: 2,
    events: [
      {
        id: "event-sent",
        threadId: "thread-1",
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn-2",
          itemId: "message-2",
          text: words,
          content: [
            { type: "text", text: words },
            {
              type: "image",
              url: `data:image/png;base64,${sent.uploads[1].bytes.toString("base64")}`,
            },
          ],
        },
        position: { anchorMs: Date.now(), index: 0 },
      },
    ],
  });
  await expect(message.locator(".task-message-delivery")).toHaveCount(0);
  await expect(message.locator(".task-message-text")).toHaveText(words, {
    useInnerText: true,
  });
  // The words wrap exactly as they did; only the delivery label above them,
  // which every sent prompt loses on confirmation, is gone.
  const { width, height } = await textBox(message);
  expect({ width, height }).toEqual({ width: uploading.width, height: uploading.height });
});

test("returns a message whose upload failed, naming the file, and removes what went up", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page);
  const sent = await routeTaskUploads(page, {
    respond: (upload) =>
      upload.name === "shot.png"
        ? {
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "upload_exists", message: "shot.png was already uploaded in this send" },
            }),
          }
        : null,
  });
  const prompts = await routePrompts(page);

  await prompt.fill("Look at these");
  await attach(form, [
    { name: "server.log", mimeType: "text/plain", buffer: LOG },
    { name: "shot.png", mimeType: "image/png", buffer: PICTURE },
  ]);
  await prompt.press("Enter");

  await expect(form).toContainText(
    "Could not upload shot.png: shot.png was already uploaded in this send",
  );
  await expect(message).toHaveCount(0);
  await expect(prompt).toHaveValue("Look at these");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(form.locator(".task-composer-file")).toHaveCount(1);
  await expect.poll(() => sent.discarded).toEqual([sent.uploads[0].folder]);
  expect(prompts).toEqual([]);
});

test("Cancel upload takes back a message when no turn is running", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page);
  const gate = deferred();
  const sent = await routeTaskUploads(page, { respond: () => gate.promise });
  const prompts = await routePrompts(page);
  let interrupts = 0;
  await page.route("**/api/tasks/thread-1/interrupt", (route) => {
    interrupts += 1;
    return route.fulfill({ status: 409, json: { error: "No turn" } });
  });

  await prompt.fill("Never mind");
  await attach(form, [{ name: "server.log", mimeType: "text/plain", buffer: LOG }]);
  await prompt.press("Enter");
  await expect.poll(() => sent.uploads.length).toBe(1);
  await form.getByRole("button", { name: "Cancel upload", exact: true }).click();

  await expect(message).toHaveCount(0);
  await expect(prompt).toHaveValue("Never mind");
  await expect(form.locator(".task-composer-file")).toHaveCount(1);
  await expect.poll(() => sent.discarded).toEqual([sent.uploads[0].folder]);
  await expect(form.locator(".task-primary-action-button")).toHaveAttribute(
    "aria-label",
    "Send prompt",
  );
  expect(prompts).toEqual([]);
  expect(interrupts).toBe(0);
  gate.resolve();
});

test("Stop during an upload stops the turn and returns messages in the order they were sent", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page, { running: true });
  const gate = deferred();
  const sent = await routeTaskUploads(page, { respond: () => gate.promise });
  const prompts = await routePrompts(page);
  const stopped = taskDetailFixture();
  stopped.revision = 2;
  stopped.task.title = "Running task";
  let interrupts = 0;
  await page.route("**/api/tasks/thread-1/interrupt", (route) => {
    interrupts += 1;
    return route.fulfill({
      json: { ...stopped, cancelledPrompts: [{ prompt: "Queued before" }] },
    });
  });

  await prompt.fill("Look at this");
  await attach(form, [{ name: "shot.png", mimeType: "image/png", buffer: PICTURE }]);
  await prompt.press("Enter");
  await expect.poll(() => sent.uploads.length).toBe(1);
  await prompt.fill("Written meanwhile");
  await form.getByRole("button", { name: "Stop current turn", exact: true }).click();

  await expect.poll(() => interrupts).toBe(1);
  await expect(message).toHaveCount(0);
  await expect(prompt).toHaveValue(
    "Queued before\n\nLook at this\n\nWritten meanwhile",
  );
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect.poll(() => sent.discarded).toEqual([sent.uploads[0].folder]);
  expect(prompts).toEqual([]);
  gate.resolve();
});

test("keeps the files of a message whose delivery is unconfirmed", { tag: "@desktop" }, async ({ page }) => {
  const { form, prompt, message } = await openFollowUp(page);
  const sent = await routeTaskUploads(page);
  const prompts = await routePrompts(page, {
    status: 504,
    json: { error: { code: "agent_timeout", message: "Codex app-server request timed out." } },
  });

  await prompt.fill("Did this arrive?");
  await attach(form, [{ name: "server.log", mimeType: "text/plain", buffer: LOG }]);
  await prompt.press("Enter");

  await expect.poll(() => prompts.length).toBe(1);
  await expect(message.locator(".task-message-delivery")).toHaveText("Delivery unconfirmed");
  await expect(prompt).toHaveValue("");
  expect(sent.discarded).toEqual([]);
});

async function openFollowUp(page, { running = false } = {}) {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture({ running });
  await page.route("**/api/tasks/thread-1", (route) => route.fulfill({ json: detail }));
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);
  const form = page.locator('.task-follow-up-form[data-task-form="follow-up"]');
  return {
    detail,
    form,
    prompt: form.getByRole("textbox", { name: "Follow-up prompt" }),
    message: page.locator('.task-message[data-message-role="user"]'),
  };
}

function syncDetail(page, detail) {
  return page.evaluate((next) => {
    window.__taskDetailSource.emit("task-sync", {
      threadId: next.threadId,
      revision: next.revision,
      detail: next,
      reason: "canonical-sync",
    });
  }, detail);
}

async function routePrompts(page, answer = null) {
  const prompts = [];
  await page.route("**/api/tasks/thread-1/prompts", (route) => {
    prompts.push(route.request().postDataJSON());
    return route.fulfill(
      answer ?? {
        json: {
          threadId: "thread-1",
          turnId: "turn-2",
          userMessageId: "message-2",
          steered: false,
        },
      },
    );
  });
  return prompts;
}

function attach(form, files) {
  return form.locator("input[data-composer-file-input]").setInputFiles(files);
}

function textBox(message) {
  return message.locator(".task-message-text").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const owner = element.closest(".task-message").getBoundingClientRect();
    return {
      top: Math.round(box.top - owner.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
