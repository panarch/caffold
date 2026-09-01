import { expect, test } from "@playwright/test";
import { actionHintDialog } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("previews a composer image without coupling preview and removal", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(scenario.contextPath)}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const prompt = tasksPage.locator('.task-new-form textarea[name="prompt"]');
  await pastePortraitImage(prompt, "composer-preview.png");

  const attachment = tasksPage.locator(
    ".task-new-form .task-composer-attachment",
  );
  const previewTrigger = attachment.getByRole("button", {
    name: "Preview composer-preview.png",
  });
  const remove = attachment.getByRole("button", {
    name: "Remove composer-preview.png",
  });
  const dialog = tasksPage.locator(
    ":scope > caffold-task-image-preview-dialog > dialog",
  );

  await expect(previewTrigger).toBeVisible();
  await clickComposerPreview(previewTrigger);
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog).toHaveAttribute("closedby", "any");
  await expect(dialog.locator("[data-task-image-preview-name]")).toHaveText(
    "composer-preview.png",
  );
  await expect(dialog.locator("[data-task-image-preview-image]")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(
    dialog.getByRole("button", { name: "Close image preview" }),
  ).toBeFocused();
  await expectPreviewContained(dialog, { portrait: true });

  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  const closeHint = hint.getByRole("button", {
    name: / — Close image preview$/,
  });
  await expect(closeHint).toBeVisible();
  const closeCode = await closeHint.getAttribute("data-action-hint-code");
  expect(closeCode).toBeTruthy();
  await page.keyboard.type(closeCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();

  await clickComposerPreview(previewTrigger);
  await expect(dialog).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(dialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();

  await remove.click();
  await expect(attachment).toHaveCount(0);
  await expect(dialog).toBeHidden();
});

test("keeps one sent-image dialog stable through live conversation updates", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const dialogHost = tasksPage.locator(
    ":scope > caffold-task-image-preview-dialog",
  );
  const dialog = dialogHost.locator(":scope > dialog");
  const sentPreview = tasksPage.getByRole("button", {
    name: "Preview planner-layout.png",
  });
  await expect(sentPreview).toBeVisible();
  await dialog.evaluate((element) => {
    window.__taskImagePreviewDialog = element;
  });

  await sentPreview.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-task-image-preview-name]")).toHaveText(
    "planner-layout.png",
  );
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(sentPreview).toBeFocused();

  await sentPreview.click();
  await expect(dialog).toBeVisible();
  const previewImage = dialog.locator("[data-task-image-preview-image]");
  const previewSource = await previewImage.getAttribute("src");
  expect(previewSource).toBeTruthy();

  scenario.events = [
    ...scenario.events,
    scenario.eventRecord(
      "event_image_preview_live",
      "status",
      "Live update while previewing",
      { status: "working" },
      20,
    ),
  ];
  scenario.updateTask({ lastEventSummary: "Live update while previewing" });
  await emitTaskSync(page, scenario, 2);

  const liveUpdate = tasksPage.locator(
    '.task-event[data-event-id="event_image_preview_live"]',
  );
  await expect(liveUpdate).toContainText("Live update while previewing");
  await expect(dialogHost).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-task-image-preview-name]")).toHaveText(
    "planner-layout.png",
  );
  await expect(previewImage).toHaveAttribute("src", previewSource);
  await expect
    .poll(() =>
      dialog.evaluate(
        (element) => element === window.__taskImagePreviewDialog,
      ),
    )
    .toBe(true);
  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toBeHidden();
  await expect(liveUpdate).toBeVisible();

  await tasksPage.evaluate((element) => {
    element.prepareRoute({ kind: "tasks", new: true });
  });
  await expect(dialog).toBeHidden();
});

