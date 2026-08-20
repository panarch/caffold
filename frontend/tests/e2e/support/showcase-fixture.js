import {
  activeTaskProjection,
  canonicalTaskState,
  installEventSourceMock,
  mockAgentModels,
} from "./task-fixtures.js";

const THREAD_ID = "thread_showcase_readme";
const REPOSITORY_ROOT = "Workspace/caffold";
const WORKTREE_ROOT = "Workspace/caffold/.caffold-worktrees/readme-user-focused";
const BRANCH = "readme-user-focused";
const HEAD_SHA = "7b2f497d4f603ea39bb49b4f9df641c42171ad61";
const TURN_ID = "turn_showcase_readme";

function taskRecord({
  threadId,
  title,
  preview,
  branch,
  recencyMs,
  state,
  unseen = false,
}) {
  return {
    id: threadId,
    threadId,
    ...state,
    title,
    preview,
    cwd: WORKTREE_ROOT,
    cwdPath: WORKTREE_ROOT,
    relativeCwd: "",
    worktree: {
      rootPath: WORKTREE_ROOT,
      repositoryRootPath: REPOSITORY_ROOT,
      branch,
      headSha: HEAD_SHA,
      relativeCwd: "",
      linked: true,
    },
    createdMs: recencyMs - 20 * 60_000,
    updatedMs: recencyMs,
    recencyMs,
    lastCompletedMs: state.threadStatus.type === "idle" ? recencyMs : null,
    lastEventSummary: preview,
    unseen,
  };
}

function event(createdMs, id, type, summary, payload) {
  return {
    id,
    threadId: THREAD_ID,
    type,
    summary,
    payload,
    createdMs,
  };
}

