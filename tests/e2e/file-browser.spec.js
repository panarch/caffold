import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LAST_DIRECTORY_KEY = `caffold:last-directory-path:${resolve("tests/fixtures/home")}`;
const LONG_ROOT_FILE =
  "this-is-a-very-long-file-name-used-to-test-horizontal-scrolling-in-the-files-pane.md";
const LONG_CHANGE_FILE =
  "src/planner/this-is-a-very-long-change-file-name-used-to-test-horizontal-scrolling-in-the-changes-pane.rs";

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    }),
  );

  await page.route("https://esm.sh/**", (route) => {
    if (route.request().url() === "https://esm.sh/marked@15.0.12") {
      return route.fulfill({
        contentType: "text/javascript",
        body: `
          const escapeHtml = (value) => value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          const inline = (value) => value
            .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
            .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
            .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
          export const marked = {
            parse(source) {
              const escaped = escapeHtml(source);
              const blocks = escaped.split(/\\n{2,}/);
              return blocks.map((block) => {
                if (block.startsWith("\\x60\\x60\\x60")) {
                  const lines = block.split("\\n");
                  return '<pre><code>' + lines.slice(1, -1).join("\\n") + '</code></pre>';
                }
                const heading = block.match(/^(#{1,6}) (.+)$/);
                if (heading) {
                  const level = heading[1].length;
                  return '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
                }
                const lines = block.split("\\n");
                if (lines.every((line) => line.startsWith("- "))) {
                  return '<ul>' + lines.map((line) => '<li>' + inline(line.slice(2)) + '</li>').join("") + '</ul>';
                }
                if (lines.length >= 2 && lines[0].startsWith("|") && lines[1].includes("---")) {
                  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
                  const header = cells(lines[0]);
                  const rows = lines.slice(2).map(cells);
                  return '<table><thead><tr>' + header.map((cell) => '<th>' + inline(cell) + '</th>').join("") + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join("") + '</tr>').join("") + '</tbody></table>';
                }
                return '<p>' + inline(lines.join(" ")) + '</p>';
              }).join("");
            },
          };
        `,
      });
    }

    if (route.request().url() !== "https://esm.sh/lucide@1.22.0") {
      return route.abort();
    }

    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export const File = [["path", { d: "M6 3h8l4 4v14H6z" }]];
        export const FileArchive = File;
        export const FileCode = [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "m10 9-3 3 3 3" }], ["path", { d: "m14 9 3 3-3 3" }]];
        export const FileCog = File;
        export const FileDiff = FileCode;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [["path", { d: "M6 3h12v18H6z" }], ["path", { d: "M9 8h6" }], ["path", { d: "M9 12h6" }]];
        export const CircleAlert = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 8v4" }], ["path", { d: "M12 16h.01" }]];
        export const CircleCheck = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m8 12 2.5 2.5L16 9" }]];
        export const CircleDot = [["circle", { cx: "12", cy: "12", r: "10" }], ["circle", { cx: "12", cy: "12", r: "2" }]];
        export const CircleSlash = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m5 5 14 14" }]];
        export const ChevronFirst = [["path", { d: "m17 18-6-6 6-6" }], ["path", { d: "M7 6v12" }]];
        export const ChevronLast = [["path", { d: "m7 18 6-6-6-6" }], ["path", { d: "M17 6v12" }]];
        export const ChevronLeft = [["path", { d: "m15 18-6-6 6-6" }]];
        export const ChevronRight = [["path", { d: "m9 18 6-6-6-6" }]];
        export const Folder = [["path", { d: "M3 6h7l2 2h9v10H3z" }]];
        export const FolderGit2 = Folder;
        export const FolderOpen = Folder;
        export const FolderSymlink = Folder;
        export const GitCompare = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["path", { d: "M6 9v7a2 2 0 0 0 2 2h3" }]];
        export const GitPullRequest = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M6 9v12" }], ["path", { d: "M18 15V5" }], ["path", { d: "M18 5h-5" }]];
        export const ArrowLeft = [
          ["path", { d: "m12 19-7-7 7-7" }],
          ["path", { d: "M19 12H5" }],
        ];
        export const History = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }], ["path", { d: "M12 7v5l3 2" }]];
        export const Info = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]];
        export const ListTodo = [["rect", { x: "3", y: "5", width: "6", height: "6", rx: "1" }], ["path", { d: "M13 7h8" }], ["path", { d: "M13 15h8" }], ["path", { d: "m4 16 2 2 4-4" }]];
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];
        export const PanelTopOpen = [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }]];
        export const Pencil = [["path", { d: "M17 3a2.8 2.8 0 0 1 4 4L7 21H3v-4z" }]];
        export const Plus = [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]];
        export const RefreshCw = [["path", { d: "M20 6v5h-5" }], ["path", { d: "M4 18v-5h5" }], ["path", { d: "M18.4 9A7 7 0 0 0 6 6.6L4 9" }], ["path", { d: "M5.6 15A7 7 0 0 0 18 17.4l2-2.4" }]];
        export const Settings = [["path", { d: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" }], ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.09.38.3.73.6 1 .3.27.68.4 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z" }]];
        export const Square = [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "1" }]];
        export const TriangleAlert = [["path", { d: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]];
        export const Trash2 = [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }]];
        export const X = [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]];
        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            ...attrs,
          };
          for (const [name, value] of Object.entries(baseAttrs)) {
            svg.setAttribute(name, String(value));
          }
          for (const [tag, childAttrs] of iconNode) {
            const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [name, value] of Object.entries(childAttrs)) {
              child.setAttribute(name, String(value));
            }
            svg.appendChild(child);
          }
          return svg;
        }
      `,
    });
  });
});

test("serves PWA manifest and icon assets", async ({ page, request }) => {
  await page.goto("/");

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
  expect(serviceWorker).toContain("/assets/pages/components/app-menu.js");
  expect(serviceWorker).toContain("/assets/pages/settings/page.js");
  expect(serviceWorker).toContain("/assets/pages/components/pathbar.js");
  expect(serviceWorker).toContain("/assets/pages/components/project-switcher.js");
  expect(serviceWorker).toContain("/assets/pages/components/header-actions.js");
  expect(serviceWorker).not.toContain("/assets/components/pathbar.js");
  expect(serviceWorker).not.toContain("/assets/components/project-switcher.js");
  expect(serviceWorker).not.toContain("/assets/components/header-actions.js");
  expect(serviceWorker).toContain("/assets/components/file-browser.js");
  expect(serviceWorker).toContain("/assets/components/file-browser.css");
  expect(serviceWorker).toContain("/assets/components/file-browser/list.js");
  expect(serviceWorker).toContain("/assets/components/file-browser/list.css");
  expect(serviceWorker).toContain("/assets/watch.js");
  expect(serviceWorker).toContain("/assets/pages/files/page.js");
  expect(serviceWorker).not.toContain("/assets/pages/files/components/list.js");
  expect(serviceWorker).not.toContain("/assets/components/file-list.js");
  expect(serviceWorker).toContain("/assets/pages/(codex)/layout.js");
  expect(serviceWorker).toContain("/assets/pages/(codex)/layout.css");
  expect(serviceWorker).toContain("/assets/pages/(codex)/tasks/page.js");
  expect(serviceWorker).toContain("/assets/pages/(codex)/tasks/page.css");
  expect(serviceWorker).toContain(
    "/assets/pages/(codex)/tasks/components/markdown.js",
  );
  expect(serviceWorker).not.toContain("/assets/pages/tasks/page.js");
  expect(serviceWorker).not.toContain("/assets/pages/tasks/page.css");
  expect(serviceWorker).toContain("/assets/pages/(review-workspace)/layout.js");
  expect(serviceWorker).toContain(
    "/assets/pages/(review-workspace)/(git)/layout.js",
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

test("opens browser-local settings and persists viewer sizes", async ({ page }, testInfo) => {
  await page.goto("/");

  const appMenu = page.locator("caffold-app-menu");
  await appMenu.locator(".app-menu-button").click();
  const popover = appMenu.locator(".app-menu-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Settings");
  await captureReviewScreenshot(page, testInfo, "app-menu-popover");
  await popover.locator('button[data-action="open-settings"]').click();

  await expect(page).toHaveURL("/settings");
  const settingsPage = page.locator("caffold-settings-page");
  await expect(settingsPage).toBeVisible();
  await expect(page.locator("caffold-pathbar")).toBeHidden();
  await expect(page.locator("caffold-files-page")).toBeHidden();

  const compact = settingsPage.locator(
    'button[data-action="set-file-tree-size"][data-value="compact"]',
  );
  const previewRow = settingsPage.locator(".settings-preview-row").first();
  const previewIcon = previewRow.locator(".settings-preview-icon");
  await settingsPage
    .locator('button[data-action="set-file-tree-size"][data-value="default"]')
    .click();
  await expect(previewRow).toHaveCSS("min-height", "30px");
  await expect(previewIcon).toHaveCSS("width", "18px");
  await compact.click();
  await expect(compact).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.fileTreeSize),
    )
    .toBe("compact");
  await expect(settingsPage.locator(".settings-tree-preview")).toHaveCSS("font-size", "13px");
  await expect(previewRow).toHaveCSS("min-height", "24px");
  await expect(previewIcon).toHaveCSS("width", "15px");

  const codePreview = settingsPage.locator(".settings-code-preview");
  const largeCode = settingsPage.locator(
    'button[data-action="set-code-size"][data-value="large"]',
  );
  await expect(codePreview).toHaveCSS("font-size", "13px");
  await settingsPage
    .locator('button[data-action="set-code-size"][data-value="default"]')
    .click();
  await expect(codePreview).toHaveCSS("font-size", "15px");
  await largeCode.click();
  await expect(largeCode).toHaveAttribute("aria-checked", "true");
  await expect(codePreview).toHaveCSS("font-size", "17px");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.codeSize))
    .toBe("large");

  await captureReviewScreenshot(page, testInfo, "settings-appearance");
  await page.reload();
  await expect(page).toHaveURL("/settings");
  await expect(
    settingsPage.locator(
      'button[data-action="set-file-tree-size"][data-value="compact"]',
    ),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    settingsPage.locator('button[data-action="set-code-size"][data-value="large"]'),
  ).toHaveAttribute("aria-checked", "true");
  await settingsPage.locator('button[data-action="close-settings"]').click();
  await expect(page).toHaveURL("/");
  await expect(page.locator("caffold-file-list .file-entry").first()).toHaveCSS(
    "font-size",
    "13px",
  );
  await expect(page.locator("caffold-file-list .file-entry").first()).toHaveCSS(
    "min-height",
    "24px",
  );
  await expect(page.locator("caffold-file-list .entry-icon-svg").first()).toHaveCSS(
    "width",
    "15px",
  );
  await page.locator('button[data-entry-path="src"]').click();
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.locator("caffold-code-viewer .code-lines")).toHaveCSS(
    "font-size",
    "17px",
  );
  const codeLineHeight = await page
    .locator("caffold-code-viewer .code-lines")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
  expect(codeLineHeight).toBeGreaterThan(25);
  expect(codeLineHeight).toBeLessThan(30);

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
    "17px",
  );
});

test("delays file list loading feedback", async ({ page }) => {
  let resolveListRequest;
  let releaseListResponse;
  const listRequested = new Promise((resolve) => {
    resolveListRequest = resolve;
  });
  const listReleased = new Promise((resolve) => {
    releaseListResponse = resolve;
  });

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    resolveListRequest();
    await listReleased;
    await route.continue();
  });

  await page.goto("/");
  await listRequested;

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await page.waitForTimeout(120);
  await expect(page.getByText("Loading files...")).toHaveCount(0);

  await page.waitForTimeout(90);
  await expect(page.getByText("Loading files...")).toBeVisible();

  releaseListResponse();
  await expect(page.locator("caffold-file-list")).toContainText("src");
});

test("keeps the file list visible while project metadata refresh is slow", async ({ page }) => {
  let releaseProjectResponses;
  const projectResponsesReleased = new Promise((resolve) => {
    releaseProjectResponses = resolve;
  });

  await page.route(/\/api\/(?:projects|project-candidate)(?:\?|$)/, async (route) => {
    await projectResponsesReleased;
    await route.continue();
  });

  await page.goto("/");
  await expect(page.locator("caffold-file-list")).toContainText("src");

  await page.waitForTimeout(240);
  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("caffold-file-list")).toContainText("src");

  releaseProjectResponses();
});

test("browses directories and opens a source file", async ({ page }, testInfo) => {
  await page.goto("/");

  await expect(page.getByText("Loading files...")).toHaveCount(0);
  await expect(page.locator("caffold-file-list")).toContainText(".caffold-hidden");
  await expect(page.locator("caffold-file-list")).toContainText("src");
  await expect(page.locator('button[data-entry-path="src"] .entry-icon')).toHaveAttribute(
    "title",
    "Git repository",
  );
  await expect(page.locator('button[data-entry-path=".caffold-hidden"]')).toHaveClass(
    /is-hidden/,
  );
  await expect(page.locator(".parent-entry")).toHaveCount(0);

  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator(".parent-entry")).toBeVisible();
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();
  await expect(page.locator("caffold-file-list .git-summary")).toHaveClass(/is-dirty/);
  await expect(page.locator('button[data-entry-path="src/ignored.log"]')).toHaveClass(
    /is-ignored/,
  );
  await expect(page.locator('button[data-entry-path="src/ignored.log"]')).toHaveAttribute(
    "title",
    "Ignored by Git",
  );
  await expect(page.locator('button[data-entry-path="src/ignored-output"]')).toHaveClass(
    /is-ignored/,
  );
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toHaveCount(0);
  await expect(page.locator("caffold-file-list .entry-icon-svg").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh files" })).toBeVisible();

  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page.getByText("Loading file...")).toHaveCount(0);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");
  await expect(page.locator("caffold-code-viewer")).not.toContainText("Highlighted");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expect(page.getByRole("button", { name: "Refresh file", exact: true })).toBeVisible();
  await expectGlobalScrollLocked(page);
  await expectPanelScrollContainers(page);
  await page.getByRole("button", { name: "Show details for example.rs" }).click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details).toBeVisible();
  await expect(details.locator('[data-field="path"] dd')).toHaveText("src/example.rs");
  await expect(details.locator('[data-field="language"] dd')).toHaveText("Rust");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page.locator("caffold-file-list")).toBeVisible();
    await expect(page.locator("caffold-file-viewer")).toBeHidden();
  }
  await page.locator('button[data-entry-path="src/planner"]').click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.locator('button[data-entry-path="src/planner/mod.rs"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("mod.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("plan_review");
  await expect(page.locator(".line-number").first()).toHaveText("1");

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "file-browser");
});

test("refreshes Files and Git after external filesystem changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Native watcher smoke runs once on desktop.");

  const suffix = `${process.pid}-${Date.now()}`;
  const repositoryRelativePath = `src/ignored-output/live-repository-${suffix}`;
  const repositoryPath = resolve("tests/fixtures/home", repositoryRelativePath);
  const firstName = `live-${suffix}.txt`;
  const renamedName = `live-${suffix}-renamed.txt`;
  const firstLogicalPath = `${repositoryRelativePath}/${firstName}`;
  const renamedLogicalPath = `${repositoryRelativePath}/${renamedName}`;
  const firstPath = resolve(repositoryPath, firstName);
  const renamedPath = resolve(repositoryPath, renamedName);

  await rm(repositoryPath, { recursive: true, force: true });
  await mkdir(resolve(repositoryPath, "nested"), { recursive: true });
  await writeFile(resolve(repositoryPath, "nested/fixture.txt"), "nested fixture\n");
  execFileSync("git", ["init", "--quiet", repositoryPath]);
  const project = await mockRegisteredProject(page, {
    id: `prj_live_${suffix}`,
    name: "Live repository",
    rootPath: repositoryPath,
    relativePath: repositoryRelativePath,
  });

  try {
    await page.goto(`/projects/${project.id}/files`);
    await page.waitForTimeout(500);

    const nestedPath = `${repositoryRelativePath}/nested`;
    const nestedFixturePath = `${nestedPath}/fixture.txt`;
    await page.locator(`button[data-entry-path="${nestedPath}"]`).click();
    await expect(page.locator(`button[data-entry-path="${nestedFixturePath}"]`)).toBeVisible();
    const resizeHandle = page.locator("caffold-file-browser > .panel-resizer");
    await dragHorizontalResizer(page, resizeHandle, 72);
    const resizedPanelWidth = await elementWidth(page, "caffold-file-list");
    const headerActions = page.locator("caffold-header-actions");
    await headerActions.evaluate((element) => {
      element.dataset.liveRefreshProbe = "kept";
    });

    const initialContent = Array.from(
      { length: 80 },
      (_, index) => `first live line ${index + 1} ${"wide-content-".repeat(16)}`,
    ).join("\n");
    await writeFile(firstPath, `${initialContent}\n`);
    const firstEntry = page.locator(`button[data-entry-path="${firstLogicalPath}"]`);
    await expect(firstEntry).toBeVisible();
    await expect(headerActions).toHaveAttribute(
      "data-live-refresh-probe",
      "kept",
    );
    await expect(page.locator(`button[data-entry-path="${nestedFixturePath}"]`)).toBeVisible();
    expect(await elementWidth(page, "caffold-file-list")).toBeCloseTo(resizedPanelWidth, 0);
    await firstEntry.click();
    await expect(page.locator("caffold-code-viewer")).toContainText("first live line 80");

    const codeScroller = page.locator("caffold-code-viewer .code-lines");
    const beforeScroll = await codeScroller.evaluate((element) => {
      element.scrollTop = 180;
      element.scrollLeft = 240;
      return { top: element.scrollTop, left: element.scrollLeft };
    });
    expect(beforeScroll.top).toBeGreaterThan(0);
    expect(beforeScroll.left).toBeGreaterThan(0);

    await writeFile(firstPath, `${initialContent}\nsecond live line\n`);
    await expect(page.locator("caffold-code-viewer")).toContainText("second live line");
    const afterScroll = await codeScroller.evaluate((element) => ({
      top: element.scrollTop,
      left: element.scrollLeft,
    }));
    expect(afterScroll.top).toBeGreaterThanOrEqual(beforeScroll.top - 2);
    expect(afterScroll.left).toBeGreaterThanOrEqual(beforeScroll.left - 2);

    await rename(firstPath, renamedPath);
    await expect(page.locator(`button[data-entry-path="${renamedLogicalPath}"]`)).toBeVisible();
    await expect(page.locator("caffold-file-viewer")).toContainText("path was not found");

    const renamedEntry = page.locator(`button[data-entry-path="${renamedLogicalPath}"]`);
    await renamedEntry.click();
    await expect(page.locator("caffold-code-viewer")).toContainText("second live line");

    const gitPopover = await openHeaderActionGroup(page, "git");
    await gitPopover.locator('button[data-action="open-diff-workspace"]').click();
    const diffEntry = page.locator(`button[data-change-path="${renamedLogicalPath}"]`);
    await expect(diffEntry).toBeVisible();
    await diffEntry.click();
    await expect(page.locator("caffold-diff-viewer")).toContainText("second live line");
    const workspace = page.locator("caffold-review-workspace");
    await workspace.evaluate((element) => {
      element.dataset.liveRefreshProbe = "kept";
    });

    await writeFile(renamedPath, "first live line\nsecond live line\nthird live line\n");
    await expect(page.locator("caffold-diff-viewer")).toContainText("third live line");
    await expect(workspace).toHaveAttribute("data-live-refresh-probe", "kept");

    await rm(renamedPath, { force: true });
    await expect(diffEntry).toHaveCount(0);
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toContainText(
      "This file no longer has uncommitted changes.",
    );
  } finally {
    await page.goto("/");
    await page.waitForTimeout(100);
    await rm(repositoryPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("keeps manual Files refresh available when live updates fail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Watcher fallback visual runs once on desktop.");
  let listRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/list") {
      listRequests += 1;
    }
  });
  await page.route(/\/api\/watch(?:\?|$)/, (route) => route.abort("failed"));

  await page.goto("/");
  const refresh = page.getByRole("button", {
    name: "Live updates unavailable. Refresh manually.",
  });
  await expect(refresh).toBeVisible();
  const beforeRefresh = listRequests;
  await refresh.click();
  await expect.poll(() => listRequests).toBeGreaterThan(beforeRefresh);
  await captureReviewScreenshot(page, testInfo, "files-live-updates-unavailable");
});

test("manages project records from the header switcher", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Project switcher CRUD is covered on desktop.");
  await mockProjectCrudApi(page);

  await page.goto("/");
  const switcher = page.locator("caffold-project-switcher");

  await expect(switcher.locator(".project-switcher-button")).toContainText("Register");
  await openProjectPopover(switcher);
  await expect(switcher.locator(".project-candidate")).toContainText("home");
  await page.keyboard.press("Escape");

  await page.locator('button[data-entry-path="src"]').click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("Register");

  await openProjectPopover(switcher);
  await expect(switcher.locator(".project-candidate")).toContainText("src");
  await switcher.locator(".project-candidate button").click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("src");
  await expect(switcher.locator(".project-popover")).toBeHidden();

  await openProjectPopover(switcher);
  await switcher.getByRole("button", { name: "Rename src" }).click();
  await switcher.locator('input[name="name"]').fill("Fixture Repo");
  await switcher.getByRole("button", { name: "Save" }).click();
  await expect(switcher.locator(".project-switcher-button")).toContainText("Fixture Repo");
  await page.keyboard.press("Escape");

  await page.locator('caffold-pathbar button[data-path=""]').click();
  await expect(page.locator("caffold-pathbar")).not.toContainText("src");
  await openProjectPopover(switcher);
  await switcher.locator(".project-open").filter({ hasText: "Fixture Repo" }).click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(switcher.locator(".project-popover")).toBeHidden();

  await page.reload();
  await openProjectPopover(switcher);
  const projectRow = switcher.locator(".project-row").filter({ hasText: "Fixture Repo" });
  await expect(projectRow).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await projectRow.getByRole("button", { name: "Delete Fixture Repo" }).click();
  await expect(switcher.locator(".project-row").filter({ hasText: "Fixture Repo" })).toHaveCount(
    0,
  );
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
    await page.goto("/");
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

        if (document.querySelector('button[data-entry-path="src"]')) {
          return "src";
        }

        return null;
      }, expectedTitle)
      .then((handle) => handle.jsonValue());

    if (entryPoint === "src") {
      const sourceDirectory = page.locator('button[data-entry-path="src"]');
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
    "Open Tasks",
  );
  await expect(codexPopover.locator('button[data-action="open-all-tasks"]')).toContainText(
    "All Tasks",
  );
  await expect(codexPopover.locator('button[data-action="new-task"]')).toContainText(
    "New Task",
  );
  await expectHeaderActionsFit(page);
  await expectHeaderPopoverFits(page, "codex");
  await captureReviewScreenshot(page, testInfo, "header-actions-codex-popover");
});

test("opens global Tasks without a registered project", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
      }

      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  await page.route(/\/api\/projects(?:\?|$)/, (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    });
  });
  await page.route(/\/api\/project-candidate(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidate: null }),
    }),
  );

  const threadId = "thread_global_fixture";
  let createdTaskRequest = null;
  const task = {
    id: threadId,
    threadId,
    projectId: null,
    activeTurnId: null,
    title: "Global task",
    preview: "Hello without a registered project",
    status: "completed",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree: null,
    createdMs: 1_767_200_000_000,
    updatedMs: 1_767_200_000_000,
    recencyMs: 1_767_200_000_000,
    lastEventSummary: "Assistant response",
  };
  const detail = {
    task,
    events: [
      {
        id: "event_prompt",
        threadId,
        projectId: "",
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Say hello globally" },
        createdMs: task.createdMs,
      },
      {
        id: "event_answer",
        threadId,
        projectId: "",
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Hello from a global Codex thread." },
        createdMs: task.createdMs + 1,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  const taskListQueries = [];

  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      taskListQueries.push({
        projectId: url.searchParams.get("projectId"),
        cwd: url.searchParams.get("cwd"),
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createdTaskRequest = request.postDataJSON();
      expect(createdTaskRequest.projectId).toBeUndefined();
      expect(createdTaskRequest.cwd).toBe(".");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      expect(url.searchParams.get("projectId")).toBe(null);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    return route.continue();
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        additions: 1,
        deletions: 0,
        files: [
          {
            path: "README.md",
            repoRelativePath: "README.md",
            status: "??",
            category: "untracked",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      }),
    }),
  );
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    expect(url.searchParams.get("file")).toBe("README.md");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        path: "README.md",
        repoRelativePath: "README.md",
        kind: "untracked",
        diff: [
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1 @@",
          "+Global worktree review",
        ].join("\n"),
      }),
    });
  });

  await page.goto("/");
  const scopedCodexPopover = await openHeaderActionGroup(page, "codex");
  await scopedCodexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL("/tasks?cwd=.");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ projectId: null, cwd: "." });
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".tasks-header")).toContainText("Threads in ~");
  await expect(tasksPage).toContainText("No tasks yet.");
  await page
    .locator("caffold-codex-workspace")
    .getByRole("button", { name: "Close Codex workspace" })
    .click();
  await expect(page).toHaveURL("/");

  const allTasksCodexPopover = await openHeaderActionGroup(page, "codex");
  await allTasksCodexPopover.locator('button[data-action="open-all-tasks"]').click();
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ projectId: null, cwd: null });
  await expect(tasksPage.locator(".tasks-header")).toContainText("All Codex threads");
  await expect(tasksPage).toContainText("No tasks yet.");
  await page
    .locator("caffold-codex-workspace")
    .getByRole("button", { name: "Close Codex workspace" })
    .click();
  await expect(page).toHaveURL("/");

  const reopenedScopedCodexPopover = await openHeaderActionGroup(page, "codex");
  await reopenedScopedCodexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL("/tasks?cwd=.");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ projectId: null, cwd: "." });

  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL("/tasks/new?cwd=.");
  await tasksPage.locator('textarea[name="prompt"]').fill("Say hello globally");
  await tasksPage.locator('textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createdTaskRequest?.prompt).toBe("Say hello globally");
  await expect(page).toHaveURL(`/tasks/${threadId}?cwd=.`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");
  const openDiff = tasksPage.getByRole("button", { name: "Open Diff" });
  await expect(openDiff).toBeDisabled();
  await expect(tasksPage).toContainText("Diff is unavailable outside a Git worktree.");

  Object.assign(task, {
    worktree: {
      rootPath: ".",
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
  });
  await page.reload();
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main");

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFiles = tasksPage.locator(".task-files-view");
  await expect(
    taskFiles.locator('button[data-entry-path="README.md"]'),
  ).toBeVisible();
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );

  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  const taskDiff = tasksPage.locator(".task-diff-view");
  const readmeChange = taskDiff.locator(
    'caffold-git-diff-changes-tree button[data-repo-relative-path="README.md"]',
  );
  await expect(readmeChange).toBeVisible();
  await readmeChange.click();
  await expect(
    taskDiff.locator(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
    ),
  ).toContainText("Global worktree review");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
});

test("opens Tasks from Codex header and runs a minimal task loop", async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve(),
      },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });

  const project = await mockRegisteredProject(page);
  await mockCodexModels(page);
  const now = 1_767_000_000_000;
  let task = null;
  let events = [];
  let createTaskRequests = 0;
  let taskDetailReadRequests = 0;
  let approvalRequests = 0;
  let gitStatusRequests = 0;
  let gitRefsRequests = 0;
  let gitCompareRequests = 0;
  let gitCompareDiffRequests = 0;
  let includeTaskDiffLiveFile = false;
  let resolveFollowUpRequest;
  let releaseFollowUpResponse;
  const followUpRequested = new Promise((resolve) => {
    resolveFollowUpRequest = resolve;
  });
  const followUpResponseReleased = new Promise((resolve) => {
    releaseFollowUpResponse = resolve;
  });
  const threadId = "thread_12345678";
  const completedAssistantResponse = [
    "## Review ready",
    "",
    "The planner changes are **ready** to review. Open `Diff` next.",
    "",
    "- Verified planner behavior",
    "- Confirmed fixture coverage",
    "",
    "```text",
    "cargo test",
    "```",
    "",
    "한국어와 English가 함께 있는 결과입니다. [Planner notes](https://example.com/planner)",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Planner | Pass |",
    "",
    `Long token: ${"planner".repeat(24)}`,
    "",
    "Malformed **marker stays readable.",
    "",
    ...Array.from(
      { length: 36 },
      (_, index) =>
        `Review note ${index + 1}: verified planner behavior and fixture coverage.`,
    ),
  ].join("\n");

  const eventRecord = (id, type, summary, payload = null, offset = 0) => ({
    id,
    threadId,
    projectId: project.id,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const detailResponse = (overrides = {}) => ({
    task,
    events,
    eventsPage: { nextCursor: null, ...(overrides.eventsPage ?? {}) },
    pendingApprovals: [],
  });
  const updateTask = (updates) => {
    task = {
      ...task,
      ...updates,
      updatedMs: now + events.length + 1,
      lastEventSummary: updates.lastEventSummary ?? task.lastEventSummary,
    };
  };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: includeTaskDiffLiveFile ? 6 : 5,
        deletions: 4,
        files: [
          {
            path: "src/planner.rs",
            repoRelativePath: "planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/tests/planner.rs",
            repoRelativePath: "tests/planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/lib.rs",
            repoRelativePath: "lib.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/unrelated.rs",
            repoRelativePath: "unrelated.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          ...(includeTaskDiffLiveFile
            ? [
                {
                  path: "src/live-update.rs",
                  repoRelativePath: "live-update.rs",
                  status: "??",
                  category: "untracked",
                  staged: false,
                  unstaged: false,
                  untracked: true,
                },
              ]
            : []),
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: url.searchParams.get("kind"),
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          "index 1111111..2222222 100644",
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old planner behavior",
          "+new planner behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    gitRefsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "origin/release", kind: "remote" },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const baseRef = url.searchParams.get("base");
    const path = baseRef === "origin/release" ? "src/release.rs" : "src/planner.rs";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        baseRef,
        headRef: "main",
        additions: baseRef === "origin/release" ? 7 : 3,
        deletions: baseRef === "origin/release" ? 2 : 1,
        files: [
          {
            path,
            repoRelativePath: path.replace(/^src\//, ""),
            status: baseRef === "origin/release" ? "A" : "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    gitCompareDiffRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: `${url.searchParams.get("base")}...main`,
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old branch behavior",
          "+new branch behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      expect(url.searchParams.get("projectId")).toBe(null);
      expect(url.searchParams.get("cwd")).toBe(project.relativePath);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: task ? [task] : [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createTaskRequests += 1;
      const body = request.postDataJSON();
      expect(body.projectId).toBeUndefined();
      expect(body.cwd).toBe(project.relativePath);
      expect(body.prompt).toBe("Inspect the planner changes");
      expect(body.model).toBe("gpt-5.5");
      expect(body.effort).toBe("high");
      task = {
        id: threadId,
        threadId,
        projectId: project.id,
        activeTurnId: "turn_1",
        title: "Inspect the planner changes",
        preview: "Inspect the planner changes",
        status: "waiting_for_approval",
        cwd: "src",
        cwdPath: "src",
        relativeCwd: "",
        worktree: {
          rootPath: "src",
          branch: "main",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          relativeCwd: "",
          linked: false,
        },
        createdMs: now,
        updatedMs: now + 4,
        recencyMs: now + 4,
        lastEventSummary: "Command approval requested",
      };
      events = [
        eventRecord("event_1", "prompt_sent", "Prompt sent", { prompt: body.prompt }, 1),
        eventRecord(
          "event_1_user",
          "user_message",
          "User prompt",
          { text: body.prompt, turnId: "turn_1" },
          2,
        ),
        eventRecord(
          "event_2",
          "thread_started",
          "Thread started",
          { threadId: "thread_12345678" },
          3,
        ),
        eventRecord("event_3", "turn_started", "Turn started", { turnId: "turn_1" }, 4),
        eventRecord(
          "event_4",
          "approval_requested",
          "Command approval requested",
          {
            approvalId: "approval_1",
            kind: "command",
            method: "item/commandExecution/requestApproval",
            params: {
              command: "cargo test",
              cwd: "src",
              reason: "Run the test suite",
              availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
            },
          },
          5,
        ),
      ];

      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      expect(url.searchParams.get("projectId")).toBe(null);
      taskDetailReadRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "prompts" &&
      method === "POST"
    ) {
      expect(url.searchParams.get("projectId")).toBe(null);
      const body = request.postDataJSON();
      expect(body.prompt).toBe("Please tighten the tests");
      expect(body.model).toBe("gpt-5.5");
      expect(body.effort).toBe("ultra");
      resolveFollowUpRequest();
      await followUpResponseReleased;
      events = [
        ...events,
        eventRecord(
          "event_6",
          "prompt_sent",
          "Follow-up prompt sent",
          { prompt: body.prompt },
          6,
        ),
      ];
      updateTask({ status: "running", lastEventSummary: "Follow-up prompt sent" });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "interrupt" &&
      method === "POST"
    ) {
      expect(url.searchParams.get("projectId")).toBe(null);
      events = [
        ...events,
        eventRecord("event_7", "turn_interrupted", "Interrupt requested", null, 7),
      ];
      updateTask({
        activeTurnId: null,
        status: "interrupted",
        lastEventSummary: "Interrupt requested",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === threadId &&
      segments[3] === "approvals" &&
      segments[4] === "approval_1" &&
      method === "POST"
    ) {
      approvalRequests += 1;
      expect(url.searchParams.get("projectId")).toBe(null);
      const body = request.postDataJSON();
      expect(body.decision).toBe("accept");
      events = [
        ...events,
        eventRecord(
          "event_5",
          "approval_resolved",
          "Approval resolved: accept",
          { approvalId: "approval_1", decision: "accept", turnId: "turn_1" },
          5,
        ),
        eventRecord(
          "event_8_progress",
          "assistant_message",
          "Assistant response",
          {
            text: "I am checking the planner diff before the final answer.",
          },
          8,
        ),
        eventRecord(
          "event_8",
          "reasoning",
          "Reasoning summary",
          {
            summary: ["Checked the planner diff.", "Confirmed the fixture coverage path."],
          },
          8,
        ),
        eventRecord(
          "event_9",
          "command_execution",
          "Command completed",
          {
            command: "cargo test",
            cwd: "src",
            status: "completed",
            aggregatedOutput: "test result: ok. 12 passed.",
          },
          9,
        ),
        eventRecord(
          "event_10",
          "file_change",
          "File changes: 2",
          {
            status: "completed",
            changeCount: 2,
            changes: [{ path: "src/planner.rs" }, { path: "tests/planner.rs" }],
          },
          10,
        ),
        eventRecord(
          "event_10_repeat",
          "file_change",
          "File changes: 1",
          {
            status: "completed",
            changeCount: 1,
            changes: [{ path: "src/lib.rs" }],
          },
          10,
        ),
        eventRecord(
          "event_11",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_11_duplicate",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_12",
          "turn_completed",
          "Turn completed",
          { turnId: "turn_1", status: "completed" },
          12,
        ),
      ];
      updateTask({
        activeTurnId: null,
        status: "completed",
        lastEventSummary: "Turn completed",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    return route.continue();
  });

  await page.goto(`/projects/${project.id}/files`);
  const codexPopover = await openHeaderActionGroup(page, "codex");
  await codexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL(`/tasks?cwd=${encodeURIComponent(project.relativePath)}`);
  const codexWorkspace = page.locator("caffold-codex-workspace");
  await expect(codexWorkspace).toBeVisible();
  await expect
    .poll(() =>
      codexWorkspace.evaluate((element) => element.parentElement?.tagName.toLowerCase()),
    )
    .toBe("caffold-app-shell");
  const appShellBox = await page.locator("caffold-app-shell").boundingBox();
  const codexWorkspaceBox = await codexWorkspace.boundingBox();
  expect(Math.round(codexWorkspaceBox?.y ?? -1)).toBe(Math.round(appShellBox?.y ?? -2));
  expect(Math.round(codexWorkspaceBox?.height ?? -1)).toBe(
    Math.round(appShellBox?.height ?? -2),
  );
  await expect(page.locator("caffold-files-page")).toBeHidden();
  const closeCodexButton = codexWorkspace.getByRole("button", {
    name: "Close Codex workspace",
  });
  await expect(closeCodexButton).toBeVisible();
  await closeCodexButton.click();
  await expect(page).toHaveURL(`/projects/${project.id}/files`);
  await expect(codexWorkspace).toBeHidden();
  await expect(page.locator("caffold-files-page")).toBeVisible();

  const reopenedCodexPopover = await openHeaderActionGroup(page, "codex");
  await reopenedCodexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL(`/tasks?cwd=${encodeURIComponent(project.relativePath)}`);
  await expect(codexWorkspace).toBeVisible();
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "list",
  );
  await expect(page.locator("caffold-tasks-page")).toContainText("No tasks yet.");

  await page
    .locator("caffold-tasks-page .tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(project.relativePath)}`);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "new",
  );
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-list"]'),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page .tasks-header h1")).toHaveText(
    "New Task",
  );
  const newTaskHeaderMetrics = await page.evaluate(() => {
    const closeButton = document
      .querySelector("caffold-codex-workspace .codex-workspace-close")
      .getBoundingClientRect();
    const title = document
      .querySelector("caffold-tasks-page .tasks-header h1")
      .getBoundingClientRect();
    return {
      closeRight: closeButton.right,
      titleLeft: title.left,
    };
  });
  expect(newTaskHeaderMetrics.titleLeft).toBeGreaterThanOrEqual(
    newTaskHeaderMetrics.closeRight + 8,
  );
  const newTaskComposer = page.locator("caffold-tasks-page .task-new-form");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("GPT-5.5");
  await newTaskComposer.locator(".task-model-button").click();
  const modelPopover = page.locator("caffold-tasks-page .task-model-popover");
  await expect(modelPopover).toBeVisible();
  const modelPopoverMetrics = await newTaskComposer.evaluate((form) => {
    const button = form.querySelector(".task-model-button").getBoundingClientRect();
    const panel = form.querySelector(".task-composer-panel").getBoundingClientRect();
    const popover = form.querySelector(".task-model-popover").getBoundingClientRect();
    const firstDescription = form.querySelector(".task-model-option small");
    const descriptionStyle = firstDescription
      ? window.getComputedStyle(firstDescription)
      : null;
    return {
      buttonBottom: button.bottom,
      buttonLeft: button.left,
      panelBottom: panel.bottom,
      panelLeft: panel.left,
      panelRight: panel.right,
      backdropVisible: Boolean(
        form.querySelector(".task-model-backdrop") &&
          window.getComputedStyle(form.querySelector(".task-model-backdrop")).display !==
            "none",
      ),
      popoverBottom: popover.bottom,
      popoverLeft: popover.left,
      popoverRight: popover.right,
      popoverTop: popover.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      descriptionWhiteSpace: descriptionStyle?.whiteSpace ?? "",
    };
  });
  expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportWidth - 9,
  );
  expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverBottom).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportHeight - 9,
  );
  expect(modelPopoverMetrics.descriptionWhiteSpace).not.toBe("nowrap");
  if (testInfo.project.name !== "phone") {
    expect(modelPopoverMetrics.backdropVisible).toBe(false);
    expect(
      Math.abs(modelPopoverMetrics.popoverLeft - modelPopoverMetrics.buttonLeft),
    ).toBeLessThanOrEqual(2);
    expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(
      modelPopoverMetrics.buttonBottom + 6,
    );
    expect(
      modelPopoverMetrics.popoverTop - modelPopoverMetrics.buttonBottom,
    ).toBeLessThanOrEqual(14);
  } else {
    expect(modelPopoverMetrics.backdropVisible).toBe(true);
    expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
    expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
      modelPopoverMetrics.viewportWidth - 9,
    );
    expect(
      modelPopoverMetrics.viewportHeight - modelPopoverMetrics.popoverBottom,
    ).toBeLessThanOrEqual(14);
    await newTaskComposer.locator(".task-model-backdrop").click({
      position: { x: 8, y: 8 },
    });
    await expect(modelPopover).toBeHidden();
    await newTaskComposer.locator(".task-model-button").click();
    await expect(modelPopover).toBeVisible();
  }
  await captureReviewScreenshot(page, testInfo, "tasks-model-popover");
  await modelPopover.getByRole("button", { name: /High/ }).click();
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("High");
  const newPromptTextarea = newTaskComposer.locator('textarea[name="prompt"]');
  const initialTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      rows: textarea.getAttribute("rows"),
    };
  });
  expect(initialTextareaMetrics.rows).toBe("2");

  await newPromptTextarea.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const expandedTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      clientHeight: textarea.clientHeight,
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      overflowY: styles.overflowY,
      scrollHeight: textarea.scrollHeight,
    };
  });
  expect(expandedTextareaMetrics.height).toBeGreaterThan(
    initialTextareaMetrics.height + 20,
  );
  expect(expandedTextareaMetrics.height).toBeLessThanOrEqual(
    expandedTextareaMetrics.maxHeight + 2,
  );
  expect(expandedTextareaMetrics.scrollHeight).toBeGreaterThan(
    expandedTextareaMetrics.clientHeight,
  );
  expect(expandedTextareaMetrics.overflowY).toBe("auto");

  await newPromptTextarea.fill("Inspect the planner changes");
  const newTaskFormState = await page.locator("caffold-tasks-page").evaluate((element) => {
    const form = element.querySelector('form[data-task-form="create"]');
    return {
      data: Object.fromEntries(new FormData(form).entries()),
      projectId: element.projectId,
      valid: form.checkValidity(),
    };
  });
  expect(newTaskFormState).toEqual({
    data: {
      effort: "high",
      model: "gpt-5.5",
      prompt: "Inspect the planner changes",
    },
    projectId: "",
    valid: true,
  });
  await page.locator('caffold-tasks-page textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${threadId}?cwd=${encodeURIComponent(project.relativePath)}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveCount(1);
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(tasksPage).toContainText("Inspect the planner changes");
  await expect(tasksPage).toContainText("Thread thread_1");
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main · src");
  await expect(tasksPage.locator(".task-conversation")).toBeVisible();
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).toContainText(
    "Inspect the planner changes",
  );
  await expect(tasksPage).toContainText("Command Approval");
  await expect(tasksPage).toContainText("cargo test");
  await expect(tasksPage).toContainText("Run the test suite");
  await expect
    .poll(() => tasksPage.evaluate((element) => element.selectedThreadId))
    .toBe(threadId);
  await expect
    .poll(() =>
      tasksPage
        .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
        .evaluate((button) => ({
          action: button.dataset.taskAction,
          approvalId: button.dataset.approvalId,
          decision: button.dataset.decision,
        })),
    )
    .toEqual({ action: "approval", approvalId: "approval_1", decision: "accept" });

  await tasksPage
    .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
    .click();
  expect(pageErrors).toEqual([]);
  await expect.poll(() => approvalRequests).toBe(1);
  await expect(tasksPage).toHaveCount(1);
  await expect
    .poll(() => tasksPage.evaluate((element) => element.events.map((event) => event.type)))
    .toContain("approval_resolved");
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toContainText(
    "The planner changes are ready to review.",
  );
  const assistantMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"] caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("h2")).toHaveText("Review ready");
  await expect(assistantMarkdown.locator("strong")).toHaveText("ready");
  await expect(assistantMarkdown.locator("li")).toHaveCount(2);
  await expect(assistantMarkdown.locator("pre code")).toHaveText("cargo test");
  await expect(assistantMarkdown.getByRole("link", { name: "Planner notes" })).toHaveAttribute(
    "href",
    "https://example.com/planner",
  );
  await expect(assistantMarkdown.locator("table")).toContainText("Planner");
  await expect(assistantMarkdown).toContainText("Malformed **marker stays readable.");
  await expect
    .poll(() =>
      assistantMarkdown.evaluate((element) => {
        const body = element.shadowRoot.querySelector(".markdown-body");
        return body.scrollWidth <= body.clientWidth;
      }),
    )
    .toBe(true);
  await tasksPage.evaluate(() => {
    const probe = document.createElement("caffold-task-markdown");
    probe.hidden = true;
    probe.textContent = "[unsafe](javascript:alert(1))";
    document.body.append(probe);
  });
  await expect(page.locator("caffold-task-markdown").last()).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(page.locator("caffold-task-markdown").last().locator("a")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toHaveCount(1);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).not.toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator(".task-turn-work")).toContainText("Worked for");
  await expect(tasksPage.locator(".task-turn-work")).toContainText("5 updates");
  await expect(tasksPage.locator(".task-turn-work details")).not.toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const work = element.querySelector(".task-turn-work");
        const assistant = element.querySelector('.task-message[data-message-role="assistant"]');
        const position = work && assistant ? work.compareDocumentPosition(assistant) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-work-item")).toHaveCount(4);
  await expect(tasksPage.locator(".task-work-item").first()).not.toBeVisible();
  await tasksPage.locator(".task-turn-work summary").click();
  await expect(tasksPage.locator('.task-work-item[data-event-type="assistant_message"]')).toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="command_execution"]')).toContainText(
    "test result: ok",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator(".task-turn-work summary").click();
  await expect(tasksPage.locator(".task-turn-work details")).not.toHaveAttribute("open", "");
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  await expect(tasksPage.locator(".task-follow-up-form")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(tasksPage).not.toContainText("assistant message");
  await expect(tasksPage).not.toContainText("user message");
  await expect(tasksPage).not.toContainText("turn started");
  const taskDetailsButton = tasksPage.getByRole("button", { name: /Task details/ });
  await expect(taskDetailsButton).toBeVisible();
  await taskDetailsButton.click();
  const taskDetailsPopover = tasksPage.locator(".task-detail-popover");
  await expect(taskDetailsPopover).toBeVisible();
  await expect(taskDetailsPopover).toContainText("completed");
  await expect(taskDetailsPopover).toContainText(threadId);
  await expect(taskDetailsPopover).toContainText("src");
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  if (testInfo.project.name === "phone") {
    const mobileHeaderMetrics = await tasksPage.evaluate((element) => {
      const header = element.querySelector(".tasks-header").getBoundingClientRect();
      const summary = element.querySelector(".task-detail-summary").getBoundingClientRect();
      const actions = [...element.querySelectorAll(".task-detail-actions button")].map(
        (button) => button.getBoundingClientRect(),
      );
      const details = element
        .querySelector(".task-detail-info-button")
        .getBoundingClientRect();
      return {
        headerHeight: header.height,
        summaryHeight: summary.height,
        overflow: element.scrollWidth > element.clientWidth,
        actionSizes: [...actions, details].map((box) => ({
          height: box.height,
          width: box.width,
        })),
      };
    });
    expect(mobileHeaderMetrics.headerHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.summaryHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.overflow).toBe(false);
    for (const size of mobileHeaderMetrics.actionSizes) {
      expect(Math.round(size.width)).toBe(32);
      expect(Math.round(size.height)).toBe(32);
    }
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  const conversationBeforeFiles = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeFiles.maxScrollTop).toBeGreaterThan(0);
  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-persist-probe", "kept"));

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFilesView = tasksPage.locator(".task-files-view");
  await expect(taskFilesView).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeHidden();
  await expect(tasksPage.locator(".task-detail-summary")).toBeHidden();
  const taskFilesLayout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-codex-workspace");
    const appHeader = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const filesHeader = document.querySelector(".task-files-header");
    const filesView = document.querySelector(".task-files-view");
    const filesTitle = document.querySelector(".task-files-header h3");
    const browser = document.querySelector(".task-files-view caffold-file-browser");
    const fileList = document.querySelector(".task-files-view caffold-file-list");

    const coveredByCodex = (element) => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        inCodex: Boolean(topElement?.closest("caffold-codex-workspace")),
        inSelf: topElement === element || element.contains(topElement),
      };
    };

    const codexRect = codex.getBoundingClientRect();
    const filesHeaderRect = filesHeader.getBoundingClientRect();
    const filesViewRect = filesView.getBoundingClientRect();
    const browserRect = browser.getBoundingClientRect();
    const fileListRect = fileList.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      appHeaderCoveredByCodex:
        coveredByCodex(appHeader).inCodex && !coveredByCodex(appHeader).inSelf,
      pathbarCoveredByCodex:
        coveredByCodex(pathbar).inCodex && !coveredByCodex(pathbar).inSelf,
      filesHeaderTop: filesHeaderRect.top,
      codexTop: codexRect.top,
      filesViewBottom: filesViewRect.bottom,
      codexBottom: codexRect.bottom,
      browserHeight: browserRect.height,
      fileListWidth: fileListRect.width,
      titleFits: filesTitle.clientWidth >= filesTitle.scrollWidth,
    };
  });
  expect(taskFilesLayout.appHeaderCoveredByCodex).toBe(true);
  expect(taskFilesLayout.pathbarCoveredByCodex).toBe(true);
  expect(taskFilesLayout.filesHeaderTop).toBeLessThanOrEqual(taskFilesLayout.codexTop + 1);
  expect(taskFilesLayout.filesViewBottom).toBeGreaterThanOrEqual(taskFilesLayout.codexBottom - 1);
  expect(taskFilesLayout.browserHeight).toBeGreaterThan(400);
  if (taskFilesLayout.viewportWidth >= 861) {
    expect(taskFilesLayout.fileListWidth).toBeGreaterThanOrEqual(300);
  }
  expect(taskFilesLayout.titleFits).toBe(true);
  const filesTitleLeft = await taskFilesView
    .locator(".task-files-header h3")
    .evaluate((element) => element.getBoundingClientRect().left);
  const codexCloseRight = await page
    .locator("caffold-codex-workspace .codex-workspace-close")
    .evaluate((element) => element.getBoundingClientRect().right);
  expect(filesTitleLeft).toBeGreaterThan(codexCloseRight);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect(taskFilesView.locator("caffold-file-browser")).toHaveAttribute(
    "data-browser-view",
    "list",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  const embeddedLiveName = `task-live-${testInfo.project.name}.txt`;
  const embeddedLivePath = resolve("tests/fixtures/home/src", embeddedLiveName);
  try {
    await writeFile(embeddedLivePath, "Codex Files live update\n");
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 2,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(embeddedLivePath, { force: true });
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 3,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toHaveCount(0);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser-list");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL(`/tasks/${threadId}?cwd=${encodeURIComponent(project.relativePath)}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(page.locator("caffold-codex-workspace")).toBeVisible();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  await taskFilesView.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(`/tasks/${threadId}?cwd=${encodeURIComponent(project.relativePath)}`);
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText(
    "alpha.rs",
  );
    await expect(taskFilesView.locator("caffold-file-viewer")).toContainText("pub const ALPHA");
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");
  if (testInfo.project.name === "phone") {
    await taskFilesView.getByRole("button", { name: "Back to files" }).click();
  }
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(taskFilesView).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeFiles.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator(".task-follow-up-form .task-model-button").click();
  await expect(modelPopover).toBeVisible();
  await modelPopover.getByRole("button", { name: /Very high/ }).click();
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Very high",
  );
  const followUpTextarea = tasksPage.locator('textarea[name="prompt"]');
  await followUpTextarea.fill("Please tighten the tests");
  await followUpTextarea.press("Enter");
  await followUpRequested;
  await expect(followUpTextarea).toBeFocused();
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toBeVisible();
  await expect(tasksPage).not.toContainText("Follow-up prompt sent");
  releaseFollowUpResponse();
  const runningStatus = tasksPage.locator(
    '.task-detail-summary .task-status-chip[data-status="running"]',
  );
  await expect(
    runningStatus,
  ).toBeVisible();
  await expect(runningStatus.locator(".task-status-spinner")).toBeVisible();
  await expect(runningStatus.locator(".task-status-label")).toHaveCount(0);
  await expect(followUpTextarea).toBeFocused();
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toHaveCount(1);

  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-review-persist-probe", "kept"));
  await followUpTextarea.fill("Keep this draft while reviewing");
  const conversationBeforeDiff = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeDiff.maxScrollTop).toBeGreaterThan(0);
  const taskDetailReadsBeforeDiff = taskDetailReadRequests;
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(page).toHaveURL(
    `/tasks/${threadId}?cwd=${encodeURIComponent(project.relativePath)}`,
  );
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  await expect(codexWorkspace).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toBeHidden();
  const taskDiffView = tasksPage.locator(".task-diff-view");
  await expect(taskDiffView).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  const taskDiffTree = taskDiffView.locator("caffold-git-diff-changes-tree");
  await expect(taskDiffTree.locator("button[data-change-path]")).toHaveCount(4);
  await expect(taskDiffTree.locator('button[data-task-related="true"]')).toHaveCount(3);
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="unrelated.rs"]'),
  ).not.toHaveAttribute("data-task-related", "true");
  await taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  const taskDiffViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
  );
  await expect(taskDiffViewer).toContainText("planner.rs");
  await expect(taskDiffViewer).toContainText(
    "new planner behavior",
  );
  const statusRequestsBeforeWatchChange = gitStatusRequests;
  includeTaskDiffLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.startsWith("/api/watch?"),
    );
    source?.emit("change", {
      revision: 4,
      paths: ["src/live-update.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect.poll(() => gitStatusRequests).toBeGreaterThan(statusRequestsBeforeWatchChange);
  const liveUpdateChange = taskDiffTree.locator(
    'button[data-repo-relative-path="live-update.rs"]',
  );
  await expect(liveUpdateChange).toHaveCount(1);
  if (testInfo.project.name === "phone") {
    await expect(liveUpdateChange).toBeHidden();
  } else {
    await expect(liveUpdateChange).toBeVisible();
  }
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");

  const refsBeforeBranch = gitRefsRequests;
  const compareBeforeBranch = gitCompareRequests;
  await taskDiffView.getByRole("button", { name: "Branch" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "branch");
  await expect.poll(() => gitRefsRequests).toBeGreaterThan(refsBeforeBranch);
  await expect.poll(() => gitCompareRequests).toBeGreaterThan(compareBeforeBranch);
  await expect(taskDiffView.locator("select[data-task-compare-base]")).toHaveValue(
    "origin/main",
  );
  await expect(taskDiffView.locator("[data-task-compare-head]")).toHaveText("main");
  const taskCompareTree = taskDiffView.locator("caffold-git-compare-tree");
  const taskCompareFile = taskCompareTree.locator(
    'button[data-compare-path="src/planner.rs"]',
  );
  await expect(taskCompareFile).toBeVisible();
  await taskCompareFile.click();
  await expect.poll(() => gitCompareDiffRequests).toBeGreaterThan(0);
  const taskCompareViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="branch"] caffold-review-file-viewer',
  );
  await expect(taskCompareViewer).toContainText("new branch behavior");
  await taskDiffView.locator("select[data-task-compare-base]").selectOption("origin/release");
  await expect(taskCompareTree.locator('button[data-compare-path="src/release.rs"]')).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");

  await taskDiffView.getByRole("button", { name: "Working Tree" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "working");
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-review-persist-probe",
    "kept",
  );
  await expect(followUpTextarea).toHaveValue("Keep this draft while reviewing");
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Very high",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeDiff.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskDetailReadRequests).toBe(taskDetailReadsBeforeDiff);
});

