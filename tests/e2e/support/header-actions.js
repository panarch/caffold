import { expect } from "@playwright/test";

export function headerActionGroupButton(page, group) {
  return page.locator(`caffold-header-actions button[data-action-group="${group}"]`);
}

export async function expectHeaderBrand(page) {
  const brand = page.locator("caffold-app-menu .app-menu-button");
  const mark = brand.locator(".app-menu-mark");
  const name = brand.locator(".app-menu-name");

  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("src", "/assets/icons/caffold-mark.svg");

  const isPhone = await page.evaluate(() => window.matchMedia("(max-width: 520px)").matches);
  if (isPhone) {
    await expect(name).toBeHidden();
  } else {
    await expect(name).toBeVisible();
    await expect(name).toHaveText("Caffold");
  }
}

export async function openHeaderActionGroup(page, group) {
  const button = headerActionGroupButton(page, group);
  const popover = page.locator(
    `caffold-header-actions .header-actions-popover[data-action-group="${group}"]`,
  );

  await expect(button).toBeVisible();
  await page.locator("caffold-header-actions").evaluate((element) => {
    element.querySelectorAll(".header-actions-popover").forEach((panel) => {
      panel.hidden = true;
    });
    element.querySelectorAll("button[data-action-group]").forEach((actionButton) => {
      actionButton.setAttribute("aria-expanded", "false");
    });
  });
  await button.click();
  await expect(popover).toBeVisible();

  return popover;
}

export async function clickHeaderAction(page, group, action) {
  const popover = await openHeaderActionGroup(page, group);
  await popover.locator(`button[data-action="${action}"]`).click();
}

export async function expectFileTreeDensity(page, entry) {
  const metrics = await entry.evaluate((element) => {
    const entryStyle = getComputedStyle(element);
    const iconStyle = getComputedStyle(element.querySelector(".entry-icon-svg"));
    const status = element.querySelector('[class*="status-code"]');
    const probe = document.createElement("span");
    probe.style.cssText = `
      position: fixed;
      inset: auto;
      visibility: hidden;
      font-size: var(--file-tree-font-size);
      min-height: var(--file-tree-row-height);
      width: var(--file-tree-icon-size);
      column-gap: var(--file-tree-column-gap);
      padding: var(--file-tree-padding-y) var(--file-tree-padding-right)
        var(--file-tree-padding-y) var(--file-tree-padding-left);
    `;
    document.body.append(probe);
    const expectedStyle = getComputedStyle(probe);

    const result = {
      expected: {
        fontSize: expectedStyle.fontSize,
        rowHeight: expectedStyle.minHeight,
        iconSize: expectedStyle.width,
        gap: expectedStyle.columnGap,
        paddingTop: expectedStyle.paddingTop,
        paddingRight: expectedStyle.paddingRight,
        paddingLeft: expectedStyle.paddingLeft,
      },
      actual: {
        fontSize: entryStyle.fontSize,
        rowHeight: entryStyle.minHeight,
        iconSize: iconStyle.width,
        gap: entryStyle.columnGap,
        paddingTop: entryStyle.paddingTop,
        paddingRight: entryStyle.paddingRight,
        paddingLeft: entryStyle.paddingLeft,
        statusFontSize: status ? getComputedStyle(status).fontSize : null,
      },
    };
    probe.remove();
    return result;
  });

  expect(metrics.actual.fontSize).toBe(metrics.expected.fontSize);
  expect(metrics.actual.rowHeight).toBe(metrics.expected.rowHeight);
  expect(metrics.actual.iconSize).toBe(metrics.expected.iconSize);
  expect(metrics.actual.gap).toBe(metrics.expected.gap);
  expect(metrics.actual.paddingTop).toBe(metrics.expected.paddingTop);
  expect(metrics.actual.paddingRight).toBe(metrics.expected.paddingRight);
  expect(metrics.actual.paddingLeft).toBe(metrics.expected.paddingLeft);
  expect(metrics.actual.statusFontSize).toBe(metrics.expected.fontSize);
}

