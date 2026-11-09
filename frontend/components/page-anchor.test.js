import assert from "node:assert/strict";
import test from "node:test";

import { readPageAnchor, scrollToPageAnchor } from "./page-anchor.js";

// A scroller of pages one above another, with padding above the first page and
// a gap between pages, laid out as its `scrollTop` places them.
function column(heights, { top = 100, padding = 16, gap = 20 } = {}) {
  const scrollport = {
    scrollTop: 0,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top }),
  };
  let offset = padding;
  const pages = heights.map((height) => {
    const pageOffset = offset;
    offset += height + gap;
    return {
      getBoundingClientRect() {
        const pageTop = top + pageOffset - scrollport.scrollTop;
        return { top: pageTop, bottom: pageTop + height, height };
      },
    };
  });
  return { scrollport, pages };
}

test("reads the page at the top edge and how far into it the edge falls", () => {
  const { scrollport, pages } = column([400, 400, 400]);
  // The second page starts at 16 + 400 + 20 = 436.
  scrollport.scrollTop = 436 + 100;

  assert.deepEqual(readPageAnchor(scrollport, pages), { page: 1, fraction: 0.25 });
});

test("returns to the same part of the same page once the pages change size", () => {
  const wide = column([400, 400, 400]);
  wide.scrollport.scrollTop = 436 + 200;
  const anchor = readPageAnchor(wide.scrollport, wide.pages);

  const narrow = column([200, 200, 200]);
  scrollToPageAnchor(narrow.scrollport, narrow.pages, anchor);

  // The second page now starts at 16 + 200 + 20 = 236.
  assert.equal(narrow.scrollport.scrollTop, 236 + 100);
  assert.deepEqual(readPageAnchor(narrow.scrollport, narrow.pages), anchor);
});

test("keeps the space above the first page, so the top stays the top", () => {
  const { scrollport, pages } = column([400, 400]);
  const anchor = readPageAnchor(scrollport, pages);

  assert.equal(anchor.page, 0);
  assert.ok(anchor.fraction < 0, "the edge is in the padding above the page");
  scrollport.scrollTop = 300;
  scrollToPageAnchor(scrollport, pages, anchor);
  assert.equal(scrollport.scrollTop, 0);
});

test("an edge in the gap between pages belongs to the page below it", () => {
  const { scrollport, pages } = column([400, 400]);
  scrollport.scrollTop = 16 + 400 + 10;

  const anchor = readPageAnchor(scrollport, pages);

  assert.equal(anchor.page, 1);
  scrollport.scrollTop = 0;
  scrollToPageAnchor(scrollport, pages, anchor);
  assert.equal(scrollport.scrollTop, 16 + 400 + 10);
});

test("gives way to the last page when the page read is gone", () => {
  const { scrollport, pages } = column([400, 400]);

  scrollToPageAnchor(scrollport, pages, { page: 5, fraction: 0.5 });

  assert.equal(scrollport.scrollTop, 436 + 200);
});

test("reads nothing from a scroller with no page or no box, and moves nothing to no page", () => {
  const { scrollport, pages } = column([400]);

  assert.equal(readPageAnchor(scrollport, []), null);
  assert.equal(
    readPageAnchor({ ...scrollport, getClientRects: () => [] }, pages),
    null,
  );
  scrollport.scrollTop = 50;
  scrollToPageAnchor(scrollport, [], { page: 0, fraction: 0 });
  assert.equal(scrollport.scrollTop, 50);
});

test("finds the page at the top of many by reading only a few of them", () => {
  const heights = Array.from({ length: 2000 }, (_, index) => 18 + (index % 5) * 18);
  const { scrollport, pages } = column(heights, { padding: 0, gap: 0 });
  let reads = 0;
  const counted = pages.map((page) => ({
    getBoundingClientRect() {
      reads += 1;
      return page.getBoundingClientRect();
    },
  }));

  for (const scrollTop of [0, 17, 18, 5000, 41_234, 107_999]) {
    scrollport.scrollTop = scrollTop;
    const expected = pages.findIndex((page) => page.getBoundingClientRect().bottom > 100);
    reads = 0;

    assert.equal(readPageAnchor(scrollport, counted).page, expected, `at ${scrollTop}`);
    assert.ok(reads <= 13, `${reads} pages read at ${scrollTop}`);
  }
});
