import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  canonicalTaskState,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test("groups removed worktrees under their recorded repository in Archived", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page);
  await mockAgentModels(page);
  const archivedTask = (threadId, title, repositoryPath) => ({
    threadId,
    title,
    conversationAvailable: true,
    ...canonicalTaskState("notLoaded"),
    cwd: `/caffold/worktrees/${threadId}`,
    cwdPath: null,
    relativeCwd: `/caffold/worktrees/${threadId}`,
    worktree: null,
    repositoryPath,
    createdMs: 1,
    updatedMs: 2,
    recencyMs: 2,
    lastCompletedMs: null,
    unseen: false,
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => route.fulfill({
    json: { sections: [], unsectioned: [] },
  }));
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) => route.fulfill({
    json: {
      tasks: [
        archivedTask("alpha-one", "Alpha first archived task", "projects/alpha"),
        archivedTask("alpha-two", "Alpha second archived task", "projects/alpha"),
        archivedTask("beta-one", "Beta archived task", "projects/beta"),
      ],
      nextCursor: null,
    },
  }));

  await page.goto("/tasks");
  const archived = page.locator("caffold-archived-task-list");
  await expect(archived.locator(".task-repository-group")).toHaveCount(2);
  const alpha = archived.locator('[data-task-repository-key="repository:projects/alpha"]');
  await expect(alpha.locator(".task-repository-label")).toHaveText("alpha");
  await expect(alpha.locator(".task-repository-header")).toHaveAttribute("title", "projects/alpha");
  await expect(alpha.locator(".task-archived-row")).toHaveCount(2);
  await expect(alpha).toContainText("Alpha first archived task");
  await expect(alpha).toContainText("Alpha second archived task");
  const beta = archived.locator('[data-task-repository-key="repository:projects/beta"]');
  await expect(beta.locator(".task-repository-label")).toHaveText("beta");
  await expect(beta.locator(".task-archived-row")).toHaveCount(1);
  await expect(beta).toContainText("Beta archived task");
});
