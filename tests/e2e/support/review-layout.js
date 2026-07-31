import { expect } from "@playwright/test";
import { scrollTop } from "./task-fixtures.js";

export async function expectGlobalScrollLocked(page) {
  const scrollState = await page.evaluate(() => {
    const element = document.scrollingElement;
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflow: window.getComputedStyle(document.body).overflow,
    };
  });

  expect(scrollState.overflow).toBe("hidden");
  expect(scrollState.scrollWidth).toBe(scrollState.clientWidth);
  expect(scrollState.scrollHeight).toBe(scrollState.clientHeight);
}

export async function expectPanelScrollContainers(page) {
  const scrollState = await page.evaluate(() => {
    const fileList = document.querySelector(".file-list");
    const codeLines = document.querySelector(".code-lines");

    return {
      fileList: {
        clientHeight: fileList.clientHeight,
        scrollHeight: fileList.scrollHeight,
        overflowY: window.getComputedStyle(fileList).overflowY,
      },
      codeLines: {
        clientHeight: codeLines.clientHeight,
        scrollHeight: codeLines.scrollHeight,
        overflowY: window.getComputedStyle(codeLines).overflowY,
      },
    };
  });

  expect(scrollState.fileList.overflowY).toBe("auto");
  expect(scrollState.codeLines.overflowY).toBe("auto");
  expect(scrollState.codeLines.scrollHeight).toBeGreaterThan(scrollState.codeLines.clientHeight);
}

export async function leftPanelWidth(page) {
  return page.locator("caffold-file-list").evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

export async function elementWidth(page, selector) {
  return page.locator(selector).evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

export async function dragHorizontalResizer(page, handle, deltaX) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  const x = box.x + box.width / 2;
  const y = box.y + Math.min(40, Math.max(1, box.height / 2));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y);
  await page.mouse.up();
}


export async function expectPreservedScroll(locator, beforeScroll) {
  const afterScroll = await scrollTop(locator);
  expect(afterScroll).toBeGreaterThan(0);
  expect(afterScroll).toBeGreaterThanOrEqual(beforeScroll - 32);
}

export async function expectHorizontalScroller(page, selector) {
  const scrollState = await page.locator(selector).evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return {
      clientWidth: element.clientWidth,
      overflowX: window.getComputedStyle(element).overflowX,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(scrollState.overflowX).toBe("auto");
  expect(scrollState.scrollWidth).toBeGreaterThan(scrollState.clientWidth);
  expect(scrollState.scrollLeft).toBeGreaterThan(0);
}

export async function expectCodeViewerGutterSeparated(page) {
  const metrics = await page.locator("caffold-code-viewer .code-lines").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;

    const container = element.getBoundingClientRect();
    const backdrop = element.querySelector(".code-gutter-backdrop").getBoundingClientRect();
    const lineNumber = element.querySelector(".line-number").getBoundingClientRect();

    return {
      backdropLeft: backdrop.left,
      backdropRight: backdrop.right,
      containerLeft: container.left,
      lineNumberLeft: lineNumber.left,
      lineNumberRight: lineNumber.right,
      scrollLeft: element.scrollLeft,
    };
  });

  expect(metrics.scrollLeft).toBeGreaterThan(0);
  expect(Math.abs(metrics.backdropLeft - metrics.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.lineNumberLeft - metrics.containerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.lineNumberRight - metrics.backdropRight)).toBeLessThanOrEqual(1);
}

