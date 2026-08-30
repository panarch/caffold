import { expect, test } from "@playwright/test";
import { copyFile, rm, writeFile } from "node:fs/promises";
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

test("renders a route-owned text-only Markdown Preview without changing file selection", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const embeddedResourceRequests = [];
  page.on("request", (request) => {
    if (request.url() === "https://example.com/preview.png") {
      embeddedResourceRequests.push(request.url());
    }
  });
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.getByRole("button", { name: "Files", exact: true }).click();

  await taskReview.evaluate((review) => {
    const viewerControl = review.querySelector(
      'caffold-segmented-control[data-review-axis="viewer"]',
    );
    for (const value of ["diff", "source"]) {
      viewerControl.querySelector(
        `button[data-segmented-value="${value}"]`,
      ).stableChoiceProbe = true;
    }
  });

  const navigator = taskReview.locator("caffold-file-navigator");
  await navigator.locator('button[data-file-tree-path="src/README.md"]').click();
  expect(await taskReview.evaluate((review) => {
    const viewerControl = review.querySelector(
      'caffold-segmented-control[data-review-axis="viewer"]',
    );
    return ["diff", "source"].every((value) =>
      viewerControl.querySelector(
        `button[data-segmented-value="${value}"]`,
      ).stableChoiceProbe === true
    );
  })).toBe(true);
  const previewControl = taskReview.getByRole("button", {
    name: "Preview",
    exact: true,
  });
  await expect(previewControl).toBeVisible();
  await expect(previewControl).toBeEnabled();
  expect(await previewControl.evaluate((button) => {
    const control = button.parentElement;
    const selected = control.querySelector('button[aria-pressed="true"]')
      ?.dataset.segmentedValue ?? "";
    const snapshot = {
      label: control.getAttribute("aria-label"),
      choices: [...control.querySelectorAll("button")].map((choice) => ({
        value: choice.dataset.segmentedValue,
        label: choice.textContent.trim(),
        title: choice.title,
      })),
    };
    button.focus();
    control.setSnapshot({
      ...snapshot,
      selected: button.dataset.segmentedValue,
    });
    const retained =
      document.activeElement === button &&
      control.querySelector(
        `button[data-segmented-value="${button.dataset.segmentedValue}"]`,
      ) === button;
    control.setSnapshot({ ...snapshot, selected });
    return retained && document.activeElement === button;
  })).toBe(true);
  await previewControl.click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview&file=README.md`,
  );
  await expect(previewControl).toHaveAttribute("aria-pressed", "true");

  const viewer = taskReview.locator("caffold-review-file-viewer");
  const markdownPreview = viewer.locator("caffold-markdown-preview");
  const preview = markdownPreview.locator(".markdown-preview-body");
  await expect(markdownPreview).toHaveAttribute("data-render-state", "markdown");
  const previewScroll = await markdownPreview.evaluate((element) => {
    window.__caffoldMarkdownPreviewElement = element;
    element.scrollTop = Math.min(120, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(previewScroll).toBeGreaterThan(0);
  const refreshedFile = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/file" &&
      url.searchParams.get("path") === "src/README.md";
  });
  await navigator.evaluate((element) => {
    element.dispatchEvent(new CustomEvent(
      "caffold:file-navigator-refresh-selected",
      { bubbles: true },
    ));
  });
  await refreshedFile;
  await expect(markdownPreview).toHaveAttribute("data-render-state", "markdown");
  expect(await markdownPreview.evaluate((element) =>
    window.__caffoldMarkdownPreviewElement === element
  )).toBe(true);
  expect(await markdownPreview.evaluate((element) => element.scrollTop)).toBe(
    previewScroll,
  );
  await markdownPreview.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(preview.locator("h1")).toHaveText("Markdown file preview");
  await expect(preview.locator("strong")).toHaveText("textual Markdown");
  await expect(preview.locator("table")).toContainText("Renders safe text content");
  await expect(preview.locator("pre code")).toContainText('println!("preview")');
  await expect(preview.locator("img, script")).toHaveCount(0);
  await expect(preview.locator(".markdown-preview-image-placeholder")).toHaveText(
    "[Image: Architecture diagram]",
  );
  await expect(preview.getByRole("link", { name: "External documentation" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(preview.locator("a", { hasText: "Sibling source" })).toHaveCount(0);
  await expect(preview.getByText("Sibling source", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.__caffoldMarkdownPreviewScriptRan),
  ).toBeUndefined();
  expect(embeddedResourceRequests).toEqual([]);
  await expect(previewControl).toHaveAttribute("aria-pressed", "true");

  const layout = await taskReview.evaluate((review) => {
    const axis = review.querySelector(
      '.task-review-viewer-axis caffold-segmented-control[data-review-axis="viewer"]',
    );
    const labels = [...axis.querySelectorAll("button > span")];
    const previewScroll = review.querySelector("caffold-markdown-preview");
    return {
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      axisWidth: axis.getBoundingClientRect().width,
      reviewOverflow: review.scrollWidth > review.clientWidth,
      previewOverflow: previewScroll.scrollWidth > previewScroll.clientWidth,
      clippedLabels: labels
        .filter((label) => label.scrollWidth > label.clientWidth)
        .map((label) => ({
          label: label.textContent.trim(),
          scrollWidth: label.scrollWidth,
          clientWidth: label.clientWidth,
        })),
      visibleLabels: labels.map((label) => label.textContent.trim()),
    };
  });
  expect(layout.reviewOverflow).toBe(false);
  expect(layout.previewOverflow).toBe(false);
  expect(layout.axisWidth).toBeCloseTo(layout.rootFontSize * 11.25, 0);
  expect(layout.clippedLabels).toEqual([]);
  expect(layout.visibleLabels).toEqual(["Diff", "Source", "Preview"]);
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-markdown-preview");

  await markdownPreview.evaluate((element) => {
    element.setMarkdown("[[caffold-test:markdown-error]]");
  });
  await expect(markdownPreview).toHaveAttribute("data-render-state", "plain");
  await expect(markdownPreview.locator(".markdown-preview-fallback")).toHaveText(
    "[[caffold-test:markdown-error]]",
  );

  await page.reload();
  await expect(markdownPreview).toHaveAttribute("data-render-state", "markdown");
  await expect(preview.locator("h1")).toHaveText("Markdown file preview");
  await expect(previewControl).toHaveAttribute("aria-pressed", "true");

  if (testInfo.project.name === "phone") {
    await taskReview.getByRole("button", { name: "Back to navigator" }).click();
  }
  await navigator.locator('button[data-file-tree-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=alpha.rs`,
  );
  await expect(viewer.locator("caffold-code-viewer")).toContainText("pub const ALPHA");
  await expect(previewControl).toBeHidden();
});

