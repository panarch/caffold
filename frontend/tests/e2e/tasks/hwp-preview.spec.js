import { expect, test } from "@playwright/test";
import { copyFile, rm, writeFile } from "node:fs/promises";

import { repositoryPath } from "../../repository-paths.mjs";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

const fixtureRoot = "frontend/tests/e2e/fixtures";
const directory = "planner";
const formats = [["hwp", 5], ["hwpx", 1]];

function documentRoute(testInfo, extension) {
  return `${directory}/hangul-${testInfo.testId}-${testInfo.repeatEachIndex}.${extension}`;
}

function documentPath(testInfo, extension) {
  return repositoryPath(`${fixtureRoot}/home/src`, documentRoute(testInfo, extension));
}

function documentResponse(testInfo, extension) {
  return (url) => url.pathname === "/api/document" &&
    url.searchParams.get("path") === `src/${documentRoute(testInfo, extension)}`;
}

function viewerFile(taskReview, testInfo, extension) {
  return taskReview.locator(
    `caffold-file-navigator button[data-file-tree-path="src/${documentRoute(testInfo, extension)}"]`,
  );
}

function libraryRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@rhwp/core@")) {
      requests.push(url.pathname.split("/").at(-1));
    }
  });
  return requests;
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  for (const [extension] of formats) {
    await copyFile(repositoryPath(fixtureRoot, `review-document.${extension}`), documentPath(testInfo, extension));
  }
});

test.afterEach(async ({}, testInfo) => {
  for (const [extension] of formats) {
    await rm(documentPath(testInfo, extension), { force: true });
  }
});

async function openDocument(page, testInfo, extension = "hwp", { beforeOpen, view = "preview" } = {}) {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await beforeOpen?.();
  const previewUrl = `/tasks/${taskScenario.threadId}/review?nav=files&view=preview&file=${encodeURIComponent(documentRoute(testInfo, extension))}`;
  await page.goto(previewUrl.replace("view=preview", `view=${view}`));
  return { taskReview, previewUrl, viewer: taskReview.getByRole("region", { name: "Hangul document preview" }) };
}

function readingPlace(viewer) {
  return viewer.evaluate((element) => {
    const pages = [...element.shadowRoot.querySelectorAll("[data-hwp-page]")];
    const top = element.getBoundingClientRect().top;
    const index = pages.findIndex((candidate) => candidate.getBoundingClientRect().bottom > top);
    const box = pages[index].getBoundingClientRect();
    return { page: index, fraction: Math.round(((top - box.top) / box.height) * 100) / 100 };
  });
}

async function readThirdPage(viewer) {
  await viewer.evaluate((element) => {
    const box = element.shadowRoot.querySelector('[data-hwp-page="3"]').getBoundingClientRect();
    element.scrollTop += box.top - element.getBoundingClientRect().top + 0.25 * box.height;
  });
  await expect.poll(() => readingPlace(viewer)).toEqual({ page: 2, fraction: 0.25 });
}

for (const [extension, pages] of formats) {
  test(`renders ${extension.toUpperCase()} in Preview at the available width`, { tag: "@all-viewports" }, async ({ page }, testInfo) => {
    const requests = libraryRequests(page);
    const { taskReview, viewer, previewUrl } = await openDocument(page, testInfo, extension, {
      view: "source",
      beforeOpen: () => expect(requests).toEqual([]),
    });

    await expect(page).toHaveURL(previewUrl);
    await expect(taskReview.getByRole("button", { name: "Source", exact: true })).toBeHidden();
    await expect(taskReview.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true");

    await expect(viewer.locator("[data-hwp-page]")).toHaveCount(pages);
    const canvas = viewer.locator('[data-hwp-page="1"] canvas');
    await expect(canvas).toBeVisible();
    expect(await canvas.evaluate((element) => {
      const { data } = element.getContext("2d").getImageData(0, 0, element.width, element.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 128 && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) {
          return true;
        }
      }
      return false;
    })).toBe(true);
    expect(requests).toEqual(["rhwp.js", "rhwp_bg.wasm"]);

    const box = await viewer.locator('[data-hwp-page="1"]').boundingBox();
    expect(box.width / box.height).toBeCloseTo(793.7 / 1122.5, 2);
    expect(box.width).toBeLessThanOrEqual(794);
    expect(await viewer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);

    if (extension === "hwp") {
      const lastCanvas = viewer.locator('[data-hwp-page="5"] canvas');
      await expect(lastCanvas).toHaveCount(0);
      await viewer.locator('[data-hwp-page="5"]').scrollIntoViewIfNeeded();
      await expect(lastCanvas).toBeVisible();
      await expect(canvas).toHaveCount(0);
      await viewer.evaluate((element) => { element.scrollTop = 0; });
      await expect(canvas).toBeVisible();
    }
    await captureReviewScreenshot(page, testInfo, `hangul-${extension}-preview`);
  });
}