export async function expectMobileBrowserViewerOverlay(page) {
  const metrics = await page.evaluate(() => {
    const fileBrowser = document.querySelector("caffold-file-browser");
    const header = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const rect = fileBrowser.getBoundingClientRect();
    const style = window.getComputedStyle(fileBrowser);

    return {
      bottom: rect.bottom,
      height: rect.height,
      headerBottom: header.getBoundingClientRect().bottom,
      pathbarBottom: pathbar.getBoundingClientRect().bottom,
      position: style.position,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  expect(metrics.position).toBe("fixed");
  expect(metrics.top).toBeLessThanOrEqual(1);
  expect(metrics.bottom).toBeGreaterThanOrEqual(metrics.viewportHeight - 1);
  expect(metrics.width).toBeGreaterThanOrEqual(metrics.viewportWidth - 1);
  expect(metrics.top).toBeLessThan(metrics.headerBottom);
  expect(metrics.top).toBeLessThan(metrics.pathbarBottom);
}

export async function expectMobileViewerCompactHeader(
  page,
  viewerSelector = "caffold-file-viewer",
) {
  const metrics = await page.locator(viewerSelector).evaluate((viewer) => {
    const header = viewer.querySelector(".viewer-panel > header");
    const closeButton = viewer.querySelector(".viewer-close-button");
    const title = viewer.querySelector("h2");
    const infoButton = viewer.querySelector(".viewer-info-button");

    function box(element) {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    }

    return {
      closeButton: box(closeButton),
      header: box(header),
      infoButton: box(infoButton),
      title: box(title),
    };
  });

  expect(metrics.header.height).toBeLessThanOrEqual(54);
  expect(metrics.closeButton.left).toBeGreaterThanOrEqual(metrics.header.left - 1);
  expect(metrics.title.left).toBeGreaterThan(metrics.closeButton.right);
  expect(metrics.infoButton.left).toBeGreaterThan(metrics.title.left);
  for (const box of [metrics.closeButton, metrics.title, metrics.infoButton]) {
    expect(box.top).toBeGreaterThanOrEqual(metrics.header.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(metrics.header.bottom + 1);
  }
}

export async function expectMobileReviewDetail(
  page,
  {
    backName,
    detailSelector,
    listSelector,
    sharedFileViewer = false,
    viewerRefresh = false,
  },
) {
  const workspace = page.locator("caffold-review-workspace");

  await expect(workspace).toHaveAttribute("data-mobile-detail", "true");
  await expect(workspace.locator(".review-workspace-header")).toBeHidden();
  await expect(page.locator(listSelector)).toBeHidden();
  await expect(page.locator(detailSelector)).toBeVisible();
  await expect(page.getByRole("button", { name: backName })).toBeVisible();
  if (sharedFileViewer) {
    await expectMobileViewerCompactHeader(page, detailSelector);
  }
  if (viewerRefresh) {
    await expect(
      page.locator(`${detailSelector} .viewer-refresh-button`),
    ).toBeVisible();
  }

  const metrics = await page.locator(detailSelector).evaluate((element) => {
    const workspace = document.querySelector("caffold-review-workspace");
    const panel = element.querySelector(".viewer-panel") ?? element;
    const panelRect = panel.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();

    return {
      panelBottom: panelRect.bottom,
      panelTop: panelRect.top,
      workspaceBottom: workspaceRect.bottom,
      workspaceTop: workspaceRect.top,
    };
  });

  expect(metrics.panelTop).toBeLessThanOrEqual(metrics.workspaceTop + 1);
  expect(metrics.panelBottom).toBeGreaterThanOrEqual(metrics.workspaceBottom - 1);
}

export async function expectUnifiedDiffRowsShareScrollWidth(page) {
  const scrollState = await page.locator("caffold-diff-viewer .diff-lines").evaluate((element) => {
    element.scrollLeft = Math.min(220, element.scrollWidth - element.clientWidth);

    const table = element.querySelector(".diff-table");
    const rows = Array.from(element.querySelectorAll(".diff-row"));
    const gutters = Array.from(element.querySelectorAll(".diff-gutter"));
    const rowWidths = rows.map((row) => row.getBoundingClientRect().width);
    const transparentGutters = gutters.filter((gutter) => {
      const backgroundColor = window.getComputedStyle(gutter).backgroundColor;
      return backgroundColor === "rgba(0, 0, 0, 0)" || backgroundColor === "transparent";
    });

    return {
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      tableWidth: table.getBoundingClientRect().width,
      minRowWidth: Math.min(...rowWidths),
      maxRowWidth: Math.max(...rowWidths),
      transparentGutterCount: transparentGutters.length,
    };
  });

  expect(scrollState.scrollWidth).toBeGreaterThan(scrollState.clientWidth);
  expect(scrollState.scrollLeft).toBeGreaterThan(0);
  expect(scrollState.minRowWidth).toBeGreaterThanOrEqual(scrollState.tableWidth - 1);
  expect(scrollState.maxRowWidth).toBeLessThanOrEqual(scrollState.tableWidth + 1);
  expect(scrollState.transparentGutterCount).toBe(0);
}

export async function expectDiffScrollerFillsViewer(page) {
  const metrics = await page.evaluate(() => {
    const element = [...document.querySelectorAll("caffold-diff-viewer")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const viewer = element.querySelector(".diff-viewer");
    const lines = element.querySelector(".diff-lines");
    const table = element.querySelector(".diff-table");
    const backdrop = element.querySelector(".diff-gutter-backdrop");
    const backdropRect = backdrop.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    const linesRect = lines.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const backdropStyle = window.getComputedStyle(backdrop);

    return {
      backdropBackground: backdropStyle.backgroundColor,
      backdropHeight: backdropRect.height,
      backdropLeft: backdropRect.left,
      linesLeft: linesRect.left,
      linesBottom: linesRect.bottom,
      linesHeight: linesRect.height,
      tableHeight: tableRect.height,
      viewerBottom: viewerRect.bottom,
      viewerHeight: viewerRect.height,
    };
  });

  expect(metrics.linesHeight).toBeGreaterThanOrEqual(metrics.viewerHeight - 1);
  expect(metrics.linesBottom).toBeGreaterThanOrEqual(metrics.viewerBottom - 1);
  expect(metrics.tableHeight).toBeGreaterThanOrEqual(metrics.linesHeight - 1);
  expect(metrics.backdropHeight).toBeGreaterThanOrEqual(metrics.linesHeight - 1);
  expect(metrics.backdropLeft).toBeGreaterThanOrEqual(metrics.linesLeft - 1);
  expect(metrics.backdropBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.backdropBackground).not.toBe("transparent");
}

export async function expectCompareRefControlsFit(page, testInfo, options = {}) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector("caffold-review-workspace .review-workspace-header");
    const title = document.querySelector("caffold-review-workspace .review-workspace-title");
    const controls = document.querySelector(
      "caffold-review-workspace .review-compare-ref-controls",
    );
    const baseSelect = document.querySelector('select[data-compare-ref="base"]');
    const headSelect = document.querySelector('select[data-compare-ref="head"]');
    const separator = controls.querySelector(".review-compare-ref-separator");
    const subtitle = document.querySelector(
      "caffold-review-workspace .review-workspace-subtitle",
    );
    const titleHeading = document.querySelector(
      "caffold-review-workspace .review-workspace-title h2",
    );

    function box(element) {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    }

    function scrollBox(element) {
      return {
        ...box(element),
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
      };
    }

    function selectMetrics(element) {
      const style = window.getComputedStyle(element);
      return {
        ...scrollBox(element),
        css: {
          fieldSizing: style.fieldSizing,
          fontSize: style.fontSize,
          height: style.height,
          maxWidth: style.maxWidth,
          minWidth: style.minWidth,
          width: style.width,
        },
        hasInlineStyle: element.hasAttribute("style"),
      };
    }

    return {
      baseSelect: selectMetrics(baseSelect),
      controls: box(controls),
      headSelect: selectMetrics(headSelect),
      header: scrollBox(header),
      separator: box(separator),
      subtitle: box(subtitle),
      title: scrollBox(title),
      titleHeading: box(titleHeading),
    };
  });

  expect(metrics.header.scrollWidth).toBeLessThanOrEqual(metrics.header.clientWidth + 1);
  expect(metrics.title.scrollWidth).toBeLessThanOrEqual(metrics.title.clientWidth + 1);
  expect(metrics.controls.left).toBeGreaterThanOrEqual(metrics.header.left - 1);
  expect(metrics.controls.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.subtitle.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.subtitle.width).toBeGreaterThan(32);
  expect(metrics.baseSelect.right).toBeLessThanOrEqual(metrics.header.right + 1);
  expect(metrics.headSelect.right).toBeLessThanOrEqual(metrics.header.right + 1);
  for (const box of [
    metrics.baseSelect,
    metrics.controls,
    metrics.headSelect,
    metrics.subtitle,
    metrics.titleHeading,
  ]) {
    expect(box.top).toBeGreaterThanOrEqual(metrics.header.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(metrics.header.bottom + 1);
  }
  expect(metrics.baseSelect.width).toBeGreaterThan(70);
  expect(metrics.headSelect.width).toBeGreaterThan(70);
  if (options.sameRefCss) {
    expect(metrics.baseSelect.hasInlineStyle).toBe(false);
    expect(metrics.headSelect.hasInlineStyle).toBe(false);
    expect(metrics.baseSelect.css.fieldSizing).toBe(metrics.headSelect.css.fieldSizing);
    expect(metrics.baseSelect.css.fontSize).toBe(metrics.headSelect.css.fontSize);
    expect(metrics.baseSelect.css.height).toBe(metrics.headSelect.css.height);
    expect(metrics.baseSelect.css.maxWidth).toBe(metrics.headSelect.css.maxWidth);
    expect(metrics.baseSelect.css.minWidth).toBe(metrics.headSelect.css.minWidth);
  }
  if (options.compactRefs && testInfo.project.name !== "phone") {
    expect(metrics.baseSelect.width).toBeLessThan(180);
    expect(metrics.headSelect.width).toBeLessThan(220);
  }
  if (options.mixedRefs && testInfo.project.name !== "phone") {
    expect(metrics.baseSelect.width).toBeLessThan(180);
    expect(metrics.headSelect.width).toBeGreaterThan(metrics.baseSelect.width + 120);
  }
  if (options.tightRefGaps && testInfo.project.name !== "phone") {
    expect(metrics.separator.left - metrics.baseSelect.right).toBeLessThanOrEqual(16);
    expect(metrics.headSelect.left - metrics.separator.right).toBeLessThanOrEqual(72);
  }
  if (options.visibleHeadRef && testInfo.project.name !== "phone") {
    expect(metrics.headSelect.scrollWidth).toBeLessThanOrEqual(
      metrics.headSelect.clientWidth + 4,
    );
  }

  if (testInfo.project.name === "phone") {
    expect(metrics.header.height).toBeLessThanOrEqual(106);
  } else {
    expect(metrics.header.height).toBeLessThanOrEqual(54);
  }
}

export async function expectAlignedWorkspaceHeaders(page, selectors) {
  const metrics = await page.evaluate((headerSelectors) => {
    return headerSelectors.map((selector) => {
      const element = document.querySelector(selector);
      return {
        height: element?.getBoundingClientRect().height ?? 0,
        clientHeight: element?.clientHeight ?? 0,
        scrollHeight: element?.scrollHeight ?? 0,
      };
    });
  }, selectors);
  const heights = metrics.map((metric) => metric.height);

  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);

  expect(minHeight).toBeGreaterThan(0);
  expect(maxHeight - minHeight).toBeLessThanOrEqual(1);
  for (const metric of metrics) {
    expect(metric.scrollHeight).toBeLessThanOrEqual(metric.clientHeight + 1);
  }
}

export async function expectMatchingPaneTitleSizes(page, selectors) {
  const fontSizes = await page.evaluate((headerSelectors) => {
    return headerSelectors.map((selector) => {
      const heading = document.querySelector(`${selector} h2`);
      return Number.parseFloat(window.getComputedStyle(heading).fontSize);
    });
  }, selectors);
  const minSize = Math.min(...fontSizes);
  const maxSize = Math.max(...fontSizes);

  expect(minSize).toBeGreaterThan(0);
  expect(maxSize - minSize).toBeLessThanOrEqual(0.1);
}
