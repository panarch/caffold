import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  openCompletedTaskForReview,
  selectTaskReviewScope,
} from "../support/task-review-test.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

// planner.rs as Source shows it: eight lines, the last without a newline.
const SOURCE = [
  "fn plan() {",
  "    let added = 1;",
  "    let also = 2;",
  "    keep();",
  "    keep_more();",
  "    replaced();",
  `    let wide = "${"wide ".repeat(80)}";`,
  "}",
].join("\n");

// Lines 2-3 added, line 6 replaced, and lines removed before line 1 and
// after the last line.
const CHANGES = { added: [[2, 3], [6, 6]], removedAfter: [0, 5, 8] };

test("marks added lines and removed places beside the Source line numbers", { tag: "@server-steady" }, async ({
  page,
}) => {
  await serveSource(page, CHANGES);
  const viewer = await openSource(page);

  const rows = await viewer.locator("caffold-code-viewer .code-row").evaluateAll(
    (elements) =>
      elements.map((row) => [
        Number(row.dataset.lineNumber),
        row.dataset.lineChange ?? null,
        row.dataset.lineRemoved ?? null,
      ]),
  );
  expect(rows).toEqual([
    [1, null, "above"],
    [2, "added", null],
    [3, "added", null],
    [4, null, null],
    [5, null, null],
    [6, "added", "above"],
    [7, null, null],
    [8, null, "below"],
  ]);

  const look = await readMarkLook(viewer);
  expect(look.added.background).toBe(look.tokens.addedBackground);
  expect(look.added.color).toBe(look.tokens.addedText);
  expect(look.added.codeBackground).toBe(look.plain.codeBackground);
  expect(look.plain.background).toBe(look.tokens.gutter);
  expect(look.plain.rule).toBe("none");
  // A removal rule lies across the boundary it marks, 1px into each row,
  // and leaves every row as tall as the others. Above the first row it
  // stays inside that row.
  for (const rule of [look.between, look.first, look.last]) {
    expect(rule.position).toBe("absolute");
    expect(rule.height).toBe(2);
    expect(rule.color).toBe(look.tokens.removedRule);
  }
  expect(look.between.center).toBeCloseTo(look.between.boundary, 1);
  expect(look.last.center).toBeCloseTo(look.last.boundary, 1);
  expect(look.first.center).toBeCloseTo(look.first.boundary + 1, 1);
  expect(new Set(look.rowHeights).size).toBe(1);

  // The numbers stay at the left edge, marks and all, while the code
  // scrolls sideways.
  const scroller = viewer.locator("caffold-code-viewer .code-lines");
  const addedNumber = viewer.locator(
    'caffold-code-viewer .code-row[data-line-number="2"] .line-number',
  );
  const left = (await addedNumber.boundingBox()).x;
  await scroller.evaluate((element) => {
    element.scrollLeft = 300;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(300);
  expect((await addedNumber.boundingBox()).x).toBe(left);
  expect((await readMarkLook(viewer)).added.background).toBe(look.tokens.addedBackground);
});

test("wraps Source with each mark across the whole of a wrapped line", { tag: "@server-steady" }, async ({
  page,
}) => {
  // The wide line 7 is added, and lines were removed after it.
  await serveSource(page, { added: [[7, 7]], removedAfter: [7] });
  const viewer = await openSource(page);
  await viewer.getByRole("button", { name: "Wrap code lines" }).click();
  const codeViewer = viewer.locator("caffold-code-viewer");
  await expect(codeViewer).toHaveAttribute("wrap", "");

  const look = await codeViewer.evaluate((element) => {
    const root = element.shadowRoot;
    const row = (line) => root.querySelector(`.code-row[data-line-number="${line}"]`);
    const scroller = root.querySelector(".code-lines");
    const wide = row(7).getBoundingClientRect();
    const number = row(7).querySelector(".line-number");
    const below = row(8).querySelector(".line-number");
    const rule = getComputedStyle(below, "::before");
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--diff-added-bg)";
    root.append(probe);
    const addedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      overflows: scroller.scrollWidth > scroller.clientWidth,
      plainHeight: row(1).getBoundingClientRect().height,
      wideHeight: wide.height,
      numberHeight: number.getBoundingClientRect().height,
      numberBackground: getComputedStyle(number).backgroundColor,
      addedBackground,
      ruleCenter:
        below.getBoundingClientRect().top +
        Number.parseFloat(rule.top) +
        Number.parseFloat(rule.height) / 2,
      wideBottom: wide.bottom,
    };
  });
  expect(look.overflows).toBe(false);
  expect(look.wideHeight).toBeGreaterThan(look.plainHeight * 2);
  expect(look.numberHeight).toBe(look.wideHeight);
  expect(look.numberBackground).toBe(look.addedBackground);
  expect(look.ruleCenter).toBeCloseTo(look.wideBottom, 1);
});

