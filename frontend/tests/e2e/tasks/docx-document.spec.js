import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installDocxRenderer } from "../support/document-renderer-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installDocxRenderer(page);
  await page.goto("/settings/files");
  await page.evaluate(async () => {
    await import("/assets/components/docx-viewer.js");
    const viewer = document.createElement("caffold-docx-viewer");
    viewer.id = "document-lifecycle-viewer";
    viewer.style.cssText = "position:fixed; inset:80px 1rem 1rem";
    window.documentRenderer.viewer = viewer;
    document.body.append(viewer);
  });
});

test("Word document replacement rejects an older render completion and clears null input", { tag: "@viewport-independent" }, async ({ page }) => {
  const viewer = page.locator("#document-lifecycle-viewer");
  const child = viewer.locator("caffold-docx-document");
  await expect(child).toHaveAttribute("data-render-state", "empty");
  await viewer.evaluate((element) => {
    window.documentRenderer.hold.add("old");
    element.file = { file: new Blob(["old"]), newerCopy: false };
  });
  await expect.poll(() => page.evaluate(() => window.documentRenderer.started)).toEqual(["old"]);
  await expect(viewer).toHaveAttribute("data-render-state", "loading");
  await child.evaluate((element) => { element.dataset.retained = "true"; });

  await viewer.evaluate((element) => {
    element.file = { file: new Blob(["current"]), newerCopy: false };
  });
  await expect(child).toHaveAttribute("data-render-state", "docx");
  await expect(viewer).toHaveAttribute("data-render-state", "docx");
  await expect(child.locator("section.docx")).toHaveText("current");
  await page.evaluate(() => window.documentRenderer.pending.get("old")());
  await expect.poll(() => page.evaluate(() => window.documentRenderer.completed)).toContain("old");
  await expect(child.locator("section.docx")).toHaveText("current");
  await expect(child).toHaveAttribute("data-retained", "true");

  await viewer.evaluate((element) => { element.file = null; });
  await expect(child).toHaveAttribute("data-render-state", "empty");
  await expect(viewer).toHaveAttribute("data-render-state", "empty");
  await expect(child.locator("section.docx")).toHaveCount(0);
  expect(await page.evaluate(() => window.documentRenderer.observers
    .filter((record) => record.target.localName === "caffold-docx-document")
    .every((record) => !record.active))).toBe(true);
});

test("Word document disconnect cancels pending work and reconnect renders the current file", { tag: "@viewport-independent" }, async ({ page }) => {
  const viewer = page.locator("#document-lifecycle-viewer");
  const child = viewer.locator("caffold-docx-document");
  await viewer.evaluate((element) => {
    window.documentRenderer.hold.add("pending");
    element.file = { file: new Blob(["pending"]), newerCopy: false };
  });
  await expect.poll(() => page.evaluate(() => window.documentRenderer.started)).toEqual(["pending"]);
  await page.evaluate(async () => {
    const fixture = window.documentRenderer;
    fixture.child = fixture.viewer.shadowRoot.querySelector("caffold-docx-document");
    fixture.viewer.remove();
    fixture.pending.get("pending")();
    await fixture.child.updateComplete;
  });
  await expect.poll(() => page.evaluate(() => window.documentRenderer.completed)).toEqual(["pending"]);
  expect(await page.evaluate(() => window.documentRenderer.child.dataset.renderState)).toBe("empty");
  expect(await page.evaluate(() => window.documentRenderer.observers
    .filter((record) => record.target.localName === "caffold-docx-document")
    .every((record) => !record.active))).toBe(true);

  await page.evaluate(() => document.body.append(window.documentRenderer.viewer));
  await expect(child).toHaveAttribute("data-render-state", "docx");
  await expect(child.locator("section.docx")).toHaveText("pending");
  expect(await child.evaluate((element) => element === window.documentRenderer.child)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.documentRenderer.started)).toEqual(["pending", "pending"]);
  expect(await page.evaluate(() => window.documentRenderer.observers
    .some((record) => (record.target.localName === "caffold-docx-document") && record.active))).toBe(true);
  await viewer.evaluate((element) => element.remove());
  expect(await page.evaluate(() => window.documentRenderer.observers
    .filter((record) => record.target.localName === "caffold-docx-document")
    .every((record) => !record.active))).toBe(true);
});

test("Word render failures release owned resources and allow a replacement", { tag: "@viewport-independent" }, async ({ page }) => {
  const viewer = page.locator("#document-lifecycle-viewer");
  const child = viewer.locator("caffold-docx-document");
  await viewer.evaluate((element) => {
    element.file = { file: new Blob(["error"]), newerCopy: false };
  });
  await expect(viewer).toHaveAttribute("data-render-state", "error");
  await expect(child).toContainText("This document could not be displayed.");
  expect(await page.evaluate(() => window.documentRenderer.observers
    .filter((record) => record.target.localName === "caffold-docx-document")
    .every((record) => !record.active))).toBe(true);
  await viewer.evaluate((element) => {
    element.file = { file: new Blob(["recovered"]), newerCopy: false };
  });
  await expect(child).toHaveAttribute("data-render-state", "docx");
  await expect(child.locator("section.docx")).toHaveText("recovered");
});
