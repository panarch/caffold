// How much of an element a phone's or tablet's on-screen keyboard covers.
// Browsers keep the page laid out at full height when the keyboard opens and
// shrink only the visual viewport, the part actually on screen. CSS cannot see
// that, so the covered height is measured from the visual viewport here.

/**
 * Calls `onChange` with the height of `element` below the visible area, now
 * and whenever it changes, until the returned function is called. A pinch
 * zoom also shrinks the visual viewport, so nothing counts as covered while
 * the page is zoomed.
 */
export function watchKeyboardInset(element, onChange) {
  const viewport = window.visualViewport;
  if (!viewport) {
    onChange(0);
    return () => {};
  }
  let covered = -1;
  let frame = 0;
  const measure = () => {
    frame = 0;
    const visibleBottom = viewport.offsetTop + viewport.height;
    const next = Math.abs(viewport.scale - 1) > 0.01
      ? 0
      : Math.max(0, Math.round(element.getBoundingClientRect().bottom - visibleBottom));
    if (next !== covered) {
      covered = next;
      onChange(covered);
    }
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(measure);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  measure();
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    if (frame) {
      cancelAnimationFrame(frame);
    }
  };
}
