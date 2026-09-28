import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installManualDefaults,
  installManualRepository,
  installManualTasks,
  MANUAL_TASKS,
} from "../support/manual-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// Each test renders one state the user manual shows and checks what the
// manual says about it before capturing the image. See docs/development/testing.md.

test.use({ timezoneId: "UTC", locale: "en-US" });

// A fixed screen stands in for a real shell, whose prompt and profile output
// would belong to whoever ran the scenario.
const PROMPT = "\x1b[36m~/lumen\x1b[0m \x1b[35m(dark-theme)\x1b[0m $ ";
const SCREEN = [
  `${PROMPT}git status --short`,
  " M src/settings/ThemePicker.tsx",
  " M src/theme/tokens.css",
  `${PROMPT}npm test -- settings`,
  "",
  "> lumen@1.4.0 test",
  "> vitest run settings",
  "",
  " \x1b[32m✓\x1b[0m src/settings/ThemePicker.test.tsx \x1b[2m(6 tests)\x1b[0m",
  " \x1b[32m✓\x1b[0m src/settings/useTheme.test.ts \x1b[2m(4 tests)\x1b[0m",
  "",
  " Test Files  \x1b[1;32m2 passed\x1b[0m (2)",
  "      Tests  \x1b[1;32m10 passed\x1b[0m (10)",
  "",
  PROMPT,
].join("\r\n");

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installManualDefaults(page);
  await installManualTasks(page);
  await installManualRepository(page);
  await page.route("**/api/terminal", (route) => route.fulfill({ status: 204 }));
  await page.routeWebSocket(/\/api\/terminal\/socket/, (socket) => {
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: "attached" }));
    socket.send(Buffer.from(SCREEN));
  });
});

test("a Task's terminal replaces its conversation and, when wide, the Task list", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
  const task = MANUAL_TASKS.darkTheme;
  await page.goto(`/tasks/${task.threadId}`);
  const button = page.locator("caffold-task-detail-terminal > button");
  await expect(button).toBeEnabled();

  await button.click();

  await expect(page).toHaveURL(`/tasks/${task.threadId}/terminal`);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const terminal = page.locator("caffold-terminal-page");
  await expect(terminal).toHaveAttribute("data-terminal-node", "live");
  await expect(terminal.locator(".xterm-rows")).toContainText("10 passed (10)");
  await expect(terminal.getByRole("button", { name: "Kill terminal" })).toBeVisible();
  const specialKeys = terminal.locator("caffold-terminal-special-keys");
  if (testInfo.project.name === "phone") {
    await expect(specialKeys).toBeVisible();
    await expect(specialKeys.getByRole("button")).toHaveText([
      "Esc", "Tab", "Ctrl", "←", "↑", "↓", "→",
    ]);
  } else {
    await expect(specialKeys).toBeHidden();
    await expect(page.locator(".task-workspace-master-pane")).toBeHidden();
    await expect(page.locator(".task-workspace-side-pane-toggle")).toBeDisabled();
  }
  await captureReviewScreenshot(page, testInfo, "terminal");
});
