import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("components wait for shared CSS and share one CSS request", { tag: "@desktop" }, async ({ page }) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = [];
  await page.route("**/assets/component-styles/*.css", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    requests.push(name);
    if (name === "compact-icon-button.css") {
      started.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await started.promise;
    expect(await page.evaluate(() => [
      "caffold-task-detail-terminal", "caffold-task-detail-git",
      "caffold-task-detail-github", "caffold-task-detail-info", "caffold-notes-info",
      "caffold-note-document", "caffold-notes-navigator",
      "caffold-task-navigator", "caffold-task-workspace", "caffold-task-git-layout",
      "caffold-task-github-layout", "caffold-terminal-page", "caffold-git-review-controls",
      "caffold-file-list", "caffold-pagination", "caffold-review-file-viewer",
    ].some((name) => Boolean(customElements.get(name))))).toBe(false);
    release.resolve();
    await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
    expect(requests.sort()).toEqual(["compact-icon-button.css"]);
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(19);
  } finally {
    release.resolve();
  }
});

test("new consumers declare their own scope, retain local overrides and reconnect without extra sheets", { tag: "@desktop" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  const originalSheets = await page.evaluate(() => document.adoptedStyleSheets.length);
  await page.evaluate(async () => {
    const { compactIconButton } = await import("/assets/component-styles.js");
    await compactIconButton.register("caffold-style-contract", "> header > .contract-actions > .contract-button");
    customElements.define("caffold-style-contract", class extends HTMLElement {
      connectedCallback() {
        if (this.childElementCount) return;
        this.innerHTML = `<header><div class="contract-actions">
          <button class="contract-button">New consumer</button>
          <caffold-unregistered-contract><button class="contract-button">Nested control</button></caffold-unregistered-contract>
        </div></header>`;
      }
    });
    const host = document.createElement("caffold-style-contract");
    const other = document.createElement("caffold-unregistered-contract");
    other.innerHTML = `<button class="contract-button">Other owner</button>`;
    document.body.append(host, other);
  });
  const button = page.locator("caffold-style-contract > header > .contract-actions > .contract-button");
  await expect(button).toHaveCSS("display", "grid");
  const dimensions = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height, surface: getComputedStyle(element, "::before").content };
  });
  expect(dimensions.width).toBe(dimensions.height);
  expect(dimensions.surface).toBe('""');
  for (const other of [
    page.locator("caffold-style-contract caffold-unregistered-contract button"),
    page.locator("body > caffold-unregistered-contract button"),
  ]) {
    expect(await other.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  }

  await button.focus();
  await expect(button).toBeFocused();
  const focusedSurface = await button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  await page.addStyleTag({ content: "caffold-style-contract > header > .contract-actions > .contract-button::before { background: rgb(12, 34, 56); }" });
  expect(focusedSurface).not.toBe("rgb(12, 34, 56)");
  await expect.poll(() => button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgb(12, 34, 56)");
  await button.evaluate((element) => { element.disabled = true; });
  await expect(button).toHaveCSS("opacity", "0.35");
  await page.evaluate(() => {
    const host = document.querySelector("caffold-style-contract");
    host.remove();
    document.body.append(host);
    document.body.append(document.createElement("caffold-style-contract"));
  });
  await expect(page.locator("caffold-style-contract > header > .contract-actions > .contract-button")).toHaveCount(2);
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(originalSheets + 1);
});

test("pagination keeps its compact surface, disabled appearance and native activation", { tag: "@all-viewports" }, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();
  await page.evaluate(() => customElements.whenDefined("caffold-pagination"));
  await page.evaluate(() => {
    const pagination = document.createElement("caffold-pagination");
    pagination.setAttribute("page", "1");
    pagination.setAttribute("total-pages", "3");
    pagination.setAttribute("has-next", "");
    pagination.addEventListener("caffold:change-page", (event) => {
      pagination.dataset.selectedPage = event.detail.page;
    });
    document.body.append(pagination);
  });
  const pagination = page.locator("caffold-pagination");
  const first = pagination.getByRole("button", { name: "First page" });
  const next = pagination.getByRole("button", { name: "Next page" });
  await expect(first).toBeDisabled();
  await expect(first).toHaveCSS("opacity", "0.55");
  await expect(first).toHaveCSS("cursor", "default");
  await expect(next).toHaveCSS("margin-top", "0px");
  const metrics = await next.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    const surface = getComputedStyle(element, "::before");
    return {
      width: box.width, height: box.height,
      visual: box.height - parseFloat(surface.top) - parseFloat(surface.bottom),
      expectedVisual: parseFloat(root.fontSize) * 1.875,
      floor: parseFloat(root.getPropertyValue("--interface-target-floor")),
      border: surface.borderTopWidth,
    };
  });
  expect(metrics.width).toBeCloseTo(metrics.height, 1);
  expect(metrics.height).toBeCloseTo(Math.max(metrics.expectedVisual, metrics.floor), 1);
  expect(metrics.visual).toBeCloseTo(metrics.expectedVisual, 1);
  expect(metrics.border).toBe("1px");
  await next.focus();
  await next.press("Enter");
  await expect(pagination).toHaveAttribute("data-selected-page", "2");
});