test("loads older task conversation events by cursor", async ({ page }) => {
  const project = await mockRegisteredProject(page);
  await mockCodexModels(page);
  const threadId = "thread_cursor_fixture";
  const now = 1_767_100_000_000;
  const task = {
    id: threadId,
    threadId,
    projectId: project.id,
    activeTurnId: null,
    title: "Long running thread",
    preview: "Latest answer",
    status: "notLoaded",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 10,
    recencyMs: now + 10,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    projectId: project.id,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const latestEvents = Array.from({ length: 12 }, (_, index) => {
    const isUserPrompt = index % 2 === 0;
    const blockNumber = index + 1;
    return eventRecord(
      `event_latest_${index}`,
      isUserPrompt ? "user_message" : "assistant_message",
      isUserPrompt ? "User prompt" : "Assistant response",
      {
        text: `${isUserPrompt ? "This is the latest prompt block" : "This is the latest answer block"} ${blockNumber}.\n\n${"Latest transcript line. ".repeat(18)}`,
      },
      10 + index,
    );
  });
  const olderEvents = [
    eventRecord(
      "event_older",
      "user_message",
      "User prompt",
      { text: "This is the older prompt." },
      1,
    ),
  ];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("projectId")).toBe(project.id);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    });
  });

  await page.route(/\/api\/tasks\/thread_cursor_fixture(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("projectId")).toBe(project.id);
    const cursor = url.searchParams.get("cursor");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task,
        events: cursor === "older_cursor" ? olderEvents : latestEvents,
        eventsPage: { nextCursor: cursor === "older_cursor" ? null : "older_cursor" },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/projects/${project.id}/tasks`);
  const tasksPage = page.locator("caffold-tasks-page");
  const taskRow = tasksPage.locator(".task-row", { hasText: "Long running thread" });
  await expect(taskRow.locator(".task-row-time")).toBeVisible();
  await expect(taskRow).not.toContainText("notLoaded");
  await taskRow.click();
  await expect(tasksPage.locator(".task-detail-summary")).not.toContainText("notLoaded");
  await expect(tasksPage).toContainText("This is the latest answer block 12.");
  await expect(tasksPage).not.toContainText("This is the older prompt.");
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollHeight > element.clientHeight;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
      }),
    )
    .toBe(true);

  await tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(tasksPage).toContainText("This is the older prompt.");
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(0);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => element.scrollTop > 0),
    )
    .toBe(true);
});

test("keeps task conversation scroll anchored during live updates", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, data) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(data) });
        }
      }

      emitOpen() {
        this.readyState = 1;
        for (const listener of this.listeners.get("open") ?? []) {
          listener({});
        }
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        for (const listener of this.listeners.get("error") ?? []) {
          listener({});
        }
      }

      close() {
        this.closed = true;
        this.readyState = 2;
      }
    };
  });

  const project = await mockRegisteredProject(page);
  await mockCodexModels(page);
  const threadId = "thread_scroll_fixture";
  const now = 1_767_200_000_000;
  const task = {
    id: threadId,
    threadId,
    projectId: project.id,
    activeTurnId: null,
    title: "Scroll fixture",
    preview: "Latest answer",
    status: "running",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20,
    recencyMs: now + 20,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    projectId: project.id,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const events = Array.from({ length: 18 }, (_, index) =>
    eventRecord(
      `event_scroll_${index}`,
      "assistant_message",
      "Assistant response",
      {
        turnId: `turn_scroll_${index}`,
        text: `Existing answer block ${index + 1}.\n\n${"Scrollable transcript content. ".repeat(14)}`,
      },
      index,
    ),
  );
  let taskDetailReadRequests = 0;
  let holdTaskRefreshes = false;
  const heldTaskRefreshes = [];

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        files: [],
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_fixture(?:\?|$)/, async (route) => {
    taskDetailReadRequests += 1;
    if (holdTaskRefreshes) {
      await new Promise((resolve) => heldTaskRefreshes.push(resolve));
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task,
        events,
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/projects/${project.id}/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect(tasksPage).toContainText("Existing answer block 18.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitOpen();
  }, threadId);
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);

  await page.evaluate(
    ({ threadId, projectId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        id: "event_live_bottom",
        threadId,
        projectId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_live_bottom",
          text: `Live answer at the bottom.\n\n${"New live transcript content. ".repeat(16)}`,
        },
        createdMs: now + 100,
      });
    },
    { threadId, projectId: project.id, now },
  );
  await expect(tasksPage).toContainText("Live answer at the bottom.");
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(
    ({ threadId, projectId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        id: "event_live_preserve",
        threadId,
        projectId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_live_preserve",
          text: `Live answer while reading older content.\n\n${"Preserve the reader position. ".repeat(16)}`,
        },
        createdMs: now + 101,
      });
    },
    { threadId, projectId: project.id, now },
  );
  await expect(tasksPage).toContainText("Live answer while reading older content.");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(16);
  await expect
    .poll(() => tasksPage.evaluate((element) => element.taskRefresh === null))
    .toBe(true);

  const readsBeforeBurst = taskDetailReadRequests;
  holdTaskRefreshes = true;
  await page.evaluate(
    ({ threadId, projectId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      for (let index = 0; index < 3; index += 1) {
        taskSource.emit("task-event", {
          id: `event_burst_${index}`,
          threadId,
          projectId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: {
            turnId: "turn_burst",
            text: `Burst update ${index + 1}`,
          },
          createdMs: now + 200 + index,
        });
      }
    },
    { threadId, projectId: project.id, now },
  );
  await expect(tasksPage).toContainText("Burst update 3");
  await expect.poll(() => taskDetailReadRequests).toBe(readsBeforeBurst + 1);
  await page.waitForTimeout(100);
  expect(taskDetailReadRequests).toBe(readsBeforeBurst + 1);

  heldTaskRefreshes.shift()?.();
  await expect.poll(() => taskDetailReadRequests).toBe(readsBeforeBurst + 2);
  await page.waitForTimeout(100);
  expect(taskDetailReadRequests).toBe(readsBeforeBurst + 2);
  heldTaskRefreshes.shift()?.();
  holdTaskRefreshes = false;
  await expect
    .poll(() => tasksPage.evaluate((element) => element.taskRefresh === null))
    .toBe(true);

  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitError();
  }, threadId);
  await expect(
    tasksPage.locator('.task-stream-state[data-stream-state="reconnecting"]'),
  ).toContainText("Reconnecting live updates...");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-live-reconnecting");

  const readsBeforeReconnect = taskDetailReadRequests;
  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitOpen();
  }, threadId);
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect.poll(() => taskDetailReadRequests).toBe(readsBeforeReconnect + 1);

  const sourcesBeforeRetry = await page.evaluate(() => window.__taskEventSources.length);
  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`) && !source.closed,
    );
    taskSource.emitError(true);
  }, threadId);
  const streamError = tasksPage.locator(
    '.task-stream-state[data-stream-state="error"]',
  );
  await expect(streamError).toContainText("Live updates unavailable.");
  await streamError.getByRole("button", { name: "Retry" }).click();
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBe(sourcesBeforeRetry + 1);
  await page.evaluate((threadId) => {
    const sources = window.__taskEventSources.filter((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    sources.at(-1).emitOpen();
  }, threadId);
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

  await page.goto("/");
  const sourceDirectory = page.locator('button[data-entry-path="src"]');
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

test("restores project file routes and browser navigation", async ({ page }, testInfo) => {
  const project = await mockRegisteredProject(page);
  let gitStatusRequests = 0;
  let listRequests = 0;

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    gitStatusRequests += 1;
    await route.continue();
  });
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    await route.continue();
  });

  await page.goto(`/projects/${project.id}/files/example.rs`);
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  await expect(page.locator("caffold-code-viewer")).toContainText("pub fn sample");

  await page.reload();
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page).toHaveURL(`/projects/${project.id}/files`);
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }

  await page.goto(`/projects/${project.id}/files`);
  await expect(page.locator("caffold-file-list")).toBeVisible();
  const gitGroupButton = headerActionGroupButton(page, "git");
  await expect(gitGroupButton.locator(".header-action-badge")).toHaveText(/\d+/);
  const headerActionsSnapshot = await page.locator("caffold-header-actions").evaluate((element) => {
    const gitGroupButton = element.querySelector('button[data-action-group="git"]');
    window.__caffoldGitGroupButton = gitGroupButton;
    return {
      groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
        (button) => button.dataset.actionGroup,
      ),
      gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
    };
  });
  const listRequestsBeforeFileClick = listRequests;
  const gitStatusRequestsBeforeFileClick = gitStatusRequests;
  await page.locator('button[data-entry-path="src/example.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/files/example.rs`);
  await expect(page.locator("caffold-file-viewer")).toContainText("example.rs");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeFileClick);
  const headerActionsState = await page.locator("caffold-header-actions").evaluate((element) => {
    const gitGroupButton = element.querySelector('button[data-action-group="git"]');
    return {
      groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
        (button) => button.dataset.actionGroup,
      ),
      gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
      sameGitGroupButton: gitGroupButton === window.__caffoldGitGroupButton,
    };
  });
  expect(headerActionsState.sameGitGroupButton).toBe(true);
  expect(headerActionsState.groups).toEqual(headerActionsSnapshot.groups);
  expect(headerActionsState.gitGroupButtonHtml).toBe(
    headerActionsSnapshot.gitGroupButtonHtml,
  );
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/files`);
  await expect(page.locator("caffold-file-list")).toBeVisible();

  await page.goto(`/projects/${project.id}/files/planner`);
  await expect(page).toHaveURL(`/projects/${project.id}/files/planner`);
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/files`);
  await expect(page.locator('button[data-entry-path="src/example.rs"]')).toBeVisible();
});

