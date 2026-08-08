import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "./support/task-fixtures.js";
import {
  headerActionGroupButton,
  expectHeaderBrand,
  openHeaderActionGroup,
  expectHeaderActionsFit,
  expectHeaderButtonOpacity,
  expectHeaderPopoverFits,
  expectHeaderGroupOpenVisualState,
} from "./support/header-actions.js";
import {
  FILES_HOME_URL,
} from "./support/file-browser-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("serves PWA manifest and icon assets", async ({ page, request }) => {
  await page.goto("/");

  const defaultTypeface = await page.evaluate(async () => {
    await document.fonts.load('400 16px "Caffold D2 Coding"');
    return {
      activePreset: document.documentElement.dataset.typefacePreset,
      bodyFamily: getComputedStyle(document.body).fontFamily,
      d2Loaded: document.fonts.check('400 16px "Caffold D2 Coding"'),
      tapHighlightColor: getComputedStyle(document.documentElement)
        .getPropertyValue("-webkit-tap-highlight-color"),
    };
  });
  expect(defaultTypeface).toEqual({
    activePreset: "d2-coding",
    bodyFamily: '"Caffold D2 Coding", ui-monospace, monospace',
    d2Loaded: true,
    tapHighlightColor: "rgba(31, 31, 31, 0.08)",
  });

  const buildInfoResponse = await request.get("/assets/build-info.js");
  expect(buildInfoResponse.headers()["content-type"]).toContain("text/javascript");
  const buildInfo = await buildInfoResponse.text();
  const buildId = buildInfo.match(/id: "([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();

  const healthResponse = await request.get("/api/health");
  const health = await healthResponse.json();
  expect(health.buildId).toBe(buildId);
  expect(health.buildLabel).toBe(buildId);
  await expect(page.locator(".app-build-rail")).toHaveCount(0);
  await expect(page.locator(".app-build-alert")).toBeHidden();

  await page.locator("caffold-app-shell").evaluate((shell) => {
    shell.updateBuildStatus({
      buildId: "stale-server-build",
      buildLabel: "stale-server-build",
    });
  });
  const buildAlert = page.locator(".app-build-alert");
  await expect(buildAlert).toBeVisible();
  await expect(buildAlert).toContainText("New Caffold build available");
  await expect(buildAlert).toContainText("stale-server-build");
  await expect(buildAlert.getByRole("button", { name: "Reload" })).toBeVisible();

  const alertLayout = await page.locator("caffold-app-shell").evaluate((shell) => {
    const main = shell.querySelector(".app-main").getBoundingClientRect();
    const alert = shell.querySelector(".app-build-alert").getBoundingClientRect();
    return { mainBottom: main.bottom, alertTop: alert.top };
  });
  expect(alertLayout.mainBottom).toBeLessThanOrEqual(alertLayout.alertTop + 1);

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/assets/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/assets/icons/caffold.svg",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/assets/icons/apple-touch-icon.png",
  );
  await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(2);
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    "content",
    "default",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#ffffff",
  );

  const manifestResponse = await request.get("/assets/manifest.webmanifest");
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("Caffold");
  expect(manifest.id).toBe("/");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.theme_color).toBe("#ffffff");
  expect(manifest.background_color).toBe("#f5f5f5");
  expect(manifest.icons.map((icon) => icon.src)).toEqual(
    expect.arrayContaining([
      "/assets/icons/caffold.svg",
      "/assets/icons/icon-192.png",
      "/assets/icons/icon-512.png",
      "/assets/icons/maskable-192.png",
      "/assets/icons/maskable-512.png",
    ]),
  );

  const svgResponse = await request.get("/assets/icons/caffold.svg");
  expect(svgResponse.headers()["content-type"]).toContain("image/svg+xml");
  const appIcon = await svgResponse.text();
  expect(appIcon).toContain('filter id="caffold-mark-shadow"');
  expect(appIcon).toContain('<rect width="256" height="256" fill="#f7faf7"/>');
  expect(appIcon).not.toContain('rx="48"');

  const markResponse = await request.get("/assets/icons/caffold-mark.svg");
  expect(markResponse.headers()["content-type"]).toContain("image/svg+xml");
  const markSvg = await markResponse.text();
  expect(markSvg).toContain('viewBox="40 40 176 176"');
  expect(markSvg).not.toContain("<rect");

  const gitBrandResponse = await request.get("/assets/brand/git-logomark-light.svg");
  expect(gitBrandResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await gitBrandResponse.text()).toContain("#100f0d");

  const githubBrandResponse = await request.get(
    "/assets/brand/github-invertocat-light.svg",
  );
  expect(githubBrandResponse.headers()["content-type"]).toContain("image/svg+xml");
  expect(await githubBrandResponse.text()).toContain("<svg");

  const codexBrandResponse = await request.get("/assets/brand/codex-template@2x.png");
  expect(codexBrandResponse.headers()["content-type"]).toContain("image/png");
  const codexBrand = await codexBrandResponse.body();
  expect([...codexBrand.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const pngResponse = await request.get("/assets/icons/icon-192.png");
  expect(pngResponse.headers()["content-type"]).toContain("image/png");
  const png = await pngResponse.body();
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  for (const weight of ["Regular", "Bold"]) {
    const fontResponse = await request.get(
      `/assets/fonts/D2Coding-${weight}.woff2`,
    );
    expect(fontResponse.headers()["content-type"]).toContain("font/woff2");
    const font = await fontResponse.body();
    expect(font.subarray(0, 4).toString()).toBe("wOF2");
  }

  const fontLicenseResponse = await request.get(
    "/assets/fonts/D2Coding-OFL.txt",
  );
  expect(fontLicenseResponse.ok()).toBe(true);
  expect(fontLicenseResponse.headers()["content-type"]).toContain("text/plain");
  expect(await fontLicenseResponse.text()).toContain("SIL OPEN FONT LICENSE");

  const fontsModuleResponse = await request.get("/assets/fonts.js");
  expect(fontsModuleResponse.headers()["content-type"]).toContain(
    "text/javascript",
  );
  expect(await fontsModuleResponse.text()).toContain("TYPEFACE_PRESETS");

  const viewerPresentationResponse = await request.get(
    "/assets/components/file-viewer-presentation.js",
  );
  expect(viewerPresentationResponse.ok()).toBe(true);
  expect(viewerPresentationResponse.headers()["content-type"]).toContain(
    "text/javascript",
  );

  const serviceWorkerResponse = await request.get("/service-worker.js");
  expect(serviceWorkerResponse.headers()["content-type"]).toContain("text/javascript");
  expect(serviceWorkerResponse.headers()["cache-control"]).toContain("no-cache");
  expect(serviceWorkerResponse.headers()["service-worker-allowed"]).toBe("/");
  const serviceWorker = await serviceWorkerResponse.text();
  expect(serviceWorker).toMatch(/const CACHE_NAME = "caffold-shell-v\d+"/);
  expect(serviceWorker).toContain("/assets/icons/caffold-mark.svg");
  expect(serviceWorker).toContain("/assets/brand/git-logomark-light.svg");
  expect(serviceWorker).toContain("/assets/brand/github-invertocat-light.svg");
  expect(serviceWorker).toContain("/assets/brand/codex-template@2x.png");
  expect(serviceWorker).toContain("/assets/pages/layout.js");
  expect(serviceWorker).toContain("/assets/pages/layout.css");
  expect(serviceWorker).toContain("/assets/settings.js");
  expect(serviceWorker).toContain("/assets/fonts.js");
  expect(serviceWorker).toContain("/assets/fonts/D2Coding-Regular.woff2");
  expect(serviceWorker).toContain("/assets/fonts/D2Coding-Bold.woff2");
  expect(serviceWorker).not.toContain("caffold-fonts");
  expect(serviceWorker).toContain("/assets/build-info.js");
  expect(serviceWorker).toContain("/assets/pages/components/app-menu.js");
  expect(serviceWorker).toContain("/assets/pages/components/about-dialog.css");
  expect(serviceWorker).toContain("/assets/pages/components/about-dialog.js");
  expect(serviceWorker).toContain("/assets/pages/settings/page.js");
  expect(serviceWorker).toContain("/assets/pages/components/pathbar.js");
  expect(serviceWorker).not.toContain("project-switcher");
  expect(serviceWorker).toContain("/assets/pages/components/header-actions.js");
  expect(serviceWorker).not.toContain("/assets/components/pathbar.js");
  expect(serviceWorker).not.toContain("/assets/components/project-switcher.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions.js");
  expect(serviceWorker).toContain("/assets/components/file-tree.js");
  expect(serviceWorker).toContain("/assets/components/file-tree.css");
  expect(serviceWorker).toContain("/assets/components/file-browser.js");
  expect(serviceWorker).toContain("/assets/components/file-browser.css");
  expect(serviceWorker).toContain("/assets/components/file-viewer-presentation.js");
  expect(serviceWorker).toContain("/assets/components/file-browser/list.js");
  expect(serviceWorker).toContain("/assets/components/file-browser/list.css");
  expect(serviceWorker).toContain("/assets/components/review-panel-resizer.js");
  expect(serviceWorker).toContain("/assets/components/review-panel-resizer.css");
  expect(serviceWorker).toContain("/assets/components/review-responsive.js");
  expect(serviceWorker).toContain("/assets/watch.js");
  expect(serviceWorker).toContain("/assets/pages/files/page.js");
  expect(serviceWorker).not.toContain("/assets/pages/files/components/list.js");
  expect(serviceWorker).not.toContain("/assets/components/file-list.js");
  expect(serviceWorker).toContain("/assets/pages/(codex)/layout.js");
  expect(serviceWorker).toContain("/assets/pages/(codex)/layout.css");
  expect(serviceWorker).toContain("/assets/pages/(codex)/tasks/page.js");
  expect(serviceWorker).toContain(
    "/assets/pages/(codex)/tasks/components/detail/conversation/command-dialog.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(codex)/tasks/components/detail/conversation/command-dialog.css",
  );
  expect(serviceWorker).toContain("/assets/pages/(codex)/tasks/page.css");
  expect(serviceWorker).toContain(
    "/assets/pages/(codex)/tasks/components/detail/conversation/markdown.js",
  );
  expect(serviceWorker).not.toContain("/assets/pages/tasks/page.js");
  expect(serviceWorker).not.toContain("/assets/pages/tasks/page.css");
  expect(serviceWorker).toContain("/assets/pages/(review-workspace)/layout.js");
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/layout.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/components/controls.css",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/components/controls.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/diff/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/components/git-diff-browser.js",
  );
  expect(serviceWorker).toContain(
    "/assets/components/git-diff-browser/changes-tree.js",
  );
  expect(serviceWorker).not.toContain(
    "/assets/pages/(review-workspace)/(git)/diff/components/changes-tree.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/layout.js",
  );
  expect(serviceWorker).not.toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/list/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/commit/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.js",
  );
  expect(serviceWorker).toContain(
    "/assets/components/git-compare-browser.js",
  );
  expect(serviceWorker).toContain(
    "/assets/components/git-compare-browser/compare-tree.js",
  );
  expect(serviceWorker).not.toContain(
    "/assets/pages/(review-workspace)/(git)/compare/components/compare-tree.js",
  );
  expect(serviceWorker).not.toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/components/list.js",
  );
  expect(serviceWorker).not.toContain(
    "/assets/pages/(review-workspace)/(git)/(log)/components/commit-tree.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/changes-tree.js");
  expect(serviceWorker).not.toContain("/assets/components/log-list.js");
  expect(serviceWorker).not.toContain("/assets/components/commit-changes-tree.js");
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(issues)/layout.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(issues)/list/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(issues)/detail/page.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/github-issues-list.js");
  expect(serviceWorker).not.toContain("/assets/components/github-issue-viewer.js");
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(pulls)/layout.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(pulls)/list/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(pulls)/detail/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(pulls)/files/page.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/(pulls)/files/components/tree.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(github)/components/markdown.js",
  );
  expect(serviceWorker).not.toContain("/assets/components/github-pulls-list.js");
  expect(serviceWorker).not.toContain("/assets/components/github-pull-viewer.js");
  expect(serviceWorker).not.toContain("/assets/components/github-pull-files-tree.js");
  expect(serviceWorker).not.toContain("/assets/components/github-markdown.js");
  expect(serviceWorker).not.toContain("/assets/components/app-shell.js");
  expect(serviceWorker).not.toContain("/assets/components/review-workspace.js");
  expect(serviceWorker).toContain(
    "/assets/pages/components/header-actions/codex-status.css",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/components/header-actions/codex-status.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/components/header-actions/git-status.js",
  );
  expect(serviceWorker).toContain(
    "/assets/pages/components/header-actions/github-status.js",
  );
  expect(serviceWorker).toContain("/assets/pages/components/header-actions/shared.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions/codex-status.css");
  expect(serviceWorker).not.toContain("/assets/components/header-actions/codex-status.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions/git-status.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions/github-status.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions/shared.js");
  expect(serviceWorker).toContain('url.pathname.startsWith("/api/")');
  expect(serviceWorker).toContain("networkFirst(request, \"/\")");
  expect(serviceWorker).toContain('url.pathname.startsWith("/assets/")');
  expect(serviceWorker).toContain("networkFirst(request)");
  expect(serviceWorker).not.toContain("cacheFirst");

  const serviceWorkerScope = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      return null;
    }

    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(serviceWorkerScope).toBe("http://127.0.0.1:18765/");
});

