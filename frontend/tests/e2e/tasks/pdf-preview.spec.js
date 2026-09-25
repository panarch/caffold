import { expect, test } from "@playwright/test";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";

import { repositoryPath } from "../../repository-paths.mjs";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

// The document is US Letter, so a phone must scale the page down while a wider
// viewer stops at the page's own width.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

const FIXTURE_DOCUMENT = repositoryPath(
  "frontend/tests/e2e/fixtures",
  "review-document.pdf",
);

// Every project reviews the same workspace at once. The document is copied in
// under a name unique to the running test, inside an existing directory the
// file tree keeps collapsed, so a concurrent test keeps both its own file and
// the tree rows it already had.
const DOCUMENT_DIRECTORY = "planner";

function documentName(testInfo, suffix = "") {
  return `review-document${suffix}-${testInfo.testId}-${testInfo.repeatEachIndex}.pdf`;
}

function documentRoute(testInfo, suffix = "") {
  return `${DOCUMENT_DIRECTORY}/${documentName(testInfo, suffix)}`;
}

// The route encodes the separator inside the selected-file parameter.
function documentRouteParam(testInfo, suffix = "") {
  return encodeURIComponent(documentRoute(testInfo, suffix));
}

function documentPath(testInfo, suffix = "") {
  return repositoryPath(
    `frontend/tests/e2e/fixtures/home/src/${DOCUMENT_DIRECTORY}`,
    documentName(testInfo, suffix),
  );
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  await copyFile(FIXTURE_DOCUMENT, documentPath(testInfo));
});

test.afterEach(async ({}, testInfo) => {
  await rm(documentPath(testInfo), { force: true });
});

function documentRequests(page, testInfo, suffix = "") {
  const pattern = new RegExp(
    `/api/pdf\\?path=${encodeURIComponent(`src/${documentRoute(testInfo, suffix)}`)
      .replace(".", "\\.")}`,
  );
  const requests = [];
  page.on("request", (request) => {
    if (pattern.test(request.url())) {
      requests.push(request.url());
    }
  });
  return { pattern, requests };
}

async function openDocument(page, testInfo, view = "preview", { beforeOpen } = {}) {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await beforeOpen?.();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=${view}` +
      `&file=${documentRouteParam(testInfo)}`,
  );
  return { taskScenario, taskReview };
}

test("renders a PDF as the only representation its file supports", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const { requests } = documentRequests(page, testInfo);

  // A PDF has no source text, so a Source route normalizes to Preview.
  const { taskScenario, taskReview } = await openDocument(page, testInfo, "source");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
      `&file=${documentRouteParam(testInfo)}`,
  );
  await expect(taskReview.getByRole("button", { name: "Source", exact: true }))
    .toBeHidden();
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const viewer = taskReview.locator("caffold-pdf-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "pdf");
  await expect(viewer.locator(".pdf-viewer-page")).toHaveCount(2);

  const canvas = viewer.locator(".pdf-viewer-page canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element) => {
    const { data } = element
      .getContext("2d")
      .getImageData(0, 0, element.width, element.height);
    let painted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) {
        painted += 1;
      }
    }
    return painted;
  })).toBeGreaterThan(0);

  // The page keeps the document's aspect ratio, never overflows the panel it
  // scrolls inside, and never grows past the width the document declares.
  const pageBox = await viewer.locator(".pdf-viewer-page").first().boundingBox();
  expect(pageBox.width / pageBox.height).toBeCloseTo(PAGE_WIDTH / PAGE_HEIGHT, 2);
  expect(pageBox.width).toBeLessThanOrEqual(PAGE_WIDTH);
  const overflow = await viewer.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const available = await viewer.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
  });
  if (available < PAGE_WIDTH) {
    // A phone-width panel scales the page down to the space it has.
    expect(pageBox.width).toBeCloseTo(available, 0);
  } else {
    expect(pageBox.width).toBeCloseTo(PAGE_WIDTH, 0);
  }

  await captureReviewScreenshot(page, testInfo, "tasks-pdf-preview");
});

test("reads the document again after the file changes", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { pattern, requests } = documentRequests(page, testInfo);

  const { taskReview } = await openDocument(page, testInfo, "preview", {
    // When the working-tree status arrives it reloads the viewer, which reads
    // the document again if the navigator has listed it by then.
    beforeOpen: () => page.route(/\/api\/git\/status(?:\?|$)/, () => {}),
  });
  const viewer = taskReview.locator("caffold-pdf-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "pdf");
  // The viewer does not wait for the navigator, and the refresh below reports a
  // change only to a file the navigator has listed and selected.
  await expect(
    taskReview
      .locator("caffold-file-navigator")
      .locator(`button[data-file-tree-path="src/${documentRoute(testInfo)}"]`),
  ).toHaveAttribute("aria-current", "true");
  expect(requests).toHaveLength(1);

  const original = await readFile(FIXTURE_DOCUMENT);
  // A trailing comment changes the file's bytes and modification time without
  // changing what it renders.
  await writeFile(
    documentPath(testInfo),
    Buffer.concat([original, Buffer.from("\n% replaced\n")]),
  );
  const reread = page.waitForRequest(pattern);
  // Re-listing the directory is what publishes the new modification time, so
  // the refresh has to cover the directories the navigator already loaded.
  await taskReview
    .locator("caffold-file-navigator")
    .evaluate((navigator) =>
      navigator.requestRefresh({ selected: true, allDirectories: true }));
  await reread;

  await expect(viewer).toHaveAttribute("data-render-state", "pdf");
  await expect(viewer.locator(".pdf-viewer-page")).toHaveCount(2);
  expect(requests).toHaveLength(2);
});

test("keeps the open document while the review switches representations", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { requests } = documentRequests(page, testInfo);

  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pdf-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "pdf");
  expect(requests).toHaveLength(1);

  await taskReview.getByRole("button", { name: "Diff", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await taskReview.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(viewer).toHaveAttribute("data-render-state", "pdf");
  await expect(viewer.locator(".pdf-viewer-page")).toHaveCount(2);

  // The panel is rebuilt, so the document is read again; the file itself is
  // unchanged, so its source URL is.
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("reads the newly selected document into the retained PDF panel", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const first = documentRequests(page, testInfo);
  const second = documentRequests(page, testInfo, "-second");
  await copyFile(FIXTURE_DOCUMENT, documentPath(testInfo, "-second"));
  try {
    const { taskScenario, taskReview } = await openDocument(page, testInfo);
    const viewer = taskReview.locator("caffold-pdf-viewer");
    await expect(viewer).toHaveAttribute("data-render-state", "pdf");

    await taskReview
      .locator("caffold-file-navigator")
      .locator(`button[data-file-tree-path="src/${documentRoute(testInfo, "-second")}"]`)
      .click();
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
        `&file=${documentRouteParam(testInfo, "-second")}`,
    );

    // The panel is reused across the selection, so the component itself has to
    // replace the document it holds.
    await expect(viewer).toHaveAttribute("data-render-state", "pdf");
    await expect(viewer.locator(".pdf-viewer-page canvas").first()).toBeVisible();
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  } finally {
    await rm(documentPath(testInfo, "-second"), { force: true });
  }
});

test("reports an unavailable PDF without replacing the review surface", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { pattern } = documentRequests(page, testInfo);
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "file_too_large", message: "file is too large" },
      }),
    }));

  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-pdf-viewer");

  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(viewer).toContainText("This PDF could not be displayed.");
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});