test("restores project review routes", async ({ page }) => {
  const project = await mockRegisteredProject(page);
  const repository = { rootPath: "src", branch: "feature/review", dirty: true };
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Route review state",
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  let gitStatusRequests = 0;
  let gitCompareRequests = 0;
  let gitCommitRequests = 0;
  let githubIssuesRequests = 0;
  let githubPullsRequests = 0;
  let githubPullRequests = 0;
  let githubPullFilesRequests = 0;
  let listRequests = 0;
  let delayNextListRequest = false;
  let resolveDelayedListStarted = null;
  let releaseDelayedListRequest = null;
  let delayNextIssueRequest = false;
  let resolveDelayedIssueStarted = null;
  let releaseDelayedIssueRequest = null;
  let delayNextPullFilesRequest = false;
  let resolveDelayedPullFilesStarted = null;
  let releaseDelayedPullFilesRequest = null;

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    if (delayNextListRequest) {
      delayNextListRequest = false;
      resolveDelayedListStarted?.();
      resolveDelayedListStarted = null;
      await new Promise((resolve) => {
        releaseDelayedListRequest = resolve;
      });
      releaseDelayedListRequest = null;
    }
    await route.continue();
  });

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: [
          {
            path: "src/example.rs",
            repoRelativePath: "example.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "unstaged",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "index 1111111..2222222 100644",
          "--- a/example.rs",
          "+++ b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old route line",
          "+new route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      }),
    }),
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    const head = url.searchParams.get("head");
    expect(["feature/review", "main"]).toContain(head);
    const files =
      head === "main"
        ? []
        : [
            {
              path: "src/example.rs",
              repoRelativePath: "example.rs",
              status: "M",
            },
          ];

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef: "origin/main",
        headRef: head,
        files,
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/main");
    expect(url.searchParams.get("head")).toBe("feature/review");
    expect(url.searchParams.get("file")).toBe("src/example.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        kind: "origin/main...feature/review",
        diff: [
          "diff --git a/example.rs b/example.rs",
          "@@ -1,1 +1,2 @@",
          "-old compare route line",
          "+new compare route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits: [commit],
        page: 2,
        perPage: 50,
        totalCommits: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    }),
  );
  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) => {
    gitCommitRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commit,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            status: "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("sha")).toBe(commit.sha);
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        kind: "commit abcdef1",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old commit route line",
          "+new commit route line",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    }),
  );
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    githubIssuesRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: [
          {
            number: 42,
            title: "Route issue detail",
            state: "OPEN",
            author: "Caffold",
            labels: ["routing"],
            assignees: [],
            comments: 1,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/issues/42",
          },
        ],
        page: 2,
        perPage: 50,
        totalIssues: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/issue(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("42");
    if (delayNextIssueRequest) {
      delayNextIssueRequest = false;
      resolveDelayedIssueStarted?.();
      resolveDelayedIssueStarted = null;
      await new Promise((resolve) => {
        releaseDelayedIssueRequest = resolve;
      });
      releaseDelayedIssueRequest = null;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        issue: {
          number: 42,
          title: "Route issue detail",
          state: "OPEN",
          author: "Caffold",
          labels: ["routing"],
          assignees: [],
          comments: 1,
          body: "Route issue body",
          bodyHtml: "<p>Route issue body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/issues/42",
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    githubPullsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("page")).toBe("2");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: [
          {
            number: 12,
            title: "Route pull request detail",
            state: "open",
            draft: false,
            author: "Caffold",
            labels: ["routing"],
            comments: 2,
            updatedAt: "2026-07-01T10:00:00Z",
            url: "https://github.com/example/caffold/pull/12",
          },
        ],
        page: 2,
        perPage: 50,
        totalPulls: 51,
        totalPages: 2,
        hasPrevious: true,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    githubPullRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        pull: {
          number: 12,
          title: "Route pull request detail",
          state: "OPEN",
          draft: false,
          author: "Caffold",
          labels: ["routing"],
          comments: 1,
          reviews: 1,
          commits: 1,
          additions: 4,
          deletions: 2,
          changedFiles: 1,
          baseRefName: "main",
          headRefName: "feature/pr-route",
          body: "Route PR body",
          bodyHtml: "<p>Route PR body</p>",
          createdAt: "2026-07-01T08:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
          url: "https://github.com/example/caffold/pull/12",
          conversationComments: [
            {
              author: "taehoon",
              body: "Conversation route comment",
              bodyHtml: "<p>Conversation route comment</p>",
              createdAt: "2026-07-01T08:30:00Z",
              updatedAt: "2026-07-01T08:30:00Z",
              url: "https://github.com/example/caffold/pull/12#issuecomment-1",
            },
          ],
          reviewComments: [
            {
              author: "codex",
              state: "COMMENTED",
              body: "Review summary route comment",
              bodyHtml: "<p>Review summary route comment</p>",
              submittedAt: "2026-07-01T09:00:00Z",
            },
          ],
          commitSummaries: [
            {
              sha: "1234567890abcdef1234567890abcdef12345678",
              shortSha: "1234567",
              subject: "Route PR commit",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:00:00Z",
              committedAt: "2026-07-01T09:00:00Z",
              url: "https://github.com/example/caffold/commit/1234567",
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, async (route) => {
    githubPullFilesRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    if (delayNextPullFilesRequest) {
      delayNextPullFilesRequest = false;
      resolveDelayedPullFilesStarted?.();
      resolveDelayedPullFilesStarted = null;
      await new Promise((resolve) => {
        releaseDelayedPullFilesRequest = resolve;
      });
      releaseDelayedPullFilesRequest = null;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            previousPath: null,
            status: "M",
            additions: 4,
            deletions: 2,
            changes: 6,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/planner/mod.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/planner/mod.rs",
          },
        ],
        totalFiles: 1,
      }),
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("number")).toBe("12");
    expect(url.searchParams.get("file")).toBe("src/planner/mod.rs");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: "M",
        kind: "PR #12",
        diff: [
          "diff --git a/planner/mod.rs b/planner/mod.rs",
          "@@ -1,1 +1,2 @@",
          "-old PR route line",
          "+new PR route line",
        ].join("\n"),
        diffUnavailable: false,
        message: null,
      }),
    });
  });

  delayNextListRequest = true;
  const delayedListStarted = new Promise((resolve) => {
    resolveDelayedListStarted = resolve;
  });
  const directDiffRoute = page.goto(`/projects/${project.id}/diff/example.rs`);
  await delayedListStarted;
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-route-surface",
    "review",
  );
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  releaseDelayedListRequest();
  await directDiffRoute;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  await page.goto(`/projects/${project.id}/diff`);
  await expect(page.locator('button[data-change-path="src/example.rs"]')).toBeVisible();
  const gitStatusRequestsBeforeDiffClick = gitStatusRequests;
  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/diff/example.rs`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new route line");
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffClick);
  const gitStatusRequestsBeforeDiffBack = gitStatusRequests;
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/diff`);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeDiffBack);

  await page.goto(
    `/projects/${project.id}/compare/example.rs?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(page.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(page.locator('select[data-compare-ref="head"]')).toHaveValue("feature/review");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  await page.goto(`/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`);
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const compareHeaderActionsSnapshot = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      window.__caffoldCompareGitGroupButton = element.querySelector(
        'button[data-action-group="git"]',
      );
      const gitGroupButton = window.__caffoldCompareGitGroupButton;
      return {
        groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
          (button) => button.dataset.actionGroup,
        ),
        gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
      };
    });
  const listRequestsBeforeCompareRefChange = listRequests;
  const gitStatusRequestsBeforeCompareRefChange = gitStatusRequests;
  await page.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(page).toHaveURL(`/projects/${project.id}/compare?base=origin%2Fmain&head=main`);
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");
  expect(listRequests).toBe(listRequestsBeforeCompareRefChange);
  expect(gitStatusRequests).toBe(gitStatusRequestsBeforeCompareRefChange);
  const compareHeaderActionsState = await page
    .locator("caffold-header-actions")
    .evaluate((element) => {
      const gitGroupButton = element.querySelector('button[data-action-group="git"]');
      return {
        groups: Array.from(element.querySelectorAll("button[data-action-group]")).map(
          (button) => button.dataset.actionGroup,
        ),
        gitGroupButtonHtml: gitGroupButton?.outerHTML ?? "",
        sameGitGroupButton: gitGroupButton === window.__caffoldCompareGitGroupButton,
      };
    });
  expect(compareHeaderActionsState.sameGitGroupButton).toBe(true);
  expect(compareHeaderActionsState.groups).toEqual(compareHeaderActionsSnapshot.groups);
  expect(compareHeaderActionsState.gitGroupButtonHtml).toBe(
    compareHeaderActionsSnapshot.gitGroupButtonHtml,
  );

  await page.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  const gitCompareRequestsBeforeClick = gitCompareRequests;
  await page.locator('button[data-compare-path="src/example.rs"]').click();
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare/example.rs?base=origin%2Fmain&head=feature%2Freview`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare route line");
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeClick);
  const gitCompareRequestsBeforeBack = gitCompareRequests;
  await page.goBack();
  await expect(page).toHaveURL(
    `/projects/${project.id}/compare?base=origin%2Fmain&head=feature%2Freview`,
  );
  expect(gitCompareRequests).toBe(gitCompareRequestsBeforeBack);

  await page.goto(`/projects/${project.id}/log/${commit.sha}/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(page.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  await page.goto(`/projects/${project.id}/log/${commit.sha}?page=2`);
  await expect(page.locator('button[data-commit-path="src/planner/mod.rs"]')).toBeVisible();
  const gitCommitRequestsBeforeClick = gitCommitRequests;
  await page.locator('button[data-commit-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/log/${commit.sha}/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new commit route line");
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeClick);
  const gitCommitRequestsBeforeBack = gitCommitRequests;
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/log/${commit.sha}?page=2`);
  expect(gitCommitRequests).toBe(gitCommitRequestsBeforeBack);
  await page.getByRole("button", { name: "Back to log" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/log?page=2`);

  delayNextIssueRequest = true;
  const delayedIssueStarted = new Promise((resolve) => {
    resolveDelayedIssueStarted = resolve;
  });
  const githubIssuesRequestsBeforeIssueDetailRoute = githubIssuesRequests;
  const directIssueRoute = page.goto(`/projects/${project.id}/issues/42?page=2`);
  await delayedIssueStarted;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issues-layout")).toHaveAttribute(
    "data-issues-view",
    "detail",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toBeHidden();
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeIssueDetailRoute);
  releaseDelayedIssueRequest();
  await directIssueRoute;
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  const githubIssuesRequestsBeforeBack = githubIssuesRequests;
  await page.getByRole("button", { name: "Back to issues" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/issues?page=2`);
  await expect(page.locator('button[data-issue-number="42"]')).toBeVisible();
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeBack + 1);
  const githubIssuesRequestsBeforeIssueClick = githubIssuesRequests;
  await page.locator('button[data-issue-number="42"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/issues/42?page=2`);
  await expect(page.locator("caffold-github-issue-detail-page")).toContainText("Route issue body");
  expect(githubIssuesRequests).toBe(githubIssuesRequestsBeforeIssueClick);

  delayNextPullFilesRequest = true;
  const delayedPullFilesStarted = new Promise((resolve) => {
    resolveDelayedPullFilesStarted = resolve;
  });
  const githubPullsRequestsBeforePrFileRoute = githubPullsRequests;
  const githubPullRequestsBeforePrFileRoute = githubPullRequests;
  const directPrFileRoute = page.goto(`/projects/${project.id}/pulls/12/files/planner/mod.rs?page=2`);
  await delayedPullFilesStarted;
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await expect(page.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-github-pull-files-page")).toHaveAttribute(
    "data-detail-view",
    "viewer",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toBeHidden();
  await expect(page.locator("caffold-github-pull-detail-page")).toBeHidden();
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforePrFileRoute);
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrFileRoute);
  releaseDelayedPullFilesRequest();
  await directPrFileRoute;
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforePrFileRoute);
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrFileRoute);
  await page.goto(`/projects/${project.id}/pulls/12/files?page=2`);
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files?page=2`);
  await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
  await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  await expect(page.locator('button[data-pull-file-path="src/planner/mod.rs"]')).toBeVisible();
  const githubPullFilesRequestsBeforeFileClick = githubPullFilesRequests;
  await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files/planner/mod.rs?page=2`);
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR route line");
  expect(githubPullFilesRequests).toBe(githubPullFilesRequestsBeforeFileClick);
  await page.goBack();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files?page=2`);
  const githubPullRequestsBeforePrBack = githubPullRequests;
  await page.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12?page=2`);
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");
  expect(githubPullRequests).toBe(githubPullRequestsBeforePrBack + 1);
  const githubPullsRequestsBeforeBack = githubPullsRequests;
  await page.getByRole("button", { name: "Back to pull requests" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls?page=2`);
  await expect(page.locator('button[data-pull-number="12"]')).toBeVisible();
  expect(githubPullsRequests).toBe(githubPullsRequestsBeforeBack + 1);
  await page.locator('button[data-pull-number="12"]').click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12?page=2`);
  await expect(page.locator("caffold-github-pull-detail-page")).toContainText("Route PR body");
});

