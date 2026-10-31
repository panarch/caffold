/**
 * The paint a focus indicator can change, read from a control and from the
 * face it draws: its `::before`, or the child `face` names.
 *
 * A control shows keyboard focus the way it shows hover where the pointer
 * hovers. Touch keeps :hover after a tap, so there hover changes nothing.
 * Specs compare these states rather than pinning colors.
 */
export function focusLook(locator, face = null) {
  return locator.evaluate((element, face) => {
    const read = (style) => ({
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      color: style.color,
      textDecorationLine: style.textDecorationLine,
      textDecorationThickness: style.textDecorationThickness,
    });
    return {
      control: read(getComputedStyle(element)),
      face: read(face
        ? getComputedStyle(element.querySelector(face))
        : getComputedStyle(element, "::before")),
    };
  }, face);
}

export function pointerHovers(page) {
  return page.evaluate(() => matchMedia("(hover: hover)").matches);
}
