import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { pngBytes } from "../support/png-fixture.js";
import {
  openVisualReview,
  VISUAL_PICTURES,
} from "../support/visual-review-fixture.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const CARD_BLOB = "1".repeat(40);

test("compares an image's change side by side and paints what changed in Difference", { tag: ["@desktop", "@phone"] }, async ({
  page,
}, testInfo) => {
  const { taskReview } = await openVisualReview(page, { file: "release-card.png" });
  const axis = taskReview.locator('caffold-segmented-control[data-review-axis="viewer"]');
  const visual = taskReview.locator("caffold-review-file-viewer caffold-visual-diff");
  const before = visual.locator('figure[data-side="before"]');
  const after = visual.locator('figure[data-side="after"]');

  await expect(axis.getByRole("button")).toHaveText(["Visual", "Preview"]);
  await expect(axis.getByRole("button", { name: "Visual" })).toHaveAttribute("aria-pressed", "true");
  // The way to compare ends where the representation choice above it ends.
  const modes = visual.locator("caffold-segmented-control");
  await expect(modes).toBeVisible();
  const [axisBox, modesBox] = [await axis.boundingBox(), await modes.boundingBox()];
  expect(Math.abs(axisBox.x + axisBox.width - (modesBox.x + modesBox.width))).toBeLessThan(1);
  await expect(before.locator("figcaption")).toHaveText(
    `Before 64 × 40 · ${VISUAL_PICTURES.blobs[CARD_BLOB].bytes.length} B`,
  );
  await expect(after.locator("figcaption")).toHaveText(
    `After 64 × 40 · ${VISUAL_PICTURES.workingTree["src/release-card.png"].bytes.length} B`,
  );
  await expectDrawn(before.locator("img"));
  await expectDrawn(after.locator("img"));

  const [beforeBox, afterBox] = [await before.boundingBox(), await after.boundingBox()];
  if (testInfo.project.name === "phone") {
    expect(afterBox.y, "the sides stack on a phone").toBeGreaterThanOrEqual(beforeBox.y + beforeBox.height);
  } else {
    expect(afterBox.x, "the sides sit side by side").toBeGreaterThanOrEqual(beforeBox.x + beforeBox.width);
    expect(Math.abs(afterBox.y - beforeBox.y)).toBeLessThan(1);
  }
  // Pictures smaller than the stage keep their own size.
  await expect.poll(() => before.locator("img").evaluate((image) => image.getBoundingClientRect().width)).toBe(64);

  await visual.getByRole("button", { name: "Difference" }).click();
  await expect(visual.locator(".difference-captions")).toContainText("50.0% of pixels changed");
  await expectDrawn(visual.locator('img[alt="Changed pixels"]'));
  // The right half changed: its pixels are painted, the left half is faint.
  const painted = await visual.locator('img[alt="Changed pixels"]').evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [
      [...context.getImageData(48, 20, 1, 1).data],
      [...context.getImageData(8, 20, 1, 1).data],
    ];
  });
  expect(painted[0]).toEqual([229, 46, 63, 255]);
  expect(painted[1][3]).toBeLessThan(80);
});