test("reloads active review modes when the directory context changes", async ({ page }) => {
  const repository = { rootPath: "src", branch: "main", dirty: true };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const gitStatusPaths = [];
  const gitRefsPaths = [];
  const gitComparePaths = [];
  const gitLogPaths = [];
  const githubIssuesPaths = [];
  const githubPullsPaths = [];

  const fileEntry = (name, path) => ({
    name,
    path,
    kind: "file",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: 10,
    modifiedMs: null,
    git: null,
  });
  const directoryEntry = (name, path) => ({
    name,
    path,
    kind: "directory",
    isSymlink: false,
    supported: true,
    gitIgnored: false,
    size: null,
    modifiedMs: null,
    git: null,
  });
  const directories = new Map([
    [
      "",
      {
        root: "tests/fixtures/home",
        path: "",
        entries: [directoryEntry("src", "src")],
        git: null,
      },
    ],
    [
      "src",
      {
        root: "tests/fixtures/home",
        path: "src",
        entries: [
          directoryEntry("planner", "src/planner"),
          fileEntry("example.rs", "src/example.rs"),
        ],
        git: repository,
      },
    ],
    [
      "src/planner",
      {
        root: "tests/fixtures/home",
        path: "src/planner",
        entries: [fileEntry("mod.rs", "src/planner/mod.rs")],
        git: repository,
      },
    ],
  ]);
  const statusFiles = {
    src: [
      {
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        status: " M",
        category: "unstaged",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    "src/planner": [
      {
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: " M",
        category: "unstaged",
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
  };
  const compareFiles = {
    src: [
      {
        path: "src/example.rs",
        repoRelativePath: "example.rs",
        status: "M",
      },
    ],
    "src/planner": [
      {
        path: "src/planner/mod.rs",
        repoRelativePath: "planner/mod.rs",
        status: "M",
      },
    ],
  };
  const logCommits = {
    src: [
      {
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        subject: "Source context commit",
        body: "",
        authorName: "Caffold",
        authorEmail: "caffold@example.test",
        authorTimeMs: 1_767_000_000_000,
      },
    ],
    "src/planner": [
      {
        sha: "2222222222222222222222222222222222222222",
        shortSha: "2222222",
        subject: "Planner context commit",
        body: "",
        authorName: "Caffold",
        authorEmail: "caffold@example.test",
        authorTimeMs: 1_767_000_001_000,
      },
    ],
  };
  const issuesByPath = {
    src: [
      {
        number: 10,
        title: "Source context issue",
        state: "OPEN",
        author: "Caffold",
        labels: ["source"],
        assignees: [],
        comments: 0,
        updatedAt: "2026-07-01T10:00:00Z",
        url: "https://github.com/example/caffold/issues/10",
      },
    ],
    "src/planner": [
      {
        number: 11,
        title: "Planner context issue",
        state: "OPEN",
        author: "Caffold",
        labels: ["planner"],
        assignees: [],
        comments: 0,
        updatedAt: "2026-07-01T10:01:00Z",
        url: "https://github.com/example/caffold/issues/11",
      },
    ],
  };
  const pullsByPath = {
    src: [
      {
        number: 20,
        title: "Source context pull",
        state: "open",
        draft: false,
        author: "Caffold",
        labels: ["source"],
        comments: 0,
        updatedAt: "2026-07-01T11:00:00Z",
        url: "https://github.com/example/caffold/pull/20",
      },
    ],
    "src/planner": [
      {
        number: 21,
        title: "Planner context pull",
        state: "open",
        draft: false,
        author: "Caffold",
        labels: ["planner"],
        comments: 0,
        updatedAt: "2026-07-01T11:01:00Z",
        url: "https://github.com/example/caffold/pull/21",
      },
    ],
  };

  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const directory = directories.get(path);
    expect(directory, `mocked directory for ${path}`).toBeTruthy();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(directory),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    }),
  );
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitStatusPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: statusFiles[path] ?? [],
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitRefsPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "feature/review", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "feature/review",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "feature/review",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitComparePaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef: url.searchParams.get("base") ?? "origin/main",
        headRef: url.searchParams.get("head") ?? "feature/review",
        files: compareFiles[path] ?? [],
      }),
    });
  });
  await page.route(/\/api\/git\/log(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    gitLogPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits: logCommits[path] ?? [],
        page: 1,
        perPage: 50,
        totalCommits: (logCommits[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    githubIssuesPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: issuesByPath[path] ?? [],
        page: 1,
        perPage: 50,
        totalIssues: (issuesByPath[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    githubPullsPaths.push(path);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: pullsByPath[path] ?? [],
        page: 1,
        perPage: 50,
        totalPulls: (pullsByPath[path] ?? []).length,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });

  const loadDirectory = async (path) => {
    await page.locator("caffold-app-shell").evaluate(
      (shell, nextPath) => shell.loadDirectory(nextPath),
      path,
    );
  };
  const expectLastPath = async (calls, path) => {
    await expect.poll(() => calls.at(-1) ?? "").toBe(path);
  };

  await page.goto("/");

  await loadDirectory("src");
  await expectLastPath(gitStatusPaths, "src");
  await clickHeaderAction(page, "git", "open-diff-workspace");
  await expect(page.locator('button[data-change-path="src/example.rs"]')).toBeVisible();
  await loadDirectory("src/planner");
  await expectLastPath(gitStatusPaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(page.locator('button[data-change-path="src/planner/mod.rs"]')).toBeVisible();
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "git", "open-compare-workspace");
  await expectLastPath(gitRefsPaths, "src");
  await expectLastPath(gitComparePaths, "src");
  await expect(page.locator('button[data-compare-path="src/example.rs"]')).toBeVisible();
  await loadDirectory("src/planner");
  await expectLastPath(gitRefsPaths, "src/planner");
  await expectLastPath(gitComparePaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(page.locator('button[data-compare-path="src/planner/mod.rs"]')).toBeVisible();
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "git", "open-log-workspace");
  await expectLastPath(gitLogPaths, "src");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Source context commit");
  await loadDirectory("src/planner");
  await expectLastPath(gitLogPaths, "src/planner");
  await expect(page.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Planner context commit");
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "github", "open-github-issues-workspace");
  await expectLastPath(githubIssuesPaths, "src");
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Source context issue",
  );
  await loadDirectory("src/planner");
  await expectLastPath(githubIssuesPaths, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Planner context issue",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();

  await loadDirectory("src");
  await clickHeaderAction(page, "github", "open-github-pulls-workspace");
  await expectLastPath(githubPullsPaths, "src");
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Source context pull",
  );
  await loadDirectory("src/planner");
  await expectLastPath(githubPullsPaths, "src/planner");
  await expect(page.locator("caffold-github-review-layout")).toHaveAttribute(
    "data-github-mode",
    "pulls",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Planner context pull",
  );
});

test("previews image files in the viewer", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="preview-image.svg"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("preview-image.svg");
  await expect(page.locator("caffold-file-viewer")).toContainText("SVG image");
  await page.getByRole("button", { name: "Show details for preview-image.svg" }).click();
  const details = page.locator("caffold-file-viewer .viewer-meta-popover");
  await expect(details.locator('[data-field="size"] dd')).toHaveText("325 B");
  await expect(details.locator('[data-field="type"] dd')).toHaveText("SVG image");

  const preview = page.locator("caffold-file-viewer img.image-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    "src",
    /\/api\/image\?path=preview-image\.svg&revision=\d+$/,
  );
  await expect(
    preview.evaluate((image) => image.complete && image.naturalWidth > 0),
  ).resolves.toBe(true);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "image-file-viewer");
});

