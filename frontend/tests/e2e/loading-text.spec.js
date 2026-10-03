import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

async function placePhrases(page) {
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  await page.evaluate(async () => {
    await import("/assets/components/loading-text.js");
    const delayed = document.createElement("caffold-loading-text");
    delayed.id = "delayed-phrase";
    delayed.textContent = "Loading files...";
    const immediate = document.createElement("caffold-loading-text");
    immediate.id = "immediate-phrase";
    immediate.setAttribute("immediate", "");
    immediate.textContent = "Loading...";
    document.body.append(delayed, immediate);
  });
}

function presentation(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      role: element.getAttribute("role"),
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationDelay: style.animationDelay,
      animationFillMode: style.animationFillMode,
      animationIterationCount: style.animationIterationCount,
      backgroundImage: style.backgroundImage,
      backgroundClip: style.backgroundClip,
      color: style.color,
      textFill: style.webkitTextFillColor,
    };
  });
}

// The theme tokens resolved to the color strings computed styles report.
function themeColors(page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const resolve = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = { muted: resolve("--muted"), text: resolve("--text") };
    probe.remove();
    return colors;
  });
}

test("waits 180 ms, fades in, and runs a highlight between the theme's text colors", { tag: "@desktop" }, async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await placePhrases(page);
    const colors = await themeColors(page);

    const delayed = await presentation(page.locator("#delayed-phrase"));
    expect(delayed).toMatchObject({
      role: "status",
      animationName: "caffold-loading-text-enter, caffold-loading-text-sweep",
      animationDuration: "0.15s, 1.8s",
      animationDelay: "0.18s, 0.18s",
      animationFillMode: "backwards, none",
      animationIterationCount: "1, infinite",
      backgroundClip: "text",
      color: colors.muted,
    });
    expect(delayed.backgroundImage).toContain(colors.muted);
    expect(delayed.backgroundImage).toContain(colors.text);

    const immediate = await presentation(page.locator("#immediate-phrase"));
    expect(immediate).toMatchObject({
      role: "status",
      animationName: "caffold-loading-text-sweep",
      animationDelay: "0s",
      animationIterationCount: "infinite",
    });
  }
});

test("keeps the wait but drops the highlight and fade for reduced motion", { tag: "@desktop" }, async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await placePhrases(page);
  const colors = await themeColors(page);

  const delayed = await presentation(page.locator("#delayed-phrase"));
  expect(delayed).toMatchObject({
    animationName: "caffold-loading-text-enter",
    animationDelay: "0.18s",
    animationFillMode: "backwards",
    backgroundImage: "none",
    color: colors.muted,
    textFill: colors.muted,
  });

  const immediate = await presentation(page.locator("#immediate-phrase"));
  expect(immediate).toMatchObject({
    animationName: "none",
    backgroundImage: "none",
    textFill: colors.muted,
  });
});
