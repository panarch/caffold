// Moves a retained Notes view into another pane, which may be a shadow root,
// and keeps where its scroller was. The view is inserted rather than moved
// with `moveBefore()`, which in Chromium leaves a view it moves back into a
// shadow root without a box. The pane may still be hidden as the view
// arrives, so the position returns once the scroller is shown.
export function moveIntoPane(
  view: Element,
  parent: ParentNode,
  before: Element | null,
  scrollerOf: () => Element | null | undefined,
) {
  if (view.parentNode === parent) {
    return;
  }
  const scroller = scrollerOf();
  const target = before?.parentNode === parent ? before : null;
  // A scroller still waiting to be shown reads 0, not its position.
  const scroll =
    (scroller && pendingRestores.get(scroller)?.scroll) ??
    (scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null);
  parent.insertBefore(view, target);
  if (scroller && scroll) {
    restoreWhenShown(scroller, scroll);
  }
}

interface ScrollPosition {
  top: number;
  left: number;
}

const pendingRestores = new WeakMap<
  Element,
  { observer: ResizeObserver; scroll: ScrollPosition }
>();

function restoreWhenShown(scroller: Element, scroll: ScrollPosition) {
  pendingRestores.get(scroller)?.observer.disconnect();
  pendingRestores.delete(scroller);
  const restore = () => {
    scroller.scrollTop = scroll.top;
    scroller.scrollLeft = scroll.left;
  };
  if (scroller.getClientRects().length > 0) {
    restore();
    return;
  }
  const observer = new ResizeObserver(() => {
    if (scroller.getClientRects().length === 0) {
      return;
    }
    observer.disconnect();
    pendingRestores.delete(scroller);
    restore();
  });
  pendingRestores.set(scroller, { observer, scroll });
  observer.observe(scroller);
}
