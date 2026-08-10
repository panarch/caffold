import { expect } from "@playwright/test";

export function headerActionGroupButton(page, group) {
  if (group === "codex") {
    return page.locator(
      'caffold-header-actions button[data-action="open-codex-settings"]',
    );
  }
  return page.locator(`caffold-header-actions button[data-action-group="${group}"]`);
}

export async function expectHeaderBrand(page) {
  const brand = page.locator("caffold-app-menu .app-menu-button");
  const mark = brand.locator(".app-menu-mark");
  const name = brand.locator(".app-menu-name");

  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("src", "/assets/icons/favicon-32.png");

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
    const owner = element.closest(
      [
        "caffold-git-diff-changes-tree",
        "caffold-git-compare-tree",
        "caffold-commit-changes-tree",
        "caffold-github-pull-files-tree",
      ].join(", "),
    );
    const probe = document.createElement("span");
    probe.style.cssText = `
      position: fixed;
      inset: auto;
      visibility: hidden;
      box-sizing: content-box;
      font-size: var(--file-tree-font-size);
      min-height: var(--file-tree-row-height);
      width: var(--file-tree-icon-size);
      column-gap: var(--file-tree-column-gap);
      padding: var(--file-tree-padding-y) var(--file-tree-padding-right)
        var(--file-tree-padding-y)
        calc(0.1875rem + var(--file-tree-padding-left));
    `;
    (owner ?? document.body).append(probe);
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
        borderLeftWidth: entryStyle.borderLeftWidth,
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
  expect(metrics.actual.borderLeftWidth).toBe("0px");
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
      'caffold-header-actions button[data-action="open-codex-settings"]',
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
    const buttonVisualStyle = window.getComputedStyle(button, "::before");

    return {
      buttonBackground: buttonVisualStyle.backgroundColor,
      buttonBottom: buttonRect.bottom,
      buttonBorderColor: buttonVisualStyle.borderTopColor,
      buttonCenter: buttonRect.left + buttonRect.width / 2,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      popoverTop: popoverRect.top,
      viewportWidth: window.innerWidth,
    };
  }, group);

  expect(metrics.buttonBackground).toBe("rgb(229, 229, 229)");
  expect(metrics.buttonBorderColor).toBe("rgb(163, 163, 163)");

  expect(metrics.popoverLeft).toBeGreaterThanOrEqual(7);
  expect(metrics.popoverRight).toBeLessThanOrEqual(metrics.viewportWidth - 7);
  expect(metrics.buttonCenter).toBeGreaterThanOrEqual(metrics.popoverLeft - 1);
  expect(metrics.buttonCenter).toBeLessThanOrEqual(metrics.popoverRight + 1);
  expect(metrics.popoverTop).toBeGreaterThanOrEqual(metrics.buttonBottom + 5);
  expect(metrics.popoverTop).toBeLessThanOrEqual(metrics.buttonBottom + 12);
}