test("keeps build metadata out of normal layout and exposes it in About", async ({
  page,
  context,
  request,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const buildInfoSource = await (await request.get("/assets/build-info.js")).text();
  const buildId = buildInfoSource.match(/id: "([^"]+)"/)?.[1];
  const version = buildInfoSource.match(/version: "([^"]+)"/)?.[1];
  const health = await (await request.get("/api/health")).json();
  expect(buildId).toBeTruthy();
  expect(version).toBeTruthy();

  const normalLayout = await page.locator("caffold-app-shell").evaluate((shell) => {
    const main = shell.querySelector(".app-main").getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      mainBottom: Math.round(main.bottom),
      shellBottom: Math.round(shellRect.bottom),
    };
  });
  expect(normalLayout.mainBottom).toBe(normalLayout.shellBottom);

  const tasksBrand = page.locator("caffold-tasks-page .tasks-brand");
  const brandGeometry = await tasksBrand.evaluate((button) => {
    const heading = button.querySelector("h1");
    const headingText = document.createRange();
    headingText.selectNodeContents(heading);
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      buttonRight: bounds.right,
      headingRight: headingText.getBoundingClientRect().right,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
    };
  });
  expect(brandGeometry.paddingLeft).toBeGreaterThanOrEqual(6);
  expect(brandGeometry.paddingRight).toBeGreaterThanOrEqual(6);
  expect(brandGeometry.paddingLeft).toBeLessThanOrEqual(12);
  expect(brandGeometry.paddingRight).toBeLessThanOrEqual(12);
  expect(brandGeometry.buttonRight - brandGeometry.headingRight).toBeLessThanOrEqual(12);
  await tasksBrand.click();

  const about = page.locator("caffold-about-dialog dialog");
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: "Caffold" })).toBeVisible();
  await expect(about.locator('[data-about-value="version"]')).toHaveText(version);
  await expect(about.locator('[data-about-value="ui-build"]')).toHaveText(buildId);
  await expect(about.locator('[data-about-value="server-build"]')).toHaveText(
    health.buildId,
  );
  await expect(about.locator("time[data-about-built]")).toHaveAttribute(
    "datetime",
    /\d{4}-\d{2}-\d{2}T/,
  );
  await captureReviewScreenshot(page, testInfo, "about-caffold");

  await about.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`UI build: ${buildId}`);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`Server build: ${health.buildId}`);

  await about.getByRole("button", { name: "Done" }).click();
  await expect(about).toBeHidden();
});

