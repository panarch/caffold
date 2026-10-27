import { expect, test } from "@playwright/test";
import { appendFile, copyFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { repositoryPath } from "../../repository-paths.mjs";
import {
  actionHintDialog,
  activateActionHint,
  activateActionHintIntoPopover,
  enterActionHints,
  popoverActionHintDialog,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  activeWatchSubscriptionId,
  captureReviewScreenshot,
  isWatchSubscriptionClosed,
  mockAgentModels,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("browses source through the shared Files navigator and one root watch", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  let releasePlannerDirectory;
  let markPlannerDirectoryRequested;
  const plannerDirectoryRelease = new Promise((resolve) => {
    releasePlannerDirectory = resolve;
  });
  const plannerDirectoryRequested = new Promise((resolve) => {
    markPlannerDirectoryRequested = resolve;
  });
  await page.route((url) =>
    url.pathname === "/api/list" &&
    (url.searchParams.get("path") ?? "").endsWith("/planner"), async (route) => {
    markPlannerDirectoryRequested();
    await plannerDirectoryRelease;
    await route.continue();
  });
  let listRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      listRequests += 1;
    }
  });
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await activateActionHint(page, /Open Working Tree$/);
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}/review`);
  await activateActionHint(page, /Show Files$/);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files`,
  );
  await expect(
    taskReview.getByRole("button", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  if (testInfo.project.name === "phone") {
    await taskReview.evaluate((review) => review.updateRoute({ viewer: "source" }));
  } else {
    await activateActionHint(page, /Show Source$/);
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
  await expect(rootFolder).toHaveAttribute("aria-expanded", "false");
  await activateActionHint(page, /Expand planner$/);
  await plannerDirectoryRequested;
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  const loadingSnapshot = await enterActionHints(page);
  await expect(loadingSnapshot.getByLabel(/Collapse planner$/)).toBeVisible();
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-file-tree-disclosure-hints",
  );
  releasePlannerDirectory();
  const plannerFile = navigator.locator(
    'button[data-file-tree-path="src/planner/mod.rs"]',
  );
  await expect(plannerFile).toBeVisible();
  await expect(loadingSnapshot).toBeVisible();
  await expect(
    loadingSnapshot.getByLabel(/Open mod\.rs$/),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(loadingSnapshot).toBeHidden();
  await rootFolder.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Collapse planner$/);
  await expect(rootFolder).toHaveAttribute("aria-expanded", "false");
  await expect(plannerFile).toHaveCount(0);
  await rootFolder.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Expand planner$/);
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  await expect(plannerFile).toBeVisible();
  await enterActionHints(page);
  await navigator.locator(".file-tree-scroll").evaluate((scroller) => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(actionHintDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actionHintDialog(page)).toBeHidden();
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

  await activateActionHint(page, /alpha\.rs file$/);
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=alpha.rs`,
  );
  await expect(taskReview.locator("caffold-review-file-viewer")).toContainText(
    "pub const ALPHA",
  );
  await activateActionHintIntoPopover(page, "Show details for alpha.rs");
  const detailsPopover = taskReview.locator(
    "caffold-review-file-viewer:not([hidden]) .viewer-meta-popover",
  );
  await expect(detailsPopover).toBeVisible();
  await expect.poll(() => detailsPopover.evaluate(
    (popover) => popover.scrollHeight <= popover.clientHeight + 1,
  )).toBe(true);
  const detailsHints = popoverActionHintDialog(page);
  await expect(detailsHints.getByRole("button", { name: / — Download$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsHints).toBeHidden();
  await expect(detailsPopover).toBeHidden();

  const detailsButton = taskReview.locator(
    "caffold-review-file-viewer:not([hidden]) .viewer-info-button",
  );
  await detailsButton.click();
  await expect(detailsPopover).toBeVisible();
  await page.keyboard.press("s");
  await expect(
    detailsPopover.locator("caffold-scroll-mode-hud .scroll-mode-status"),
  ).toBeHidden();
  await expect(detailsPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsPopover).toBeHidden();

  if (testInfo.project.name === "desktop") {
    await detailsButton.click();
    await expect(detailsPopover).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 160 });
    await expect.poll(() => detailsPopover.evaluate(
      (popover) => popover.scrollHeight > popover.clientHeight + 1,
    )).toBe(true);
    const before = await detailsPopover.evaluate((popover) => popover.scrollTop);
    await page.keyboard.press("s");
    const localHud = detailsPopover.locator(
      "caffold-scroll-mode-hud .scroll-mode-status",
    );
    await expect(localHud).toContainText("Scroll: File details");
    await page.keyboard.press("j");
    await expect.poll(() => detailsPopover.evaluate((popover) => popover.scrollTop))
      .toBeGreaterThan(before);
    await page.keyboard.press("Escape");
    await expect(localHud).toBeHidden();
    // Details with an action close with the keyboard session, as Task and
    // Note details do.
    await expect(detailsPopover).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");

  if (testInfo.project.name === "phone") {
    await enterActionHints(page);
    await navigator.locator(".file-tree-scroll").evaluate((scroller) => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await expect(actionHintDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await activateActionHint(page, /Back to navigator$/);
    await expect(page).toHaveURL(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
    );
  }
  const reviewWatchSubscriptionId = await activeWatchSubscriptionId(page);
  expect(reviewWatchSubscriptionId).not.toBeNull();
  await tasksPage.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page).toHaveURL(`/tasks/${taskScenario.threadId}`);
  await expect
    .poll(() =>
      isWatchSubscriptionClosed(page, reviewWatchSubscriptionId),
    )
    .toBe(true);
});

test("opens a folder and its parent from Action Hints outside Git", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const directory = await response.json();
    await route.fulfill({
      response,
      json: {
        ...directory,
        git: null,
        entries: directory.entries.map((entry) => ({ ...entry, gitIgnored: false })),
      },
    });
  });
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  taskScenario.updateTask({ worktree: null });
  await page.reload();
  await tasksPage.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source`,
  );

  const navigator = taskReview.locator("caffold-file-navigator");
  const planner = navigator.locator('button[data-file-tree-path="src/planner"]');
  const plannerFile = navigator.locator('button[data-file-tree-path="src/planner/mod.rs"]');
  await expect(planner).toBeVisible();
  await expect(planner).not.toHaveAttribute("aria-expanded");
  await activateActionHint(page, /planner dir$/);
  await expect(plannerFile).toBeVisible();
  await expect(planner).toHaveCount(0);
  await activateActionHint(page, /Parent directory$/);
  await expect(planner).toBeVisible();
  await expect(plannerFile).toHaveCount(0);
});

