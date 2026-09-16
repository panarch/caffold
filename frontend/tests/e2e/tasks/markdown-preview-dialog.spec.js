import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHint,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

const PREVIEW_SOURCE = [
  "## Release notes",
  "",
  "Ship **Markdown previews** with `Eye` controls. Read [Caffold](https://example.com/caffold).",
  "",
  "- Wrap and Copy keep their places",
  "- Preview opens a dialog",
  "",
  "| Surface | Control |",
  "| --- | --- |",
  "| Code block | Preview |",
  "",
].join("\n");

const LONG_PREVIEW_SOURCE = [
  "## Long notes",
  "",
  "Read [Caffold](https://example.com/caffold) first.",
  "",
  ...Array.from({ length: 60 }, (_, index) => `- Scroll line ${index + 1}`),
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("previews a Markdown fence in a modal and returns focus to its Preview button", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedPreviewTask(
    page,
    "thread_markdown_preview_" + testInfo.project.name,
    [PREVIEW_SOURCE, LONG_PREVIEW_SOURCE],
  );
  const blocks = finalMarkdown(page).locator("caffold-task-markdown-code-block");
  const previewButton = blocks.nth(0).getByRole("button", { name: "Preview Markdown" });
  const dialog = page.locator("caffold-task-markdown-preview-dialog > dialog");
  const preview = dialog.locator("caffold-markdown-preview");

  await expect(blocks.nth(1).getByRole("button", { name: "Preview Markdown" })).toHaveCount(0);
  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog.getByRole("heading", { name: "Markdown preview" })).toBeVisible();
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  await expect(preview.getByRole("heading", { name: "Release notes" })).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("Markdown previews");
  await expect(preview.locator("code")).toHaveText("Eye");
  await expect(preview.locator("li")).toHaveText([
    "Wrap and Copy keep their places",
    "Preview opens a dialog",
  ]);
  await expect(preview.locator("td")).toHaveText(["Code block", "Preview"]);
  await expect(preview.getByRole("link", { name: "Caffold" })).toHaveAttribute(
    "target",
    "_blank",
  );

  const viewport = page.viewportSize();
  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const title = element.querySelector(".task-markdown-preview-title").getBoundingClientRect();
    const close = element.querySelector(".task-markdown-preview-close").getBoundingClientRect();
    const body = element.querySelector("caffold-markdown-preview").getBoundingClientRect();
    return {
      box: {
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        top: box.top,
      },
      bodyInside:
        body.left >= box.left - 0.5 &&
        body.right <= box.right + 0.5 &&
        body.bottom <= box.bottom + 0.5,
      closeInside: close.right <= box.right + 0.5 && close.top >= box.top - 0.5,
      titleBeforeClose: title.right <= close.left + 0.5,
    };
  });
  expect(geometry.box.left).toBeGreaterThanOrEqual(0);
  expect(geometry.box.top).toBeGreaterThanOrEqual(0);
  expect(geometry.box.right).toBeLessThanOrEqual(viewport.width);
  expect(geometry.box.bottom).toBeLessThanOrEqual(viewport.height);
  expect(geometry.bodyInside).toBe(true);
  expect(geometry.closeInside).toBe(true);
  expect(geometry.titleBeforeClose).toBe(true);
  await captureReviewScreenshot(page, testInfo, "task-markdown-preview-dialog");

  await dialog.getByRole("button", { name: "Close Markdown preview" }).click();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();

  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await page.mouse.click(1, 1);
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();

  const longPreviewButton = blocks.nth(2).getByRole("button", { name: "Preview Markdown" });
  await longPreviewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(preview.getByRole("heading", { name: "Long notes" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Release notes" })).toHaveCount(0);
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);
  await captureReviewScreenshot(page, testInfo, "task-markdown-preview-dialog-long");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(longPreviewButton).toBeFocused();
  expect(scenario.pageErrors).toEqual([]);
});