test("groups header review actions into Git, GitHub, and Codex popovers", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "main", dirty: true };
  let gitFileCount = 0;
  const githubStatus = {
    repository,
    github: {
      owner: "example",
      name: "caffold",
      nameWithOwner: "example/caffold",
      url: "https://github.com/example/caffold",
    },
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: true,
    pullsAvailable: true,
    message: null,
  };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: Array.from({ length: gitFileCount }, (_, index) => ({
          path: `src/header-${index}.rs`,
          repoRelativePath: `header-${index}.rs`,
          status: " M",
          category: "unstaged",
          staged: false,
          unstaged: true,
          untracked: false,
        })),
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(githubStatus),
    }),
  );

  const openSourceDirectoryWithGitCount = async (count) => {
    gitFileCount = count;
    await page.goto(FILES_HOME_URL);
    const expectedTitle = `Git actions, ${count} changed ${count === 1 ? "file" : "files"}`;
    const gitButton = headerActionGroupButton(page, "git");
    const entryPoint = await page
      .waitForFunction((title) => {
        const git = document.querySelector(
          'caffold-header-actions button[data-action-group="git"]',
        );
        if (git?.getAttribute("title") === title) {
          return "git";
        }

        if (document.querySelector('button[data-file-tree-path="src"]')) {
          return "src";
        }

        return null;
      }, expectedTitle)
      .then((handle) => handle.jsonValue());

    if (entryPoint === "src") {
      const sourceDirectory = page.locator('button[data-file-tree-path="src"]');
      await expect(sourceDirectory).toBeVisible();
      await sourceDirectory.click();
    }
    await expect(gitButton).toHaveAttribute("title", expectedTitle);
  };

  await openSourceDirectoryWithGitCount(0);

  const gitButton = headerActionGroupButton(page, "git");
  const githubButton = headerActionGroupButton(page, "github");
  const codexButton = headerActionGroupButton(page, "codex");
  await expect(gitButton.locator(".header-action-badge")).toHaveCount(0);
  const gitBrandIcon = gitButton.locator("img.header-action-brand-icon");
  const githubBrandIcon = githubButton.locator("img.header-action-brand-icon");
  const codexBrandIcon = codexButton.locator("img.header-action-brand-icon");
  await expect(gitBrandIcon).toBeVisible();
  await expect(githubBrandIcon).toBeVisible();
  await expect(codexBrandIcon).toBeVisible();
  const headerActionGeometry = await page
    .locator("caffold-header-actions .header-action-group-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const icon = button.querySelector(".header-action-icon");
        const controlBox = button.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        return {
          controlWidth: controlBox.width,
          controlHeight: controlBox.height,
          iconWidth: iconBox.width,
          iconHeight: iconBox.height,
          centerDeltaX: Math.abs(
            controlBox.left + controlBox.width / 2 -
              (iconBox.left + iconBox.width / 2),
          ),
          centerDeltaY: Math.abs(
            controlBox.top + controlBox.height / 2 -
              (iconBox.top + iconBox.height / 2),
          ),
        };
      }),
    );
  for (const geometry of headerActionGeometry) {
    expect(geometry.controlWidth).toBeCloseTo(geometry.controlHeight, 1);
    expect(geometry.iconWidth).toBeCloseTo(geometry.iconHeight, 1);
    expect(geometry.centerDeltaX).toBeLessThanOrEqual(0.5);
    expect(geometry.centerDeltaY).toBeLessThanOrEqual(0.5);
  }
  expect(new Set(headerActionGeometry.map(({ iconWidth }) => iconWidth)).size).toBe(1);
  await expect(gitBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/git-logomark-light.svg",
  );
  await expect(githubBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/github-invertocat-light.svg",
  );
  await expect(codexBrandIcon).toHaveAttribute(
    "src",
    "/assets/brand/codex-template@2x.png",
  );
  await expectHeaderBrand(page);
  await expectHeaderActionsFit(page);
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "header-actions-badge-zero");

  await openSourceDirectoryWithGitCount(13);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("13");
  const gitPopover = await openHeaderActionGroup(page, "git");
  await expectHeaderGroupOpenVisualState(page, "git");
  await expect(gitPopover.locator(".header-actions-popover-header")).toContainText(
    "13 changed files",
  );
  await expect(
    gitPopover.locator('button[data-action="open-diff-workspace"] .header-menu-metric'),
  ).toHaveText("13");
  await expect(gitPopover.locator('button[data-action="open-compare-workspace"]')).toContainText(
    "Compare",
  );
  await expect(gitPopover.locator('button[data-action="open-log-workspace"]')).toContainText(
    "Log",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "git");
  await captureReviewScreenshot(page, testInfo, "header-actions-git-popover");

  await openSourceDirectoryWithGitCount(120);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("99+");
  const githubPopover = await openHeaderActionGroup(page, "github");
  await expectHeaderGroupOpenVisualState(page, "github");
  await expect(githubPopover.locator(".header-actions-popover-header")).toContainText(
    "example/caffold",
  );
  await expect(githubPopover.locator('button[data-action="open-github-pulls-workspace"]')).toContainText(
    "PRs",
  );
  await expect(githubPopover.locator('button[data-action="open-github-issues-workspace"]')).toContainText(
    "Issues",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "github");
  await captureReviewScreenshot(page, testInfo, "header-actions-github-popover");

  const codexPopover = await openHeaderActionGroup(page, "codex");
  await expectHeaderGroupOpenVisualState(page, "codex");
  await expect(codexPopover.locator(".header-actions-popover-header")).toContainText(
    "Connected",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText(
    "user@example.com",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText("pro");
  await expect(codexPopover.locator(".header-status-panel")).toContainText(
    "Remaining usage",
  );
  await expect(codexPopover.locator(".header-status-panel")).toContainText("5 hours");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("17%");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("1 week");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("69%");
  await expect(codexPopover.locator(".header-status-panel")).toContainText("3 available");
  await expect(codexPopover.locator('button[data-action="open-tasks"]')).toContainText(
    "Tasks",
  );
  await expect(codexPopover.locator('button[data-action="open-all-tasks"]')).toHaveCount(0);
  await expect(codexPopover.locator('button[data-action="new-task"]')).toContainText(
    "New Task",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "codex");
  await captureReviewScreenshot(page, testInfo, "header-actions-codex-popover");
});