test("reuses the engine and remembers the reading position when changing Hangul files", { tag: "@server-steady" }, async ({ page }, testInfo) => {
  const requests = libraryRequests(page);
  const { taskReview, viewer } = await openDocument(page, testInfo);
  await expect(viewer.locator("[data-hwp-page]")).toHaveCount(5);
  await readThirdPage(viewer);
  await viewerFile(taskReview, testInfo, "hwpx").click();
  await expect(viewer.locator("[data-hwp-page]")).toHaveCount(1);
  await expect(viewer.locator("canvas")).toBeVisible();
  expect(await viewer.evaluate((element) => element.scrollTop)).toBe(0);

  await viewerFile(taskReview, testInfo, "hwp").click();
  await expect(viewer.locator("[data-hwp-page]")).toHaveCount(5);
  await expect.poll(() => readingPlace(viewer)).toEqual({ page: 2, fraction: 0.25 });
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect.poll(() => readingPlace(viewer)).toEqual({ page: 2, fraction: 0.25 });
  expect(requests).toEqual(["rhwp.js", "rhwp_bg.wasm"]);
});

test("draws a newer copy at the same reading position", { tag: "@server-changes" }, async ({ page }, testInfo) => {
  const { viewer, taskReview } = await openDocument(page, testInfo);
  await expect(viewerFile(taskReview, testInfo, "hwp")).toHaveAttribute("aria-current", "true");
  await expect(viewer.locator("[data-hwp-page]")).toHaveCount(5);
  await readThirdPage(viewer);
  const thirdPage = viewer.locator('[data-hwp-page="3"]');
  const canvas = thirdPage.locator("canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => { element.dataset.beforeRefresh = ""; });
  // A different file version containing the same pages isolates refresh and
  // reading position from pagination changes.
  await copyFile(repositoryPath(fixtureRoot, "review-document.hwp"), documentPath(testInfo, "hwp"));
  const reread = page.waitForResponse((response) => documentResponse(testInfo, "hwp")(new URL(response.url())));
  await taskReview.locator("caffold-file-navigator").evaluate((element) => element.requestRefresh({ selected: true }));
  await reread;
  await expect(thirdPage.locator("canvas[data-before-refresh]")).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await expect.poll(() => readingPlace(viewer)).toEqual({ page: 2, fraction: 0.25 });
});

test("discards the file request when another Hangul document is selected", { tag: "@server-changes" }, async ({ page }, testInfo) => {
  let resumeFirst;
  const held = new Promise((resolve) => { resumeFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let firstReleased;
  const released = new Promise((resolve) => { firstReleased = resolve; });
  await page.route(documentResponse(testInfo, "hwp"), async (route) => {
    firstStarted();
    await held;
    await route.continue().catch(() => {});
    firstReleased();
  });

  try {
    const { taskReview, viewer } = await openDocument(page, testInfo);
    await started;
    await expect(viewer).toHaveAttribute("data-render-state", "loading");
    const cancelled = page.waitForEvent("requestfailed", (request) =>
      documentResponse(testInfo, "hwp")(new URL(request.url())));
    await viewerFile(taskReview, testInfo, "hwpx").click();
    await expect(viewer.locator("[data-hwp-page]")).toHaveCount(1);
    await expect(viewer.locator("canvas")).toBeVisible();
    resumeFirst();
    await released;
    await cancelled;
    await expect(viewerFile(taskReview, testInfo, "hwpx")).toHaveAttribute("aria-current", "true");
    await expect(viewer.locator("[data-hwp-page]")).toHaveCount(1);
  } finally {
    resumeFirst();
  }
});

test("reports an unreadable Hangul file inside Review", { tag: "@server-steady" }, async ({ page }, testInfo) => {
  await writeFile(documentPath(testInfo, "hwp"), "Not a Hangul document");
  const { taskReview, viewer } = await openDocument(page, testInfo);
  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(viewer).toContainText("This Hangul document could not be displayed.");
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});

test("reports a failed WASM download inside Review", { tag: "@server-steady" }, async ({ page }, testInfo) => {
  await page.route((url) => url.hostname === "cdn.jsdelivr.net" &&
    url.pathname.endsWith("/rhwp_bg.wasm"), (route) => route.abort());
  const { taskReview, viewer } = await openDocument(page, testInfo);
  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true");
});

// The room the viewer gives its pages, and the box and drawn canvas of each
// page.
function hwpLayout(viewer) {
  return viewer.evaluate((element) => {
    const style = getComputedStyle(element);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return {
      room: {
        width: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
        height: element.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
      },
      pages: [...element.shadowRoot.querySelectorAll("[data-hwp-page]")].map((page) => {
        const box = page.getBoundingClientRect();
        const canvas = page.querySelector("canvas");
        return {
          width: box.width,
          height: box.height,
          canvasWidth: canvas?.width ?? 0,
          canvasHeight: canvas?.height ?? 0,
          sharpWidth: Math.round(page.clientWidth * ratio),
        };
      }),
    };
  });
}

async function openHwpZoom(taskReview) {
  const fileViewer = taskReview.locator("caffold-review-file-viewer");
  await fileViewer.getByRole("button", { name: "Zoom", exact: true }).click();
  const zoom = fileViewer.locator("caffold-zoom-control");
  await expect(zoom).toBeVisible();
  return {
    zoom,
    percent: zoom.getByRole("textbox", { name: "Zoom percent" }),
    slider: zoom.getByRole("slider", { name: "Zoom" }),
  };
}

test("Zoom fits a Hangul page to the viewer or draws it at a percent of its size, drawing it again once let go", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  const { taskReview, viewer } = await openDocument(page, testInfo);
  await expect(viewer.locator("[data-hwp-page]")).toHaveCount(5);
  await expect(viewer.locator("[data-hwp-page] canvas").first()).toBeVisible();
  const { zoom, percent, slider } = await openHwpZoom(taskReview);

  await zoom.getByRole("button", { name: "Fit page" }).click();
  await expect.poll(async () => {
    const { room, pages } = await hwpLayout(viewer);
    return pages[0].height <= room.height + 1;
  }).toBe(true);
  const whole = (await hwpLayout(viewer)).pages[0];
  expect(whole.width / whole.height).toBeCloseTo(793.7 / 1122.5, 2);
  await expect(percent).toHaveValue(`${Math.round((whole.width / 793.7) * 100)}%`);

  await readThirdPage(viewer);
  await percent.fill("150");
  await percent.press("Enter");
  await expect.poll(async () => (await hwpLayout(viewer)).pages[2].width).toBeCloseTo(793.7 * 1.5, 0);
  const kept = await readingPlace(viewer);
  expect(kept.page).toBe(2);
  expect(Math.abs(kept.fraction - 0.25)).toBeLessThanOrEqual(0.02);
  // RHWP rounds a canvas side its own way, a pixel either side.
  await expect.poll(async () => {
    const { pages } = await hwpLayout(viewer);
    return Math.abs(pages[2].canvasWidth - pages[2].sharpWidth) <= 1;
  }).toBe(true);

  const drawnAt = (await hwpLayout(viewer)).pages[2].canvasWidth;
  const box = await slider.boundingBox();
  const middle = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.65, middle);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, middle, { steps: 5 });
  await expect.poll(async () => (await hwpLayout(viewer)).pages[2].width)
    .toBeGreaterThan(793.7 * 1.5 + 50);
  expect((await hwpLayout(viewer)).pages[2].canvasWidth).toBe(drawnAt);
  await page.mouse.up();
  await expect.poll(async () => {
    const { pages } = await hwpLayout(viewer);
    return Math.abs(pages[2].canvasWidth - pages[2].sharpWidth) <= 1 && pages[2].canvasWidth !== drawnAt;
  }).toBe(true);
});

test.describe("on a screen of two device pixels to the CSS pixel", () => {
  test.use({ deviceScaleFactor: 2 });

  test("draws a Hangul page zoomed far in coarser, within the canvas size an iPhone draws", { tag: "@server-steady" }, async ({
    page,
  }, testInfo) => {
    const { taskReview, viewer } = await openDocument(page, testInfo);
    await expect(viewer.locator("[data-hwp-page] canvas").first()).toBeVisible();
    const { percent } = await openHwpZoom(taskReview);

    await percent.fill("400");
    await percent.press("Enter");
    await expect.poll(async () => (await hwpLayout(viewer)).pages[0].canvasWidth).toBeGreaterThan(793.7 * 4);
    const [first] = (await hwpLayout(viewer)).pages;
    expect(first.canvasWidth * first.canvasHeight).toBeLessThanOrEqual(4096 * 4096);
    expect(first.canvasWidth).toBeLessThan(first.sharpWidth);
  });
});