test("keeps the preview through a detail rerender and closes it when the Task changes or its detail is left", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedPreviewTask(
    page,
    "thread_markdown_preview_lifecycle",
    [PREVIEW_SOURCE],
  );
  const tasksPage = page.locator("caffold-tasks-page");
  const previewButton = finalMarkdown(page).getByRole("button", { name: "Preview Markdown" });
  const dialog = page.locator("caffold-task-markdown-preview-dialog > dialog");

  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await dialog.evaluate((element) => {
    window.__markdownPreviewDialog = element;
  });
  await page.evaluate((threadId) => {
    for (const source of window.__caffoldMockEventSources) {
      if (source.url === `/api/tasks/${threadId}/stream` && source.readyState !== 2) {
        source.emitError();
      }
    }
  }, scenario.threadId);
  await expect(
    page.locator('.app-foreground-recovery[data-recovery-state="reconnecting"]'),
  ).toBeVisible();
  await expect(page.locator("caffold-task-markdown-preview-dialog > dialog:modal")).toHaveCount(1);
  expect(
    await dialog.evaluate((element) => element === window.__markdownPreviewDialog),
  ).toBe(true);
  await expect(dialog.getByRole("heading", { name: "Release notes" })).toBeVisible();

  await tasksPage.evaluate((element) => {
    element.prepareRoute({ kind: "tasks", new: true });
  });
  await expect(dialog).not.toHaveAttribute("open", "");

  await page.goto("/tasks/" + scenario.threadId);
  await expect(finalMarkdown(page)).toHaveAttribute("data-render-state", "markdown");
  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await tasksPage.evaluate((element) => {
    element.prepareRoute({ kind: "tasks", threadId: "thread_markdown_preview_other" });
  });
  await expect(dialog).not.toHaveAttribute("open", "");
  expect(scenario.pageErrors).toEqual([]);
});

test("drives the preview with Action Hints and Scroll mode", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedPreviewTask(
    page,
    "thread_markdown_preview_keyboard",
    [LONG_PREVIEW_SOURCE],
  );
  const previewButton = finalMarkdown(page).getByRole("button", { name: "Preview Markdown" });
  const dialog = page.locator("caffold-task-markdown-preview-dialog > dialog");
  const preview = dialog.locator("caffold-markdown-preview");
  const modalHud = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation caffold-scroll-mode-hud",
  );

  await previewButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Preview Markdown$/);
  await expect(dialog).toHaveAttribute("open", "");
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  await expect.poll(() => preview.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  )).toBe(true);

  await page.keyboard.press("f");
  const modalHint = actionHintDialog(page);
  await expect(modalHint).toBeVisible();
  await expect(
    modalHint.getByRole("button", { name: / — Close Markdown preview$/ }),
  ).toBeVisible();
  await expect(
    modalHint.getByRole("button", { name: / — Open Caffold in a new tab$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modalHint).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");

  await page.keyboard.press("s");
  await expect(modalHud).toContainText("Scroll: Markdown preview");
  const step = await preview.evaluate((element) =>
    Math.max(1, Math.round(element.clientHeight * 0.1))
  );
  await page.keyboard.press("j");
  await expect.poll(() => preview.evaluate((element) => element.scrollTop))
    .toBe(step);
  await page.keyboard.press("Escape");
  await expect(modalHud).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");

  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();
  expect(scenario.pageErrors).toEqual([]);
});

function finalMarkdown(page) {
  return page.locator(
    'caffold-task-assistant-message[data-message-phase="final"] caffold-task-markdown',
  );
}

async function seedPreviewTask(page, threadId, [firstMarkdown, ...laterMarkdown]) {
  const markdownFence = (markdown) => [
    "",
    "```markdown",
    ...markdown.slice(0, -1).split("\n"),
    "```",
  ];
  const scenario = await installTaskLoopFixture(page, {
    threadId,
    completedAssistantResponse: [
      "Here is the draft.",
      ...markdownFence(firstMarkdown),
      "",
      "```rust",
      "fn main() {}",
      "```",
      ...laterMarkdown.flatMap(markdownFence),
    ].join("\n"),
  });
  await scenario.seedCompletedTask();
  await page.goto("/tasks/" + scenario.threadId);
  await expect(finalMarkdown(page)).toHaveAttribute("data-render-state", "markdown");
  return scenario;
}
