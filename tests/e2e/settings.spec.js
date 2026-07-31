import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { FILES_HOME_URL } from "./support/file-browser-fixtures.js";
import {
  captureReviewScreenshot,
  mockCodexModels,
} from "./support/task-fixtures.js";

const SETTINGS_KEY = "caffold:settings";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockCodexModels(page);
});

test("normalizes legacy settings into the three appearance axes", async ({
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

  await page.goto("/settings");
  const settingsPage = page.locator("caffold-settings-page");
  await expect(settingsPage).toBeVisible();
  await expect(range(settingsPage, "interfaceScalePercent")).toHaveValue("100");
  await expect(range(settingsPage, "conversationTextPx")).toHaveValue("17");
  await expect(range(settingsPage, "codeTextPx")).toHaveValue("15");

  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SETTINGS_KEY),
    )
    .toEqual({
      appearanceVersion: 2,
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
  await appMenu.locator(".app-menu-button").click();
  const popover = appMenu.locator(".app-menu-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Settings");
  await popover.locator('button[data-action="open-settings"]').click();

  await expect(page).toHaveURL("/settings");
  const settingsPage = page.locator("caffold-settings-page");
  await expect(settingsPage).toBeVisible();
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
      settingsPage.locator(".settings-close-button"),
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

test("applies extreme values to Files and Code without coupling the axes", async ({
  page,
}) => {
  await page.goto("/settings");
  const settingsPage = page.locator("caffold-settings-page");
  await setRange(range(settingsPage, "interfaceScalePercent"), 120);
  await setRange(range(settingsPage, "conversationTextPx"), 13);
  await setRange(range(settingsPage, "codeTextPx"), 20);

  await page.goto(FILES_HOME_URL);
  const rootFontSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const firstEntry = page.locator("caffold-file-list .file-entry").first();
  await expect(firstEntry).toBeVisible();
  const fileMetrics = await firstEntry.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      fontSize: Number.parseFloat(style.fontSize),
      height: box.height,
    };
  });
  expect(fileMetrics.fontSize).toBeCloseTo(rootFontSize * 0.8125, 3);
  const touchInterface = await page.evaluate(
    () =>
      matchMedia("(pointer: coarse)").matches ||
      matchMedia("(max-width: 520px)").matches,
  );
  expect(fileMetrics.height).toBeGreaterThanOrEqual(
    (touchInterface ? 40 : rootFontSize * 1.5) - 0.02,
  );

  await page.locator('button[data-entry-path="src"]').click();
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "font-size",
    "20px",
  );

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
  await page.goto("/settings");
  const settingsPage = page.locator("caffold-settings-page");
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

function range(settingsPage, name) {
  return settingsPage.locator(`input[type="range"][data-setting="${name}"]`);
}

async function setRange(locator, value) {
  await locator.evaluate((element, nextValue) => {
    element.value = `${nextValue}`;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
