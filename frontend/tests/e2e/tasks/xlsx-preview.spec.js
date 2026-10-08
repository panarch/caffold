import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";

import { repositoryPath } from "../../repository-paths.mjs";
import {
  activateActionHint,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import {
  cellRow,
  columnName,
  spreadsheetWorkbook,
} from "../../support/spreadsheet-fixture.js";

// Style 1 is a bold header on a filled background with a red bottom border;
// style 2 centers its text inside a red left border.
const STYLES = `
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFFF0000"/></bottom><diagonal/></border>
    <border><left style="medium"><color rgb="FFFF0000"/></left><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center"/>
    </xf>
  </cellXfs>`;

function text(reference, value, style) {
  return `<c r="${reference}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t>${value}</t></is></c>`;
}

// The header row and the first column are frozen. Column B is wide, column F
// and row 3 are hidden, and D2:E2 is one merged cell. B2 and B4 link out of
// the workbook, B5 to a script URL, and D4 to a cell of another sheet.
const SUMMARY = {
  name: "Summary",
  body: `
    <sheetViews><sheetView workbookViewId="0">
      <pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>
    </sheetView></sheetViews>
    <cols>
      <col min="2" max="2" width="20" customWidth="1"/>
      <col min="6" max="6" width="9" hidden="1"/>
    </cols>
    <sheetData>
      <row r="1">
        ${["Region", "Owner", "Budget", "Notes", "More"].map((value, index) =>
          text(`${columnName(index)}1`, value, 1)).join("")}
      </row>
      <row r="2">
        ${text("A2", "North")}${text("B2", "Report")}<c r="C2"><v>1200</v></c>
        ${text("D2", "Merged note", 2)}${text("F2", "Hidden column")}
      </row>
      <row r="3" hidden="1">${text("A3", "Hidden row")}</row>
      <row r="4">${text("A4", "South")}${text("B4", "Team")}<c r="C4"><v>950</v></c>${text("D4", "Jump")}</row>
      <row r="5">${text("A5", "West")}${text("B5", "Unsafe")}<c r="C5"><v>400</v></c></row>
    </sheetData>
    <mergeCells count="1"><mergeCell ref="D2:E2"/></mergeCells>`,
  links: {
    B2: "https://example.com/report",
    B4: "mailto:team@example.com",
    B5: "javascript:window.__xlsxLinkRan = true",
    D4: "#Ledger!A1",
  },
};

const LEDGER_ROWS = 1500;
const LEDGER_COLUMNS = 30;

function ledger(firstCell = "R1C1") {
  const rows = [];
  for (let row = 1; row <= LEDGER_ROWS; row += 1) {
    const values = [];
    for (let column = 1; column <= LEDGER_COLUMNS; column += 1) {
      values.push(row === 1 && column === 1 ? firstCell : `R${row}C${column}`);
    }
    rows.push(cellRow(row, values));
  }
  return { name: "Ledger", body: `<sheetData>${rows.join("")}</sheetData>` };
}

function reviewWorkbook({ firstLedgerCell } = {}) {
  return spreadsheetWorkbook({
    styles: STYLES,
    sheets: [
      SUMMARY,
      {
        name: "Hidden",
        hidden: true,
        body: `<sheetData><row r="1">${text("A1", "Secret")}</row></sheetData>`,
      },
      ledger(firstLedgerCell),
    ],
  });
}

// Every project reviews the same workspace at once, so each test writes its
// workbook under a name unique to it, inside a directory the file tree keeps
// collapsed.
const DOCUMENT_DIRECTORY = "planner";

function documentName(testInfo) {
  return `review-workbook-${testInfo.testId}-${testInfo.repeatEachIndex}.xlsx`;
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

async function openDocument(page, testInfo, view = "preview", { beforeOpen } = {}) {
  const { taskScenario, tasksPage, taskReview } =
    await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await beforeOpen?.();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=${view}` +
      `&file=${encodeURIComponent(documentRoute(testInfo))}`,
  );
  return { taskScenario, taskReview };
}

function sheetTab(viewer, name) {
  return viewer.locator(".xlsx-viewer-tabs").getByRole("button", { name, exact: true });
}

// The rectangle of a drawn cell or header, relative to the sheet's scrollport.
function placement(viewer, locator) {
  return locator.evaluate((element) => {
    const port = element.closest(".xlsx-viewer-sheet").getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      top: Math.round(box.top - port.top),
      left: Math.round(box.left - port.left),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  await writeFile(documentPath(testInfo), await reviewWorkbook());
});

test.afterEach(async ({}, testInfo) => {
  await rm(documentPath(testInfo), { force: true });
});

test("renders an Excel workbook as the only representation its file supports", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  // A workbook has no source text, so a Source route normalizes to Preview.
  const { taskScenario, taskReview } = await openDocument(page, testInfo, "source");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
      `&file=${encodeURIComponent(documentRoute(testInfo))}`,
  );
  await expect(taskReview.getByRole("button", { name: "Source", exact: true }))
    .toBeHidden();
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "xlsx");
  await expect(viewer.getByText("Region", { exact: true })).toBeVisible();
  await expect(viewer.locator(".xlsx-viewer-header", { hasText: /^B$/ })).toBeVisible();
  await expect(viewer.locator(".xlsx-viewer-header", { hasText: /^2$/ })).toBeVisible();

  // The hidden sheet has no tab; the first visible sheet opens.
  await expect(sheetTab(viewer, "Summary")).toHaveAttribute("aria-pressed", "true");
  await expect(sheetTab(viewer, "Ledger")).toHaveAttribute("aria-pressed", "false");
  await expect(sheetTab(viewer, "Hidden")).toHaveCount(0);

  // The sheet scrolls inside the viewer, which never widens the review.
  const overflow = await viewer.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await captureReviewScreenshot(page, testInfo, "tasks-xlsx-preview");
});

test("draws the workbook's sizes, merges, hidden tracks, and formatting", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "xlsx");

  // Column B is 20 Calibri digits wide, and D2:E2 spans two default columns.
  const owner = await placement(viewer, viewer.locator(".xlsx-viewer-cell", { hasText: "Report" }));
  expect(owner.width).toBe(140);
  const merged = await placement(viewer, viewer.locator(".xlsx-viewer-cell", { hasText: "Merged note" }));
  expect(merged.width).toBe(128);
  await expect(viewer.locator(".xlsx-viewer-cell", { hasText: "Merged note" }))
    .toHaveCSS("justify-content", "center");
  await expect(viewer.locator(".xlsx-viewer-cell", { hasText: "Merged note" }))
    .toHaveCSS("border-left", "2px solid rgb(255, 0, 0)");

  // A hidden row and column take no space and draw nothing.
  await expect(viewer.getByText("Hidden row")).toHaveCount(0);
  await expect(viewer.getByText("Hidden column")).toHaveCount(0);
  await expect(viewer.locator(".xlsx-viewer-header", { hasText: /^3$/ })).toHaveCount(0);
  await expect(viewer.locator(".xlsx-viewer-header", { hasText: /^F$/ })).toHaveCount(0);
  const northBox = await placement(viewer, viewer.locator(".xlsx-viewer-cell", { hasText: "North" }));
  const southBox = await placement(viewer, viewer.locator(".xlsx-viewer-cell", { hasText: "South" }));
  expect(southBox.top - northBox.top).toBe(northBox.height);

  const header = viewer.locator(".xlsx-viewer-cell", { hasText: "Region" });
  await expect(header).toHaveCSS("font-weight", "700");
  await expect(header).toHaveCSS("background-color", "rgb(221, 235, 247)");
  await expect(header).toHaveCSS("border-bottom", "1px solid rgb(255, 0, 0)");

  // A number left to General alignment sits at the end of its cell.
  await expect(viewer.locator(".xlsx-viewer-cell", { hasText: "1200" }))
    .toHaveCSS("justify-content", "end");

  // The sheet stays paper in the dark theme; its headers follow the theme.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const north = viewer.locator(".xlsx-viewer-cell", { hasText: "North" });
  await expect(north).toHaveCSS("color", "rgb(0, 0, 0)");
  expect(await north.evaluate((element) =>
    getComputedStyle(element.closest(".xlsx-viewer-block")).backgroundColor))
    .toBe("rgb(255, 255, 255)");
  await expect(viewer.locator(".xlsx-viewer-header", { hasText: /^B$/ }))
    .not.toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("keeps the headers and frozen panes in place while the sheet scrolls", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "xlsx");
  await sheetTab(viewer, "Ledger").click();
  await expect(viewer.getByText("R1C1", { exact: true })).toBeVisible();

  // The Ledger has no frozen panes, so its headers alone stay; Summary's
  // frozen header row and first column are checked after it.
  const sheet = viewer.locator(".xlsx-viewer-sheet");
  const columnHeader = viewer.locator(".xlsx-viewer-header", { hasText: /^C$/ });
  const firstCell = viewer.getByText("R1C1", { exact: true });
  const before = await placement(viewer, columnHeader);
  const cellBefore = await placement(viewer, firstCell);
  await sheet.evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect.poll(async () => (await placement(viewer, firstCell)).top)
    .toBe(cellBefore.top - 400);
  expect(await placement(viewer, columnHeader)).toEqual(before);

  await sheetTab(viewer, "Summary").click();
  await expect(viewer.getByText("Region", { exact: true })).toBeVisible();
  const frozenHeader = viewer.locator(".xlsx-viewer-cell", { hasText: "Owner" });
  const frozenColumn = viewer.locator(".xlsx-viewer-cell", { hasText: "North" });
  const headerBefore = await placement(viewer, frozenHeader);
  const columnBefore = await placement(viewer, frozenColumn);
  // The sheet is too small to scroll, so the scrollport is narrowed to make
  // it.
  await sheet.evaluate((element) => {
    element.style.width = "160px";
    element.style.height = "70px";
  });
  await sheet.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => sheet.evaluate((element) => element.scrollLeft > 0 && element.scrollTop > 0))
    .toBe(true);
  expect((await placement(viewer, frozenHeader)).top).toBe(headerBefore.top);
  expect((await placement(viewer, frozenColumn)).left).toBe(columnBefore.left);
});

test("draws only the cells near the viewport of a large sheet", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "xlsx");
  const rowHeaderWidth = () => placement(
    viewer,
    viewer.locator(".xlsx-viewer-corner > .xlsx-viewer-header").first(),
  ).then(({ width }) => width);
  const summaryRowHeader = await rowHeaderWidth();
  await sheetTab(viewer, "Ledger").click();
  await expect(viewer.getByText("R1C1", { exact: true })).toBeVisible();
  // The row numbers' column widens for a sheet with more digits in them.
  expect(await rowHeaderWidth()).toBeGreaterThan(summaryRowHeader);

  const drawnCells = viewer.locator(".xlsx-viewer-main .xlsx-viewer-cell");
  const drawn = await drawnCells.count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan((LEDGER_ROWS * LEDGER_COLUMNS) / 10);
  await expect(viewer.getByText(`R${LEDGER_ROWS}C1`, { exact: true })).toHaveCount(0);

  // The sheet keeps every row's height, so its end is a scroll away.
  await viewer.locator(".xlsx-viewer-sheet").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(viewer.getByText(`R${LEDGER_ROWS}C1`, { exact: true })).toBeVisible();
  await expect(viewer.getByText("R1C1", { exact: true })).toHaveCount(0);
  const lastRowNumber = viewer.locator(".xlsx-viewer-header", {
    hasText: new RegExp(`^${LEDGER_ROWS}$`),
  });
  await expect(lastRowNumber).toBeVisible();
  expect(await lastRowNumber.evaluate((element) => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return text.getBoundingClientRect().width <= element.clientWidth;
  })).toBe(true);
});

test("switches sheets with the tabs and keeps the sheet when its file changes", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo, "preview", {
    // When the working-tree status arrives it reloads the viewer, which reads
    // the workbook again if the navigator has listed it by then.
    beforeOpen: () => page.route(/\/api\/git\/status(?:\?|$)/, () => {}),
  });
  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer.getByText("Region", { exact: true })).toBeVisible();

  await activateActionHint(page, "Show sheet Ledger");
  await expect(sheetTab(viewer, "Ledger")).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.getByText("R1C1", { exact: true })).toBeVisible();
  await expect(viewer.getByText("Region", { exact: true })).toHaveCount(0);
  await waitForActionHintTarget(page, "Show sheet Summary");

  // The refresh below reports a change only to a file the navigator has listed
  // and selected.
  await expect(
    taskReview
      .locator("caffold-file-navigator")
      .locator(`button[data-file-tree-path="src/${documentRoute(testInfo)}"]`),
  ).toHaveAttribute("aria-current", "true");
  await writeFile(documentPath(testInfo), await reviewWorkbook({ firstLedgerCell: "Revised" }));
  await taskReview
    .locator("caffold-file-navigator")
    .evaluate((navigator) =>
      navigator.requestRefresh({ selected: true, allDirectories: true }));

  await expect(viewer.getByText("Revised", { exact: true })).toBeVisible();
  await expect(sheetTab(viewer, "Ledger")).toHaveAttribute("aria-pressed", "true");
});

test("links a cell only to a web or mail address", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-xlsx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "xlsx");

  const report = viewer.getByRole("link", { name: "Report" });
  await expect(report).toHaveAttribute("href", "https://example.com/report");
  await expect(report).toHaveAttribute("target", "_blank");
  await expect(viewer.getByRole("link", { name: "Team" }))
    .toHaveAttribute("href", "mailto:team@example.com");
  await expect(viewer.locator("a")).toHaveCount(2);
  await expect(viewer.getByText("Jump", { exact: true })).toBeVisible();
  await expect(viewer.getByText("Unsafe", { exact: true })).toBeVisible();

  await waitForActionHintTarget(page, "Open Report in a new tab");
  await waitForActionHintTarget(page, "Open Team in an email app");
  expect(await page.evaluate(() => window.__xlsxLinkRan)).toBeUndefined();
});

test("reports an unavailable workbook without replacing the review surface", { tag: "@desktop" }, async ({
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
  const viewer = taskReview.locator("caffold-xlsx-viewer");

  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(viewer).toContainText("This document could not be displayed.");
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});
