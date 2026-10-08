import { expect, test } from "@playwright/test";
import { copyFile, rm, writeFile } from "node:fs/promises";

import { repositoryPath } from "../../repository-paths.mjs";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";
import { wordDocument } from "../support/word-document-fixture.js";

// A4 in twentieths of a point, and the CSS pixels docx-preview lays it out at.
const PORTRAIT = { width: 11906, height: 16838 };
const LANDSCAPE = { width: 16838, height: 11906 };
const PORTRAIT_WIDTH = (PORTRAIT.width / 20) * (96 / 72);
const LANDSCAPE_WIDTH = (LANDSCAPE.width / 20) * (96 / 72);
const MARGINS =
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';

// Three portrait pages and a landscape one, marked the way Word saves them: the
// document's own page break and change of section, plus Word's mark on the
// first line of each page it laid out, one of them inside a table that runs
// onto another page. The first page links out with a script URL, links to a
// bookmark on the second, and embeds HTML whose script would mark the window if
// it ever ran.
const TABLE_CELL = '<w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>';
const REVIEW_DOCUMENT = {
  body: `
    <w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rIdReport"><w:r><w:t>External report</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink w:anchor="appendix"><w:r><w:t>Jump to the appendix</w:t></w:r></w:hyperlink></w:p>
    <w:altChunk r:id="rIdEmbedded"/>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:bookmarkStart w:id="0" w:name="appendix"/><w:r><w:lastRenderedPageBreak/><w:t>Appendix</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>
      <w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>
      <w:tr><w:tc>${TABLE_CELL}<w:p><w:r><w:t>Table start</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc>${TABLE_CELL}<w:p><w:r><w:lastRenderedPageBreak/><w:t>Table continues</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:lastRenderedPageBreak/><w:t>Appendix notes</w:t></w:r></w:p>
    <w:p><w:pPr><w:sectPr>
      <w:pgSz w:w="${PORTRAIT.width}" w:h="${PORTRAIT.height}"/>${MARGINS}
    </w:sectPr></w:pPr></w:p>
    <w:p><w:r><w:lastRenderedPageBreak/><w:t>Wide schedule</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="${LANDSCAPE.width}" w:h="${LANDSCAPE.height}" w:orient="landscape"/>${MARGINS}
    </w:sectPr>
  `,
  relationships: [
    {
      id: "rIdReport",
      type: "hyperlink",
      target: "javascript:window.__docxLinkRan = true",
      external: true,
    },
    { id: "rIdEmbedded", type: "aFChunk", target: "embedded.html" },
  ],
  parts: {
    "word/embedded.html":
      "<html><body><p>Embedded table</p>" +
      "<script>parent.__docxEmbeddedHtmlRan = true;</script></body></html>",
  },
};

const PDF_FIXTURE = repositoryPath(
  "frontend/tests/e2e/fixtures",
  "review-document.pdf",
);

// Every project reviews the same workspace at once, so each test writes its
// documents under names unique to it, inside a directory the file tree keeps
// collapsed.
const DOCUMENT_DIRECTORY = "planner";

function documentName(testInfo, suffix = "", extension = "docx") {
  return `review-document${suffix}-${testInfo.testId}-${testInfo.repeatEachIndex}.${extension}`;
}

function documentRoute(testInfo, suffix, extension) {
  return `${DOCUMENT_DIRECTORY}/${documentName(testInfo, suffix, extension)}`;
}

function documentPath(testInfo, suffix, extension) {
  return repositoryPath(
    `frontend/tests/e2e/fixtures/home/src/${DOCUMENT_DIRECTORY}`,
    documentName(testInfo, suffix, extension),
  );
}

function documentRequests(page, testInfo, suffix = "") {
  const pattern = new RegExp(
    `/api/docx\\?path=${encodeURIComponent(`src/${documentRoute(testInfo, suffix)}`)
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

async function writeDocument(testInfo, suffix, document = REVIEW_DOCUMENT) {
  await writeFile(documentPath(testInfo, suffix), await wordDocument(document));
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

function navigatorFile(taskReview, testInfo, suffix, extension) {
  return taskReview
    .locator("caffold-file-navigator")
    .locator(
      `button[data-file-tree-path="src/${documentRoute(testInfo, suffix, extension)}"]`,
    );
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBrowserDefaults(page);
  await writeDocument(testInfo);
});

test.afterEach(async ({}, testInfo) => {
  await rm(documentPath(testInfo), { force: true });
});

test("renders a Word document as the only representation its file supports", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  // A Word document has no source text, so a Source route normalizes to
  // Preview.
  const { taskScenario, taskReview } = await openDocument(page, testInfo, "source");
  await expect(page).toHaveURL(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=preview` +
      `&file=${encodeURIComponent(documentRoute(testInfo))}`,
  );
  await expect(taskReview.getByRole("button", { name: "Source", exact: true }))
    .toBeHidden();
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const viewer = taskReview.locator("caffold-docx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "docx");
  const pages = viewer.locator("section.docx");
  await expect(pages).toHaveCount(4);
  await expect(viewer.getByText("Quarterly review")).toBeVisible();

  // Each page keeps the width its section declares when the viewer has room,
  // and zooms down to the viewer's width when it does not.
  const available = await viewer.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
  });
  const widths = await pages.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width));
  for (const [index, declared] of [
    PORTRAIT_WIDTH,
    PORTRAIT_WIDTH,
    PORTRAIT_WIDTH,
    LANDSCAPE_WIDTH,
  ].entries()) {
    expect(Math.abs(widths[index] - Math.min(declared, available)))
      .toBeLessThanOrEqual(1);
  }
  const overflow = await viewer.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // The document's styles stay in its shadow root, and the app's stylesheet
  // does not reach the document.
  const leakedRules = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) =>
          rule.cssText.includes("docx-wrapper"));
      } catch {
        // A cross-origin sheet hides its rules, and none of them is the
        // document's.
        return false;
      }
    }));
  expect(leakedRules).toBe(false);
  await expect(viewer.getByText("Quarterly review"))
    .toHaveCSS("box-sizing", "content-box");

  await captureReviewScreenshot(page, testInfo, "tasks-docx-preview");
});

