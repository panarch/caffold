// Where a scroller of pages is read, by the page at its top rather than by
// pixels: a page that fits the width it is given grows and shrinks with that
// width, so the same pixel offset reaches another page once the width changes.
export interface PageAnchor {
  // The first page whose bottom is below the scroller's top edge, from 0.
  page: number;
  // How far into that page the top edge falls, as a share of the page's
  // height; below 0 while the edge is in the space above the page.
  fraction: number;
}

// The anchor of what the scroller shows now, or null when it shows no page.
export function readPageAnchor(
  scrollport: Element,
  pages: readonly Element[],
): PageAnchor | null {
  if (pages.length === 0 || !scrollport.getClientRects().length) {
    return null;
  }
  const top = scrollport.getBoundingClientRect().top;
  const index = pages.findIndex(
    (page) => page.getBoundingClientRect().bottom > top,
  );
  const page = index < 0 ? pages.length - 1 : index;
  const box = pages[page].getBoundingClientRect();
  return { page, fraction: box.height > 0 ? (top - box.top) / box.height : 0 };
}

// Scrolls to the anchor's place in its page as the page is laid out now. A
// page that is no longer there gives way to the last one.
export function scrollToPageAnchor(
  scrollport: Element,
  pages: readonly Element[],
  anchor: PageAnchor,
) {
  const page = pages[Math.min(anchor.page, pages.length - 1)];
  if (!page) {
    return;
  }
  const box = page.getBoundingClientRect();
  const pageTop =
    box.top - scrollport.getBoundingClientRect().top + scrollport.scrollTop;
  scrollport.scrollTop = pageTop + anchor.fraction * box.height;
}
