import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { FILES_HOME_URL } from "./support/file-browser-fixtures.js";
import {
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "./support/task-fixtures.js";

const SETTINGS_KEY = "caffold:settings";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockCodexModels(page);
});

test("returns from Settings to the canonical Tasks home", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await page.goto("/settings");
  const settingsWorkspace = page.locator("caffold-settings-workspace");
  if (testInfo.project.name === "phone") {
    await expect(settingsWorkspace).toBeHidden();
  } else {
    await expect(settingsWorkspace).toBeVisible();
  }
  await expect(page.locator("caffold-settings-navigator")).toBeVisible();
  await expect(page.locator(".files-surface")).toBeHidden();

  await page
    .locator('.task-workspace-navigation [data-workspace-mode="tasks"]')
    .click();

  await expect(page).toHaveURL("/");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "home");
  await expect(tasksPage.locator(".task-new-form")).toBeVisible();
  await expect(page.locator(".files-surface")).toBeHidden();
});

test("normalizes legacy settings into the current appearance contract", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          fileTreeSize: "large",
          taskListSize: "compact",
          taskDetailSize: "large",
          codeSize: "default",
        }),
      );
    },
    { key: SETTINGS_KEY },
  );

  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  await expect(settingsPage).toBeVisible();
  await expect(page.locator(".files-surface")).toBeHidden();
  await expect(page.locator("caffold-app-menu")).toBeHidden();
  await expect(
    page.locator("caffold-settings-workspace .settings-workspace-detail-header"),
  ).toBeVisible();
  await expect(range(settingsPage, "interfaceScalePercent")).toHaveValue("100");
  await expect(range(settingsPage, "conversationTextPx")).toHaveValue("17");
  await expect(range(settingsPage, "codeTextPx")).toHaveValue("15");
  await expect(settingsPage.locator("select[data-typeface-setting]")).toHaveValue(
    "d2-coding",
  );

  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toEqual({
      appearanceVersion: 3,
      typefacePreset: "d2-coding",
      interfaceScalePercent: 100,
      conversationTextPx: 17,
      codeTextPx: 15,
    });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [
          "fileTreeSize",
          "codeSize",
          "taskListSize",
          "taskDetailSize",
        ].some((name) => Object.hasOwn(document.documentElement.dataset, name)),
      ),
    )
    .toBe(false);
});