export async function expectHeaderActionsFit(page) {
  const metrics = await page.evaluate(() => {
    const box = (element) => {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const header = document.querySelector("caffold-app-shell .app-header");
    const brand = document.querySelector("caffold-app-menu .app-menu-button");
    const git = document.querySelector('caffold-header-actions button[data-action-group="git"]');
    const github = document.querySelector(
      'caffold-header-actions button[data-action-group="github"]',
    );
    const codex = document.querySelector(
      'caffold-header-actions button[data-action-group="codex"]',
    );
    const badge = git?.querySelector(".header-action-badge");

    return {
      viewportWidth: window.innerWidth,
      header: {
        clientWidth: header?.clientWidth ?? 0,
        scrollWidth: header?.scrollWidth ?? 0,
      },
      brand: box(brand),
      git: box(git),
      github: box(github),
      codex: box(codex),
      badge: box(badge),
    };
  });

  expect(metrics.header.scrollWidth).toBeLessThanOrEqual(metrics.header.clientWidth + 1);
  expect(metrics.brand.right).toBeLessThanOrEqual(metrics.git.left);
  expect(metrics.git.right).toBeLessThanOrEqual(metrics.github.left);
  expect(metrics.github.right).toBeLessThanOrEqual(metrics.codex.left);
  expect(metrics.codex.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  const expectedControlSize =
    (await page.evaluate(
      () =>
        matchMedia("(pointer: coarse)").matches ||
        matchMedia("(max-width: 520px)").matches,
    ))
      ? 40
      : 32;
  expect(metrics.git.width).toBeCloseTo(expectedControlSize, 0);
  expect(metrics.github.width).toBeCloseTo(expectedControlSize, 0);
  expect(metrics.codex.width).toBeCloseTo(expectedControlSize, 0);

  if (metrics.badge) {
    expect(metrics.badge.left).toBeGreaterThanOrEqual(metrics.git.left);
    expect(metrics.badge.right).toBeGreaterThan(metrics.git.right);
    expect(metrics.badge.right).toBeLessThanOrEqual(metrics.github.left);
    expect(metrics.badge.bottom).toBeGreaterThan(metrics.git.top);
    expect(metrics.badge.top).toBeLessThanOrEqual(metrics.git.top + 2);
  }
}

export async function expectHeaderButtonOpacity(page, group, expected) {
  const opacity = await headerActionGroupButton(page, group).evaluate((button) =>
    Number.parseFloat(window.getComputedStyle(button).opacity),
  );

  expect(opacity).toBeCloseTo(expected, 2);
}

export async function expectHeaderPopoverFits(page, group) {
  const metrics = await page.evaluate((actionGroup) => {
    const popover = document.querySelector(
      `caffold-header-actions .header-actions-popover[data-action-group="${actionGroup}"]`,
    );
    const rect = popover.getBoundingClientRect();

    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }, group);

  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.width).toBeGreaterThan(0);
  expect(metrics.height).toBeGreaterThan(0);
}

export async function expectHeaderGroupOpenVisualState(page, group) {
  const metrics = await page.evaluate((actionGroup) => {
    const button = document.querySelector(
      `caffold-header-actions button[data-action-group="${actionGroup}"]`,
    );
    const popover = document.querySelector(
      `caffold-header-actions .header-actions-popover[data-action-group="${actionGroup}"]`,
    );
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const buttonStyle = window.getComputedStyle(button);
    const arrowStyle = window.getComputedStyle(popover, "::before");
    const arrowLeft = Number.parseFloat(arrowStyle.left);
    const arrowTop = Number.parseFloat(arrowStyle.top);
    const arrowWidth = Number.parseFloat(arrowStyle.width);
    const arrowVisualTop =
      popoverRect.top + arrowTop + arrowWidth / 2 - (Math.SQRT2 * arrowWidth) / 2;

    return {
      arrowCenter: popoverRect.left + arrowLeft + arrowWidth / 2,
      arrowContent: arrowStyle.content,
      arrowDisplay: arrowStyle.display,
      arrowHeight: arrowStyle.height,
      arrowWidth: arrowStyle.width,
      buttonBackground: buttonStyle.backgroundColor,
      buttonBottom: buttonRect.bottom,
      buttonBorderColor: buttonStyle.borderTopColor,
      buttonCenter: buttonRect.left + buttonRect.width / 2,
      buttonToArrowGap: arrowVisualTop - buttonRect.bottom,
      isMobileLayout: window.matchMedia("(max-width: 520px)").matches,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      viewportWidth: window.innerWidth,
    };
  }, group);

  expect(metrics.buttonBackground).toBe("rgb(237, 244, 239)");
  expect(metrics.buttonBorderColor).toBe("rgb(182, 199, 189)");

  if (metrics.isMobileLayout) {
    expect(metrics.arrowDisplay).toBe("none");
    expect(metrics.popoverLeft).toBeGreaterThanOrEqual(7);
    expect(metrics.popoverRight).toBeLessThanOrEqual(metrics.viewportWidth - 7);
    return;
  }

  expect(metrics.arrowContent).toBe('""');
  expect(Number.parseFloat(metrics.arrowWidth)).toBeCloseTo(
    metrics.rootFontSize * 0.625,
    2,
  );
  expect(Number.parseFloat(metrics.arrowHeight)).toBeCloseTo(
    metrics.rootFontSize * 0.625,
    2,
  );
  expect(Math.abs(metrics.arrowCenter - metrics.buttonCenter)).toBeLessThanOrEqual(4);
  expect(metrics.buttonToArrowGap).toBeGreaterThanOrEqual(-1);
  expect(metrics.buttonToArrowGap).toBeLessThanOrEqual(3);
}
