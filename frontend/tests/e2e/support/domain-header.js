import { expect } from "@playwright/test";

export async function expectDomainBackChrome(header, label) {
  const button = header.getByRole("button", { name: label });
  await expect(button).toBeVisible();

  const geometry = await header.evaluate((element, accessibleLabel) => {
    const back = element.querySelector(
      `.task-domain-back[aria-label="${CSS.escape(accessibleLabel)}"]`,
    );
    const icon = back.querySelector(".task-domain-back-icon");
    const title = element.querySelector(".task-domain-title");
    const headerBounds = element.getBoundingClientRect();
    const backBounds = back.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    const headerStyle = getComputedStyle(element);
    const visualStyle = getComputedStyle(back, "::before");
    const visualBounds = {
      left: backBounds.left + Number.parseFloat(visualStyle.left),
      right: backBounds.right - Number.parseFloat(visualStyle.right),
      top: backBounds.top + Number.parseFloat(visualStyle.top),
      bottom: backBounds.bottom - Number.parseFloat(visualStyle.bottom),
    };
    const center = (bounds, axis) =>
      axis === "x"
        ? bounds.left + bounds.width / 2
        : bounds.top + bounds.height / 2;
    const visualCenter = (start, end) => start + (end - start) / 2;

    return {
      visualBorder:
        visualStyle.borderStyle !== "none" &&
        Number.parseFloat(visualStyle.borderWidth) > 0,
      visualBackground: visualStyle.backgroundColor !== "rgba(0, 0, 0, 0)",
      visualSquare:
        Math.abs(
          Number.parseFloat(visualStyle.width) -
            Number.parseFloat(visualStyle.height),
        ) <= 1,
      visualInsideHitArea:
        Number.parseFloat(visualStyle.width) <= backBounds.width &&
        Number.parseFloat(visualStyle.height) <= backBounds.height,
      iconCentered:
        Math.abs(
          center(iconBounds, "x") -
            visualCenter(visualBounds.left, visualBounds.right),
        ) <= 1 &&
        Math.abs(
          center(iconBounds, "y") -
            visualCenter(visualBounds.top, visualBounds.bottom),
        ) <= 1,
      visualCentered:
        Math.abs(
          visualCenter(visualBounds.top, visualBounds.bottom) -
            center(headerBounds, "y"),
        ) <= 1,
      titleCentered:
        Math.abs(center(titleBounds, "y") - center(headerBounds, "y")) <= 1,
      visualStartsAtPadding:
        Math.abs(
          visualBounds.left -
            (headerBounds.left + Number.parseFloat(headerStyle.paddingLeft)),
        ) <= 1,
      titleGapMatches:
        Math.abs(
          titleBounds.left -
            visualBounds.right -
            Number.parseFloat(headerStyle.columnGap),
        ) <= 1,
    };
  }, label);

  expect(geometry).toEqual({
    visualBorder: true,
    visualBackground: true,
    visualSquare: true,
    visualInsideHitArea: true,
    iconCentered: true,
    visualCentered: true,
    titleCentered: true,
    visualStartsAtPadding: true,
    titleGapMatches: true,
  });
}
