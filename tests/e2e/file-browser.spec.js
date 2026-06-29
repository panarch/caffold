import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const LAST_DIRECTORY_KEY = `codger:last-directory-path:${resolve("tests/fixtures/home")}`;

test.beforeEach(async ({ page }) => {
  await page.route("https://esm.sh/**", (route) => {
    if (route.request().url() !== "https://esm.sh/lucide@1.22.0") {
      return route.abort();
    }

    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export const File = [["path", { d: "M6 3h8l4 4v14H6z" }]];
        export const FileArchive = File;
        export const FileCode = [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "m10 9-3 3 3 3" }], ["path", { d: "m14 9 3 3-3 3" }]];
        export const FileCog = File;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [["path", { d: "M6 3h12v18H6z" }], ["path", { d: "M9 8h6" }], ["path", { d: "M9 12h6" }]];
        export const Folder = [["path", { d: "M3 6h7l2 2h9v10H3z" }]];
        export const FolderGit2 = Folder;
        export const FolderOpen = Folder;
        export const FolderSymlink = Folder;
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];

        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            ...attrs,
          };
          for (const [name, value] of Object.entries(baseAttrs)) {
            svg.setAttribute(name, String(value));
          }
          for (const [tag, childAttrs] of iconNode) {
            const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [name, value] of Object.entries(childAttrs)) {
              child.setAttribute(name, String(value));
            }
            svg.appendChild(child);
          }
          return svg;
        }
      `,
    });
  });
});

test("delays file list loading feedback", async ({ page }) => {
  let resolveListRequest;
  let releaseListResponse;
  const listRequested = new Promise((resolve) => {
    resolveListRequest = resolve;
  });
  const listReleased = new Promise((resolve) => {
    releaseListResponse = resolve;
  });

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    resolveListRequest();
    await listReleased;
    await route.continue();
  });

  await page.goto("/");
  await listRequested;

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await page.waitForTimeout(120);
  await expect(page.getByText("Loading files...")).toHaveCount(0);

  await page.waitForTimeout(90);
  await expect(page.getByText("Loading files...")).toBeVisible();

  releaseListResponse();
  await expect(page.locator("codger-file-list")).toContainText("src");
});

test("browses directories and opens a source file", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("codger-file-list")).toContainText(".codger-hidden");
  await expect(page.locator("codger-file-list")).toContainText("src");
  await expect(page.locator('button[data-entry-path="src"] .entry-icon')).toHaveAttribute(
    "title",
    "Git repository",
  );
  await expect(page.locator('button[data-entry-path=".codger-hidden"]')).toHaveClass(
    /is-hidden/,
  );
  await expect(page.locator(".parent-entry")).toHaveCount(0);

  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator(".parent-entry")).toBeVisible();
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();
  await expect(page.locator("codger-file-list .git-summary")).toHaveClass(/is-dirty/);
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toHaveCount(0);

  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.getByText("Loading file...")).toHaveCount(0);
  await expect(page.locator("codger-file-viewer")).toContainText("example.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("pub fn sample");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expect(page.locator(".entry-icon-svg").first()).toBeVisible();
  await expectGlobalScrollLocked(page);
  await expectPanelScrollContainers(page);
  await page.locator('button[data-entry-path="src/planner"]').click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.locator('button[data-entry-path="src/planner/mod.rs"]').click();
  await expect(page.locator("codger-file-viewer")).toContainText("mod.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("plan_review");
  await expect(page.locator(".line-number").first()).toHaveText("1");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "file-browser");
});

test("keeps the toggled tree row anchored while expanding", async ({ page }) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      codger-file-list .file-list {
        max-height: 150px;
      }
    `,
  });

  await page.locator('button[data-entry-path="src"]').click();
  const planner = page.locator('button[data-entry-path="src/planner"]');
  await expect(planner).toBeVisible();

  const beforeTop = await planner.evaluate((element) => {
    const scroller = element.closest(".file-list");
    scroller.scrollTop = 0;
    return element.getBoundingClientRect().top;
  });

  await planner.click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.waitForTimeout(50);

  const afterTop = await planner.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
});

test("opens changed files and diffs from the Git panel", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const gitButton = page.locator("codger-pathbar .git-panel-button");
  await expect(gitButton).toBeVisible();
  await expect(gitButton.locator(".git-count")).not.toHaveText("");

  await gitButton.click();
  await expect(page.locator("codger-git-panel")).toContainText("Untracked");
  await expect(page.locator("codger-git-panel")).toContainText("example.rs");

  const exampleChange = page
    .locator("codger-git-panel .git-change-section li")
    .filter({ hasText: "example.rs" })
    .first();

  await exampleChange.locator(".git-file-path").click();
  await expect(page.locator("codger-file-viewer")).toContainText("example.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("pub fn sample");

  await gitButton.click();
  await exampleChange.locator(".git-diff-button").click();
  await expect(page.locator("codger-file-viewer")).toContainText("example.rs");
  await expect(page.locator("codger-code-viewer")).toContainText("+++");
  await expect(page.locator("codger-code-viewer")).toContainText("pub fn sample");
});

test("restores the last opened directory after reload", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();

  await page.reload();
  await expect(page.locator("codger-pathbar")).toContainText("src");
  await expect(page.locator("codger-file-list .git-summary")).toBeVisible();
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "src",
  );
});

test("falls back when the stored directory no longer opens", async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(key, "missing-directory");
    },
    [LAST_DIRECTORY_KEY],
  );

  await page.goto("/");
  await expect(page.locator("codger-file-list")).toContainText("src");
  await expect(page.locator(".parent-entry")).toHaveCount(0);
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "",
  );
});

test("extends the line-number gutter for short files", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("codger-file-viewer")).toContainText("README.md");
  await expect(page.locator("codger-code-viewer")).toContainText("Fixture Home");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "short-file-gutter");
});

async function captureReviewScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach(`${name}-${testInfo.project.name}`, {
    path,
    contentType: "image/png",
  });
}

async function expectGlobalScrollLocked(page) {
  const scrollState = await page.evaluate(() => {
    const element = document.scrollingElement;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflow: window.getComputedStyle(document.body).overflow,
    };
  });

  expect(scrollState.overflow).toBe("hidden");
  expect(scrollState.scrollHeight).toBe(scrollState.clientHeight);
}

async function expectPanelScrollContainers(page) {
  const scrollState = await page.evaluate(() => {
    const fileList = document.querySelector(".file-list");
    const codeLines = document.querySelector(".code-lines");

    return {
      fileList: {
        clientHeight: fileList.clientHeight,
        scrollHeight: fileList.scrollHeight,
        overflowY: window.getComputedStyle(fileList).overflowY,
      },
      codeLines: {
        clientHeight: codeLines.clientHeight,
        scrollHeight: codeLines.scrollHeight,
        overflowY: window.getComputedStyle(codeLines).overflowY,
      },
    };
  });

  expect(scrollState.fileList.overflowY).toBe("auto");
  expect(scrollState.codeLines.overflowY).toBe("auto");
  expect(scrollState.codeLines.scrollHeight).toBeGreaterThan(scrollState.codeLines.clientHeight);
}

async function stabilizeDynamicText(page) {
  await page.addStyleTag({
    content: `
      [data-field="modified"] dd {
        color: transparent !important;
        font-size: 0 !important;
      }

      [data-field="modified"] dd::after {
        content: "fixture time";
        color: var(--text);
        font-size: 0.8rem;
      }
    `,
  });
}
