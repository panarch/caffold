import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { repositoryPath } from "../../repository-paths.mjs";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("browses source through the shared Files navigator and one root watch", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  let listRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      listRequests += 1;
    }
  });
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  if (testInfo.project.name === "phone") {
    await taskReview.evaluate((review) => review.updateAxis("viewer", "source"));
  } else {
    await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  }
  await expect(taskReview.getByRole("button", { name: "Refresh review" })).toHaveCount(0);
  await expect(taskReview.getByRole("button", { name: "Refresh files" })).toHaveCount(0);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
  );

  const navigator = taskReview.locator("caffold-file-navigator");
  await expect(navigator.locator('button[data-file-tree-path="src/alpha.rs"]')).toBeVisible();
  const rootFolder = navigator.locator(
    'button[data-file-tree-path="src/planner"]',
  );
  const rootFile = navigator.locator(
    'button[data-file-tree-path="src/alpha.rs"]',
  );
  await expect(rootFolder).toBeVisible();
  expect((await rootFolder.boundingBox()).y).toBeLessThan(
    (await rootFile.boundingBox()).y,
  );
  const listRequestsBeforeOrderChange = listRequests;
  await page.evaluate(async () => {
    const { setFileSortMode } = await import("/assets/settings.js");
    setFileSortMode("name");
  });
  expect((await rootFile.boundingBox()).y).toBeLessThan(
    (await rootFolder.boundingBox()).y,
  );
  expect(listRequests).toBe(listRequestsBeforeOrderChange);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__caffoldMockEventSources.filter(
            (source) => source.url.startsWith("/api/watch?") && source.readyState !== 2,
          ).length,
      ),
    )
    .toBe(1);

  const liveName = `task-live-${testInfo.project.name}.txt`;
  const livePath = repositoryPath("frontend/tests/e2e/fixtures/home/src", liveName);
  try {
    await writeFile(livePath, "Caffold Review live update\n");
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find(
        (candidate) => candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
      );
      source?.emit("change", {
        revision: 2,
        paths: [logicalPath],
        gitStatusChanged: false,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${liveName}`);
    await expect(
      navigator.locator(`button[data-file-tree-path="src/${liveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(livePath, { force: true });
  }

  await navigator.locator('button[data-file-tree-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=alpha.rs`,
  );
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "pub const ALPHA",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");

  if (testInfo.project.name === "phone") {
    await taskReview.getByRole("button", { name: "Back to navigator" }).click();
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
    );
  }
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__caffoldMockEventSources.filter(
            (source) => source.url.startsWith("/api/watch?") && source.readyState !== 2,
          ).length,
      ),
    )
    .toBe(0);
});

test("previews images selected from the shared Files navigator", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  if (test.info().project.name === "phone") {
    await taskReview.evaluate((review) => review.updateAxis("viewer", "source"));
  } else {
    await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  }

  const navigator = taskReview.locator("caffold-file-navigator");
  await navigator.locator('button[data-file-tree-path="src/review-image.svg"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=review-image.svg`,
  );
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(viewer).toContainText("review-image.svg");
  await expect(viewer).toContainText("SVG image");
  await expect(viewer.locator("img.image-preview")).toHaveAttribute(
    "src",
    /\/api\/image\?path=src%2Freview-image\.svg&revision=\d+$/,
  );
});

test("keeps the shared Review panes inside the task workspace", { tag: "@all-viewports" }, async ({ page }) => {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();

  const layout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-task-workspace");
    const appMain = document.querySelector("caffold-app-shell .app-main");
    const review = document.querySelector("caffold-task-review");
    const reviewRect = review.getBoundingClientRect();
    const codexRect = codex.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      appMainTop: appMain.getBoundingClientRect().top,
      codexTop: codexRect.top,
      left: reviewRect.left,
      right: reviewRect.right,
      bottom: reviewRect.bottom,
      codexLeft: codexRect.left,
      codexRight: codexRect.right,
      codexBottom: codexRect.bottom,
      navigatorWidth: review.querySelector(".task-review-navigator-pane").getBoundingClientRect().width,
      overflow: review.scrollWidth > review.clientWidth,
    };
  });

  expect(Math.abs(layout.codexTop - layout.appMainTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.left - layout.codexLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.right - layout.codexRight)).toBeLessThanOrEqual(1);
  expect(layout.bottom).toBeGreaterThanOrEqual(layout.codexBottom - 1);
  expect(layout.overflow).toBe(false);
  if (layout.viewportWidth >= 561) {
    expect(layout.navigatorWidth).toBeGreaterThanOrEqual(220);
  }
});

test("keeps browser Back aligned with the semantic Review parent", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();

  const navigator = taskReview.locator("caffold-file-navigator");
  await navigator.locator('button[data-file-tree-path="src/alpha.rs"]').click();
  await navigator.locator('button[data-file-tree-path="src/planner.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=planner.rs`,
  );

  await page.goBack();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
  );
  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
});
