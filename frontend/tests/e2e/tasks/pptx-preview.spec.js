import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";

import { repositoryPath } from "../../repository-paths.mjs";
import {
  activateActionHint,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { presentationDeck } from "../support/presentation-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

// pptxgenjs's default 16:9 slide, 10 by 5.625 inches, in CSS pixels.
const SLIDE_WIDTH = 960;

const PICTURE =
  "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Three slides: the first links out of the deck, to the third slide, and to a
// script URL that would mark the window if it ever ran, from its text and from
// two whole pictures; the second holds a video with its poster and an audio
// clip with the picture PowerPoint gives it.
function reviewDeck(presentation) {
  const opening = presentation.addSlide();
  opening.addText("Quarterly deck", { x: 0.5, y: 0.4, w: 6, h: 0.6, fontSize: 28 });
  opening.addText([
    { text: "Quarterly report", options: { hyperlink: { url: "https://example.com/report" } } },
  ], { x: 0.5, y: 1.4, w: 6, h: 0.5 });
  opening.addText([
    { text: "Appendix", options: { hyperlink: { slide: 3 } } },
  ], { x: 0.5, y: 2.1, w: 6, h: 0.5 });
  opening.addText([
    {
      text: "Unsafe link",
      options: { hyperlink: { url: "javascript:window.__pptxLinkRan = true" } },
    },
  ], { x: 0.5, y: 2.8, w: 6, h: 0.5 });
  opening.addImage({ data: PICTURE, x: 7, y: 1.4, w: 2, h: 1.2, hyperlink: { slide: 3 } });
  opening.addImage({
    data: PICTURE,
    x: 7,
    y: 3,
    w: 2,
    h: 1.2,
    hyperlink: { url: "https://example.com/diagram" },
  });

  const media = presentation.addSlide();
  media.addText("Recorded demo", { x: 0.5, y: 0.4, w: 6, h: 0.6 });
  media.addMedia({
    type: "video",
    data: "video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=",
    cover: PICTURE,
    x: 0.5,
    y: 1.2,
    w: 4,
    h: 2.25,
  });
  media.addMedia({
    type: "audio",
    data: "audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA",
    x: 5.5,
    y: 1.2,
    w: 1,
    h: 1,
  });

  presentation.addSlide().addText("Appendix notes", { x: 0.5, y: 0.4, w: 6, h: 0.6 });
}

// Every project reviews the same workspace at once, so each test writes its
// deck under a name unique to it, inside a directory the file tree keeps
// collapsed.
const DOCUMENT_DIRECTORY = "planner";

function documentName(testInfo) {
  return `review-deck-${testInfo.testId}-${testInfo.repeatEachIndex}.pptx`;
}

function documentRoute(testInfo) {
  return `${DOCUMENT_DIRECTORY}/${documentName(testInfo)}`;
}

function documentPath(testInfo) {
  return repositoryPath(
    `frontend/tests/e2e/fixtures/home/src/${DOCUMENT_DIRECTORY}`,
    documentName(testInfo),
  );
}

async function openDocument(page, testInfo, view = "preview") {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=${view}` +
      `&file=${encodeURIComponent(documentRoute(testInfo))}`,
  );
  return { taskScenario, taskReview };
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  await writeFile(documentPath(testInfo), await presentationDeck(reviewDeck));
});

test.afterEach(async ({}, testInfo) => {
  await rm(documentPath(testInfo), { force: true });
});

test("renders a PowerPoint deck as the only representation its file supports", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  // A deck has no source text, so a Source route normalizes to Preview.
  const { taskScenario, taskReview } = await openDocument(page, testInfo, "source");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
      `&file=${encodeURIComponent(documentRoute(testInfo))}`,
  );
  await expect(taskReview.getByRole("button", { name: "Source", exact: true }))
    .toBeHidden();
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const viewer = taskReview.locator("caffold-pptx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "pptx");
  await expect(viewer.getByText("Quarterly deck")).toBeVisible();

  // The first slide fits the viewer's width, and never grows past its own.
  const available = await viewer.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
  });
  const slide = viewer.locator('[data-slide-index="0"]');
  const width = await slide.evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(width - Math.min(SLIDE_WIDTH, available))).toBeLessThanOrEqual(1);
  const overflow = await viewer.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // A panel wider than the slide leaves it at its own size.
  await viewer.evaluate((element) => {
    element.style.width = "1400px";
    element.style.maxWidth = "none";
  });
  await expect.poll(() => slide.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width))).toBe(SLIDE_WIDTH);
  await viewer.evaluate((element) => {
    element.style.width = "";
    element.style.maxWidth = "";
  });

  await captureReviewScreenshot(page, testInfo, "tasks-pptx-preview");
});

test("reaches the deck's links and jumps to a linked slide", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pptx-viewer");
  await expect(viewer.getByText("Quarterly deck")).toBeVisible();

  // Only the web link becomes a link out of the deck.
  const report = viewer.getByRole("link", { name: "Quarterly report" });
  await expect(report).toHaveAttribute("href", "https://example.com/report");
  await expect(report).toHaveAttribute("target", "_blank");
  await expect(viewer.locator("a")).toHaveCount(1);
  await expect(viewer.getByText("Unsafe link")).toBeVisible();

  // Where the third slide sits inside the scrollport, whether or not the
  // renderer has drawn it yet.
  const appendixPlacement = () => viewer.evaluate((element) => {
    const slide = element.querySelector(".pptx-viewer-document").shadowRoot
      .querySelector('[data-slide-index="2"]');
    const port = element.getBoundingClientRect();
    const box = slide.getBoundingClientRect();
    return {
      below: box.top >= port.bottom,
      inside: box.top >= port.top - 1 && box.bottom <= port.bottom + 1,
    };
  });
  expect((await appendixPlacement()).below).toBe(true);

  await waitForActionHintTarget(page, "Open Quarterly report in a new tab");
  await activateActionHint(page, "Go to Appendix (slide 3)");

  // The viewer scrolls until the linked slide is in view.
  await expect.poll(async () => (await appendixPlacement()).inside).toBe(true);
  await expect(viewer.getByText("Appendix notes")).toBeVisible();
  expect(await page.evaluate(() => window.__pptxLinkRan)).toBeUndefined();
});

test("reaches a link on a whole picture from the keyboard", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pptx-viewer");
  await expect(viewer.getByText("Quarterly deck")).toBeVisible();

  // The renderer only makes the pictures clickable; the viewer gives them the
  // keyboard.
  const jump = viewer.getByRole("link", { name: "Go to slide 3", exact: true });
  const diagram = viewer.getByRole("link", { name: "https://example.com/diagram" });
  await expect(jump).toHaveAttribute("tabindex", "0");
  await expect(diagram).toHaveAttribute("tabindex", "0");
  await waitForActionHintTarget(page, "Go to slide 3");
  await waitForActionHintTarget(page, "Open https://example.com/diagram");

  await jump.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => viewer.evaluate((element) => {
    const slide = element.querySelector(".pptx-viewer-document").shadowRoot
      .querySelector('[data-slide-index="2"]');
    const port = element.getBoundingClientRect();
    const box = slide.getBoundingClientRect();
    return box.top >= port.top - 1 && box.bottom <= port.bottom + 1;
  })).toBe(true);
});

test("shows a deck's media as its pictures without playing it", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pptx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "pptx");

  const mediaSlide = viewer.locator('[data-slide-index="1"]');
  await mediaSlide.scrollIntoViewIfNeeded();
  await expect(mediaSlide.getByText("Recorded demo")).toBeVisible();

  // The video's poster stands in for it, and the audio clip leaves only its
  // picture.
  await expect(mediaSlide.locator("img.pptx-viewer-media-poster")).toHaveCount(1);
  await expect(mediaSlide.locator("img.pptx-viewer-media-poster")).toBeVisible();
  await expect(mediaSlide.locator("img")).toHaveCount(2);
  await expect(viewer.locator("video, audio")).toHaveCount(0);
  await expect(viewer.getByText("Media is not played in this preview.")).toHaveCount(0);
});

test("reports an unavailable deck without replacing the review surface", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await page.route(/\/api\/document\?path=/, (route) =>
    route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "file_too_large", message: "file is too large" },
      }),
    }));

  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pptx-viewer");

  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(viewer).toContainText("This document could not be displayed.");
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});
