import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { installTaskLoopFixture } from "./support/task-loop-fixture.js";

test("native import aliases share module identity with asset URLs and register their consumers", { tag: "@viewport-independent" }, async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installBrowserDefaults(page);
  await installTaskLoopFixture(page);
  await page.goto("/");
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute("data-tasks-view", "home");

  const result = await page.evaluate(async () => {
    const modules = [
      ["#app/api.js", "/assets/api.js"],
      ["#app/component-styles.js", "/assets/component-styles.js"],
      ["#components/dom.js", "/assets/components/dom.js"],
      ["#tasks/task-format.js", "/assets/pages/(task-workspace)/tasks/task-format.js"],
    ];
    const identities = await Promise.all(modules.map(async ([alias, url]) => {
      const [aliased, direct] = await Promise.all([import(alias), import(url)]);
      return { alias, sameModule: aliased === direct };
    }));
    const consumers = [
      ["#tasks/new/components/directory-picker.js", "caffold-task-directory-picker"],
      ["#tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.js", "caffold-conversation-fork-dialog"],
      ["#tasks/(detail)/(github)/components/task-start-dialog.js", "caffold-github-task-start-dialog"],
    ];
    const registrations = await Promise.all(consumers.map(async ([alias, tag]) => {
      await import(alias);
      return { tag, registered: Boolean(customElements.get(tag)) };
    }));
    return { identities, registrations };
  });

  expect(result.identities).toEqual([
    { alias: "#app/api.js", sameModule: true },
    { alias: "#app/component-styles.js", sameModule: true },
    { alias: "#components/dom.js", sameModule: true },
    { alias: "#tasks/task-format.js", sameModule: true },
  ]);
  expect(result.registrations.every(({ registered }) => registered)).toBe(true);
  expect(errors).toEqual([]);
});