test("shows a document's text without its links or embedded HTML", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-docx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "docx");

  await expect(viewer.getByText("External report")).toBeVisible();
  await expect(viewer.getByText("Jump to the appendix")).toBeVisible();
  await expect(viewer.locator("a")).toHaveCount(0);

  await expect(
    viewer.getByText("Embedded HTML content is not shown in this preview."),
  ).toBeVisible();
  await expect(viewer.locator("iframe")).toHaveCount(0);
  await expect(viewer.getByText("Embedded table")).toHaveCount(0);
  expect(await page.evaluate(() => window.__docxEmbeddedHtmlRan)).toBeUndefined();
});

test("splits pages where Word last broke them, without an empty page after a page break", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openDocument(page, testInfo);
  const viewer = taskReview.locator("caffold-docx-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "docx");

  // Word's marks after the page break and at the change to landscape repeat a
  // break the document already makes, and the mark inside the table does not
  // split it.
  const pages = viewer.locator("section.docx");
  await expect(pages).toHaveCount(4);
  await expect(pages.nth(0)).toContainText("Quarterly review");
  await expect(pages.nth(1)).toContainText("Appendix");
  await expect(pages.nth(1)).toContainText("Table continues");
  await expect(pages.nth(1)).not.toContainText("Appendix notes");
  await expect(pages.nth(2)).toContainText("Appendix notes");
  await expect(pages.nth(3)).toContainText("Wide schedule");
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
  const viewer = taskReview.locator("caffold-docx-viewer");
  await expect(viewer.getByText("Quarterly review")).toBeVisible();
  // The refresh below reports a change only to a file the navigator has listed
  // and selected.
  await expect(navigatorFile(taskReview, testInfo))
    .toHaveAttribute("aria-current", "true");
  expect(requests).toHaveLength(1);

  await writeDocument(testInfo, "", {
    body: "<w:p><w:r><w:t>Revised review</w:t></w:r></w:p>",
  });
  const reread = page.waitForRequest(pattern);
  // Re-listing the directory is what publishes the new modification time, so
  // the refresh has to cover the directories the navigator already loaded.
  await taskReview
    .locator("caffold-file-navigator")
    .evaluate((navigator) =>
      navigator.requestRefresh({ selected: true, allDirectories: true }));
  await reread;

  await expect(viewer.getByText("Revised review")).toBeVisible();
  await expect(viewer.getByText("Quarterly review")).toHaveCount(0);
  expect(requests).toHaveLength(2);
});

test("reads the newly selected Word document into the retained panel", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const first = documentRequests(page, testInfo);
  const second = documentRequests(page, testInfo, "-second");
  const reads = [];
  page.on("request", (request) => {
    if (first.pattern.test(request.url())) {
      reads.push("first");
    } else if (second.pattern.test(request.url())) {
      reads.push("second");
    }
  });
  await writeDocument(testInfo, "-second", {
    body: "<w:p><w:r><w:t>Second document</w:t></w:r></w:p>",
  });
  try {
    const { taskReview } = await openDocument(page, testInfo);
    const viewer = taskReview.locator("caffold-docx-viewer");
    await expect(viewer.getByText("Quarterly review")).toBeVisible();
    await viewer.evaluate((element) => {
      element.dataset.retainedViewer = "true";
    });

    await navigatorFile(taskReview, testInfo, "-second").click();

    // The panel is reused across the selection, so the component itself has to
    // replace the document it holds.
    await expect(viewer.getByText("Second document")).toBeVisible();
    await expect(viewer).toHaveAttribute("data-retained-viewer", "true");

    // The first document is read again if its modification time arrives after
    // it opened, so only the reads from the selection on are fixed: a viewer
    // load can read the first document only while it is selected, and the
    // second, chosen from a listing that knows its modification time, once.
    const selectedAt = reads.indexOf("second");
    expect(reads[0]).toBe("first");
    expect(reads.slice(selectedAt)).toEqual(["second"]);
  } finally {
    await rm(documentPath(testInfo, "-second"), { force: true });
  }
});

test("switches the document panel between a Word document and a PDF", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  await copyFile(PDF_FIXTURE, documentPath(testInfo, "-pdf", "pdf"));
  try {
    const { taskReview } = await openDocument(page, testInfo);
    const wordViewer = taskReview.locator("caffold-docx-viewer");
    const pdfViewer = taskReview.locator("caffold-pdf-viewer");
    await expect(wordViewer).toHaveAttribute("data-render-state", "docx");

    await navigatorFile(taskReview, testInfo, "-pdf", "pdf").click();
    await expect(pdfViewer).toHaveAttribute("data-render-state", "pdf");
    await expect(wordViewer).toHaveCount(0);

    await navigatorFile(taskReview, testInfo).click();
    await expect(wordViewer).toHaveAttribute("data-render-state", "docx");
    await expect(pdfViewer).toHaveCount(0);
    await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  } finally {
    await rm(documentPath(testInfo, "-pdf", "pdf"), { force: true });
  }
});

test("reports an unavailable document without replacing the review surface", { tag: "@desktop" }, async ({
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
  const viewer = taskReview.locator("caffold-docx-viewer");

  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(viewer).toContainText("This document could not be displayed.");
  await expect(taskReview.getByRole("button", { name: "Preview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});