test("invalidates the browser cache when an open image changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Native image refresh smoke runs once.");
  const name = `live-image-${process.pid}.svg`;
  const path = resolve("tests/fixtures/home", name);
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${fill}"/></svg>`;

  await rm(path, { force: true });
  try {
    await page.goto("/");
    await page.waitForTimeout(500);
    await writeFile(path, svg("#0b7a5f"));
    const entry = page.locator(`button[data-entry-path="${name}"]`);
    await expect(entry).toBeVisible();
    await entry.click();
    const image = page.locator("caffold-file-viewer .image-preview");
    await expect(image).toBeVisible();
    const firstSource = await image.getAttribute("src");

    await writeFile(path, svg("#1f2a24"));
    await expect.poll(() => image.getAttribute("src")).not.toBe(firstSource);
  } finally {
    await rm(path, { force: true });
  }
});

test("keeps the toggled tree row anchored while expanding", async ({ page }) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list {
        max-height: 150px;
      }
    `,
  });

  await page.locator('button[data-entry-path="src"]').click();
  const planner = page.locator('button[data-entry-path="src/planner"]');
  await expect(planner).toBeVisible();

  const beforeTop = await planner.evaluate((element) => {
    const scroller = element.closest(".file-list");
    scroller.scrollTop = 0;
    return element.getBoundingClientRect().top;
  });

  await planner.click();
  await expect(page.locator('button[data-entry-path="src/planner/mod.rs"]')).toBeVisible();
  await page.waitForTimeout(50);

  const afterTop = await planner.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
});

test("resizes the left file panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The phone layout stacks panels vertically.");

  await page.goto("/");
  const handle = page.locator(".panel-resizer");
  await expect(handle).toBeVisible();

  const beforeWidth = await leftPanelWidth(page);
  await dragHorizontalResizer(page, handle, 96);

  const afterWidth = await leftPanelWidth(page);
  expect(afterWidth).toBeGreaterThan(beforeWidth + 48);
  await captureReviewScreenshot(page, testInfo, "file-panel-resized");
});

test("scrolls long names horizontally in Files and Changes", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".file-list");

  await page.locator('button[data-entry-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");
  await expect(page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`)).toBeVisible();
  await expectHorizontalScroller(page, ".changes-tree-list");
});

test("scrolls long source lines horizontally in the code viewer", async ({ page }) => {
  const longLine = "long-source-token-".repeat(48);

  await page.route(/\/api\/file(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "README.md") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        path: "README.md",
        name: "README.md",
        size: longLine.length,
        modifiedMs: null,
        languageHint: "markdown",
        content: `# Fixture Home\n\n${longLine}\n`,
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("caffold-code-viewer")).toContainText("long-source-token");
  await expectHorizontalScroller(page, "caffold-code-viewer .code-lines");
  await expectCodeViewerGutterSeparated(page);
});

test("uses a single-pane file viewer on phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Only the phone layout switches browser panes.");

  await page.goto("/");
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list {
        max-height: 140px;
      }
    `,
  });

  const fileBrowser = page.locator("caffold-file-browser");
  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator(`button[data-entry-path="${LONG_ROOT_FILE}"]`);
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();

  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "viewer");
  await expect(page.locator("caffold-file-list")).toBeHidden();
  await expect(page.locator("caffold-file-viewer")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toContainText(LONG_ROOT_FILE);
  await expect(page.getByRole("button", { name: "Back to files" })).toBeVisible();
  await expectMobileBrowserViewerOverlay(page);
  await expectMobileViewerCompactHeader(page);
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "mobile-file-viewer-single-pane");

  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(fileBrowser).toHaveAttribute("data-browser-view", "list");
  await expect(page.locator("caffold-file-list")).toBeVisible();
  await expect(page.locator("caffold-file-viewer")).toBeHidden();
  await expect(fileTarget).toHaveAttribute("aria-current", "true");
  await expectPreservedScroll(fileList, beforeFileScroll);
});

test("keeps list scroll positions when selecting files and changes", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      caffold-file-list .file-list,
      caffold-git-diff-page .changes-tree-list {
        max-height: 72px;
      }
    `,
  });

  const fileList = page.locator("caffold-file-list .file-list");
  const fileTarget = page.locator('button[data-entry-path="README.md"]');
  await fileTarget.scrollIntoViewIfNeeded();
  const beforeFileScroll = await scrollTop(fileList);
  expect(beforeFileScroll).toBeGreaterThan(0);

  await fileTarget.click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to files" }).click();
    await expect(page.locator("caffold-file-list")).toBeVisible();
  }
  await expectPreservedScroll(fileList, beforeFileScroll);

  await page.locator('button[data-entry-path="src"]').click();
  await clickHeaderAction(page, "git", "open-diff-workspace");

  const changesList = page.locator("caffold-git-diff-page .changes-tree-list");
  const changeTarget = page.locator(`button[data-change-path="${LONG_CHANGE_FILE}"]`);
  await changeTarget.scrollIntoViewIfNeeded();
  const beforeChangesScroll = await scrollTop(changesList);
  expect(beforeChangesScroll).toBeGreaterThan(0);

  await changeTarget.click();
  await expect(page.locator("caffold-diff-viewer")).toContainText("long_change_name_fixture");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(page.locator("caffold-git-diff-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(changesList).toBeVisible();
  }
  await expectPreservedScroll(changesList, beforeChangesScroll);
});