test("selects supported source and preview representations for images", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const rasterName = `review-image-${testInfo.project.name}.png`;
  const rasterPath = repositoryPath("frontend/tests/e2e/fixtures/home/src", rasterName);
  await copyFile(
    repositoryPath("frontend/assets/icons/favicon-32.png"),
    rasterPath,
  );
  try {
    const { taskScenario, tasksPage, taskReview } =
      await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
    if (testInfo.project.name === "phone") {
      await taskReview.evaluate((review) => review.updateAxis("viewer", "source"));
    } else {
      await taskReview.getByRole("button", { name: "Source", exact: true }).click();
    }

    const navigator = taskReview.locator("caffold-file-navigator");
    await navigator.locator(`button[data-file-tree-path="src/${rasterName}"]`).click();
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview&file=${rasterName}`,
    );
    const viewer = taskReview.locator("caffold-review-file-viewer");
    const sourceControl = taskReview.getByRole("button", {
      name: "Source",
      exact: true,
    });
    const previewControl = taskReview.getByRole("button", {
      name: "Preview",
      exact: true,
    });
    await expect(sourceControl).toBeHidden();
    await expect(previewControl).toHaveAttribute("aria-pressed", "true");
    await expect(viewer).toContainText("PNG image");
    await expect(viewer.locator("img.image-preview")).toHaveAttribute(
      "src",
      new RegExp(`/api/image\\?path=src%2F${rasterName}&revision=\\d+$`),
    );

    if (testInfo.project.name === "phone") {
      await taskReview.getByRole("button", { name: "Back to navigator" }).click();
    }
    await navigator.locator('button[data-file-tree-path="src/review-image.svg"]').click();
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview&file=review-image.svg`,
    );
    await expect(sourceControl).toBeVisible();
    await expect(previewControl).toHaveAttribute("aria-pressed", "true");
    await expect(viewer).toContainText("SVG image");
    await expect(viewer.locator("img.image-preview")).toHaveAttribute(
      "src",
      /\/api\/image\?path=src%2Freview-image\.svg&revision=\d+$/,
    );

    await sourceControl.click();
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=review-image.svg`,
    );
    await expect(viewer.locator("caffold-code-viewer")).toContainText("<svg");
    await expect(viewer.locator("img.image-preview")).toHaveCount(0);

    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=${rasterName}`,
    );
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview&file=${rasterName}`,
    );
    await expect(viewer.locator("img.image-preview")).toBeVisible();
  } finally {
    await rm(rasterPath, { force: true });
  }
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