test("downloads a file Source cannot show from inside File details", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const name = `download-${testInfo.project.name}.bin`;
  const path = repositoryPath("frontend/tests/e2e/fixtures/home/src/ignored-output", name);
  const bytes = Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]);
  await writeFile(path, bytes);
  try {
    const { taskScenario, taskReview } = await openCompletedTaskForReview(page);
    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=ignored-output/${name}`,
    );
    const viewer = taskReview.locator("caffold-review-file-viewer:not([hidden])");
    await expect(viewer.locator(".error-panel")).toContainText(
      "binary-looking files are not supported",
    );

    await activateActionHintIntoPopover(page, `Show details for ${name}`);
    const code = await popoverActionHintDialog(page)
      .getByRole("button", { name: / — Download$/ })
      .getAttribute("data-action-hint-code");
    expect(code).toMatch(/^[A-Z]+$/);
    const download = page.waitForEvent("download");
    await page.keyboard.type(code.toLowerCase());
    const saved = await download;

    expect(saved.suggestedFilename()).toBe(name);
    expect(await readFile(await saved.path())).toEqual(bytes);
  } finally {
    await rm(path, { force: true });
  }
});

test("colors Source with the syntax the server names in File details", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const folder = "frontend/tests/e2e/fixtures/home/src/ignored-output";
  const script = `syntax-${testInfo.project.name}.js`;
  const unknown = `syntax-${testInfo.project.name}.unknownext`;
  const scriptPath = repositoryPath(folder, script);
  const unknownPath = repositoryPath(folder, unknown);
  await writeFile(scriptPath, "/* first\n   middle\n   last */\nconst answer = 1;\n");
  await writeFile(unknownPath, "/* first */\nconst answer = 1;\n");
  try {
    const { taskScenario, taskReview } = await openCompletedTaskForReview(page);
    const viewer = taskReview.locator("caffold-review-file-viewer:not([hidden])");
    const language = viewer.locator('.viewer-meta-popover [data-field="language"] dd');
    const lineColors = () => viewer.locator(".code-row .line-code").evaluateAll((lines) =>
      lines.map((line) => [...line.querySelectorAll("span")].map((span) => [
        span.className,
        span.textContent,
      ])),
    );

    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=ignored-output/${script}`,
    );
    await expect(viewer.locator(".code-row")).toHaveCount(5);
    const colors = await lineColors();
    expect(colors.slice(0, 3)).toEqual([
      [["syntax-comment", "/* first"]],
      [["syntax-comment", "   middle"]],
      [["syntax-comment", "   last */"]],
    ]);
    expect(colors[3]).toContainEqual(["syntax-keyword", "const"]);
    await expect(language).toHaveText("JavaScript (Babel)");

    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=ignored-output/${unknown}`,
    );
    await expect(viewer).toContainText("const answer = 1;");
    await expect(viewer.locator(".code-row .line-code span")).toHaveCount(0);
    await expect(language).toHaveText("Plain Text");
  } finally {
    await rm(scriptPath, { force: true });
    await rm(unknownPath, { force: true });
  }
});

test("File details Download measures the same as the Task details actions", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const actionGeometry = (section, control) => section.evaluate((element, controlSelector) => {
    const action = element.querySelector(controlSelector);
    const style = getComputedStyle(action);
    const frame = getComputedStyle(action, "::before");
    const sectionStyle = getComputedStyle(element);
    return {
      height: action.getBoundingClientRect().height,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      paddingInline: [style.paddingLeft, style.paddingRight],
      frame: [frame.top, frame.bottom, frame.borderTopWidth, frame.borderTopLeftRadius],
      section: [sectionStyle.marginTop, sectionStyle.paddingTop, sectionStyle.borderTopWidth],
    };
  }, control);

  await mockAgentModels(page);
  const { taskScenario, taskReview } = await openCompletedTaskForReview(page);
  await page.locator("caffold-task-detail-info .task-detail-info-button").click();
  const taskSection = page.locator(".task-detail-popover .task-detail-fork-action");
  await expect(taskSection).toBeVisible();
  const task = await actionGeometry(taskSection, ':scope > button[data-task-info-action="fork"]');

  await page.goto(`/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=alpha.rs`);
  const viewer = taskReview.locator("caffold-review-file-viewer:not([hidden])");
  await expect(viewer).toContainText("pub const ALPHA");
  await viewer.locator(".viewer-info-button").click();
  const section = viewer.locator(".viewer-meta-popover > .viewer-meta-actions");
  await expect(section).toBeVisible();
  const link = section.locator(":scope > .viewer-download-link");
  await expect(link).toHaveAttribute("download", "alpha.rs");
  await expect(link.locator(".viewer-download-svg")).toBeVisible();

  expect(await actionGeometry(section, ":scope > .viewer-download-link")).toEqual(task);
  // The icon sits before the label on one line, and the frame leaves the same
  // space before the icon as after the label.
  const layout = await link.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const icon = element.querySelector(":scope > .viewer-download-icon").getBoundingClientRect();
    const label = element.querySelector(":scope > span:last-child").getBoundingClientRect();
    return {
      iconBeforeLabel: icon.right <= label.left,
      centerOffset: Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2),
      insetDifference: Math.abs((icon.left - frame.left) - (frame.right - label.right)),
    };
  });
  expect(layout.iconBeforeLabel).toBe(true);
  expect(layout.centerOffset).toBeLessThanOrEqual(0.5);
  expect(layout.insetDifference).toBeLessThanOrEqual(0.5);
});

test("renders a route-owned Markdown Preview without changing file selection", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  await context.route("https://example.com/docs", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>External documentation</title>",
    }),
  );
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
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  await expect(page.locator("caffold-scroll-surface-selector > dialog:modal")).toBeHidden();
  const workspaceHud = page.locator(
    "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
  );
  await expect(workspaceHud).toContainText("Scroll: README.md preview");
  await page.keyboard.press("j");
  await expect.poll(() => markdownPreview.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(workspaceHud).toBeHidden();
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
  const externalDocumentation = preview.getByRole("link", {
    name: "External documentation",
  });
  await expect(externalDocumentation).toHaveAttribute(
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
  await externalDocumentation.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  const popupPromise = page.waitForEvent("popup");
  await activateActionHint(
    page,
    /Open External documentation in a new tab$/,
  );
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://example.com/docs");
  await popup.close();
  await expect(previewControl).toHaveAttribute("aria-pressed", "true");
  await markdownPreview.evaluate((element) => {
    element.scrollTop = 0;
  });

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
  expect(await page.locator("caffold-task-workspace").evaluate((workspace) =>
    workspace.actionHintScope().targets.some(
      (target) => target.label ===
        "Open External documentation in a new tab",
    )
  )).toBe(false);

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

test("draws the workspace images a Markdown Preview names and leaves the rest as their descriptions", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  // Concurrent tests keep the rows they already have: the files go into a
  // directory the file tree keeps collapsed.
  const folder = `planner/markdown-images-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const folderPath = repositoryPath("frontend/tests/e2e/fixtures/home/src", folder);
  await mkdir(`${folderPath}/docs`, { recursive: true });
  const picture = repositoryPath("frontend/assets/icons/favicon-32.png");
  await copyFile(picture, `${folderPath}/docs/beside.png`);
  await copyFile(picture, `${folderPath}/docs/with space.png`);
  await copyFile(picture, `${folderPath}/parent.png`);
  await writeFile(`${folderPath}/docs/guide.md`, [
    "# Images",
    "",
    "![Beside](beside.png) ![Dotted](./beside.png?raw=true#top) ![Spaced](with%20space.png)",
    "",
    `![Parent](../parent.png) ![Rooted](/${folder}/parent.png)`,
    "",
    "![Workspace](../../../../preview-image.svg)",
    "",
    '<img src="beside.png" alt="Sized" width="20" height="10">',
    "",
    "![Web](https://example.com/web.png) ![Missing](missing.png) ![Above](../../../../../outside.png)",
    "",
  ].join("\n"));
  try {
    const requested = [];
    const webRequests = [];
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/image" && !address.searchParams.has("version")) {
        requested.push(address.searchParams.get("path"));
      }
      if (address.origin === "https://example.com") {
        webRequests.push(request.url());
      }
    });
    const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
        `&file=${encodeURIComponent(`${folder}/docs/guide.md`)}`,
    );
    const preview = taskReview.locator("caffold-review-file-viewer caffold-markdown-preview");

    for (const name of ["Beside", "Dotted", "Spaced", "Parent", "Rooted", "Workspace", "Sized"]) {
      await expectFetchedPicture(preview.locator(`img[alt="${name}"]`));
    }
    await expect(preview.locator('img[alt="Sized"]')).toHaveAttribute("width", "20");
    await expect(preview.locator('img[alt="Sized"]')).toHaveAttribute("height", "10");
    await expect(preview.locator(".markdown-preview-image-placeholder")).toHaveText([
      "[Image: Web]",
      "[Image: Missing]",
      "[Image: Above]",
    ]);
    await expect(preview.locator("img")).toHaveCount(7);
    expect(new Set(requested)).toEqual(new Set([
      `src/${folder}/docs/beside.png`,
      `src/${folder}/docs/with space.png`,
      `src/${folder}/parent.png`,
      "preview-image.svg",
      `src/${folder}/docs/missing.png`,
    ]));
    expect(webRequests).toEqual([]);
  } finally {
    await rm(folderPath, { recursive: true, force: true });
  }
});