test("reads Source against the base of the scope it is in", { tag: "@server-steady" }, async ({
  page,
}) => {
  const source = await serveSource(page, CHANGES);
  const viewer = await openSource(page);
  expect(source.reads.at(-1)).toEqual({ path: "src/planner.rs", base: "HEAD" });

  await selectTaskReviewScope(page.locator("caffold-tasks-page"), "branch");
  await expect.poll(() => source.reads.at(-1)?.base).toBe("origin/main");
  await expect(
    viewer.locator('caffold-code-viewer .code-row[data-line-change="added"]'),
  ).toHaveCount(3);
});

test("marks Source again when a ref moves and the file does not", { tag: "@server-changes" }, async ({
  page,
}) => {
  const source = await serveSource(page, CHANGES);
  const viewer = await openSource(page);
  const added = viewer.locator('caffold-code-viewer .code-row[data-line-change="added"]');
  await expect(added).toHaveCount(3);

  // A commit takes the changes in: the file stays and its marks go.
  const reads = source.reads.length;
  source.lineChanges = { added: [], removedAfter: [] };
  await emitGitRefsChanged(page);
  await expect.poll(() => source.reads.length).toBe(reads + 1);
  await expect(added).toHaveCount(0);
  await expect(viewer.locator("caffold-code-viewer [data-line-removed]")).toHaveCount(0);
  await expect(viewer.locator("caffold-code-viewer .code-row")).toHaveCount(8);
});

// Answers planner.rs with the marks `lineChanges` names when a base is
// asked for, and records each read's base.
async function serveSource(page, lineChanges) {
  const source = { reads: [], lineChanges };
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path");
    const base = url.searchParams.get("base");
    source.reads.push({ path, base });
    return route.fulfill({
      json: {
        path,
        name: path.split("/").at(-1),
        size: SOURCE.length,
        modifiedMs: 1_700_000_000_000,
        language: "Rust",
        content: SOURCE,
        syntaxSpans: null,
        lineChanges: base ? source.lineChanges : null,
      },
    });
  });
  return source;
}

// Opens planner.rs from Working Tree as Source.
async function openSource(page) {
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview
    .locator('caffold-git-diff-changes-tree button[data-file-tree-relative-path="planner.rs"]')
    .click();
  await taskReview.getByRole("button", { name: "Source", exact: true }).click();
  const viewer = taskReview.locator("caffold-review-file-viewer");
  await expect(viewer.locator("caffold-code-viewer .code-row")).toHaveCount(8);
  return viewer;
}

// The computed look of the marks beside an added line (2) and an unmarked
// line (4); the removal rules above line 6 (between rows), above line 1
// (first row), and below line 8 (last row), each with the boundary it marks;
// every row's height; and the diff tokens the marks draw from.
function readMarkLook(viewer) {
  return viewer.locator("caffold-code-viewer").evaluate((codeViewer) => {
    const root = codeViewer.shadowRoot;
    const number = (line) =>
      root.querySelector(`.code-row[data-line-number="${line}"] .line-number`);
    const cell = (line, part = ".line-number") =>
      getComputedStyle(root.querySelector(`.code-row[data-line-number="${line}"] ${part}`));
    const rule = (line, pseudo, boundary) => {
      const box = number(line).getBoundingClientRect();
      const style = getComputedStyle(number(line), pseudo);
      const height = Number.parseFloat(style.height);
      return {
        position: style.position,
        height,
        color: style.backgroundColor,
        center: box.top + Number.parseFloat(style.top) + height / 2,
        boundary: boundary(box),
      };
    };
    const token = (name, property = "color") => {
      const probe = document.createElement("span");
      probe.style[property] = `var(${name})`;
      root.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    return {
      added: {
        background: cell(2).backgroundColor,
        color: cell(2).color,
        codeBackground: cell(2, ".line-code").backgroundColor,
      },
      plain: {
        background: cell(4).backgroundColor,
        codeBackground: cell(4, ".line-code").backgroundColor,
        rule: getComputedStyle(number(4), "::before").content,
      },
      between: rule(6, "::before", (box) => box.top),
      first: rule(1, "::before", (box) => box.top),
      last: rule(8, "::after", (box) => box.bottom),
      rowHeights: [...root.querySelectorAll(".code-row")].map(
        (row) => row.getBoundingClientRect().height,
      ),
      tokens: {
        addedBackground: token("--diff-added-bg", "backgroundColor"),
        addedText: token("--diff-added-text"),
        removedRule: token("--diff-removed-rule"),
        gutter: token("--code-gutter", "backgroundColor"),
      },
    };
  });
}

async function emitGitRefsChanged(page) {
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find(
      (candidate) =>
        candidate.url.startsWith("/api/watch?") && candidate.readyState !== 2,
    );
    if (!source) {
      throw new Error("Missing Task Review watch source");
    }
    source.emit("change", {
      revision: Date.now(),
      paths: [],
      gitStatusChanged: false,
      gitRefsChanged: true,
      overflow: false,
    });
  });
}