test("renders and previews assistant-generated images after history reload", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page);
  await scenario.seedCompletedTask();
  scenario.events = [
    ...scenario.events.filter((event) => event.id !== "event_generated_image"),
    scenario.eventRecord(
      "thread_12345678:turn_1:image_1",
      "generated_image",
      "Image generated",
      {
        threadId: scenario.threadId,
        turnId: "turn_1",
        itemId: "image_1",
        status: "completed",
        available: true,
        revisedPrompt: "A compact green architecture diagram",
        name: "Generated image.png",
      },
      10.5,
    ),
  ];
  await page.route(
    `/api/tasks/${scenario.threadId}/generated-images/image_1`,
    (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
  );

  await page.goto(`/tasks/${scenario.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const preview = tasksPage.getByRole("button", {
    name: "Preview Generated image.png",
  });
  const dialog = tasksPage.locator(
    ":scope > caffold-task-image-preview-dialog > dialog",
  );

  await expect(preview).toBeVisible();
  await expect(preview.locator("img")).toHaveAttribute(
    "src",
    `/api/tasks/${scenario.threadId}/generated-images/image_1`,
  );
  await expect(
    tasksPage.locator(".task-work-details", {
      has: preview,
    }),
  ).toHaveCount(0);
  await preview.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-task-image-preview-name]")).toHaveText(
    "Generated image.png",
  );
  await dialog.getByRole("button", { name: "Close image preview" }).click();

  await page.reload();
  const restoredPreview = tasksPage.getByRole("button", {
    name: "Preview Generated image.png",
  });
  await expect(restoredPreview).toBeVisible();
  await restoredPreview.click();
  await expect(dialog).toBeVisible();
});

async function clickComposerPreview(previewTrigger) {
  const box = await previewTrigger.boundingBox();
  if (!box) {
    throw new Error("Composer preview trigger has no layout box");
  }
  await previewTrigger.click({
    position: {
      x: Math.min(12, box.width / 4),
      y: box.height / 2,
    },
  });
}

async function pastePortraitImage(locator, name) {
  await locator.evaluate(async (textarea, fileName) => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 1200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e33";
    context.fillRect(0, 0, 120, 400);
    context.fillStyle = "#3a3";
    context.fillRect(0, 400, 120, 400);
    context.fillStyle = "#36c";
    context.fillRect(0, 800, 120, 400);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([blob], fileName, { type: "image/png" }));
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, name);
}

async function expectPreviewContained(dialog, { portrait = false } = {}) {
  await dialog
    .locator("[data-task-image-preview-image]")
    .evaluate((image) => image.decode());
  const metrics = await dialog.evaluate((element) => {
    const image = element.querySelector("[data-task-image-preview-image]");
    const dialogRect = element.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const body = element.querySelector(".task-image-preview-body");
    const bodyRect = body.getBoundingClientRect();
    const viewportRect = element
      .querySelector(".task-image-preview-viewport")
      .getBoundingClientRect();
    return {
      body: {
        height: bodyRect.height,
        width: bodyRect.width,
      },
      viewport: {
        height: viewportRect.height,
        width: viewportRect.width,
      },
      dialogContained:
        dialogRect.left >= 0 &&
        dialogRect.top >= 0 &&
        dialogRect.right <= window.innerWidth &&
        dialogRect.bottom <= window.innerHeight,
      imageContained:
        imageRect.left >= bodyRect.left &&
        imageRect.top >= bodyRect.top &&
        imageRect.right <= bodyRect.right &&
        imageRect.bottom <= bodyRect.bottom,
      fillsContainBox:
        Math.abs(imageRect.width - viewportRect.width) <= 1 &&
        Math.abs(imageRect.height - viewportRect.height) <= 1,
      image: {
        bottom: imageRect.bottom,
        height: imageRect.height,
        right: imageRect.right,
        width: imageRect.width,
      },
      objectFit: getComputedStyle(image).objectFit,
      portrait: image.naturalHeight > image.naturalWidth * 5,
    };
  });
  expect(metrics, JSON.stringify(metrics)).toMatchObject({
    dialogContained: true,
    imageContained: true,
    fillsContainBox: true,
    objectFit: "contain",
    portrait,
  });
}

async function emitTaskSync(page, scenario, revision) {
  await page.evaluate(
    ({ detail, threadId, revision }) => {
      const source = window.__caffoldMockEventSources.find(
        (candidate) =>
          candidate.url === `/api/tasks/${threadId}/stream` &&
          candidate.readyState !== 2,
      );
      if (!source) {
        throw new Error(`Task detail stream not found for ${threadId}`);
      }
      source.emit("task-sync", {
        threadId,
        revision,
        reason: "image-preview-stability",
        detail,
      });
    },
    {
      threadId: scenario.threadId,
      revision,
      detail: scenario.detailResponse({ revision }),
    },
  );
}