test("keeps the way to compare across files and says what Difference cannot draw", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { taskReview, requests } = await openVisualReview(page, { file: "release-card.png" });
  const changes = taskReview.locator("caffold-git-diff-changes-tree");
  const axis = taskReview.locator('caffold-segmented-control[data-review-axis="viewer"]');
  const visual = taskReview.locator("caffold-review-file-viewer caffold-visual-diff");
  const open = (path) => changes.locator(`button[data-file-tree-path="src/${path}"]`).click();

  await visual.getByRole("button", { name: "Difference" }).click();
  await expect(visual.locator(".difference-captions")).toContainText("50.0% of pixels changed");

  await open("app-icon.png");
  await expect(visual.getByRole("button", { name: "Difference" })).toHaveAttribute("aria-pressed", "true");
  await expect(visual.locator(".difference-message")).toHaveText(
    "Difference compares pictures of the same size. " +
      "Before is 32 × 32 and After is 64 × 64. Side by side shows both.",
  );
  await visual.getByRole("button", { name: "Side by side" }).click();
  // Both sides share one scale, so the picture that doubled draws twice as wide.
  await expectDrawn(visual.locator('figure[data-side="after"] img'));
  const widths = await visual.locator("figure img").evaluateAll((images) =>
    images.map((image) => image.getBoundingClientRect().width),
  );
  expect(widths).toEqual([32, 64]);

  await open("beta-badge.png");
  await expect(visual.locator("figure")).toHaveCount(1);
  await expect(visual.locator("figure figcaption")).toContainText("After 48 × 20");
  await expect(visual.locator("caffold-segmented-control")).toHaveCount(0);

  await open("spring-banner.png");
  await expect(visual.locator("figure figcaption")).toContainText("Before 80 × 20");

  await open("planner.rs");
  await expect(axis.getByRole("button", { name: "Diff" })).toHaveAttribute("aria-pressed", "true");
  // Diff is the address's default, so the address names no view.
  await expect(page).not.toHaveURL(/view=/);

  await open("logo.svg");
  await expect(axis.getByRole("button")).toHaveText(["Diff", "Visual", "Source", "Preview"]);
  await expect(axis.getByRole("button", { name: "Diff" })).toHaveAttribute("aria-pressed", "true");
  await axis.getByRole("button", { name: "Visual" }).click();
  await expect(page).toHaveURL(/view=visual/);
  // The way to compare outlived the files shown as Diff in between.
  await expect(visual.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
  await expectDrawn(visual.locator('figure[data-side="before"] img'));
  await expectDrawn(visual.locator('figure[data-side="after"] img'));
  expect(requests.versions).toContain("src/logo.svg");

  // The address keeps Visual for a file that also has Diff.
  await page.reload();
  await expect(axis.getByRole("button", { name: "Visual" })).toHaveAttribute("aria-pressed", "true");
  await expectDrawn(visual.locator('figure[data-side="after"] img'));
});

test("shows the side it got when the other cannot be fetched", { tag: "@server-steady" }, async ({ page }) => {
  const { taskReview } = await openVisualReview(page, {
    file: "release-card.png",
    failingBlobs: [CARD_BLOB],
  });
  const visual = taskReview.locator("caffold-review-file-viewer caffold-visual-diff");

  await expect(visual.locator('figure[data-side="before"]')).toContainText(
    "This picture could not be loaded.",
  );
  await expectDrawn(visual.locator('figure[data-side="after"] img'));
  await expect(taskReview.locator("caffold-review-file-viewer .error-panel")).toHaveCount(0);

  await visual.getByRole("button", { name: "Difference" }).click();
  await expect(visual.locator(".difference-message")).toHaveText(
    "Difference needs both pictures. Before could not be loaded.",
  );
});

test("asks again for the working tree side when the file changes, and never for a blob", { tag: "@server-changes" }, async ({
  page,
}) => {
  const { taskReview, requests, changeWorkingTree } = await openVisualReview(page, {
    file: "release-card.png",
  });
  const after = taskReview.locator('caffold-visual-diff figure[data-side="after"]');
  await expectDrawn(after.locator("img"));
  const drawnBefore = await after.locator("img").getAttribute("src");
  expect(requests.blobs).toEqual([CARD_BLOB]);

  changeWorkingTree("src/release-card.png", pngBytes(64, 40, () => [0, 0, 0, 255]));
  // A tracked file that changes on disk may change Git status too, as the
  // server's watch reports it.
  await page.evaluate(() => {
    window.__caffoldMockEventSources.filter(
      (candidate) => candidate.channel === "watch" && candidate.context === "src" && candidate.readyState === 1,
    ).at(-1).emit("change", {
      revision: 2,
      paths: ["src/release-card.png"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });

  await expect.poll(() => after.locator("img").getAttribute("src")).not.toBe(drawnBefore);
  await expectDrawn(after.locator("img"));
  expect(requests.blobs, "the blob is kept by its id").toEqual([CARD_BLOB]);
  expect(requests.images.length).toBeGreaterThanOrEqual(2);
});

test("chooses Difference through its Action Hint", { tag: "@server-steady" }, async ({ page }) => {
  const { taskReview } = await openVisualReview(page, { file: "release-card.png" });
  const visual = taskReview.locator("caffold-review-file-viewer caffold-visual-diff");
  await expectDrawn(visual.locator('figure[data-side="after"] img'));

  await activateActionHint(page, "Show Difference");

  await expect(visual.getByRole("button", { name: "Difference" })).toHaveAttribute("aria-pressed", "true");
  await expect(visual.locator(".difference-captions")).toContainText("50.0% of pixels changed");
});

async function expectDrawn(image) {
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
}