test("keeps header action slots stable while status checks resolve", async ({ page }) => {
  const repository = { rootPath: "src", branch: "main", dirty: false };
  let resolveGitStatus;
  let resolveGithubStatus;
  const gitStatusResponse = new Promise((resolve) => {
    resolveGitStatus = resolve;
  });
  const githubStatusResponse = new Promise((resolve) => {
    resolveGithubStatus = resolve;
  });

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    const body = await gitStatusResponse;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, async (route) => {
    const body = await githubStatusResponse;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(FILES_HOME_URL);
  const sourceDirectory = page.locator('button[data-file-tree-path="src"]');
  await expect(sourceDirectory).toBeVisible();
  await sourceDirectory.click();

  const gitButton = headerActionGroupButton(page, "git");
  const githubButton = headerActionGroupButton(page, "github");
  const codexButton = headerActionGroupButton(page, "codex");
  await expect(gitButton).toBeVisible();
  await expect(githubButton).toBeVisible();
  await expect(codexButton).toBeVisible();
  await expect(gitButton).toHaveAttribute("data-state", "available");
  await expect(gitButton).toHaveAttribute("title", "Git actions, Checking...");
  await expect(githubButton).toHaveAttribute("data-state", "pending");
  await expect(codexButton).toHaveAttribute("data-state", "available");
  await expectHeaderButtonOpacity(page, "git", 1);
  await expectHeaderButtonOpacity(page, "github", 1);

  const githubPendingPopover = await openHeaderActionGroup(page, "github");
  await expect(githubPendingPopover).toContainText("Checking GitHub status");

  resolveGithubStatus({
    repository,
    github: null,
    ghAvailable: true,
    authenticated: true,
    issuesAvailable: false,
    pullsAvailable: false,
    message: "No GitHub remote detected",
  });
  await expect(githubButton).toHaveAttribute("data-state", "unavailable");
  await expect(githubButton).toHaveAttribute("title", "No GitHub remote detected");
  await expectHeaderButtonOpacity(page, "github", 0.72);
  await expect(githubPendingPopover).toContainText("No GitHub remote detected");
  await expect(
    githubPendingPopover.locator('button[data-action="open-github-pulls-workspace"]'),
  ).toHaveCount(0);

  resolveGitStatus({
    repository,
    files: Array.from({ length: 7 }, (_, index) => ({
      path: `src/pending-${index}.rs`,
      repoRelativePath: `pending-${index}.rs`,
      status: " M",
      category: "unstaged",
      staged: false,
      unstaged: true,
      untracked: false,
    })),
  });
  await expect(gitButton).toHaveAttribute("data-state", "available");
  await expect(gitButton).toHaveAttribute("title", "Git actions, 7 changed files");
  await expect(gitButton.locator(".header-action-badge")).toHaveText("7");
  await expectHeaderActionsFit(page);
});