test("shrinks a Markdown Preview image wider than the text to the text width", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const folder = `planner/markdown-wide-image-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const folderPath = repositoryPath("frontend/tests/e2e/fixtures/home/src", folder);
  await mkdir(folderPath, { recursive: true });
  await writeFile(
    `${folderPath}/wide.svg`,
    '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100">' +
      '<rect width="2000" height="100" fill="#888"/></svg>',
  );
  await writeFile(`${folderPath}/wide.md`, "# Wide\n\n![Wide](wide.svg)\n");
  try {
    const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
        `&file=${encodeURIComponent(`${folder}/wide.md`)}`,
    );
    const preview = taskReview.locator("caffold-review-file-viewer caffold-markdown-preview");
    await expectFetchedPicture(preview.locator('img[alt="Wide"]'));

    const sizes = await preview.evaluate((element) => {
      const text = element.querySelector(".markdown-preview-body").getBoundingClientRect();
      const image = element.querySelector('img[alt="Wide"]').getBoundingClientRect();
      return { text: text.width, width: image.width, height: image.height };
    });
    expect(sizes.width).toBeLessThanOrEqual(sizes.text);
    expect(sizes.width).toBeGreaterThan(sizes.text - 1);
    expect(Math.abs(sizes.height - sizes.width / 20)).toBeLessThanOrEqual(1);
  } finally {
    await rm(folderPath, { recursive: true, force: true });
  }
});

test("keeps a Markdown Preview's reading position while it fetches its pictures again", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const folder = `planner/markdown-image-position-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const folderPath = repositoryPath("frontend/tests/e2e/fixtures/home/src", folder);
  await mkdir(folderPath, { recursive: true });
  const lines = ["# Position", ""];
  for (let index = 0; index < 4; index += 1) {
    await copyFile(
      repositoryPath("frontend/assets/icons/icon-512.png"),
      `${folderPath}/picture-${index}.png`,
    );
    lines.push(`![Picture ${index}](picture-${index}.png)`, "");
  }
  lines.push("Below the pictures.", "");
  for (let index = 0; index < 60; index += 1) {
    lines.push(`Line ${index} after the pictures.`, "");
  }
  await writeFile(`${folderPath}/guide.md`, lines.join("\n"));
  try {
    const { taskReview, preview } = await openGuidePreview(page, folder);
    const pictures = [0, 1, 2, 3].map((index) => preview.locator(`img[alt="Picture ${index}"]`));
    for (const picture of pictures) {
      await expectFetchedPicture(picture);
    }
    const paragraph = preview.getByText("Below the pictures.", { exact: true });
    const place = () => paragraph.evaluate((element) => Math.round(
      element.getBoundingClientRect().top -
        element.closest("caffold-markdown-preview").getBoundingClientRect().top,
    ));
    await preview.evaluate((element, offset) => {
      element.scrollTop += offset;
    }, (await place()) - 120);
    expect(await place()).toBe(120);

    // Every picture is held from here on, so each place is read before any
    // picture is drawn again.
    const pictureFiles = heldResponse();
    let heldPictures = 0;
    await page.route(/\/api\/image\?/, async (route) => {
      heldPictures += 1;
      await pictureFiles.held;
      await route.fallback().catch(() => {});
    });

    await appendFile(`${folderPath}/guide.md`, "\nOne more line.\n");
    await reportGuideChange(page, folder);
    await expect(preview).toContainText("One more line.");
    await expect.poll(() => heldPictures).toBeGreaterThan(0);
    await expect(pictures[0]).toBeHidden();
    expect(await place()).toBe(120);

    const navigator = taskReview.locator("caffold-file-navigator");
    await navigator.locator('button[data-file-tree-path="src/planner/mod.rs"]').click();
    await expect(taskReview.locator("caffold-review-file-viewer caffold-code-viewer")).toBeVisible();
    const heldBeforeReturn = heldPictures;
    await navigator.locator(`button[data-file-tree-path="src/${folder}/guide.md"]`).click();
    await taskReview.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(preview).toContainText("One more line.");
    await expect.poll(() => heldPictures).toBeGreaterThan(heldBeforeReturn);
    await expect(pictures[0]).toBeHidden();
    expect(await place()).toBe(120);

    pictureFiles.letThrough();
    for (const picture of pictures) {
      await expectFetchedPicture(picture);
    }
    expect(await place()).toBe(120);
  } finally {
    await rm(folderPath, { recursive: true, force: true });
  }
});