test("opens changed diffs from Changes mode", async ({ page }, testInfo) => {
  const longContextLine = ` context line ${"long-diff-token-".repeat(36)}`;
  const repository = { rootPath: "src", branch: "main", dirty: true };
  let delayNextStatus = false;
  let resolveStatusStarted;
  let releaseStatus;

  await page.route(/\/api\/git\/status(?:\?|$)/, async (route) => {
    if (delayNextStatus) {
      delayNextStatus = false;
      resolveStatusStarted?.();
      await new Promise((resolve) => {
        releaseStatus = resolve;
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        additions: 6540,
        deletions: 19618,
        files: [
          {
            path: "src/example.rs",
            repoRelativePath: "example.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/deleted.rs",
            repoRelativePath: "deleted.rs",
            status: " D",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/new-file.rs",
            repoRelativePath: "new-file.rs",
            status: "??",
            category: "untracked",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      }),
    });
  });

  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    const kind = url.searchParams.get("kind");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind,
        diff:
          kind === "untracked"
            ? [
                "diff --git a/new-file.rs b/new-file.rs",
                "new file mode 100644",
                "index 0000000..1111111",
                "--- /dev/null",
                "+++ b/new-file.rs",
                "@@ -0,0 +1,2 @@",
                "+pub fn new_file() {}",
                "+// new file line",
              ].join("\n")
            : [
                `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
                "index 1111111..2222222 100644",
                `--- a/${file.replace(/^src\//, "")}`,
                `+++ b/${file.replace(/^src\//, "")}`,
                "@@ -10,4 +10,5 @@ pub fn sample()",
                longContextLine,
                "-old line",
                "+new line",
                "+another line",
                " trailing line",
              ].join("\n"),
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const gitButton = headerActionGroupButton(page, "git");
  await expect(gitButton).toBeVisible();
  await expect(page.locator("caffold-pathbar .header-action-button")).toHaveCount(0);
  await expect(gitButton.locator(".header-action-badge")).toHaveText("3");
  await expect(gitButton.locator("img.header-action-brand-icon")).toBeVisible();
  await expect(gitButton.locator("img.header-action-brand-icon")).toHaveAttribute(
    "src",
    "/assets/brand/git-logomark-light.svg",
  );
  await expect(gitButton).not.toContainText("master");
  await expect(gitButton).toHaveAttribute("title", "Git actions, 3 changed files");

  const gitPopover = await openHeaderActionGroup(page, "git");
  const diffMenuItem = gitPopover.locator('button[data-action="open-diff-workspace"]');
  await expect(diffMenuItem.locator(".header-menu-label")).toHaveText("Diff");
  await expect(diffMenuItem.locator(".header-menu-metric")).toHaveText("3");
  await diffMenuItem.click();
  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "diff",
  );
  await expect(workspace.getByRole("button", { name: "Refresh diff" })).toBeVisible();
  const statusStarted = new Promise((resolve) => {
    resolveStatusStarted = resolve;
  });
  delayNextStatus = true;
  const refreshDiff = workspace.getByRole("button", { name: "Refresh diff" });
  await refreshDiff.click();
  await statusStarted;
  await expect(refreshDiff).toHaveClass(/is-refreshing/);
  releaseStatus();
  await expect(refreshDiff).not.toHaveClass(/is-refreshing/);
  await expect(workspace.getByRole("button", { name: "Close review workspace" })).toBeVisible();
  await expect(page.locator("caffold-git-diff-page")).toContainText("Unstaged");
  await expect(page.locator("caffold-git-diff-page")).not.toContainText("Untracked");
  await expect(page.locator("caffold-git-diff-page")).toContainText("example.rs");
  await expect(page.locator("caffold-git-diff-page")).toContainText("deleted.rs");
  await expect(page.locator("caffold-git-diff-page")).toContainText("new-file.rs");
  await expect(
    page.locator("caffold-git-diff-changes-tree .change-line-stats .is-addition"),
  ).toHaveText("+6,540");
  await expect(
    page.locator("caffold-git-diff-changes-tree .change-line-stats .is-deletion"),
  ).toHaveText("-19,618");
  await expect(page.locator('button[data-change-path="src/new-file.rs"] .change-status-code')).toHaveText(
    "A",
  );
  await expectFileTreeDensity(
    page,
    page.locator('button[data-change-path="src/new-file.rs"]'),
  );
  await captureReviewScreenshot(page, testInfo, "diff-changes-summary");
  if (testInfo.project.name !== "phone") {
    const resizeHandle = workspace.locator(".git-mode-diff .git-diff-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-git-diff-page caffold-git-diff-browser > caffold-git-diff-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-git-diff-page caffold-git-diff-browser > caffold-git-diff-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await page.locator('button[data-change-path="src/example.rs"]').click();
  await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toContainText(
    "example.rs",
  );
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText(
    "Modified · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to changes",
      detailSelector: ".git-mode-diff caffold-review-file-viewer",
      listSelector: "caffold-git-diff-changes-tree",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-git-diff-changes-tree .changes-tree-panel > header",
      ".git-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-git-diff-changes-tree .changes-tree-panel > header",
      ".git-mode-diff caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("@@ -10,4 +10,5 @@");
  await expect(page.locator("caffold-diff-viewer")).toContainText("old line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new line");
  await expectHorizontalScroller(page, "caffold-diff-viewer .diff-lines");
  await expectUnifiedDiffRowsShareScrollWidth(page);
  await expectDiffScrollerFillsViewer(page);
  await captureReviewScreenshot(page, testInfo, "diff-viewer-horizontal-scroll");

  const contextRow = page.locator(".diff-row-context").filter({ hasText: "context line" });
  await expect(contextRow.locator(".diff-old-line")).toHaveText("10");
  await expect(contextRow.locator(".diff-new-line")).toHaveText("10");

  const removedRow = page.locator(".diff-row-removed").filter({ hasText: "old line" });
  await expect(removedRow.locator(".diff-old-line")).toHaveText("11");
  await expect(removedRow.locator(".diff-new-line")).toHaveText("");
  await expect(removedRow.locator(".diff-prefix")).toHaveText("-");

  const addedRow = page.locator(".diff-row-added").filter({ hasText: "new line" });
  await expect(addedRow.locator(".diff-old-line")).toHaveText("");
  await expect(addedRow.locator(".diff-new-line")).toHaveText("11");
  await expect(addedRow.locator(".diff-prefix")).toHaveText("+");

  const trailingRow = page.locator(".diff-row-context").filter({ hasText: "trailing line" });
  await expect(trailingRow.locator(".diff-old-line")).toHaveText("12");
  await expect(trailingRow.locator(".diff-new-line")).toHaveText("13");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-git-diff-page")).toBeVisible();
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toBeHidden();
  }
  await page.locator('button[data-change-path="src/deleted.rs"]').click();
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText(
    "Deleted · Unstaged",
  );
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".git-mode-diff")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-diff-page")).toBeVisible();
    await expect(page.locator(".git-mode-diff caffold-review-file-viewer")).toBeHidden();
    await expect(page.locator('button[data-change-path="src/deleted.rs"]')).toHaveAttribute(
      "aria-current",
      "false",
    );
  }

  await page.locator('button[data-change-path="src/new-file.rs"]').click();
  await expect(page.locator(".git-mode-diff .viewer-subtitle")).toHaveText("Added");
  await expect(page.locator("caffold-diff-viewer")).toContainText("pub fn new_file");
  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to changes" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
  }

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
  await expect(page.locator("caffold-file-list")).toBeVisible();
});

test("opens branch compare diffs", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: false };
  const baseRef =
    "origin/codex/replace-coverage-badges-with-shields-for-very-long-base-branch-name";
  const headRef =
    "origin/codex/add-column-selection-to-scan-data-and-implement-in-parquet-review-flow-with-extra-long-head-reference-for-layout";
  const compareRefs = {
    repository,
    refs: [
      { name: "HEAD", kind: "head" },
      { name: "feature/review", kind: "local" },
      { name: "main", kind: "local" },
      { name: "origin/main", kind: "remote" },
      { name: baseRef, kind: "remote" },
      { name: headRef, kind: "remote" },
      { name: "origin/release", kind: "remote" },
    ],
    currentRef: "feature/review",
    defaultBaseRef: baseRef,
    defaultHeadRef: headRef,
  };

  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(compareRefs),
    });
  });

  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    const baseRef = url.searchParams.get("base");
    const headRef = url.searchParams.get("head");
    const changedPath =
      baseRef === "origin/release" ? "src/runtime/release.rs" : "src/planner/function.rs";
    const files =
      baseRef === headRef
        ? []
        : [
            {
              path: changedPath,
              repoRelativePath: changedPath.replace(/^src\//, ""),
              status: baseRef === "origin/release" ? "A" : "M",
            },
            {
              path: "src/runtime/new.rs",
              repoRelativePath: "runtime/new.rs",
              status: "A",
            },
          ];

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        baseRef,
        headRef,
        additions: files.length === 0 ? 0 : baseRef === "origin/release" ? 7 : 5,
        deletions: files.length === 0 ? 0 : baseRef === "origin/release" ? 3 : 2,
        files,
      }),
    });
  });

  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("base")).toBe("origin/release");
    expect(url.searchParams.get("head")).toBe(headRef);
    expect(url.searchParams.get("file")).toBe("src/runtime/release.rs");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: "src/runtime/release.rs",
        repoRelativePath: "runtime/release.rs",
        kind: `origin/release...${headRef}`,
        diff: [
          "diff --git a/runtime/release.rs b/runtime/release.rs",
          "index 1111111..2222222 100644",
          "--- a/runtime/release.rs",
          "+++ b/runtime/release.rs",
          "@@ -1,1 +1,2 @@",
          "-old compare line",
          "+new compare line",
          "+another compare line",
        ].join("\n"),
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const gitPopover = await openHeaderActionGroup(page, "git");
  const compareButton = gitPopover.locator('button[data-action="open-compare-workspace"]');
  await expect(compareButton.locator(".header-menu-label")).toHaveText("Compare");
  await expect(compareButton).toHaveAttribute("title", "Open Compare");
  await compareButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "compare",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Compare");
  await expect(workspace.getByRole("button", { name: "Refresh compare" })).toBeVisible();
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "2 files",
  );
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue(
    baseRef,
  );
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(
    headRef,
  );
  await expect(
    workspace.locator('select[data-compare-ref="head"] optgroup[label="Current"]'),
  ).toHaveCount(1);
  await expectCompareRefControlsFit(page, testInfo, { sameRefCss: true });
  await captureReviewScreenshot(page, testInfo, "compare-long-refs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("2 files");
  await expect(page.locator("caffold-git-compare-page")).toContainText("planner");
  await expect(page.locator("caffold-git-compare-page")).toContainText("function.rs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("new.rs");
  await expect(
    page.locator("caffold-git-compare-tree .compare-line-stats .is-addition"),
  ).toHaveText("+5");
  await expect(
    page.locator("caffold-git-compare-tree .compare-line-stats .is-deletion"),
  ).toHaveText("-2");

  await workspace.locator('select[data-compare-ref="base"]').selectOption("main");
  await workspace.locator('select[data-compare-ref="head"]').selectOption("main");
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue("main");
  await expectCompareRefControlsFit(page, testInfo, {
    compactRefs: true,
    sameRefCss: true,
    tightRefGaps: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-empty-short-refs");
  await expect(page.locator("caffold-git-compare-page")).toContainText("0 files");

  await workspace.locator('select[data-compare-ref="base"]').selectOption("origin/main");
  await workspace.locator('select[data-compare-ref="head"]').selectOption("feature/review");
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(
    "feature/review",
  );
  await expectCompareRefControlsFit(page, testInfo, {
    compactRefs: true,
    sameRefCss: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-short-refs");

  await workspace.locator('select[data-compare-ref="head"]').selectOption(headRef);
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/main");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(headRef);
  await expectCompareRefControlsFit(page, testInfo, {
    sameRefCss: true,
    mixedRefs: true,
  });
  await captureReviewScreenshot(page, testInfo, "compare-mixed-refs");
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 2048, height: 900 });
    await expectCompareRefControlsFit(page, testInfo, {
      sameRefCss: true,
      mixedRefs: true,
      visibleHeadRef: true,
    });
    await captureReviewScreenshot(page, testInfo, "compare-mixed-refs-wide");
  }

  await workspace.locator('select[data-compare-ref="base"]').selectOption(
    "origin/release",
  );
  await expect(workspace.locator('select[data-compare-ref="base"]')).toHaveValue("origin/release");
  await expect(workspace.locator('select[data-compare-ref="head"]')).toHaveValue(headRef);
  await expect(page.locator("caffold-git-compare-page")).toContainText("release.rs");
  await expectFileTreeDensity(
    page,
    page.locator('button[data-compare-path="src/runtime/release.rs"]'),
  );

  await page.locator('button[data-compare-path="src/runtime/release.rs"]').click();
  await expect(page.locator('button[data-compare-path="src/runtime/release.rs"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator(".git-mode-compare caffold-review-file-viewer")).toContainText(
    "release.rs",
  );
  await expect(page.locator(".git-mode-compare .viewer-subtitle")).toHaveText(
    `Added · origin/release...${headRef}`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("old compare line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new compare line");
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to compare",
      detailSelector: ".git-mode-compare caffold-review-file-viewer",
      listSelector: "caffold-git-compare-tree",
    });
    await page.getByRole("button", { name: "Back to compare" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(workspace.locator(".git-mode-compare")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(page.locator("caffold-git-compare-page")).toBeVisible();
    await expect(page.locator(".git-mode-compare caffold-review-file-viewer")).toBeHidden();
  }
});

test("opens GitHub issues from the header", async ({ page }, testInfo) => {
  const repository = { rootPath: "src", branch: "feature/review", dirty: false };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const issues = [
    {
      number: 42,
      title: "Track mobile review issues",
      state: "OPEN",
      author: "taehoon",
      labels: ["review", "mobile"],
      assignees: [],
      comments: 3,
      updatedAt: "2026-07-01T10:00:00Z",
      url: "https://github.com/example/caffold/issues/42",
    },
    {
      number: 41,
      title: "Keep readonly GitHub access narrow",
      state: "OPEN",
      author: "codex",
      labels: ["github"],
      assignees: ["taehoon"],
      comments: 0,
      updatedAt: "2026-07-01T09:00:00Z",
      url: "https://github.com/example/caffold/issues/41",
    },
  ];
  const olderIssues = [
    {
      number: 7,
      title: "Older issue still reachable by pagination",
      state: "OPEN",
      author: "taehoon",
      labels: ["pagination"],
      assignees: [],
      comments: 1,
      updatedAt: "2026-06-30T09:00:00Z",
      url: "https://github.com/example/caffold/issues/7",
    },
  ];

  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });

  await page.route(/\/api\/github\/issues(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 260);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        issues: pageNumber === 2 ? olderIssues : issues,
        page: pageNumber,
        perPage: 50,
        totalIssues: 75,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });

  await page.route(/\/api\/github\/issue(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("42");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        issue: {
          ...issues[0],
          body: "**Review** GitHub issues without leaving the readonly console.\n\n```sh\ncargo test\n```",
          bodyHtml: `
            <h2>Review Steps</h2>
            <p><strong>Review</strong> GitHub issues without leaving the readonly console.</p>
            <pre><code>cargo test</code></pre>
            <table>
              <thead>
                <tr><th>Feature</th><th>Status</th><th>Notes</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Long markdown table support</td>
                  <td>Ready</td>
                  <td>Preserve readable columns without splitting words on phone-width review screens</td>
                </tr>
              </tbody>
            </table>
            <a href="https://example.com/docs">docs</a>
            <a href="javascript:alert(1)">unsafe</a>
            <script>alert(1)</script>
          `,
          createdAt: "2026-07-01T08:00:00Z",
        },
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const githubPopover = await openHeaderActionGroup(page, "github");
  const issuesButton = githubPopover.locator(
    'button[data-action="open-github-issues-workspace"]',
  );
  await expect(issuesButton.locator(".header-menu-label")).toHaveText("Issues");
  await issuesButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issues");
  await expect(workspace.locator(".review-workspace-subtitle")).toHaveText(
    "example/caffold · 75 issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Track mobile review issues",
  );
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Keep readonly GitHub access narrow",
  );
  await expect(page.locator("caffold-github-issues-list-page .github-issues-count")).toHaveText(
    "75 issues",
  );
  const issuePagination = page.locator("caffold-github-issues-list-page caffold-pagination");
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Newer issue page" })).toBeDisabled();
  await expect(page.locator("caffold-github-issues-list-page")).toBeVisible();
  await expect(page.locator("caffold-github-issue-detail-page")).toBeHidden();
  await expectAlignedWorkspaceHeaders(page, [
    "caffold-review-workspace .review-workspace-header",
    "caffold-github-issues-list-page .github-issues-panel > header",
  ]);
  await expectMatchingPaneTitleSizes(page, [
    "caffold-github-issues-list-page .github-issues-panel > header",
  ]);
  await captureReviewScreenshot(page, testInfo, "github-issues-list");

  await page.locator('button[data-issue-number="42"]').click();
  const issueViewer = page.locator("caffold-github-issue-detail-page");
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".github-mode-issues")).toHaveAttribute(
    "data-issues-view",
    "detail",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issue");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "#42 Track mobile review issues",
  );
  await expect(workspace.getByRole("button", { name: "Back to issues" })).toBeVisible();
  await expect(page.locator("caffold-github-issues-list-page")).toBeHidden();
  await expect(issueViewer).toBeVisible();
  await expect(issueViewer).toContainText("Track mobile review issues");
  await expect(issueViewer).toContainText("3 comments");
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to issues",
      detailSelector: "caffold-github-issue-detail-page",
      listSelector: "caffold-github-issues-list-page",
    });
  }
  const markdownViewer = issueViewer.locator("caffold-github-markdown");
  await expect(markdownViewer).toBeVisible();
  await expect(markdownViewer.locator("h2")).toHaveText("Review Steps");
  await expect(markdownViewer.locator("strong")).toHaveText("Review");
  await expect(markdownViewer.locator("pre")).toContainText("cargo test");
  const markdownSafety = await markdownViewer.evaluate((element) => {
    const root = element.shadowRoot;
    const docsLink = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "docs",
    );
    const unsafeLink = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "unsafe",
    );

    return {
      scripts: root.querySelectorAll("script").length,
      docsTarget: docsLink?.getAttribute("target"),
      docsRel: docsLink?.getAttribute("rel"),
      unsafeLinkPresent: Boolean(unsafeLink),
      unsafeHref: unsafeLink?.getAttribute("href") ?? null,
    };
  });
  expect(markdownSafety).toEqual({
    scripts: 0,
    docsTarget: "_blank",
    docsRel: "noreferrer",
    unsafeLinkPresent: false,
    unsafeHref: null,
  });
  const markdownLayout = await markdownViewer.evaluate((element) => {
    const root = element.shadowRoot;
    const wrapper = root.querySelector(".markdown-table-scroll");
    const cell = root.querySelector("td");
    const hostStyle = getComputedStyle(element);
    const headingStyle = getComputedStyle(root.querySelector("h2"));
    const cellStyle = getComputedStyle(cell);

    return {
      hasTableScrollWrapper: Boolean(wrapper),
      tableScrolls: wrapper ? wrapper.scrollWidth > wrapper.clientWidth : false,
      cellWhiteSpace: cellStyle.whiteSpace,
      hostFontSize: hostStyle.fontSize,
      headingFontSize: headingStyle.fontSize,
    };
  });
  expect(markdownLayout).toMatchObject({
    hasTableScrollWrapper: true,
    cellWhiteSpace: "nowrap",
    hostFontSize: "14px",
  });
  expect(Number.parseFloat(markdownLayout.headingFontSize)).toBeGreaterThan(14);
  if (testInfo.project.name === "phone") {
    expect(markdownLayout.tableScrolls).toBe(true);
  }
  await expect(issueViewer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/caffold/issues/42",
  );
  await captureReviewScreenshot(page, testInfo, "github-issue-detail");

  if (testInfo.project.name === "phone") {
    await issueViewer.getByRole("button", { name: "Back to issues" }).click();
  } else {
    await workspace.getByRole("button", { name: "Back to issues" }).click();
  }
  await expect(workspace.locator(".github-mode-issues")).toHaveAttribute(
    "data-issues-view",
    "list",
  );
  await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Issues");
  await expect(page.locator("caffold-github-issues-list-page")).toBeVisible();
  await expect(issueViewer).toBeHidden();

  await issuePagination.getByRole("button", { name: "Oldest issue page" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator("caffold-github-issues-list-page .github-issues-loading-body")).toHaveText(
    "Loading issues...",
  );
  await expect(page.locator("caffold-github-issues-list-page")).not.toContainText(
    "Track mobile review issues",
  );
  await expect(issuePagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(issuePagination.getByRole("button", { name: "Newest issue page" })).toBeEnabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expect(page.locator("caffold-github-issues-list-page")).toContainText(
    "Older issue still reachable by pagination",
  );
  await expect(page.locator("caffold-github-issues-list-page")).not.toContainText("Loading issues...");
  await expect(issuePagination.getByRole("button", { name: "Older issue page" })).toBeDisabled();
  await expect(issuePagination.getByRole("button", { name: "Oldest issue page" })).toBeDisabled();
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "github-issues-page-2");
});

