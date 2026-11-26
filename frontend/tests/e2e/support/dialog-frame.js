// Where an open document or output dialog sits in the viewport and how its
// edges are drawn. Pass it to `evaluate` on the `<dialog>` locator. `end`
// names the element whose bottom padding is the room after the end of what
// the dialog shows; `inShadow` names the element inside `end`'s shadow root
// that holds that padding instead. Gaps run left, right, top, bottom; corner
// radii run clockwise from the top left.
export function dialogFrame(dialog, { end, inShadow } = {}) {
  const box = dialog.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  let room = end ? dialog.querySelector(end) : null;
  if (room && inShadow) {
    room = room.shadowRoot.querySelector(inShadow);
  }
  return {
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    viewportHeight: innerHeight,
    gaps: [box.left, innerWidth - box.right, box.top, innerHeight - box.bottom],
    width: box.width,
    height: box.height,
    corners: [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ],
    bottomBorder: style.borderBottomWidth,
    endRoom: room ? parseFloat(getComputedStyle(room).paddingBottom) : null,
  };
}