test("puts a Markdown Preview picture's loading phrase on the text line, or in the middle of the place it holds", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  const folder = `planner/markdown-image-loading-${testInfo.project.name}-${testInfo.repeatEachIndex}`;
  const folderPath = repositoryPath("frontend/tests/e2e/fixtures/home/src", folder);
  await mkdir(folderPath, { recursive: true });
  await copyFile(repositoryPath("frontend/assets/icons/icon-512.png"), `${folderPath}/picture.png`);
  await writeFile(`${folderPath}/guide.md`, "# Loading\n\nBefore ![Picture](picture.png) after.\n");
  try {
    let pictureFile = heldResponse();
    await page.route(/\/api\/image\?/, async (route) => {
      await pictureFile.held;
      await route.fallback().catch(() => {});
    });
    const { taskReview, preview } = await openGuidePreview(page, folder);
    const place = preview.locator(".markdown-preview-image");
    const loading = place.locator("caffold-loading-text");

    // Nothing says how large the picture is yet: the phrase reads on the line.
    await expect(loading).toHaveText("Loading image...");
    await expect(place).not.toHaveAttribute("data-reserved");
    const baselines = await place.evaluate((element) => {
      const baselineAt = (insert) => {
        const probe = document.createElement("span");
        probe.style.cssText = "display: inline-block; width: 0; height: 0;";
        insert(probe);
        const bottom = probe.getBoundingClientRect().bottom;
        probe.remove();
        return bottom;
      };
      return {
        line: baselineAt((probe) => element.closest("p").prepend(probe)),
        phrase: baselineAt((probe) => element.querySelector("caffold-loading-text").append(probe)),
      };
    });
    expect(Math.abs(baselines.phrase - baselines.line)).toBeLessThanOrEqual(1);

    pictureFile.letThrough();
    await expectFetchedPicture(preview.locator('img[alt="Picture"]'));

    // Drawn once, the picture's size is known when the Markdown is drawn
    // again: the phrase waits in the middle of the place held for it.
    pictureFile = heldResponse();
    await appendFile(`${folderPath}/guide.md`, "\nOne more line.\n");
    await reportGuideChange(page, folder);
    await expect(preview).toContainText("One more line.");
    await expect(place).toHaveAttribute("data-reserved", "");
    await expect(loading).toHaveText("Loading image...");
    const middles = await place.evaluate((element) => {
      const middle = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      return {
        place: middle(element.getBoundingClientRect()),
        phrase: middle(element.querySelector("caffold-loading-text").getBoundingClientRect()),
      };
    });
    expect(Math.abs(middles.phrase.x - middles.place.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(middles.phrase.y - middles.place.y)).toBeLessThanOrEqual(1);
    pictureFile.letThrough();
    await expectFetchedPicture(preview.locator('img[alt="Picture"]'));
  } finally {
    await rm(folderPath, { recursive: true, force: true });
  }
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
    const rasterRequests = imageRequests(page, rasterName);
    const svgRequests = imageRequests(page, "review-image.svg");
    const { taskScenario, tasksPage, taskReview } =
      await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
    if (testInfo.project.name === "phone") {
      await taskReview.evaluate((review) => review.updateRoute({ viewer: "source" }));
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
    await expect.poll(() => rasterRequests.length).toBe(1);
    await expectFetchedPicture(viewer.locator("img.image-preview"));
    const imageStage = viewer.locator(".image-stage");
    await viewer.locator("img.image-preview").evaluate((image) => {
      image.style.height = "1200px";
      image.style.width = "1200px";
      image.style.maxHeight = "none";
      image.style.maxWidth = "none";
    });
    await expect.poll(() => imageStage.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 1,
    )).toBe(true);
    await expect.poll(() => imageStage.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1,
    )).toBe(true);
    await page.locator(".task-workspace-surface").focus();
    await page.keyboard.press("s");
    const surfaceSelector = page.locator(
      "caffold-scroll-surface-selector > dialog:modal",
    );
    const workspaceHud = page.locator(
      "caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status",
    );
    if (await surfaceSelector.isVisible()) {
      await surfaceSelector.getByLabel(
        new RegExp(`^[A-Z]+ — ${rasterName.replace(".", "\\.")} image$`),
      ).click();
    }
    await expect(workspaceHud).toContainText(`Scroll: ${rasterName} image`);
    await expect(workspaceHud.locator("[data-scroll-mode-shortcut-help]"))
      .toContainText("?");
    await page.keyboard.press("l");
    await expect.poll(() => imageStage.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await page.keyboard.press("j");
    await expect.poll(() => imageStage.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(workspaceHud).toBeHidden();

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
    await expect.poll(() => svgRequests.length).toBe(1);
    await expectFetchedPicture(viewer.locator("img.image-preview"));

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

test("fetches an image again only when the file may have changed", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const imageName = "review-image-address.png";
  const imagePath = repositoryPath("frontend/tests/e2e/fixtures/home/src", imageName);
  const firstModified = new Date(1_700_000_000_000);
  const laterModified = new Date(1_700_000_005_000);
  await copyFile(repositoryPath("frontend/assets/icons/favicon-32.png"), imagePath);
  await utimes(imagePath, firstModified, firstModified);
  try {
    const requests = imageRequests(page, imageName);
    const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
    const navigator = taskReview.locator("caffold-file-navigator");
    const image = taskReview.locator("caffold-review-file-viewer img.image-preview");

    await navigator.locator(`button[data-file-tree-path="src/${imageName}"]`).click();
    await taskReview.getByRole("button", { name: "Preview", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await expectFetchedPicture(image);
    const drawnFirst = await image.getAttribute("src");
    await navigator.locator('button[data-file-tree-path="src/alpha.rs"]').click();
    await expect(image).toHaveCount(0);
    await navigator.locator(`button[data-file-tree-path="src/${imageName}"]`).click();
    await expect.poll(() => requests.length).toBe(2);
    await expectFetchedPicture(image);

    await utimes(imagePath, laterModified, laterModified);
    const drawnBefore = await image.getAttribute("src");
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
    }, `src/${imageName}`);
    await expect.poll(() => requests.length).toBe(3);
    // The file on disk changed, so the server names another version and the
    // picture is drawn from the new copy.
    await expect.poll(() => image.getAttribute("src")).not.toBe(drawnBefore);
    await expectFetchedPicture(image);
    expect(new Set(requests).size, "the image keeps one address").toBe(1);
    expect(drawnFirst).toMatch(/^blob:/);
  } finally {
    await rm(imagePath, { force: true });
  }
});

test("fetches an image once when the file list arrives after it", { tag: "@viewport-independent" }, async ({
  page,
}, testInfo) => {
  // Concurrent tests keep the rows they already have: the picture goes into a
  // directory the file tree keeps collapsed.
  const imageName = `planner/review-image-late-list-${testInfo.project.name}.png`;
  const imagePath = repositoryPath("frontend/tests/e2e/fixtures/home/src", imageName);
  await copyFile(repositoryPath("frontend/assets/icons/favicon-32.png"), imagePath);
  try {
    const requests = imageRequests(page, imageName);
    const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    const listing = heldResponse();
    const status = heldResponse();
    const listingPattern = /\/api\/list\?path=src%2Fplanner(?:&|$)/;
    const statusPattern = /\/api\/git\/status(?:\?|$)/;
    await page.route(listingPattern, async (route) => {
      await listing.held;
      await route.continue();
    });
    await page.route(statusPattern, async (route) => {
      await status.held;
      await route.continue();
    });
    await page.goto(
      `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
        `&file=${encodeURIComponent(imageName)}`,
    );
    await expect.poll(() => requests.length).toBe(1);

    // The viewer fetched the file before the list knew it; the list arrives
    // next, and then the status, whose arrival loads the viewer again.
    const listed = page.waitForResponse(listingPattern);
    listing.letThrough();
    await listed;
    await expect(
      taskReview
        .locator("caffold-file-navigator")
        .locator(`button[data-file-tree-path="src/${imageName}"]`),
    ).toHaveAttribute("aria-current", "true");
    const viewer = taskReview.locator("caffold-review-file-viewer");
    await markShownAgain(viewer, "setImage");
    const statusArrived = page.waitForResponse(statusPattern);
    status.letThrough();
    await statusArrived;
    await expect(viewer).toHaveAttribute("data-shown-again", "");

    await expectFetchedPicture(taskReview.locator("caffold-review-file-viewer img.image-preview"));
    expect(requests).toHaveLength(1);
  } finally {
    await rm(imagePath, { force: true });
  }
});

test("fetches a large image in 64 KB cells, the later ones under its version", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const imageName = "review-image-cells.png";
  const imagePath = repositoryPath("frontend/tests/e2e/fixtures/home/src", imageName);
  await copyFile(repositoryPath("frontend/assets/icons/icon-512.png"), imagePath);
  try {
    const cells = [];
    page.on("response", (response) => {
      const address = new URL(response.url());
      if (
        address.pathname === "/api/image" &&
        address.searchParams.get("path") === `src/${imageName}`
      ) {
        cells.push({
          version: address.searchParams.get("version"),
          range: response.request().headers().range,
          status: response.status(),
          contentRange: response.headers()["content-range"],
        });
      }
    });
    const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
    const image = taskReview.locator("caffold-review-file-viewer img.image-preview");

    await taskReview
      .locator(`caffold-file-navigator button[data-file-tree-path="src/${imageName}"]`)
      .click();
    await taskReview.getByRole("button", { name: "Preview", exact: true }).click();

    await expectFetchedPicture(image);
    expect(await image.evaluate((element) => element.naturalWidth)).toBe(512);
    await expect.poll(() => cells.length).toBe(2);
    expect(cells).toEqual([
      {
        version: null,
        range: "bytes=0-65535",
        status: 206,
        contentRange: "bytes 0-65535/106327",
      },
      {
        version: expect.stringMatching(/^[0-9a-f]+-[0-9a-f]+$/),
        range: "bytes=65536-106326",
        status: 206,
        contentRange: "bytes 65536-106326/106327",
      },
    ]);
  } finally {
    await rm(imagePath, { force: true });
  }
});

test("says an image is loading until it is drawn", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const imageName = "review-image-loading.png";
  const imagePath = repositoryPath("frontend/tests/e2e/fixtures/home/src", imageName);
  await copyFile(repositoryPath("frontend/assets/icons/icon-512.png"), imagePath);
  try {
    let releaseImage;
    const imageGate = new Promise((resolve) => {
      releaseImage = resolve;
    });
    await page.route(/\/api\/image\?/, async (route) => {
      if (new URL(route.request().url()).searchParams.get("path") === `src/${imageName}`) {
        await imageGate;
      }
      return route.fallback();
    });
    const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
    await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
    await taskReview.getByRole("button", { name: "Files", exact: true }).click();
    const viewer = taskReview.locator("caffold-review-file-viewer");
    const image = viewer.locator("img.image-preview");
    const loading = viewer.locator(".image-stage > caffold-loading-text");

    await taskReview
      .locator(`caffold-file-navigator button[data-file-tree-path="src/${imageName}"]`)
      .click();
    await taskReview.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(loading).toHaveText("Loading image...");
    await expect(loading).toBeVisible();
    await expect(image).toBeHidden();

    releaseImage();
    await expectFetchedPicture(image);
    await expect(image).toBeVisible();
    await expect(loading).toHaveCount(0);
  } finally {
    await rm(imagePath, { force: true });
  }
});

// Each request for an image's first cell, the address the viewer asks for;
// later cells add the file's version to that address.
function imageRequests(page, name) {
  const requests = [];
  page.on("request", (request) => {
    const address = new URL(request.url());
    if (
      address.pathname === "/api/image" &&
      address.searchParams.get("path") === `src/${name}` &&
      !address.searchParams.has("version")
    ) {
      requests.push(request.url());
    }
  });
  return requests;
}

// Opens a test's guide.md in Preview. The Working Tree status draws the open
// file again when it arrives, so it is held until the file is drawn and its
// redraw is over before the test goes on.
async function openGuidePreview(page, folder) {
  const { taskScenario, tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const status = heldResponse();
  const statusPattern = /\/api\/git\/status(?:\?|$)/;
  await page.route(statusPattern, async (route) => {
    await status.held;
    await route.continue();
  });
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
      `&file=${encodeURIComponent(`${folder}/guide.md`)}`,
  );
  const preview = taskReview.locator("caffold-review-file-viewer caffold-markdown-preview");
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await markShownAgain(viewer, "setMarkdown");
  const statusArrived = page.waitForResponse(statusPattern);
  status.letThrough();
  await statusArrived;
  await expect(viewer).toHaveAttribute("data-shown-again", "");
  await expect(preview).toHaveAttribute("data-render-state", "markdown");
  return { taskReview, preview };
}

// Marks the viewer once the Review hands it its file again through `method`.
async function markShownAgain(viewer, method) {
  await viewer.evaluate((element, name) => {
    const show = element[name];
    element[name] = function (...args) {
      this.dataset.shownAgain = "";
      return show.apply(this, args);
    };
  }, method);
}

// Tells the Review's open watch on the Task root that a test's guide.md
// changed, and waits for the Review to read the file again.
async function reportGuideChange(page, folder) {
  const logicalPath = `src/${folder}/guide.md`;
  const watchesRoot = () => page.evaluate(() => window.__caffoldMockEventSources.filter(
    (candidate) => candidate.channel === "watch" && candidate.context === "src" && candidate.readyState === 1,
  ).length);
  await expect.poll(watchesRoot).toBeGreaterThan(0);
  const reread = page.waitForResponse((response) => {
    const address = new URL(response.url());
    return address.pathname === "/api/file" && address.searchParams.get("path") === logicalPath;
  });
  await page.evaluate((logicalPath) => {
    window.__caffoldMockEventSources.filter(
      (candidate) => candidate.channel === "watch" && candidate.context === "src" && candidate.readyState === 1,
    ).at(-1).emit("change", {
      revision: 2,
      paths: [logicalPath],
      gitStatusChanged: false,
      gitRefsChanged: false,
      overflow: false,
    });
  }, logicalPath);
  await reread;
}

// A response held back until the test lets it through.
function heldResponse() {
  let letThrough;
  const held = new Promise((resolve) => {
    letThrough = resolve;
  });
  return { held, letThrough };
}

// A picture is drawn from the copy fetched for it, not from its address.
async function expectFetchedPicture(image) {
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
}

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
  await expect(page).toHaveURL("/");
});

test("keeps the open file shown while the next one loads and names a longer wait", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  const { reviewScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const viewer = taskReview.locator("caffold-review-file-viewer");
  const title = viewer.locator(".viewer-title-block h2");
  await changes.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  await expect(viewer.locator("caffold-diff-viewer")).toContainText(
    "new planner behavior",
  );

  // Timers stay still until the test moves them, so the wait cannot end
  // before an answer that the test lets through.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  await viewer.evaluate((element) => {
    window.viewerShowedLoading = false;
    new MutationObserver(() => {
      if (element.querySelector("caffold-loading-text")) {
        window.viewerShowedLoading = true;
      }
    }).observe(element, { childList: true, subtree: true });
  });
  await changes.locator('button[data-file-tree-relative-path="lib.rs"]').click();
  await expect(title).toHaveText("lib.rs");
  expect(
    await page.evaluate(() => window.viewerShowedLoading),
    "a file that arrives within the wait replaces the open one directly",
  ).toBe(false);

  const releaseDiff = reviewScenario.holdDiff();
  try {
    await changes.locator('button[data-file-tree-relative-path="planner.rs"]').click();
    await page.clock.runFor(179);
    await expect(title).toHaveText("lib.rs");
    await expect(viewer.locator("caffold-loading-text")).toHaveCount(0);
    await page.clock.runFor(200);
    await expect(title).toHaveText("planner.rs");
    await expect(viewer.locator("caffold-loading-text")).toHaveText("Loading file...");
    await expect(viewer.locator("caffold-loading-text")).toHaveAttribute("immediate", "");
  } finally {
    releaseDiff();
  }
  await page.clock.resume();
  await expect(viewer.locator("caffold-diff-viewer")).toContainText(
    "new planner behavior",
  );
});

test("the file viewer offers a notice's representation button, and details only for metadata", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const result = await page.evaluate(async () => {
    await import("/assets/components/file-viewer.js");
    const viewer = document.createElement("caffold-review-file-viewer");
    document.body.append(viewer);
    const drawn = () => new Promise(requestAnimationFrame);
    const targets = async () => {
      await drawn();
      return viewer.actionHintScope({
        scopeId: "review:viewer",
        actions: {
          parent: "navigation.parent",
          notice: "navigation.review.axis",
          details: "navigation.file-details.open",
        },
      }).targets.map((target) => [target.id, target.actionId, target.label]);
    };
    const openDetails = async () => {
      viewer.querySelector(".viewer-info-button").click();
      await drawn();
      return viewer.keyboardNavigationContexts({ scopeId: "review:viewer" })
        .map((context) => [context.id, context.actionHints.targets.length]);
    };

    viewer.setNotice("This file is large.", {
      title: "big.md",
      actionLabel: "View rendered preview",
      action: "view-preview",
    });
    const notice = await targets();
    viewer.setNotice("This file could not be read.", {
      title: "big.md",
      actionLabel: "Try again",
      action: "retry",
    });
    const otherNotice = await targets();
    viewer.setDiff({ diff: "" }, {
      presentation: { title: "a.rs", subtitle: "src/a.rs", metadata: [] },
    });
    const bare = await targets();
    const bareDetails = await openDetails();
    viewer.setDiff({ diff: "" }, {
      presentation: {
        title: "a.rs",
        metadata: [{ field: "size", label: "Size", value: "1 KB" }],
      },
    });
    const described = await targets();
    const describedDetails = await openDetails();
    return { notice, otherNotice, bare, bareDetails, described, describedDetails };
  });

  // Beside a file list the viewer has no Back or close button to offer.
  expect(result).toEqual({
    notice: [
      ["review:viewer:notice:view-preview", "navigation.review.axis", "View rendered preview"],
    ],
    otherNotice: [],
    bare: [],
    bareDetails: [],
    described: [
      ["review:viewer:details:open", "navigation.file-details.open", "Show details for a.rs"],
    ],
    describedDetails: [["review:viewer:details", 0]],
  });
});

test("each document preview scrolls as one vertical surface named after its file", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const surfaces = await page.evaluate(async () => {
    await import("/assets/components/file-viewer.js");
    const described = [];
    for (const kind of ["pdf", "docx", "pptx"]) {
      const element = document.createElement(`caffold-${kind}-viewer`);
      element.style.cssText = "display: block; height: 100px; overflow: auto;";
      document.body.append(element);
      await new Promise(requestAnimationFrame);
      described.push(element.scrollSurfaceScope({
        scopeId: `review:viewer:${kind}`,
        label: `report.${kind} preview`,
      }).surfaces.map((surface) => ({
        id: surface.id,
        label: surface.label,
        axes: surface.axes,
        scrollport: surface.scrollport === element,
      })));
      element.hidden = true;
      await new Promise(requestAnimationFrame);
      described.push(element.scrollSurfaceScope({
        scopeId: `review:viewer:${kind}`,
      }).surfaces);
    }
    return described;
  });

  expect(surfaces).toEqual(["pdf", "docx", "pptx"].flatMap((kind) => [
    [{
      id: `review:viewer:${kind}:scroll`,
      label: `report.${kind} preview`,
      axes: ["vertical"],
      scrollport: true,
    }],
    [],
  ]));
});

test("the file viewer scrolls a source file and a notice under the names it shows", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const surfaces = await page.evaluate(async () => {
    await import("/assets/components/file-viewer.js");
    const viewer = document.createElement("caffold-review-file-viewer");
    viewer.style.cssText = "display: block; height: 300px;";
    document.body.append(viewer);
    const described = async () => {
      await new Promise(requestAnimationFrame);
      return viewer.scrollSurfaceScope({ scopeId: "review:viewer" })
        .surfaces.map((surface) => ({
          id: surface.id,
          label: surface.label,
          axes: surface.axes ?? ["vertical"],
          scrollport: surface.scrollport.className,
        }));
    };
    viewer.setFile({ path: "src/PLAN.md", content: "# Plan\nNext" });
    const source = await described();
    viewer.setNotice("This file is large.", { title: "big.bin" });
    const notice = await described();
    return { source, notice };
  });

  expect(surfaces).toEqual({
    source: [{
      id: "review:viewer:source:scroll",
      label: "PLAN.md source",
      axes: ["vertical", "horizontal"],
      scrollport: "code-lines",
    }],
    notice: [{
      id: "review:viewer:notice:scroll",
      label: "big.bin notice",
      axes: ["vertical"],
      scrollport: "viewer-notice-content",
    }],
  });
});
