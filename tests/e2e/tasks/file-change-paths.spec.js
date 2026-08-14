import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("renders managed Task file changes relative in live cards and Work details", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__fileChangePathSources",
    autoOpen: true,
  });
  await mockCodexModels(page);

  const threadId = "thread_file_change_paths";
  const turnId = "turn_file_change_paths";
  const rootPath =
    "/Users/taehoon/Library/Application Support/Caffold/data/worktrees/task-133";
  const localAbsolutePath =
    `${rootPath}/tests/./css/../css-ownership.test.mjs`;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Task-local file paths",
    preview: "Files changed",
    cwd: rootPath,
    cwdPath: rootPath.slice(1),
    relativeCwd: rootPath.slice(1),
    worktree: {
      rootPath: `${rootPath.slice(1)}/`,
      branch: "issue-133-relative-file-paths",
      baseRef: "origin/main",
      relativeCwd: "",
      linked: true,
    },
    createdMs: 1,
    updatedMs: 10,
    recencyMs: 10,
    lastEventSummary: "Files changed",
  };
  const event = (id, type, createdMs, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload,
    createdMs,
  });
  const events = [
    event("standalone-file-change", "file_change", 1, {
      changes: [
        { path: localAbsolutePath },
        { path: "tests/css-ownership.test.mjs" },
        { path: `${rootPath}-copy/tests/css-ownership.test.mjs` },
        { path: "frontend\\pages\\..\\app.js" },
      ],
      changeCount: 4,
      status: "completed",
    }),
    event("completed-user", "user_message", 2, {
      turnId,
      text: "Finish the file path work.",
    }),
    event("completed-file-change-1", "file_change", 3, {
      turnId,
      changes: [{ path: `${rootPath}/src/./render.js` }],
      changeCount: 1,
      status: "inProgress",
    }),
    event("completed-file-change-2", "file_change", 4, {
      turnId,
      changes: [
        { path: "src/render.js" },
        { path: "/private/tmp/shared.js" },
      ],
      changeCount: 2,
      status: "completed",
    }),
    event("completed-turn", "turn_completed", 5, {
      turnId,
      status: "completed",
    }),
  ];
  const detail = {
    revision: 1,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: detail }),
  );

  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const standalone = tasksPage.locator(".task-file-change");
  await expect(standalone).toHaveCount(1);
  const standaloneFiles = standalone.locator("caffold-task-changed-files");
  await expect(standaloneFiles.locator("code")).toHaveText([
    "tests/css-ownership.test.mjs",
    `${rootPath}-copy/tests/css-ownership.test.mjs`,
    "frontend/app.js",
  ]);
  await expect(standaloneFiles.locator("li").first()).toHaveAttribute(
    "data-file-change-path",
    localAbsolutePath,
  );
  await expect(standaloneFiles.locator("code").first()).toHaveAttribute(
    "title",
    localAbsolutePath,
  );

  const workDetails = tasksPage.locator("caffold-task-work-details > details");
  await workDetails.locator(":scope > summary").click();
  const completedFiles = workDetails.locator("caffold-task-changed-files");
  const completedPaths = completedFiles.locator("code");
  await expect(completedPaths).toHaveText([
    "src/render.js",
    "/private/tmp/shared.js",
  ]);
  await expect(completedPaths.first()).toHaveAttribute(
    "title",
    `${rootPath}/src/./render.js`,
  );

  await page.evaluate(() => {
    const standaloneOwner = document.querySelector(
      ".task-file-change caffold-task-changed-files",
    );
    const completedOwner = document.querySelector(
      "caffold-task-work-details caffold-task-changed-files",
    );
    window.__standaloneChangedFiles = standaloneOwner;
    window.__standaloneFirstFileRow = standaloneOwner?.querySelector("li");
    window.__completedChangedFiles = completedOwner;
    window.__completedFirstFileRow = completedOwner?.querySelector("li");
    window.__changedFileMutationCount = 0;
    for (const owner of [standaloneOwner, completedOwner]) {
      new MutationObserver((records) => {
        window.__changedFileMutationCount += records.length;
      }).observe(owner, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  });

  const equivalentDetail = structuredClone(detail);
  equivalentDetail.revision = 2;
  await emitTaskSync(page, threadId, equivalentDetail);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        completedOwner:
          document.querySelector(
            "caffold-task-work-details caffold-task-changed-files",
          ) === window.__completedChangedFiles,
        completedRow:
          document.querySelector(
            "caffold-task-work-details caffold-task-changed-files li",
          ) === window.__completedFirstFileRow,
        mutations: window.__changedFileMutationCount,
        standaloneOwner:
          document.querySelector(
            ".task-file-change caffold-task-changed-files",
          ) === window.__standaloneChangedFiles,
        standaloneRow:
          document.querySelector(
            ".task-file-change caffold-task-changed-files li",
          ) === window.__standaloneFirstFileRow,
      })),
    )
    .toEqual({
      completedOwner: true,
      completedRow: true,
      mutations: 0,
      standaloneOwner: true,
      standaloneRow: true,
    });

  const revisedDetail = structuredClone(detail);
  revisedDetail.revision = 3;
  const revisedStandalone = revisedDetail.events.find(
    ({ id }) => id === "standalone-file-change",
  );
  revisedStandalone.payload.changes.push({ path: `${rootPath}/src/new.js` });
  revisedStandalone.payload.changeCount = 5;
  revisedStandalone.payload.status = "inProgress";
  const revisedCompleted = revisedDetail.events.find(
    ({ id }) => id === "completed-file-change-2",
  );
  revisedCompleted.payload.changes.push({
    path: `${rootPath}/src/new-work.js`,
  });
  revisedCompleted.payload.changeCount = 3;
  await emitTaskSync(page, threadId, revisedDetail);

  await expect(standaloneFiles.locator("code")).toHaveText([
    "tests/css-ownership.test.mjs",
    `${rootPath}-copy/tests/css-ownership.test.mjs`,
    "frontend/app.js",
    "src/new.js",
  ]);
  await expect(completedPaths).toHaveText([
    "src/render.js",
    "/private/tmp/shared.js",
    "src/new-work.js",
  ]);
  await expect(standalone.locator(":scope > article > p")).toHaveText(
    "5 changed files · Status: inProgress",
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        completedOwner:
          document.querySelector(
            "caffold-task-work-details caffold-task-changed-files",
          ) === window.__completedChangedFiles,
        completedRow:
          document.querySelector(
            "caffold-task-work-details caffold-task-changed-files li",
          ) === window.__completedFirstFileRow,
        standaloneOwner:
          document.querySelector(
            ".task-file-change caffold-task-changed-files",
          ) === window.__standaloneChangedFiles,
        standaloneRow:
          document.querySelector(
            ".task-file-change caffold-task-changed-files li",
          ) === window.__standaloneFirstFileRow,
      })),
    )
    .toEqual({
      completedOwner: true,
      completedRow: true,
      standaloneOwner: true,
      standaloneRow: true,
    });
  await expect(workDetails).toHaveAttribute("open", "");
  await captureReviewScreenshot(page, testInfo, "task-file-change-paths");
});

async function emitTaskSync(page, threadId, detail) {
  await page.evaluate(
    ({ detail, threadId }) => {
      const source = window.__fileChangePathSources.find(
        (candidate) =>
          candidate.url === `/api/tasks/${threadId}/stream` &&
          candidate.readyState !== 2,
      );
      if (!source) {
        throw new Error(`Task detail stream not found for ${threadId}`);
      }
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        reason: "canonical-sync",
        detail,
      });
    },
    { detail, threadId },
  );
}