test("opens GitHub pull requests from the header", async ({ page }, testInfo) => {
  const project = await mockRegisteredProject(page);
  const repository = { rootPath: "src", branch: "feature/pr-review", dirty: false };
  const github = {
    owner: "example",
    name: "caffold",
    nameWithOwner: "example/caffold",
    url: "https://github.com/example/caffold",
  };
  const pulls = [
    {
      number: 12,
      title: "Add read-only PR review surface",
      state: "open",
      draft: false,
      author: "taehoon",
      labels: ["github", "review"],
      comments: 4,
      updatedAt: "2026-07-01T10:00:00Z",
      url: "https://github.com/example/caffold/pull/12",
    },
    {
      number: 11,
      title: "Keep PR actions readonly",
      state: "open",
      draft: true,
      author: "codex",
      labels: ["safety"],
      comments: 1,
      updatedAt: "2026-07-01T09:00:00Z",
      url: "https://github.com/example/caffold/pull/11",
    },
  ];
  const olderPulls = [
    {
      number: 5,
      title: "Older PR reachable by pagination",
      state: "open",
      draft: false,
      author: "taehoon",
      labels: ["pagination"],
      comments: 0,
      updatedAt: "2026-06-30T09:00:00Z",
      url: "https://github.com/example/caffold/pull/5",
    },
  ];
  const longPullBodyHtml = [
    "<p><strong>Review</strong> PR body for the readonly surface.</p>",
    ...Array.from(
      { length: 36 },
      (_, index) => `
        <h2>Deep PR section ${index + 1}</h2>
        <p>Scrollable pull request detail content line ${index + 1}.</p>
      `,
    ),
    "<p>Deep PR body sentinel</p>",
  ].join("");
  let pullFilesRequests = 0;
  let listRequests = 0;

  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    listRequests += 1;
    await route.continue();
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        files: [],
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });
  await page.route(/\/api\/github\/pulls(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("perPage")).toBe("50");
    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 260);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        state: "open",
        pulls: pageNumber === 2 ? olderPulls : pulls,
        page: pageNumber,
        perPage: 50,
        totalPulls: 64,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        pull: {
          ...pulls[0],
          state: "OPEN",
          comments: 1,
          reviews: 1,
          commits: 2,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          baseRefName: "main",
          headRefName: "feature/pr-review",
          body: "**Review** PR body for the readonly surface.\n\nDeep PR body sentinel",
          bodyHtml: longPullBodyHtml,
          createdAt: "2026-07-01T08:00:00Z",
          conversationComments: [
            {
              author: "taehoon",
              body: "Conversation comment body",
              bodyHtml: "<p>Conversation comment body</p>",
              createdAt: "2026-07-01T08:30:00Z",
              updatedAt: "2026-07-01T08:30:00Z",
              url: "https://github.com/example/caffold/pull/12#issuecomment-1",
            },
          ],
          reviewComments: [
            {
              author: "codex",
              state: "COMMENTED",
              body: "Review summary body",
              bodyHtml: "<p>Review summary body</p>",
              submittedAt: "2026-07-01T09:00:00Z",
            },
          ],
          commitSummaries: [
            {
              sha: "1234567890abcdef1234567890abcdef12345678",
              shortSha: "1234567",
              subject: "Add PR files route",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:00:00Z",
              committedAt: "2026-07-01T09:00:00Z",
              url: "https://github.com/example/caffold/commit/1234567",
            },
            {
              sha: "abcdef1234567890abcdef1234567890abcdef12",
              shortSha: "abcdef1",
              subject: "Render PR conversation",
              authorName: "Caffold",
              authorEmail: "caffold@example.test",
              authoredAt: "2026-07-01T09:10:00Z",
              committedAt: "2026-07-01T09:10:00Z",
              url: "https://github.com/example/caffold/commit/abcdef1",
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/github\/pull-files(?:\?|$)/, (route) => {
    pullFilesRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        files: [
          {
            path: "src/planner/mod.rs",
            repoRelativePath: "planner/mod.rs",
            previousPath: null,
            status: "M",
            additions: 10,
            deletions: 2,
            changes: 12,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/planner/mod.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/planner/mod.rs",
          },
          {
            path: "src/runtime/lib.rs",
            repoRelativePath: "runtime/lib.rs",
            previousPath: null,
            status: "A",
            additions: 2,
            deletions: 0,
            changes: 2,
            patchAvailable: true,
            blobUrl: "https://github.com/example/caffold/blob/pr/runtime/lib.rs",
            rawUrl: "https://raw.githubusercontent.com/example/caffold/pr/runtime/lib.rs",
          },
        ],
        totalFiles: 2,
      }),
    });
  });
  await page.route(/\/api\/github\/pull-file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("number")).toBe("12");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        github,
        number: 12,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        status: file.endsWith("lib.rs") ? "A" : "M",
        kind: "PR #12",
        diff: [
          `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
          "@@ -1,1 +1,2 @@",
          "-old PR review line",
          "+new PR review line",
          "+another PR review line",
        ].join("\n"),
        diffUnavailable: false,
        message: null,
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-project-switcher")).toContainText(project.name);

  const githubPopover = await openHeaderActionGroup(page, "github");
  const pullsButton = githubPopover.locator('button[data-action="open-github-pulls-workspace"]');
  await expect(pullsButton.locator(".header-menu-label")).toHaveText("PRs");
  await pullsButton.click();

  const workspace = page.locator("caffold-review-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "github");
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Pull Requests");
  await expect(workspace.locator(".review-workspace-subtitle")).toHaveText(
    "example/caffold · 64 PRs",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Add read-only PR review surface",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Keep PR actions readonly",
  );
  await expect(page.locator("caffold-github-pulls-list-page .github-pulls-count")).toHaveText(
    "64 PRs",
  );
  await expect(page.locator("caffold-github-pull-detail-page")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "github-pulls-list");

  await page.locator('button[data-pull-number="12"]').click();
  const pullViewer = page.locator("caffold-github-pull-detail-page");
  await expect(workspace.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "detail",
  );
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("PR");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText(
    "#12 Add read-only PR review surface",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).toBeHidden();
  await expect(pullViewer).toBeVisible();
  await expect(pullViewer).toContainText("Conversation comment body");
  await expect(pullViewer).toContainText("Review summary body");
  await expect(pullViewer).toContainText("Add PR files route");
  await expect(pullViewer).toContainText("Deep PR body sentinel");
  await expect(pullViewer.locator("caffold-github-markdown").first().locator("strong")).toHaveText(
    "Review",
  );
  const pullDetailScroll = await pullViewer.locator(".github-pull-viewer-scroll").evaluate((el) => {
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  expect(pullDetailScroll.overflowY).toBe("auto");
  expect(pullDetailScroll.scrollHeight).toBeGreaterThan(pullDetailScroll.clientHeight);
  expect(pullDetailScroll.scrollTop).toBe(0);

  const pullDetailScrollBox = await pullViewer
    .locator(".github-pull-viewer-scroll")
    .boundingBox();
  expect(pullDetailScrollBox).not.toBeNull();
  await page.mouse.move(
    pullDetailScrollBox.x + pullDetailScrollBox.width / 2,
    pullDetailScrollBox.y + pullDetailScrollBox.height / 2,
  );
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(100);
  const pullDetailScrollTop = await pullViewer
    .locator(".github-pull-viewer-scroll")
    .evaluate((el) => el.scrollTop);
  expect(pullDetailScrollTop).toBeGreaterThan(0);
  const pullContentLayout = await pullViewer.evaluate((element) => {
    const scroll = element.querySelector(".github-pull-viewer-scroll").getBoundingClientRect();
    const heading = element.querySelector(".github-pull-section > h3").getBoundingClientRect();
    const commits = element.querySelector(".github-pull-commits").getBoundingClientRect();

    return {
      scrollLeft: scroll.left,
      scrollWidth: scroll.width,
      headingLeft: heading.left,
      headingWidth: heading.width,
      commitsLeft: commits.left,
      commitsWidth: commits.width,
    };
  });
  expect(pullContentLayout.headingWidth).toBeLessThanOrEqual(
    Math.min(pullContentLayout.scrollWidth, 980) + 1,
  );
  expect(pullContentLayout.commitsWidth).toBeLessThanOrEqual(
    Math.min(pullContentLayout.scrollWidth, 980) + 1,
  );
  if (pullContentLayout.scrollWidth > 1040) {
    expect(pullContentLayout.headingLeft).toBeGreaterThan(
      pullContentLayout.scrollLeft + 40,
    );
    expect(pullContentLayout.commitsLeft).toBeGreaterThan(
      pullContentLayout.scrollLeft + 40,
    );
  }
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to pull requests",
      detailSelector: "caffold-github-pull-detail-page",
      listSelector: "caffold-github-pulls-list-page",
    });
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-detail");

  await pullViewer.getByRole("button", { name: "Open files for PR #12" }).click();
  await expect(workspace.locator(".github-mode-pulls")).toHaveAttribute(
    "data-pulls-view",
    "files",
  );
  await expect(page.locator("caffold-github-pull-files-tree")).toContainText("2 files");
  await expect(page.locator('button[data-pull-file-path="src/planner/mod.rs"]')).toBeVisible();
  await expectFileTreeDensity(
    page,
    page.locator('button[data-pull-file-path="src/planner/mod.rs"]'),
  );
  await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  if (testInfo.project.name === "phone") {
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(page.locator("caffold-github-pull-files-tree")).toBeVisible();
    await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toBeHidden();
  }

  const listRequestsBeforeFileClick = listRequests;
  const pullFilesRequestsBeforeFileClick = pullFilesRequests;
  await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
  await expect(page).toHaveURL(
    `/projects/${project.id}/pulls/12/files/planner/mod.rs`,
  );
  await expect(page.locator("caffold-diff-viewer")).toContainText("new PR review line");
  expect(listRequests).toBe(listRequestsBeforeFileClick);
  expect(pullFilesRequests).toBe(pullFilesRequestsBeforeFileClick);
  if (testInfo.project.name === "phone") {
    await expectMobileReviewDetail(page, {
      backName: "Back to PR files",
      detailSelector: ".github-mode-pulls caffold-review-file-viewer",
      listSelector: "caffold-github-pull-files-tree",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".github-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-github-pull-files-tree .github-pull-files-panel > header",
      ".github-mode-pulls caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await captureReviewScreenshot(page, testInfo, "github-pull-file-diff");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to PR files" }).click();
    await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files`);
    await expect(page.locator("caffold-github-pull-files-page")).toBeVisible();
    await expect(page.locator(".github-mode-pulls caffold-review-file-viewer")).toBeHidden();
    await page.locator('button[data-pull-file-path="src/planner/mod.rs"]').click();
    await expect(page).toHaveURL(
      `/projects/${project.id}/pulls/12/files/planner/mod.rs`,
    );
    await page.getByRole("button", { name: "Back to PR files" }).click();
    await expect(page).toHaveURL(`/projects/${project.id}/pulls/12/files`);
  }
  await workspace.getByRole("button", { name: "Back to PR" }).click();
  await expect(page).toHaveURL(`/projects/${project.id}/pulls/12`);
  await expect(pullViewer).toBeVisible();
  if (testInfo.project.name === "phone") {
    await pullViewer.getByRole("button", { name: "Back to pull requests" }).click();
  } else {
    await workspace.getByRole("button", { name: "Back to pull requests" }).click();
  }
  await expect(page).toHaveURL(`/projects/${project.id}/pulls`);
  await expect(page.locator("caffold-github-pulls-list-page")).toBeVisible();

  const pullPagination = page.locator("caffold-github-pulls-list-page caffold-pagination");
  await pullPagination.getByRole("button", { name: "Oldest pull request page" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator("caffold-github-pulls-list-page .github-pulls-loading-body")).toHaveText(
    "Loading pull requests...",
  );
  await expect(pullPagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("caffold-github-pulls-list-page")).toContainText(
    "Older PR reachable by pagination",
  );
  await expect(page.locator("caffold-github-pulls-list-page")).not.toContainText(
    "Loading pull requests...",
  );
  await expectGlobalScrollLocked(page);
  await captureReviewScreenshot(page, testInfo, "github-pulls-page-2");
});