export async function installShowcaseFixture(page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:settings",
      JSON.stringify({
        themeMode: "light",
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 14,
        codeTextPx: 13,
        fileSortMode: "folders-first",
      }),
    );
  });

  const now = Date.now();
  const selectedTask = taskRecord({
    threadId: THREAD_ID,
    title: "Refine README onboarding",
    preview: "README is ready to review",
    branch: BRANCH,
    recencyMs: now - 2 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  });
  const tasks = [
    selectedTask,
    taskRecord({
      threadId: "thread_showcase_mobile_navigation",
      title: "Stabilize mobile task navigation",
      preview: "Checking the foldable layout",
      branch: "fix/mobile-task-navigation",
      recencyMs: now - 7 * 60_000,
      state: canonicalTaskState("active", {
        turnId: "turn_showcase_mobile_navigation",
        startedAtMs: now - 7 * 60_000,
        latestTurnStatus: "inProgress",
      }),
    }),
    taskRecord({
      threadId: "thread_showcase_notifications",
      title: "Review notification settings",
      preview: "Browser delivery states verified",
      branch: "review/notification-settings",
      recencyMs: now - 42 * 60_000,
      state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      unseen: true,
    }),
  ];
  const turnStart = selectedTask.createdMs + 1_000;
  const detail = {
    threadId: THREAD_ID,
    syncState: "ready",
    revision: 3,
    task: selectedTask,
    events: [
      event(turnStart, "showcase-user", "user_message", "User prompt", {
        turnId: TURN_ID,
        text:
          "Rewrite the README for someone installing Caffold for the first time. " +
          "Keep source-build instructions in contributor docs and add a reproducible showcase.",
      }),
      event(
        turnStart + 1_000,
        "showcase-commentary",
        "assistant_message",
        "Assistant response",
        {
          turnId: TURN_ID,
          phase: "progress",
          text: "I’m aligning the product story, installation path, and representative review fixture.",
        },
      ),
      event(
        turnStart + 2_000,
        "showcase-command",
        "command_execution",
        "Command completed",
        {
          turnId: TURN_ID,
          itemId: "showcase-command",
          command: "npm run test:contract",
          cwd: WORKTREE_ROOT,
          status: "completed",
          exitCode: 0,
          durationMs: 4_820,
          output: "tests 101\npass 101\nfail 0",
        },
      ),
      event(turnStart + 3_000, "showcase-files", "file_change", "Files changed", {
        turnId: TURN_ID,
        status: "completed",
        paths: ["README.md", "docs/product/installation.md", "docs/product/vision.md", "tests/e2e/showcase.spec.js", "tests/e2e/support/showcase-fixture.js"],
      }),
      event(
        turnStart + 4_000,
        "showcase-final",
        "assistant_message",
        "Assistant response",
        {
          turnId: TURN_ID,
          phase: "final",
          text: [
            "## README is ready to review",
            "",
            "The entry point now follows the way Caffold is actually used:",
            "",
            "- start and continue persistent Codex Tasks;",
            "- inspect approvals, test output, files, and diffs;",
            "- direct the next step by text or host-local voice input; and",
            "- keep source builds in the contributor workflow.",
            "",
            "The macOS installation guide and deterministic Playwright showcase are included. Open **Working Tree** to inspect the changes.",
          ].join("\n"),
        },
      ),
      event(turnStart + 5_000, "showcase-complete", "turn_completed", "Turn completed", {
        turnId: TURN_ID,
        status: "completed",
      }),
    ],
    fileLinks: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    permissionMode: "approveForMe",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    fastMode: true,
  };

  await installEventSourceMock(page, {
    autoOpen: true,
    bootstrapFunctionKey: "__caffoldShowcaseDetailBootstrap",
  });
  await page.exposeFunction(
    "__caffoldShowcaseDetailBootstrap",
    (requestedThreadId) => requestedThreadId === THREAD_ID ? detail : null,
  );
  await mockAgentModels(page);

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection(tasks) }),
  );
  await page.route(new RegExp(`/api/tasks/${THREAD_ID}(?:\\?|$)`), (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route(/\/api\/voice\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        supported: true,
        model: {
          id: "large-v3-turbo",
          bytes: 1_624_555_275,
          installed: true,
          loaded: true,
          downloading: false,
        },
        maxRecordingSeconds: 300,
      },
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository: { rootPath: WORKTREE_ROOT, branch: BRANCH, dirty: true },
        github: { owner: "panarch", name: "caffold" },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    }),
  );

  const changedFiles = [
    { path: "README.md", status: " M", category: "unstaged" },
    { path: "docs/product/installation.md", status: "??", category: "untracked" },
    { path: "docs/product/vision.md", status: " M", category: "unstaged" },
    { path: "tests/e2e/showcase.spec.js", status: "??", category: "untracked" },
    {
      path: "tests/e2e/support/showcase-fixture.js",
      status: "??",
      category: "untracked",
    },
  ];
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository: { rootPath: WORKTREE_ROOT, branch: BRANCH, dirty: true },
        additions: 248,
        deletions: 131,
        files: changedFiles.map((file) => ({
          ...file,
          repoRelativePath: file.path,
          staged: false,
          unstaged: file.status !== "??",
          untracked: file.status === "??",
        })),
      },
    }),
  );
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("file") ?? "README.md";
    const readmeDiff = [
      "diff --git a/README.md b/README.md",
      "index 14a796f..2d5a1ad 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,7 +1,10 @@",
      " # Caffold",
      " ",
      "-Caffold is scaffolding for agent-assisted development.",
      "+Caffold is a browser interface for doing development work with Codex on a",
      "+Mac you control.",
    ].join("\n");
    return route.fulfill({
      json: {
        repository: { rootPath: WORKTREE_ROOT, branch: BRANCH, dirty: true },
        path,
        repoRelativePath: path,
        kind: url.searchParams.get("kind") ?? "unstaged",
        additions: path === "README.md" ? 2 : 8,
        deletions: path === "README.md" ? 1 : 0,
        diff: path === "README.md"
          ? readmeDiff
          : [
              `diff --git a/${path} b/${path}`,
              `--- a/${path}`,
              `+++ b/${path}`,
              "@@ -1 +1,2 @@",
              "+Representative showcase content",
            ].join("\n"),
      },
    });
  });

  return {
    threadId: THREAD_ID,
    branch: BRANCH,
    selectedTask,
  };
}