test("updates independent ranges live without replacing their DOM", async ({
  page,
}, testInfo) => {
  await page.goto(FILES_HOME_URL);
  const appMenu = page.locator("caffold-app-menu");
  const sharedInterfaceTextSize = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;font-size:var(--interface-meta-font-size)";
    document.body.append(probe);
    const value = getComputedStyle(probe).fontSize;
    probe.remove();
    return value;
  });

  await expect(page.locator("caffold-pathbar .path-crumbs button").first()).toHaveCSS(
    "font-size",
    sharedInterfaceTextSize,
  );
  await appMenu.locator(".app-menu-button").click();
  const popover = appMenu.locator(".app-menu-popover");
  await expect(popover).toBeVisible();
  const [appMenuButtonBox, appMenuPopoverBox] = await Promise.all([
    appMenu.locator(".app-menu-button").boundingBox(),
    popover.boundingBox(),
  ]);
  expect(appMenuButtonBox).not.toBeNull();
  expect(appMenuPopoverBox).not.toBeNull();
  expect(appMenuPopoverBox.x).toBeGreaterThanOrEqual(7);
  expect(appMenuPopoverBox.x + appMenuPopoverBox.width).toBeLessThanOrEqual(
    page.viewportSize().width - 7,
  );
  expect(appMenuPopoverBox.y).toBeGreaterThanOrEqual(
    appMenuButtonBox.y + appMenuButtonBox.height + 4,
  );
  expect(appMenuPopoverBox.y).toBeLessThanOrEqual(
    appMenuButtonBox.y + appMenuButtonBox.height + 9,
  );
  expect(appMenuButtonBox.x + appMenuButtonBox.width / 2).toBeGreaterThanOrEqual(
    appMenuPopoverBox.x - 1,
  );
  expect(appMenuButtonBox.x + appMenuButtonBox.width / 2).toBeLessThanOrEqual(
    appMenuPopoverBox.x + appMenuPopoverBox.width + 1,
  );
  await expect(popover).toContainText("Settings");
  await expect(popover.getByRole("menuitem", { name: "About Caffold" })).toHaveCSS(
    "font-size",
    sharedInterfaceTextSize,
  );
  const openSettings = popover.locator('button[data-action="open-settings"]');
  await expect(openSettings).toHaveCSS("font-size", sharedInterfaceTextSize);
  await openSettings.click();

  await expect(page).toHaveURL("/settings");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  if (testInfo.project.name === "phone") {
    await expect(settingsPage).toBeHidden();
    await page
      .locator('button[data-settings-section="appearance"]')
      .click();
    await expect(page).toHaveURL("/settings/appearance");
  }
  await expect(settingsPage).toBeVisible();
  await expect(page.locator(".files-surface")).toBeHidden();
  await expect(page.locator("caffold-app-menu")).toBeHidden();
  await expect(page.locator("caffold-pathbar")).toBeHidden();
  await expect(page.locator("caffold-files-page")).toBeHidden();

  const interfaceRange = range(settingsPage, "interfaceScalePercent");
  const conversationRange = range(settingsPage, "conversationTextPx");
  const codeRange = range(settingsPage, "codeTextPx");
  await expect(interfaceRange).toHaveAttribute("min", "90");
  await expect(interfaceRange).toHaveAttribute("max", "120");
  await expect(interfaceRange).toHaveAttribute("step", "5");
  await expect(conversationRange).toHaveAttribute("min", "13");
  await expect(conversationRange).toHaveAttribute("max", "20");
  await expect(codeRange).toHaveAttribute("min", "12");
  await expect(codeRange).toHaveAttribute("max", "20");

  const responsiveDefaults = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    narrow: matchMedia("(max-width: 520px)").matches,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    targetFloor: getComputedStyle(document.documentElement)
      .getPropertyValue("--interface-target-floor")
      .trim(),
  }));
  const touchInterface = responsiveDefaults.coarse || responsiveDefaults.narrow;
  expect(responsiveDefaults.rootFontSize).toBe(touchInterface ? "17px" : "16px");
  expect(responsiveDefaults.targetFloor).toBe(touchInterface ? "40px" : "0px");
  const settingsControlTiers = await settingsPage.evaluate((element) => {
    const tokenHeight = (token) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;height:var(${token})`;
      document.body.append(probe);
      const value = probe.getBoundingClientRect().height;
      probe.remove();
      return value;
    };
    const height = (selector) =>
      element.querySelector(selector).getBoundingClientRect().height;
    const visualHeight = (selector) => {
      const control = element.querySelector(selector);
      const box = control.getBoundingClientRect();
      const inset = Number.parseFloat(
        getComputedStyle(control, "::before").top,
      );
      return box.height - inset * 2;
    };
    return {
      regularHit: tokenHeight("--interface-control-hit-size"),
      compactVisual: tokenHeight("--interface-compact-visual-size"),
      resetAllVisual: visualHeight(".settings-reset-all"),
      resetOneVisual: visualHeight(".settings-range-control button"),
    };
  });
  expect(settingsControlTiers.resetAllVisual).toBeCloseTo(
    settingsControlTiers.compactVisual,
    1,
  );
  expect(settingsControlTiers.resetOneVisual).toBeCloseTo(
    settingsControlTiers.compactVisual,
    1,
  );
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "15px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "13px",
  );

  await interfaceRange.evaluate((element) => {
    element.dataset.instanceMarker = "stable";
  });
  await interfaceRange.focus();
  await interfaceRange.press("ArrowRight");
  await expect(interfaceRange).toHaveValue("105");
  await expect(interfaceRange).toHaveAttribute("data-instance-marker", "stable");
  await expect(interfaceRange).toBeFocused();
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "15px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "13px",
  );

  await setRange(conversationRange, 20);
  await setRange(codeRange, 18);
  await expect(
    settingsPage.locator(".settings-conversation-message p").first(),
  ).toHaveCSS("font-size", "20px");
  await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
    "font-size",
    "18px",
  );

  const semanticProbe = await page.evaluate(() => {
    const github = document.createElement("caffold-github-markdown");
    github.setHtml("<p>Conversation <code>code</code></p>");
    document.body.append(github);
    const githubBody = github.shadowRoot.querySelector("p");
    const githubCode = github.shadowRoot.querySelector("code");

    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    document.body.append(composer);
    const textarea = composer.querySelector("textarea");
    const modelButton = composer.querySelector(".task-model-button");

    const result = {
      githubBody: getComputedStyle(githubBody).fontSize,
      githubCode: getComputedStyle(githubCode).fontSize,
      textarea: getComputedStyle(textarea).fontSize,
      modelButton: getComputedStyle(modelButton).fontSize,
    };
    github.remove();
    composer.remove();
    return result;
  });
  expect(semanticProbe.githubBody).toBe("20px");
  expect(semanticProbe.githubCode).toBe("18px");
  expect(semanticProbe.textarea).toBe("20px");
  expect(semanticProbe.modelButton).not.toBe("20px");

  if (touchInterface) {
    for (const control of [
      settingsPage.locator(".settings-reset-all"),
      settingsPage.locator(".settings-range-control button").first(),
      settingsPage.locator(".settings-interface-preview-row"),
    ]) {
      const box = await control.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  }

  await captureReviewScreenshot(page, testInfo, "settings-appearance");
  await page.reload();
  await expect(interfaceRange).toHaveValue("105");
  await expect(conversationRange).toHaveValue("20");
  await expect(codeRange).toHaveValue("18");

  await settingsPage
    .locator(
      'button[data-action="reset-setting"][data-setting="conversationTextPx"]',
    )
    .click();
  await expect(conversationRange).toHaveValue("15");
  await expect(interfaceRange).toHaveValue("105");
  await expect(codeRange).toHaveValue("18");

  await settingsPage.locator('button[data-action="reset-appearance"]').click();
  await expect(interfaceRange).toHaveValue("100");
  await expect(conversationRange).toHaveValue("15");
  await expect(codeRange).toHaveValue("13");
});

test("switches and persists the local typeface presets", async ({ page }) => {
  await page.goto("/settings/appearance");

  const settingsPage = page.locator("caffold-settings-appearance-page");
  const select = settingsPage.locator("select[data-typeface-setting]");
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select).not.toContainText("Noto Sans Mono CJK KR");
  await expect(select).toHaveValue("d2-coding");
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "d2-coding",
  );

  await select.selectOption("system-mono");
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "system-mono",
  );
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toMatchObject({ typefacePreset: "system-mono" });

  await settingsPage.locator('button[data-action="reset-typeface"]').click();
  await expect(select).toHaveValue("d2-coding");
  await expect(page.locator("html")).toHaveAttribute(
    "data-typeface-preset",
    "d2-coding",
  );
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toMatchObject({
      typefacePreset: "d2-coding",
    });
});

test("applies extreme values to Files and Code without coupling the axes", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  await setRange(range(settingsPage, "interfaceScalePercent"), 120);
  await setRange(range(settingsPage, "conversationTextPx"), 13);
  await setRange(range(settingsPage, "codeTextPx"), 20);

  await page.goto(FILES_HOME_URL);
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const firstEntry = page.locator("caffold-file-list .file-tree-entry").first();
  await expect(firstEntry).toBeVisible();
  const fileMetrics = await firstEntry.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const rowHeightProbe = document.createElement("div");
    rowHeightProbe.style.cssText =
      "position:fixed;height:var(--file-tree-row-height)";
    document.body.append(rowHeightProbe);
    const configuredRowHeight = rowHeightProbe.getBoundingClientRect().height;
    rowHeightProbe.remove();
    return {
      fontSize: Number.parseFloat(style.fontSize),
      height: box.height,
      configuredRowHeight,
    };
  });
  expect(fileMetrics.fontSize).toBeCloseTo(rootFontSize * 0.8125, 3);
  const touchInterface = await page.evaluate(
    () =>
      matchMedia("(pointer: coarse)").matches ||
      matchMedia("(max-width: 520px)").matches,
  );
  expect(fileMetrics.configuredRowHeight).toBeCloseTo(
    touchInterface ? 36 : rootFontSize * 1.5,
    2,
  );
  expect(fileMetrics.height).toBeGreaterThanOrEqual(
    fileMetrics.configuredRowHeight - 0.02,
  );

  await page.locator('button[data-file-tree-path="src"]').click();
  await page.locator('button[data-file-tree-path="src/example.rs"]').click();
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "font-size",
    "20px",
  );
  const fileToolbarTiers = await page.evaluate(() => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.cssText =
      "position:fixed;height:var(--interface-compact-hit-size)";
    document.body.append(tokenProbe);
    const compact = tokenProbe.getBoundingClientRect().height;
    tokenProbe.remove();
    const height = (selector) =>
      document.querySelector(selector).getBoundingClientRect().height;
    return {
      compact,
      info: height("caffold-file-viewer .viewer-info-button"),
    };
  });
  expect(fileToolbarTiers.info).toBeCloseTo(fileToolbarTiers.compact, 1);

  await page.locator("caffold-file-viewer").evaluate((viewer) => {
    viewer.setDiff({
      path: "src/example.rs",
      repoRelativePath: "src/example.rs",
      kind: "Working tree",
      repository: { rootPath: "src" },
      diff: "@@ -1 +1 @@\n-old line\n+new line",
    });
  });
  await expect(page.locator("caffold-diff-viewer .diff-lines")).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
});

test("keeps mixed surfaces reflowed across appearance extremes", async ({
  page,
}, testInfo) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  const combinations = [
    [100, 15, 13],
    [90, 13, 12],
    [120, 20, 20],
    [90, 20, 20],
    [120, 13, 12],
  ];

  for (const [interfaceValue, conversationValue, codeValue] of combinations) {
    await setRange(range(settingsPage, "interfaceScalePercent"), interfaceValue);
    await setRange(range(settingsPage, "conversationTextPx"), conversationValue);
    await setRange(range(settingsPage, "codeTextPx"), codeValue);

    await expect(
      settingsPage.locator(".settings-conversation-message p").first(),
    ).toHaveCSS("font-size", `${conversationValue}px`);
    await expect(settingsPage.locator(".settings-code-preview")).toHaveCSS(
      "font-size",
      `${codeValue}px`,
    );
    await expect
      .poll(() =>
        settingsPage.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      )
      .toBe(true);
  }

  await setRange(range(settingsPage, "interfaceScalePercent"), 120);
  await setRange(range(settingsPage, "conversationTextPx"), 20);
  await setRange(range(settingsPage, "codeTextPx"), 20);
  const mixedMetrics = await page.evaluate(() => {
    const host = document.createElement("section");
    host.style.cssText =
      "position:fixed;inset:0;z-index:100;background:var(--surface);overflow:auto;padding:1rem";
    document.body.append(host);

    const conversation = document.createElement("caffold-task-conversation");
    host.append(conversation);
    conversation.innerHTML = `
      <article class="task-approval-card">
        <header><h3>Approval</h3><p>Review the requested command before continuing.</p></header>
        <pre>cargo test --all-targets</pre>
        <div class="task-approval-actions">
          <button class="task-secondary-button">Decline</button>
          <button class="task-primary-button">Approve</button>
        </div>
      </article>
    `;

    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    host.append(composer);

    const github = document.createElement("caffold-github-markdown");
    github.setHtml("<p>Long-form review <code>const value = 1;</code></p>");
    host.append(github);

    const approval = conversation.querySelector(".task-approval-card");
    const approvalText = approval.querySelector("p");
    const approvalCode = approval.querySelector("pre");
    const textarea = composer.querySelector("textarea");
    const send = composer.querySelector(".task-send-button");
    const githubText = github.shadowRoot.querySelector("p");
    const githubCode = github.shadowRoot.querySelector("code");
    const metric = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        height: box.height,
        right: box.right,
      };
    };
    const result = {
      viewportWidth: innerWidth,
      documentOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      approvalText: metric(approvalText),
      approvalCode: metric(approvalCode),
      textarea: metric(textarea),
      send: metric(send),
      githubText: metric(githubText),
      githubCode: metric(githubCode),
    };
    host.remove();
    return result;
  });
  expect(mixedMetrics.documentOverflow).toBe(false);
  expect(mixedMetrics.approvalText.fontSize).toBe("20px");
  expect(mixedMetrics.approvalCode.fontSize).toBe("20px");
  expect(mixedMetrics.textarea.fontSize).toBe("20px");
  expect(mixedMetrics.githubText.fontSize).toBe("20px");
  expect(mixedMetrics.githubCode.fontSize).toBe("20px");
  for (const control of [mixedMetrics.send]) {
    expect(control.height).toBeGreaterThanOrEqual(
      testInfo.project.name === "desktop" ? 38 : 40,
    );
    expect(control.right).toBeLessThanOrEqual(mixedMetrics.viewportWidth);
  }

  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 640, height: 400 });
    await expect
      .poll(() =>
        settingsPage.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
});

test("keeps model picker chrome compact and scales it only with Interface", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  const settingsPage = page.locator("caffold-settings-appearance-page");
  const interfaceRange = range(settingsPage, "interfaceScalePercent");
  const conversationRange = range(settingsPage, "conversationTextPx");
  const codeRange = range(settingsPage, "codeTextPx");

  await page.evaluate(() => {
    const host = document.createElement("section");
    host.dataset.appearancePickerProbe = "";
    host.style.cssText =
      "position:fixed;inset:0;z-index:100;background:var(--surface);overflow:auto";
    const composer = document.createElement("caffold-task-composer");
    composer.setContext({ mode: "create", cwd: "." });
    host.append(composer);
    document.body.append(host);
  });

  const composer = page.locator(
    "[data-appearance-picker-probe] caffold-task-composer",
  );
  const modelButton = composer.getByRole("button", {
    name: "Choose model and reasoning",
  });
  await expect(modelButton).toContainText("5.6 Sol");

  await setRange(interfaceRange, 90);
  await setRange(conversationRange, 13);
  await setRange(codeRange, 12);
  await modelButton.click();
  const popover = composer.getByRole("menu", {
    name: "Model and reasoning options",
  });
  await expect(popover).toBeVisible();
  const compact = await modelPickerMetrics(composer);
  await expect(modelButton).toHaveText("5.6 Sol · low");
  await expect(
    composer.getByRole("button", { name: "Choose approval mode" }),
  ).toHaveText("Auto review");
  expect(compact.modelButtonFontSize / compact.rootFontSize).toBeCloseTo(
    0.75,
    2,
  );
  expect(compact.permissionButtonFontSize / compact.rootFontSize).toBeCloseTo(
    0.75,
    2,
  );
  expect(compact.titleFontSize / compact.rootFontSize).toBeCloseTo(0.875, 2);
  expect(compact.toolbarPadding / compact.rootFontSize).toBeCloseTo(0.25, 2);
  expect(compact.toolbarGap / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.popoverPadding / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.optionPadding / compact.rootFontSize).toBeCloseTo(0.375, 2);
  expect(compact.optionGap / compact.rootFontSize).toBeCloseTo(0.5, 2);
  expect(compact.modelButtonIconCount).toBe(0);
  expect(compact.permissionButtonIconCount).toBe(0);
  expect(compact.modelButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(compact.permissionButtonBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(compact.modelButtonOverflow).toBe(false);
  expect(compact.permissionButtonOverflow).toBe(false);
  expect(compact.modelPickerDeadSpace).toBeLessThanOrEqual(1);
  expect(compact.chipGap).toBeGreaterThanOrEqual(0);
  expect(compact.chipGap).toBeLessThanOrEqual(compact.toolbarGap + 1);
  expectComposerIconsCentered(compact);

  await setRange(conversationRange, 20);
  await setRange(codeRange, 20);
  const contentAxesChanged = await modelPickerMetrics(composer);
  expect(stableModelPickerMetrics(contentAxesChanged)).toEqual(
    stableModelPickerMetrics(compact),
  );

  await setRange(interfaceRange, 120);
  const spacious = await modelPickerMetrics(composer);
  const interfaceRatio = spacious.rootFontSize / compact.rootFontSize;
  expect(interfaceRatio).toBeCloseTo(4 / 3, 2);
  for (const property of [
    "modelButtonFontSize",
    "permissionButtonFontSize",
    "titleFontSize",
    "toolbarPadding",
    "toolbarGap",
    "popoverPadding",
    "optionPadding",
    "optionGap",
  ]) {
    expect(spacious[property] / compact[property]).toBeCloseTo(interfaceRatio, 2);
  }
  expect(spacious.modelButtonHeight).toBeGreaterThanOrEqual(
    compact.modelButtonHeight,
  );
  expect(compact.modelButtonHeight).toBeCloseTo(compact.compactVisualSize, 1);
  expect(spacious.modelButtonHeight).toBeCloseTo(spacious.compactVisualSize, 1);
  expect(spacious.optionHeight).toBeGreaterThanOrEqual(compact.optionHeight);
  expect(compact.optionHeight).toBeGreaterThanOrEqual(compact.targetFloor);
  expect(spacious.optionHeight).toBeGreaterThanOrEqual(spacious.targetFloor);
  expect(spacious.modelButtonOverflow).toBe(false);
  expect(spacious.permissionButtonOverflow).toBe(false);
  expect(spacious.toolbarOverflow).toBe(false);
  expect(spacious.modelPickerDeadSpace).toBeLessThanOrEqual(1);
  expect(spacious.chipGap).toBeGreaterThanOrEqual(0);
  expect(spacious.chipGap).toBeLessThanOrEqual(spacious.toolbarGap + 1);
  expectComposerIconsCentered(spacious);
  expect(compact.overflowX).toBe(false);
  expect(spacious.overflowX).toBe(false);
});

function range(settingsPage, name) {
  return settingsPage.locator(`input[type="range"][data-setting="${name}"]`);
}

async function setRange(locator, value) {
  await locator.evaluate((element, nextValue) => {
    element.value = `${nextValue}`;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function modelPickerMetrics(composer) {
  return composer.evaluate((element) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const toolbar = element.querySelector(".task-composer-toolbar");
    const modelButton = element.querySelector(".task-model-button");
    const permissionButton = element.querySelector(".task-permission-button");
    const popover = element.querySelector(".task-model-popover");
    const option = popover.querySelector(".task-model-option");
    const title = option.querySelector("strong");
    const toolbarStyle = getComputedStyle(toolbar);
    const popoverStyle = getComputedStyle(popover);
    const optionStyle = getComputedStyle(option);
    const modelButtonStyle = getComputedStyle(modelButton);
    const permissionButtonStyle = getComputedStyle(permissionButton);
    const modelPickerRect = modelButton.parentElement.getBoundingClientRect();
    const modelButtonRect = modelButton.getBoundingClientRect();
    const permissionButtonRect = permissionButton.getBoundingClientRect();
    const number = (value) => Number.parseFloat(value) || 0;
    const tokenHeight = (token) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;height:var(${token})`;
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    };
    const iconGeometry = [
      ["send", element.querySelector(".task-send-button"), element.querySelector(".task-send-icon")],
    ].map(([name, button, icon]) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon?.getBoundingClientRect();
      const glyphBox = icon?.getBBox?.();
      const viewBox = icon?.viewBox?.baseVal;
      return {
        name,
        tagName: icon?.tagName?.toLowerCase() ?? "",
        outerAspectDelta: Math.abs(iconBox.width - iconBox.height),
        buttonCenterDeltaY: Math.abs(
          iconBox.top + iconBox.height / 2 - (buttonBox.top + buttonBox.height / 2),
        ),
        glyphCenterDeltaX: Math.abs(
          glyphBox.x + glyphBox.width / 2 - (viewBox.x + viewBox.width / 2),
        ),
        glyphCenterDeltaY: Math.abs(
          glyphBox.y + glyphBox.height / 2 - (viewBox.y + viewBox.height / 2),
        ),
      };
    });
    return {
      rootFontSize: number(rootStyle.fontSize),
      targetFloor: number(rootStyle.getPropertyValue("--interface-target-floor")),
      compactVisualSize: tokenHeight("--interface-compact-visual-size"),
      titleFontSize: number(getComputedStyle(title).fontSize),
      modelButtonFontSize: number(getComputedStyle(modelButton).fontSize),
      permissionButtonFontSize: number(
        getComputedStyle(permissionButton).fontSize,
      ),
      modelButtonBackground: modelButtonStyle.backgroundColor,
      permissionButtonBackground: permissionButtonStyle.backgroundColor,
      modelButtonIconCount: modelButton.querySelectorAll("svg").length,
      permissionButtonIconCount: permissionButton.querySelectorAll("svg").length,
      modelButtonOverflow: modelButton.scrollWidth > modelButton.clientWidth,
      permissionButtonOverflow:
        permissionButton.scrollWidth > permissionButton.clientWidth,
      modelPickerDeadSpace: modelPickerRect.width - modelButtonRect.width,
      chipGap: permissionButtonRect.left - modelButtonRect.right,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      toolbarPadding: number(toolbarStyle.paddingTop),
      toolbarGap: number(toolbarStyle.columnGap),
      modelButtonHeight: modelButton.getBoundingClientRect().height,
      popoverPadding: number(popoverStyle.paddingTop),
      optionPadding: number(optionStyle.paddingTop),
      optionGap: number(optionStyle.columnGap),
      optionHeight: option.getBoundingClientRect().height,
      iconGeometry,
      overflowX:
        popover.scrollWidth > popover.clientWidth ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

function stableModelPickerMetrics(metrics) {
  const {
    modelButtonBackground: _modelButtonBackground,
    permissionButtonBackground: _permissionButtonBackground,
    ...stableMetrics
  } = metrics;
  return stableMetrics;
}

function expectComposerIconsCentered(metrics) {
  expect(metrics.iconGeometry).toHaveLength(1);
  for (const icon of metrics.iconGeometry) {
    expect(icon.tagName, `${icon.name} must use an SVG icon`).toBe("svg");
    expect(icon.outerAspectDelta, `${icon.name} must use a square slot`).toBeLessThanOrEqual(
      0.1,
    );
    expect(
      icon.buttonCenterDeltaY,
      `${icon.name} must be vertically centered in its control`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      icon.glyphCenterDeltaX,
      `${icon.name} glyph must be centered in its SVG view box`,
    ).toBeLessThanOrEqual(0.75);
    expect(
      icon.glyphCenterDeltaY,
      `${icon.name} glyph must be centered in its SVG view box`,
    ).toBeLessThanOrEqual(0.75);
  }
}