test("opens commit diffs from Log mode", async ({ page }, testInfo) => {
  const commit = {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    shortSha: "abcdef1",
    subject: "Update planner function",
    body: "Explain the planner update.\n\nKeep review context visible in the log.",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_767_000_000_000,
  };
  const fillerCommits = Array.from({ length: 49 }, (_, index) => ({
    sha: `feed${index.toString(16).padStart(36, "0")}`,
    shortSha: `feed${index.toString(16).padStart(3, "0")}`,
    subject: `Earlier commit ${index + 1}`,
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_766_000_000_000 - index * 1000,
  }));
  const olderCommits = Array.from({ length: 25 }, (_, index) => ({
    sha: `dead${index.toString(16).padStart(36, "0")}`,
    shortSha: `dead${index.toString(16).padStart(3, "0")}`,
    subject: `Oldest page commit ${index + 1}`,
    body: "",
    authorName: "Caffold",
    authorEmail: "caffold@example.test",
    authorTimeMs: 1_765_000_000_000 - index * 1000,
  }));
  const pageOneCommits = [...fillerCommits, commit];
  const totalCommits = pageOneCommits.length + olderCommits.length;
  const repository = { rootPath: "src", branch: "main", dirty: true };

  await page.route(/\/api\/git\/log(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("perPage") ?? "50");
    const commits = pageNumber === 2 ? olderCommits : pageOneCommits;

    if (pageNumber === 2) {
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commits,
        page: pageNumber,
        perPage,
        totalCommits,
        totalPages: 2,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < 2,
      }),
    });
  });

  await page.route(/\/api\/git\/commit(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        commit,
        additions: 12,
        deletions: 4,
        files: [
          {
            path: "src/planner/function.rs",
            repoRelativePath: "planner/function.rs",
            status: "M",
          },
          {
            path: "src/runtime/lib.rs",
            repoRelativePath: "runtime/lib.rs",
            status: "A",
          },
        ],
      }),
    }),
  );

  await page.route(/\/api\/git\/commit-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository,
        path: file,
        repoRelativePath: file.replace(/^src\//, ""),
        kind: "commit abcdef1",
        diff: [
          `diff --git a/${file.replace(/^src\//, "")} b/${file.replace(/^src\//, "")}`,
          "index 1111111..2222222 100644",
          `--- a/${file.replace(/^src\//, "")}`,
          `+++ b/${file.replace(/^src\//, "")}`,
          "@@ -1,1 +1,2 @@",
          "-old planner line",
          "+new planner line",
          "+another planner line",
        ].join("\n"),
      }),
    });
  });

  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();

  const gitPopover = await openHeaderActionGroup(page, "git");
  const logButton = gitPopover.locator('button[data-action="open-log-workspace"]');
  await expect(logButton.locator(".header-menu-label")).toHaveText("Log");
  await expect(logButton).toHaveAttribute("title", "Open Log");
  await logButton.click();
  const workspace = page.locator("caffold-review-workspace");
  const logView = workspace.locator(".git-mode-log");
  const backButton = workspace.locator('button[data-action="back-review-workspace"]');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute("data-workspace-mode", "git");
  await expect(workspace.locator("caffold-git-review-layout")).toHaveAttribute(
    "data-git-mode",
    "log",
  );
  await expect(workspace.getByRole("button", { name: "Refresh log" })).toBeVisible();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Update planner function");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("abcdef1");
  await expect(page.locator("caffold-git-log-list-page")).toBeVisible();
  await expect(page.locator("caffold-git-log-commit-page")).toBeHidden();
  await captureReviewScreenshot(page, testInfo, "log-list");
  const pagination = page.locator("caffold-git-log-list-page caffold-pagination");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(pagination.getByRole("button", { name: "Newest page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Newer page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Oldest page" }).click();
  await page.waitForTimeout(40);
  const preservedLogText = await page.locator("caffold-git-log-list-page").textContent();
  expect(preservedLogText).toContain("Update planner function");
  expect(preservedLogText).not.toContain("Loading log...");
  await expect(pagination.locator(".pagination-indicator")).toHaveText("2 / 2");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Oldest page commit 1");
  await expect(pagination.getByRole("button", { name: "Older page" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Oldest page" })).toBeDisabled();

  await pagination.getByRole("button", { name: "Newest page" }).click();
  await expect(pagination.locator(".pagination-indicator")).toHaveText("1 / 2");
  await expect(page.locator("caffold-git-log-list-page")).toContainText("Update planner function");

  const logEntry = page.locator(
    'caffold-git-log-list-page .log-entry[data-commit-sha="abcdef1234567890abcdef1234567890abcdef12"]',
  );
  const logList = page.locator("caffold-git-log-list-page .log-list");
  await logEntry.scrollIntoViewIfNeeded();
  const beforeLogScroll = await scrollTop(logList);
  expect(beforeLogScroll).toBeGreaterThan(0);
  await expect(logEntry).not.toHaveAttribute("aria-current");
  const bodyToggle = logEntry.getByRole("button", { name: /Expand commit body for abcdef1/ });
  await bodyToggle.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(logEntry).not.toHaveAttribute("aria-current");
  await expectPreservedScroll(logList, beforeLogScroll);
  await expect(logEntry.locator(".log-body")).toContainText("Explain the planner update.");
  await expect(logEntry.locator(".log-body")).toContainText("Keep review context visible");
  await logEntry.getByRole("button", { name: /Collapse commit body for abcdef1/ }).click();
  await expect(logEntry.locator(".log-body")).toHaveCount(0);
  await expectPreservedScroll(logList, beforeLogScroll);

  await logEntry.getByRole("button", { name: /Open commit diff for abcdef1/ }).click();
  await expect(logView).toHaveAttribute("data-log-view", "detail");
  await expect(page.locator("caffold-git-log-list-page")).toBeHidden();
  await expect(page.locator("caffold-git-log-commit-page")).toBeVisible();
  await expect(backButton).toBeVisible();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Commit");
  await expect(workspace.locator(".review-workspace-subtitle")).toContainText("abcdef1");
  const commitTree = page.locator("caffold-commit-changes-tree");
  await expect(commitTree).toContainText("2 files");
  await expect(commitTree.locator(".commit-line-stats .is-addition")).toHaveText("+12");
  await expect(commitTree.locator(".commit-line-stats .is-deletion")).toHaveText("-4");
  await expect(commitTree).not.toContainText("Update planner function");
  await expect(commitTree).toContainText("planner");
  await expect(commitTree).toContainText("function.rs");
  const commitFileButton = page.locator('button[data-commit-path="src/planner/function.rs"]');
  await expect(commitFileButton).toHaveAttribute("aria-current", "false");
  await expectFileTreeDensity(page, commitFileButton);
  await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toContainText(
    "Select a file to inspect it.",
  );
  await captureReviewScreenshot(page, testInfo, "log-commit-detail");
  if (testInfo.project.name === "phone") {
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  if (testInfo.project.name === "desktop") {
    const resizeHandle = workspace.locator("caffold-git-log-commit-page .review-panel-resizer");
    await expect(resizeHandle).toBeVisible();
    const beforeReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace caffold-git-log-commit-page > caffold-commit-changes-tree",
    );
    await dragHorizontalResizer(page, resizeHandle, 96);
    const afterReviewWidth = await elementWidth(
      page,
      "caffold-review-workspace caffold-git-log-commit-page > caffold-commit-changes-tree",
    );
    expect(afterReviewWidth).toBeGreaterThan(beforeReviewWidth + 48);
  }

  await commitFileButton.click();
  await expect(commitFileButton).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".git-mode-log .viewer-subtitle")).toHaveText(
    "Modified · Commit abcdef1",
  );
  if (testInfo.project.name === "phone") {
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "viewer",
    );
    await expectMobileReviewDetail(page, {
      backName: "Back to commit",
      detailSelector: ".git-mode-log caffold-review-file-viewer",
      listSelector: "caffold-commit-changes-tree",
    });
  } else {
    await expectAlignedWorkspaceHeaders(page, [
      "caffold-review-workspace .review-workspace-header",
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".git-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
    await expectMatchingPaneTitleSizes(page, [
      "caffold-commit-changes-tree .commit-tree-panel > header",
      ".git-mode-log caffold-review-file-viewer .viewer-panel > header",
    ]);
  }
  await expect(page.locator("caffold-diff-viewer")).toContainText("old planner line");
  await expect(page.locator("caffold-diff-viewer")).toContainText("new planner line");
  await captureReviewScreenshot(page, testInfo, "log-commit-file-diff");

  if (testInfo.project.name === "phone") {
    await page.getByRole("button", { name: "Back to commit" }).click();
    await expect(workspace).toHaveAttribute("data-mobile-detail", "false");
    await expect(logView.locator("caffold-git-log-commit-page")).toHaveAttribute(
      "data-detail-view",
      "list",
    );
    await expect(commitTree).toBeVisible();
    await expect(page.locator(".git-mode-log caffold-review-file-viewer")).toBeHidden();
  }
  await backButton.click();
  await expect(logView).toHaveAttribute("data-log-view", "list");
  await expect(backButton).toBeHidden();
  await expect(workspace.locator(".review-workspace-title h2")).toHaveText("Log");
  await expect(page.locator("caffold-git-log-list-page")).toBeVisible();
  await expect(page.locator("caffold-git-log-commit-page")).toBeHidden();
  await expect(logEntry).not.toHaveAttribute("aria-current");

  await workspace.getByRole("button", { name: "Close review workspace" }).click();
  await expect(workspace).toBeHidden();
});

test("restores the last opened directory after reload", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[data-entry-path="src"]').click();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();

  await page.reload();
  await expect(page.locator("caffold-pathbar")).toContainText("src");
  await expect(page.locator("caffold-file-list .git-summary")).toBeVisible();
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "src",
  );
});

test("falls back when the stored directory no longer opens", async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(key, "missing-directory");
    },
    [LAST_DIRECTORY_KEY],
  );

  await page.goto("/");
  await expect(page.locator("caffold-file-list")).toContainText("src");
  await expect(page.locator(".parent-entry")).toHaveCount(0);
  await expect(page.evaluate((key) => localStorage.getItem(key), LAST_DIRECTORY_KEY)).resolves.toBe(
    "",
  );
});

test("extends the line-number gutter for short files", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator('button[data-entry-path="README.md"]').click();
  await expect(page.locator("caffold-file-viewer")).toContainText("README.md");
  await expect(page.locator("caffold-code-viewer")).toContainText("Fixture Home");
  await expect(page.locator(".line-number").first()).toHaveText("1");
  await expectGlobalScrollLocked(page);

  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "short-file-gutter");
});

async function captureReviewScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach(`${name}-${testInfo.project.name}`, {
    path,
    contentType: "image/png",
  });
}

async function openProjectPopover(switcher) {
  const popover = switcher.locator(".project-popover");
  if (!(await popover.isVisible())) {
    await switcher.locator(".project-switcher-button").click();
  }

  await expect(popover).toBeVisible();
}

function headerActionGroupButton(page, group) {
  return page.locator(`caffold-header-actions button[data-action-group="${group}"]`);
}

function mockCodexStatus(overrides = {}) {
  return {
    available: true,
    codexCliAvailable: true,
    appServerAvailable: true,
    message: null,
    account: {
      accountType: "chatgpt",
      email: "user@example.com",
      planType: "pro",
    },
    requiresOpenaiAuth: true,
    rateLimits: {
      rateLimitResetCredits: {
        availableCount: 3,
      },
      rateLimits: {
        primary: {
          usedPercent: 83,
          resetsAt: 1914709200,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 31,
          resetsAt: 1915243200,
          windowDurationMins: 10080,
        },
      },
    },
    usage: {
      summary: {
        lifetimeTokens: 1234567,
      },
    },
    appServer: {
      userAgent: "Codex Desktop/0.142.3",
      codexHome: "/Users/example/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
    ...overrides,
  };
}

async function expectHeaderBrand(page) {
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

async function openHeaderActionGroup(page, group) {
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

async function clickHeaderAction(page, group, action) {
  const popover = await openHeaderActionGroup(page, group);
  await popover.locator(`button[data-action="${action}"]`).click();
}

async function expectFileTreeDensity(page, entry) {
  const metrics = await entry.evaluate((element) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const entryStyle = getComputedStyle(element);
    const iconStyle = getComputedStyle(element.querySelector(".entry-icon-svg"));
    const status = element.querySelector('[class*="status-code"]');

    return {
      expected: {
        fontSize: rootStyle.getPropertyValue("--file-tree-font-size").trim(),
        rowHeight: rootStyle.getPropertyValue("--file-tree-row-height").trim(),
        iconSize: rootStyle.getPropertyValue("--file-tree-icon-size").trim(),
        gap: rootStyle.getPropertyValue("--file-tree-column-gap").trim(),
        paddingTop: rootStyle.getPropertyValue("--file-tree-padding-y").trim(),
        paddingRight: rootStyle.getPropertyValue("--file-tree-padding-right").trim(),
        paddingLeft: rootStyle.getPropertyValue("--file-tree-padding-left").trim(),
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

async function expectHeaderActionsFit(page) {
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
    const project = document.querySelector("caffold-project-switcher .project-switcher-button");
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
      project: box(project),
      git: box(git),
      github: box(github),
      codex: box(codex),
      badge: box(badge),
    };
  });

  expect(metrics.header.scrollWidth).toBeLessThanOrEqual(metrics.header.clientWidth + 1);
  expect(metrics.brand.right).toBeLessThanOrEqual(metrics.project.left);
  expect(metrics.project.right).toBeLessThanOrEqual(metrics.git.left);
  expect(metrics.git.right).toBeLessThanOrEqual(metrics.github.left);
  expect(metrics.github.right).toBeLessThanOrEqual(metrics.codex.left);
  expect(metrics.codex.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.git.width).toBeGreaterThanOrEqual(30);
  expect(metrics.git.width).toBeLessThanOrEqual(32);
  expect(metrics.github.width).toBeGreaterThanOrEqual(30);
  expect(metrics.github.width).toBeLessThanOrEqual(32);
  expect(metrics.codex.width).toBeGreaterThanOrEqual(30);
  expect(metrics.codex.width).toBeLessThanOrEqual(32);

  if (metrics.badge) {
    expect(metrics.badge.left).toBeGreaterThanOrEqual(metrics.git.left);
    expect(metrics.badge.right).toBeGreaterThan(metrics.git.right);
    expect(metrics.badge.right).toBeLessThanOrEqual(metrics.github.left);
    expect(metrics.badge.bottom).toBeGreaterThan(metrics.git.top);
    expect(metrics.badge.top).toBeLessThanOrEqual(metrics.git.top + 2);
  }
}

async function expectHeaderButtonOpacity(page, group, expected) {
  const opacity = await headerActionGroupButton(page, group).evaluate((button) =>
    Number.parseFloat(window.getComputedStyle(button).opacity),
  );

  expect(opacity).toBeCloseTo(expected, 2);
}

async function expectHeaderPopoverFits(page, group) {
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

async function expectHeaderGroupOpenVisualState(page, group) {
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
  expect(metrics.arrowWidth).toBe("10px");
  expect(metrics.arrowHeight).toBe("10px");
  expect(Math.abs(metrics.arrowCenter - metrics.buttonCenter)).toBeLessThanOrEqual(4);
  expect(metrics.buttonToArrowGap).toBeGreaterThanOrEqual(-1);
  expect(metrics.buttonToArrowGap).toBeLessThanOrEqual(3);
}

async function mockRegisteredProject(page, overrides = {}) {
  const project = {
    id: "prj_route_fixture",
    name: "src",
    rootPath: resolve("tests/fixtures/home/src"),
    relativePath: "src",
    createdMs: 1,
    updatedMs: 1,
    lastOpenedMs: 1,
    ...overrides,
  };

  await page.route(`/api/projects/${project.id}/open`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(project),
    }),
  );
  await page.route(/\/api\/projects(?:\?|$)/, (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ projects: [project] }),
    });
  });
  await page.route(/\/api\/project-candidate(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const inProject = path === project.relativePath || path.startsWith(`${project.relativePath}/`);

    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        candidate: inProject
          ? {
              name: project.name,
              rootPath: project.rootPath,
              relativePath: project.relativePath,
              alreadyRegistered: true,
              projectId: project.id,
            }
          : null,
      }),
    });
  });

  return project;
}

async function mockCodexModels(page) {
  await page.route(/\/api\/codex\/models(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Best for deeper coding work",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "ultra",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fastest responses" },
              { reasoningEffort: "medium", description: "Balanced reasoning" },
              { reasoningEffort: "high", description: "Deeper reasoning" },
              { reasoningEffort: "ultra", description: "Most thorough reasoning" },
            ],
          },
        ],
        nextCursor: null,
      }),
    }),
  );
}

async function mockProjectCrudApi(page) {
  let projects = [];
  let nextProjectId = 1;
  const homeRootPath = resolve("tests/fixtures/home");
  const rootPath = resolve("tests/fixtures/home/src");
  const relativePath = "src";

  const projectResponse = (project) => ({
    ...project,
    rootPath,
    relativePath,
    createdMs: project.createdMs ?? 1,
    updatedMs: project.updatedMs ?? 1,
    lastOpenedMs: project.lastOpenedMs ?? null,
  });

  const projectCandidate = (path) => {
    const isProjectPath = path === relativePath || path.startsWith(`${relativePath}/`);
    const candidateRootPath = isProjectPath ? rootPath : resolve(homeRootPath, path);
    const candidateRelativePath = isProjectPath ? relativePath : path;
    const candidateName = isProjectPath ? "src" : path.split("/").filter(Boolean).pop() || "home";
    const registeredProject = projects.find(
      (project) => project.rootPath === candidateRootPath,
    );
    return {
      name: registeredProject?.name ?? candidateName,
      rootPath: candidateRootPath,
      relativePath: candidateRelativePath,
      alreadyRegistered: Boolean(registeredProject),
      projectId: registeredProject?.id ?? null,
    };
  };

  await page.route(/\/api\/project-candidate(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidate: projectCandidate(path) }),
    });
  });

  await page.route(/\/api\/projects(?:\/[^/]+(?:\/open)?|)(?:\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments[2] ? decodeURIComponent(segments[2]) : null;
    const method = request.method();

    if (url.pathname === "/api/projects" && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ projects: projects.map(projectResponse) }),
      });
    }

    if (url.pathname === "/api/projects" && method === "POST") {
      const body = request.postDataJSON();
      const name = body.name?.trim() || "src";
      const project = projectResponse({
        id: `test_project_${nextProjectId}`,
        name,
        rootPath,
        relativePath,
        createdMs: nextProjectId,
        updatedMs: nextProjectId,
      });
      nextProjectId += 1;
      projects = [project, ...projects];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(project),
      });
    }

    if (segments.length === 4 && segments[3] === "open" && projectId && method === "POST") {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Project not found" } }),
        });
      }

      const openedProject = projectResponse({
        ...project,
        lastOpenedMs: Date.now(),
      });
      projects = projects.map((candidate) =>
        candidate.id === openedProject.id ? openedProject : candidate,
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(openedProject),
      });
    }

    if (segments.length === 3 && projectId && method === "PATCH") {
      const body = request.postDataJSON();
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Project not found" } }),
        });
      }

      const renamedProject = projectResponse({
        ...project,
        name: body.name?.trim() || project.name,
        updatedMs: Date.now(),
      });
      projects = projects.map((candidate) =>
        candidate.id === renamedProject.id ? renamedProject : candidate,
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(renamedProject),
      });
    }

    if (segments.length === 3 && projectId && method === "DELETE") {
      projects = projects.filter((project) => project.id !== projectId);
      return route.fulfill({ status: 204, body: "" });
    }

    return route.continue();
  });
}

async function expectGlobalScrollLocked(page) {
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

async function expectPanelScrollContainers(page) {
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

async function leftPanelWidth(page) {
  return page.locator("caffold-file-list").evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

async function elementWidth(page, selector) {
  return page.locator(selector).evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

async function dragHorizontalResizer(page, handle, deltaX) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  const x = box.x + box.width / 2;
  const y = box.y + Math.min(40, Math.max(1, box.height / 2));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y);
  await page.mouse.up();
}

async function scrollTop(locator) {
  return locator.evaluate((element) => element.scrollTop);
}

async function isScrolledToBottom(locator) {
  return locator.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    return maxScrollTop - element.scrollTop <= 8;
  });
}

async function expectPreservedScroll(locator, beforeScroll) {
  const afterScroll = await scrollTop(locator);
  expect(afterScroll).toBeGreaterThan(0);
  expect(afterScroll).toBeGreaterThanOrEqual(beforeScroll - 32);
}

async function expectHorizontalScroller(page, selector) {
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

async function expectCodeViewerGutterSeparated(page) {
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

async function expectMobileBrowserViewerOverlay(page) {
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

async function expectMobileViewerCompactHeader(page) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector("caffold-file-viewer .viewer-panel > header");
    const closeButton = document.querySelector("caffold-file-viewer .viewer-close-button");
    const title = document.querySelector("caffold-file-viewer h2");
    const infoButton = document.querySelector("caffold-file-viewer .viewer-info-button");

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

  expect(metrics.header.height).toBeLessThanOrEqual(42);
  expect(metrics.closeButton.left).toBeGreaterThanOrEqual(metrics.header.left - 1);
  expect(metrics.title.left).toBeGreaterThan(metrics.closeButton.right);
  expect(metrics.infoButton.left).toBeGreaterThan(metrics.title.left);
  for (const box of [metrics.closeButton, metrics.title, metrics.infoButton]) {
    expect(box.top).toBeGreaterThanOrEqual(metrics.header.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(metrics.header.bottom + 1);
  }
}

async function expectMobileReviewDetail(page, { backName, detailSelector, listSelector }) {
  const workspace = page.locator("caffold-review-workspace");

  await expect(workspace).toHaveAttribute("data-mobile-detail", "true");
  await expect(workspace.locator(".review-workspace-header")).toBeHidden();
  await expect(page.locator(listSelector)).toBeHidden();
  await expect(page.locator(detailSelector)).toBeVisible();
  await expect(page.getByRole("button", { name: backName })).toBeVisible();

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

async function expectUnifiedDiffRowsShareScrollWidth(page) {
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

async function expectDiffScrollerFillsViewer(page) {
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

async function expectCompareRefControlsFit(page, testInfo, options = {}) {
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
    expect(metrics.header.height).toBeLessThanOrEqual(84);
  } else {
    expect(metrics.header.height).toBeLessThanOrEqual(44);
  }
}

async function expectAlignedWorkspaceHeaders(page, selectors) {
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

async function expectMatchingPaneTitleSizes(page, selectors) {
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

async function stabilizeDynamicText(page) {
  await page.addStyleTag({
    content: `
      [data-field="modified"] dd {
        color: transparent !important;
        font-size: 0 !important;
      }

      [data-field="modified"] dd::after {
        content: "fixture time";
        color: var(--text);
        font-size: 0.8rem;
      }
    `,
  });
}
