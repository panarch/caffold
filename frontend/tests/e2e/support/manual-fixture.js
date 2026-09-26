import { AGENT_CATALOG, agentPermissionModes } from "./agent-catalog-fixture.js";
import { mockCodexStatus } from "./browser-defaults.js";
import {
  activeListTask,
  canonicalTaskState,
  installEventSourceMock,
} from "./task-fixtures.js";

// The user manual shows one sample workspace: a photo app called Lumen, its
// API, and a folder of launch notes. Every time is derived from MANUAL_NOW,
// which each scenario also fixes as the page clock.
export const MANUAL_NOW = Date.UTC(2026, 8, 24, 14, 30);

const REPOSITORY = "Workspace/lumen";
const API_REPOSITORY = "Workspace/lumen-api";
const NOTES_FOLDER = "Documents/launch";
const HEAD_SHA = "5d0c1e7a9b3f4c2d8e6a1b0c9d8e7f6a5b4c3d2e";

export const MANUAL_TASKS = {
  darkTheme: manualTask({
    threadId: "019d7a2c-5e41-7b90-a3f2-6c1e8d4b2f07",
    title: "Add a dark theme to Settings",
    worktree: managedWorktree("9f2c41d0-7a3e-4b19-8c52-d06e1f4a8b37", "dark-theme"),
    finishedAgoMs: 3 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  }),
  flakyCheckout: manualTask({
    threadId: "019d7a31-0c8e-7d25-b6a4-93f0e2c7d518",
    title: "Fix the flaky checkout test",
    worktree: managedWorktree("4b7e90a2-1c5d-4f86-a3b0-e92d7c615f08", "fix/flaky-checkout"),
    finishedAgoMs: 26 * 60_000,
    state: canonicalTaskState("active", {
      activeFlags: ["waitingOnApproval"],
      turnId: "turn_manual_checkout",
      startedAtMs: MANUAL_NOW - 95_000,
      latestTurnStatus: "inProgress",
    }),
  }),
  uploadsReview: manualTask({
    threadId: "019d7a18-b2f6-7c03-8e59-4a7d1c0f6e92",
    title: "Review PR #214: resumable uploads",
    worktree: managedWorktree("c13d58ee-6f20-4a9b-b7e4-3d1c8a05f962", "review/resumable-uploads"),
    finishedAgoMs: 41 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    unseen: true,
  }),
  pagination: manualTask({
    threadId: "019d79f4-6a1d-7e8b-9c30-d5b2a8e4f716",
    title: "Paginate the photos endpoint",
    worktree: {
      rootPath: API_REPOSITORY,
      repositoryRootPath: API_REPOSITORY,
      branch: "main",
      headSha: HEAD_SHA,
      relativeCwd: "",
      linked: false,
    },
    finishedAgoMs: 2 * 60 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  }),
  announcement: manualTask({
    threadId: "019d7812-3e9b-7a46-b1d8-0f6c5a2e9d43",
    title: "Draft the launch announcement",
    worktree: null,
    cwd: NOTES_FOLDER,
    finishedAgoMs: 26 * 60 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  }),
};

// The checkout Task as it looks before it asks for approval: still working,
// with a prompt the person sent into the running turn.
const RUNNING_CHECKOUT = manualTask({
  threadId: MANUAL_TASKS.flakyCheckout.threadId,
  title: MANUAL_TASKS.flakyCheckout.title,
  worktree: MANUAL_TASKS.flakyCheckout.worktree,
  finishedAgoMs: 26 * 60_000,
  state: canonicalTaskState("active", {
    turnId: "turn_manual_checkout",
    startedAtMs: MANUAL_NOW - 95_000,
    latestTurnStatus: "inProgress",
  }),
});

export const MANUAL_SECTION_ID = "section-lumen";

const ARCHIVED_TASKS = [
  manualTask({
    threadId: "019d6f0b-8d42-7e19-a6c5-2b90f3e7d184",
    title: "Compress thumbnails on upload",
    worktree: null,
    cwd: REPOSITORY,
    finishedAgoMs: 3 * 24 * 60 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  }),
  manualTask({
    threadId: "019d6c55-2f7a-7b63-9e04-c8d1a6f5b320",
    title: "Raise the API rate limits",
    worktree: null,
    cwd: API_REPOSITORY,
    finishedAgoMs: 5 * 24 * 60 * 60_000,
    state: canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  }),
].map((task) => ({ ...task, conversationAvailable: true }));

function manualSections(checkout) {
  return [
    {
      id: MANUAL_SECTION_ID,
      name: REPOSITORY,
      repository: true,
      tasks: [MANUAL_TASKS.darkTheme, checkout, MANUAL_TASKS.uploadsReview],
    },
    {
      id: "section-lumen-api",
      name: API_REPOSITORY,
      repository: true,
      tasks: [MANUAL_TASKS.pagination],
    },
    {
      id: "section-launch",
      name: NOTES_FOLDER,
      repository: false,
      tasks: [MANUAL_TASKS.announcement],
    },
  ];
}

export const ASK_JEV_FIRST = "caffold:ask-jev-first";

// Fixes the clock, the appearance, and the agents every manual screenshot
// shares. Call it before any surface fixture.
export async function installManualDefaults(page) {
  await page.clock.setFixedTime(new Date(MANUAL_NOW));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:settings",
      JSON.stringify({
        themeMode: "light",
        uiTypefacePreset: "geist-sans",
        codeTypefacePreset: "geist-mono",
        interfaceScalePercent: 100,
        conversationTextPx: 14,
        codeTextPx: 13,
        fileSortMode: "folders-first",
      }),
    );
  });
  await page.route("**/api/agent/models", (route) =>
    route.fulfill({ json: AGENT_CATALOG }),
  );
  await page.route("**/api/agent/permissions*", (route) => {
    const url = new URL(route.request().url());
    const modes = agentPermissionModes(
      url.searchParams.get("provider") ?? "",
      url.searchParams.get("model") ?? "",
    );
    return route.fulfill({ json: withAskJevFirst(modes) });
  });
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({ json: manualCodexStatus() }),
  );
}

// The Tasks surface: the three Sections, two archived Tasks, each Task's
// conversation, the dark theme Task's plan and changes, and voice input ready
// to use. The checkout Task waits for an approval unless `runningCheckout`
// shows it still working.
export async function installManualTasks(page, { runningCheckout = false } = {}) {
  const checkout = runningCheckout ? RUNNING_CHECKOUT : MANUAL_TASKS.flakyCheckout;
  const sections = manualSections(checkout);
  const details = {
    [MANUAL_TASKS.darkTheme.threadId]: darkThemeDetail(),
    [checkout.threadId]: runningCheckout ? runningCheckoutDetail() : flakyCheckoutDetail(),
    [MANUAL_TASKS.uploadsReview.threadId]: emptyDetail(MANUAL_TASKS.uploadsReview),
    [MANUAL_TASKS.pagination.threadId]: emptyDetail(MANUAL_TASKS.pagination),
    [MANUAL_TASKS.announcement.threadId]: emptyDetail(MANUAL_TASKS.announcement),
  };
  await page.exposeFunction(
    "__caffoldManualDetailBootstrap",
    (threadId) => details[threadId] ?? null,
  );
  await installEventSourceMock(page, {
    autoOpen: true,
    bootstrapFunctionKey: "__caffoldManualDetailBootstrap",
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        sections: sections.map((section) => ({
          ...section,
          tasks: section.tasks.map(activeListTask),
        })),
        unsectioned: [],
      },
    }),
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: ARCHIVED_TASKS, nextCursor: null } }),
  );
  await page.route(/\/api\/tasks\/(?!archived(?:[/?]|$))([^/?]+)(?:\?|$)/, (route) => {
    const threadId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1),
    );
    const detail = details[threadId];
    return detail
      ? route.fulfill({ json: detail })
      : route.fulfill({ status: 404, json: { error: { code: "not_found" } } });
  });
  await page.route(/\/api\/current-plan(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({
      json:
        path === MANUAL_TASKS.darkTheme.cwd
          ? DARK_THEME_PLAN
          : { status: "absent", watchPath: path, plan: null, problems: [] },
    });
  });
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const content = PLAN_DOCUMENTS[path];
    return content === undefined
      ? route.fallback()
      : route.fulfill({
          json: {
            path,
            name: path.split("/").at(-1),
            size: content.length,
            modifiedMs: MANUAL_NOW - 3 * 60_000,
            languageHint: "markdown",
            content,
          },
        });
  });
  await page.route(/\/api\/voice\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: { provider: "whisper", ready: true, maxRecordingSeconds: 300 },
    }),
  );
}

// Pastes two screenshots of Lumen's dark Settings page, one from a desktop and
// one from a phone, into a Composer's prompt as a clipboard paste.
export async function pasteManualScreenshots(prompt) {
  await prompt.evaluate(async (textarea) => {
    const screenshot = (width, height, sidebar) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#15171c";
      context.fillRect(0, 0, width, height);
      if (sidebar) {
        context.fillStyle = "#1d2027";
        context.fillRect(0, 0, 240, height);
      }
      const left = sidebar ? 288 : 32;
      context.fillStyle = "#e6e8ee";
      context.font = "600 36px sans-serif";
      context.fillText("Appearance", left, 96);
      ["System", "Light", "Dark"].forEach((label, index) => {
        const top = 150 + index * 88;
        context.fillStyle = index === 2 ? "#23262e" : "#1d2027";
        context.fillRect(left, top, width - left - 32, 64);
        context.fillStyle = index === 2 ? "#3a3e48" : "#aab0bd";
        context.font = "28px sans-serif";
        context.fillText(label, left + 24, top + 42);
      });
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    };
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File([await screenshot(1280, 800, true)], "settings-dark-desktop.png", {
        type: "image/png",
      }),
    );
    clipboard.items.add(
      new File([await screenshot(390, 844, false)], "settings-dark-phone.png", {
        type: "image/png",
      }),
    );
    textarea.focus();
    textarea.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  });
}

// The dark theme Task's repository: its uncommitted changes, the refs Git
// Compare offers, and the Lumen repository on GitHub with one Pull Request.
export async function installManualRepository(page) {
  const task = MANUAL_TASKS.darkTheme;
  const repository = {
    rootPath: task.worktree.rootPath,
    branch: task.worktree.branch,
    dirty: true,
  };
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        additions: 20,
        deletions: 2,
        files: WORKING_TREE_FILES.map((file) => ({
          path: file.path,
          status: file.status,
          category: file.status === "??" ? "untracked" : "unstaged",
          repoRelativePath: file.path,
          staged: false,
          unstaged: file.status !== "??",
          untracked: file.status === "??",
        })),
      },
    }),
  );
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("file") ??
      WORKING_TREE_FILES[0].path;
    const file = WORKING_TREE_FILES.find((candidate) => candidate.path === path) ??
      WORKING_TREE_FILES[0];
    return route.fulfill({
      json: {
        repository,
        path: file.path,
        repoRelativePath: file.path,
        kind: file.status === "??" ? "untracked" : "unstaged",
        additions: file.additions,
        deletions: file.deletions,
        diff: file.diff,
      },
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "dark-theme", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "origin/release/2.4", kind: "remote" },
        ],
        currentRef: "dark-theme",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "dark-theme",
      },
    }),
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        repository,
        baseRef: url.searchParams.get("base") || "origin/release/2.4",
        headRef: url.searchParams.get("head") || "origin/main",
        additions: 212,
        deletions: 58,
        files: COMPARE_FILES.map((file) => ({
          path: `${repository.rootPath}/${file.path}`,
          repoRelativePath: file.path,
          status: file.status,
        })),
      },
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const requested = url.searchParams.get("file") ?? "";
    const file = COMPARE_FILES.find((candidate) =>
      requested.endsWith(candidate.path)) ?? COMPARE_FILES[0];
    return route.fulfill({
      json: {
        repository,
        path: `${repository.rootPath}/${file.path}`,
        repoRelativePath: file.path,
        kind: `${url.searchParams.get("base")}...${url.searchParams.get("head")}`,
        additions: file.additions,
        deletions: file.deletions,
        diff: file.diff,
      },
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        github: GITHUB_REPOSITORY,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    }),
  );
  await page.route(/\/api\/github\/pull(?:\?|$)/, (route) =>
    route.fulfill({ json: { repository, github: GITHUB_REPOSITORY, pull: UPLOADS_PULL } }),
  );
}

// The Notes a person keeps across Tasks, with one Note open.
export async function installManualNotes(page) {
  await page.route(/\/api\/notes(?:\?|$)/, (route) => {
    const directoryId = new URL(route.request().url()).searchParams.get("directoryId");
    return route.fulfill({ json: NOTES_TREE[directoryId ?? ""] ?? { directories: [], notes: [] } });
  });
  await page.route(/\/api\/notes\/[^/?]+(?:\?|$)/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
    const note = NOTES[id];
    return note
      ? route.fulfill({ json: note })
      : route.fulfill({
          status: 404,
          json: { error: { code: "note_not_found", message: "That Note no longer exists." } },
        });
  });
}

export const MANUAL_NOTE_ID = "note-theme-tokens";

export async function installManualSettings(page) {
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        state: "ready",
        reasonCode: "serveReady",
        diagnosticMessage: "Caffold is available through Tailscale Serve.",
        tailnetUrl: MANUAL_TAILNET_URL,
        canManage: true,
      },
    }),
  );
  await page.route("**/api/voice/settings", (route) =>
    route.fulfill({
      json: {
        selected: "whisper",
        whisper: {
          model: "large-v3-turbo",
          revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
          bytes: 1_624_555_275,
          installed: true,
          loaded: true,
          downloading: false,
          downloadError: null,
        },
        openai: { model: "gpt-transcribe", keyConfigured: false },
        gemini: { model: "gemini-3.5-transcribe", keyConfigured: false },
        grok: { model: "grok-voice-transcribe-2.0", keyConfigured: false },
      },
    }),
  );
  await page.route("**/api/jev/settings", (route) =>
    route.fulfill({
      json: {
        model: "jev-1.13.0",
        keyConfigured: true,
        criteria: MANUAL_JEV_RULES,
        lastCheck: { ok: true, message: null, model: "jev-1.13.0" },
      },
    }),
  );
}

// This browser already allowed notifications and is subscribed, beside a
// phone that is subscribed too.
export async function installManualNotifications(page) {
  const clientId = "7c2e4b1a-0d9f-4e58-9a3c-5b6d7e8f9a01";
  await page.addInitScript((id) => {
    localStorage.setItem("caffold:push-client-id", id);
    const subscription = {
      endpoint: "https://push.example.test/studio-mac",
      expirationTime: null,
      toJSON() {
        return { keys: { p256dh: "browser-public", auth: "browser-auth" } };
      },
      async unsubscribe() {
        return true;
      },
    };
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class {
        static get permission() {
          return "granted";
        }

        static async requestPermission() {
          return "granted";
        }
      },
    });
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      configurable: true,
      get: () => ({
        async getSubscription() {
          return subscription;
        },
        async subscribe() {
          return subscription;
        },
      }),
    });
  }, clientId);
  const updatedAtMs = MANUAL_NOW - 3 * 24 * 60 * 60_000;
  await page.route(/\/api\/push\/(?:config|installations)/, (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/push/config") {
      return route.fulfill({ json: { publicKey: "BEl6Q2FmZm9sZC10ZXN0LWtleQ" } });
    }
    if (request.method() === "GET") {
      return route.fulfill({
        json: {
          currentState: "subscribed",
          installations: [
            {
              clientId: "3f1a9c2e-6b4d-4c8e-8f7a-1d2e3f4a5b6c",
              installationLabel: "Chrome on Android · phone",
              createdAtMs: updatedAtMs,
              updatedAtMs,
            },
          ],
        },
      });
    }
    if (request.method() === "PUT") {
      return route.fulfill({
        json: {
          clientId,
          installationLabel: "Chrome on macOS · studio-mac",
          createdAtMs: updatedAtMs,
          updatedAtMs,
        },
      });
    }
    return route.fulfill({ status: 204 });
  });
}

export const MANUAL_TAILNET_URL = "https://studio-mac.tail7c2e.ts.net/";

export const MANUAL_JEV_RULES = [
  "Anything that reads or writes inside the working directory is fine.",
  "Ask me before anything that pushes to a remote or publishes a package.",
].join("\n");

function manualTask({ threadId, title, worktree, cwd, finishedAgoMs, state, unseen = false }) {
  const finishedMs = MANUAL_NOW - finishedAgoMs;
  const root = worktree?.rootPath ?? cwd;
  return {
    id: threadId,
    threadId,
    ...state,
    title,
    preview: title,
    cwd: root,
    cwdPath: root,
    relativeCwd: "",
    worktree,
    createdMs: finishedMs - 20 * 60_000,
    updatedMs: finishedMs,
    recencyMs: finishedMs,
    lastCompletedMs: state.threadStatus.type === "idle" ? finishedMs : null,
    lastEventSummary: title,
    unseen,
  };
}

function managedWorktree(id, branch) {
  return {
    rootPath: `Library/Application Support/Caffold/data/worktrees/${id}`,
    repositoryRootPath: REPOSITORY,
    branch,
    headSha: HEAD_SHA,
    relativeCwd: "",
    linked: true,
  };
}

function withAskJevFirst(modes) {
  const reviewed = {
    mode: ASK_JEV_FIRST,
    label: "Ask Jev first",
    description:
      "Asks about everything. Jev holds back only what an automatic mode would stop for, plus whatever your extra rules name.",
    allowed: true,
    dangerous: false,
  };
  const options = [...modes.options];
  const dangerous = options.findIndex((option) => option.dangerous);
  options.splice(dangerous < 0 ? options.length : dangerous, 0, reviewed);
  return { ...modes, options };
}

function manualCodexStatus() {
  const status = mockCodexStatus();
  const resetsIn = (minutes) => Math.floor((MANUAL_NOW + minutes * 60_000) / 1000);
  return {
    ...status,
    readiness: {
      ...status.readiness,
      minimumSupportedVersion: "0.155.1",
      detectedExecutable: { path: "/Users/sam/.local/bin/codex", version: "0.158.0" },
      managedExecutable: {
        path: "/Users/sam/.codex/packages/standalone/current/codex",
        version: "0.158.0",
      },
      runningAppServerVersion: "0.158.0",
    },
    daemon: {
      ...status.daemon,
      managedCodexPath: "/Users/sam/.codex/packages/standalone/current/codex",
      managedCodexVersion: "0.158.0",
      socketPath: "/Users/sam/.codex/app-server-control/app-server-control.sock",
      cliVersion: "0.158.0",
      appServerVersion: "0.158.0",
    },
    account: { accountType: "chatgpt", email: "sam@example.com", planType: "pro" },
    rateLimits: {
      ...status.rateLimits,
      rateLimits: {
        primary: { usedPercent: 42, resetsAt: resetsIn(134), windowDurationMins: 300 },
        secondary: { usedPercent: 18, resetsAt: resetsIn(4 * 24 * 60 + 90), windowDurationMins: 10080 },
      },
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [
          {
            id: "reset-october",
            status: "available",
            title: "Rate-limit reset",
            expiresAt: Math.floor((MANUAL_NOW + 12 * 24 * 60 * 60_000) / 1000),
          },
          {
            id: "reset-november",
            status: "available",
            title: "Rate-limit reset",
            expiresAt: Math.floor((MANUAL_NOW + 43 * 24 * 60 * 60_000) / 1000),
          },
        ],
      },
    },
  };
}

function detailFor(task, overrides = {}) {
  return {
    threadId: task.threadId,
    provider: "codex",
    syncState: "ready",
    revision: 3,
    eventRevision: 3,
    task,
    events: [],
    fileLinks: [],
    eventsPage: { nextCursor: null },
    eventsRange: { from: null, to: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
    model: "gpt-6-astra",
    reasoningEffort: "high",
    fastMode: false,
    ...overrides,
  };
}

function emptyDetail(task) {
  return detailFor(task);
}

function event(threadId, anchorMs, id, type, summary, payload) {
  return { id, threadId, type, summary, payload, position: { anchorMs, index: 0 } };
}

function darkThemeDetail() {
  const task = MANUAL_TASKS.darkTheme;
  const turnId = "turn_manual_dark_theme";
  const start = task.updatedMs - 5 * 60_000;
  const at = (seconds) => start + seconds * 1000;
  return detailFor(task, {
    events: [
      event(task.threadId, at(0), "dark-theme-prompt", "user_message", "User prompt", {
        turnId,
        text:
          "Add a dark theme to the Settings page. Follow the system setting by default, " +
          "let people override it, and add tests.",
      }),
      event(task.threadId, at(20), "dark-theme-progress", "assistant_message", "Assistant response", {
        turnId,
        phase: "progress",
        text:
          "I'll add a theme preference, apply it through the existing CSS variables, " +
          "and cover both the system default and an override in the settings tests.",
      }),
      event(task.threadId, at(230), "dark-theme-tests", "command_execution", "Command completed", {
        turnId,
        itemId: "dark-theme-tests",
        command: "npm test -- settings",
        cwd: task.cwd,
        status: "completed",
        exitCode: 0,
        durationMs: 6_210,
        output: " ✓ tests/settings/theme.test.ts (6 tests)\n ✓ tests/settings/settings-page.test.ts (17 tests)\n\n Test Files  2 passed (2)\n      Tests  23 passed (23)",
      }),
      event(task.threadId, at(250), "dark-theme-files", "file_change", "Files changed", {
        turnId,
        status: "completed",
        paths: WORKING_TREE_FILES.map((file) => file.path),
      }),
      event(task.threadId, at(290), "dark-theme-answer", "assistant_message", "Assistant response", {
        turnId,
        phase: "final",
        text: [
          "## Dark theme is ready to review",
          "",
          "Settings now has an **Appearance** choice:",
          "",
          "- **System** follows the operating system and is the default;",
          "- **Light** and **Dark** override it and are remembered in the browser.",
          "",
          "Every page takes its colors from the existing CSS variables, so the whole app follows the choice. `npm test -- settings` passes all 23 tests.",
          "",
          "Open **Working Tree** to review the four changed files.",
        ].join("\n"),
      }),
      event(task.threadId, at(300), "dark-theme-complete", "turn_completed", "Turn completed", {
        turnId,
        status: "completed",
      }),
    ],
  });
}

function flakyCheckoutDetail() {
  const task = MANUAL_TASKS.flakyCheckout;
  const turnId = task.activeTurn.id;
  const start = task.activeTurn.startedAtMs;
  const at = (seconds) => start + seconds * 1000;
  return detailFor(task, {
    events: [
      event(task.threadId, at(0), "checkout-prompt", "user_message", "User prompt", {
        turnId,
        text: "The checkout test fails about one run in ten on CI. Find out why and fix it.",
      }),
      event(task.threadId, at(40), "checkout-progress", "assistant_message", "Assistant response", {
        turnId,
        phase: "progress",
        text:
          "The test clicks **Pay** before the address form finishes validating. " +
          "It now waits for the validated state. I'd like to run it 20 times to confirm the flake is gone.",
      }),
      event(task.threadId, at(55), "checkout-files", "file_change", "Files changed", {
        turnId,
        status: "completed",
        paths: ["tests/e2e/checkout.spec.ts"],
      }),
      event(task.threadId, at(60), "approval_requested:checkout-repeat", "approval_requested", "Command approval requested", {
        turnId,
        itemId: "checkout-repeat",
        approvalId: "checkout-repeat",
        title: "Command approval requested",
        reason: "Repeat the checkout test to confirm the fix",
        command: "npx playwright test tests/e2e/checkout.spec.ts --repeat-each=20",
        cwd: task.cwd,
        decisions: ["allow", "allowForSession", "deny", "denyAndStop"],
      }),
    ],
  });
}

function runningCheckoutDetail() {
  const task = RUNNING_CHECKOUT;
  const turnId = task.activeTurn.id;
  const start = task.activeTurn.startedAtMs;
  const at = (seconds) => start + seconds * 1000;
  return detailFor(task, {
    events: [
      event(task.threadId, at(0), "checkout-prompt", "user_message", "User prompt", {
        turnId,
        text: "The checkout test fails about one run in ten on CI. Find out why and fix it.",
      }),
      event(task.threadId, at(40), "checkout-progress", "assistant_message", "Assistant response", {
        turnId,
        phase: "progress",
        text:
          "The test clicks **Pay** before the address form finishes validating. " +
          "It now waits for the validated state; running it 20 times to confirm the flake is gone.",
      }),
      event(task.threadId, at(55), "checkout-files", "file_change", "Files changed", {
        turnId,
        status: "completed",
        paths: ["tests/e2e/checkout.spec.ts"],
      }),
      event(task.threadId, at(80), "checkout-steer", "user_message", "User prompt", {
        turnId,
        text: "Run it in WebKit too before you finish.",
      }),
    ],
  });
}

const DARK_THEME_PLAN_ROOT = `${MANUAL_TASKS.darkTheme.cwd}/.caffold/plans/current`;

const PLAN_DOCUMENTS = {
  [`${DARK_THEME_PLAN_ROOT}/PLAN.md`]: [
    "# Dark theme for Settings",
    "",
    "Follow the system setting by default and let people override it with Light",
    "or Dark. Apply the choice through the existing CSS variables so every page",
    "follows it, and remember it in the browser.",
    "",
  ].join("\n"),
  [`${DARK_THEME_PLAN_ROOT}/CHECKLIST.md`]: [
    "- [x] Add a theme preference with System, Light, and Dark",
    "- [x] Apply the theme through the existing CSS variables",
    "- [x] Add the Appearance choice to Settings",
    "- [x] Test the system default and an override",
    "- [x] Run the settings test suite",
    "",
  ].join("\n"),
};

const DARK_THEME_PLAN = {
  status: "ready",
  watchPath: DARK_THEME_PLAN_ROOT,
  plan: {
    title: "Dark theme for Settings",
    completed: 5,
    total: 5,
    planDocument: planDocument("PLAN.md"),
    checklistDocument: planDocument("CHECKLIST.md"),
  },
  problems: [],
};

function planDocument(name) {
  const path = `${DARK_THEME_PLAN_ROOT}/${name}`;
  return {
    path,
    name,
    size: PLAN_DOCUMENTS[path].length,
    modifiedMs: MANUAL_NOW - 3 * 60_000,
  };
}

const WORKING_TREE_FILES = [
  {
    path: "src/settings/SettingsPage.tsx",
    status: " M",
    additions: 8,
    deletions: 1,
    diff: [
      "diff --git a/src/settings/SettingsPage.tsx b/src/settings/SettingsPage.tsx",
      "index 3a41c7e..8d2f0b9 100644",
      "--- a/src/settings/SettingsPage.tsx",
      "+++ b/src/settings/SettingsPage.tsx",
      "@@ -1,13 +1,20 @@",
      " import { AccountSection } from \"./AccountSection\";",
      " import { NotificationSection } from \"./NotificationSection\";",
      "+import { ThemePicker } from \"./ThemePicker\";",
      "+import { useThemePreference } from \"../styles/theme\";",
      " ",
      " export function SettingsPage() {",
      "+  const [theme, setTheme] = useThemePreference();",
      "+",
      "   return (",
      "     <main className=\"settings\">",
      "-      <h1>Settings</h1>",
      "+      <h1 className=\"settings-title\">Settings</h1>",
      "       <AccountSection />",
      "+      <section aria-labelledby=\"appearance-title\">",
      "+        <h2 id=\"appearance-title\">Appearance</h2>",
      "+        <ThemePicker value={theme} onChange={setTheme} />",
      "+      </section>",
      "       <NotificationSection />",
      "     </main>",
      "   );",
      " }",
    ].join("\n"),
  },
  {
    path: "src/settings/ThemePicker.tsx",
    status: "??",
    additions: 7,
    deletions: 0,
    diff: newFileDiff("src/settings/ThemePicker.tsx", [
      "type Theme = \"system\" | \"light\" | \"dark\";",
      "",
      "const OPTIONS: { value: Theme; label: string }[] = [",
      "  { value: \"system\", label: \"System\" },",
      "  { value: \"light\", label: \"Light\" },",
      "  { value: \"dark\", label: \"Dark\" },",
      "];",
    ]),
  },
  {
    path: "src/styles/theme.css",
    status: " M",
    additions: 2,
    deletions: 1,
    diff: [
      "diff --git a/src/styles/theme.css b/src/styles/theme.css",
      "--- a/src/styles/theme.css",
      "+++ b/src/styles/theme.css",
      "@@ -1,4 +1,5 @@",
      "-:root {",
      "+:root,",
      "+:root[data-theme=\"light\"] {",
      "   --surface: #ffffff;",
      "   --text: #1d1d1f;",
      " }",
    ].join("\n"),
  },
  {
    path: "tests/settings/theme.test.ts",
    status: "??",
    additions: 3,
    deletions: 0,
    diff: newFileDiff("tests/settings/theme.test.ts", [
      "import { renderSettings } from \"./render\";",
      "",
      "test(\"follows the system setting by default\", async () => {",
    ]),
  },
];

function newFileDiff(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

const COMPARE_FILES = [
  {
    path: "src/uploads/ResumableUpload.ts",
    status: "A",
    additions: 148,
    deletions: 0,
    diff: newFileDiff("src/uploads/ResumableUpload.ts", [
      "export class ResumableUpload {",
      "  constructor(private file: File, private chunkSize = 5 * 1024 * 1024) {}",
      "",
      "  async resume(offset: number) {",
      "    for (let start = offset; start < this.file.size; start += this.chunkSize) {",
      "      await this.send(this.file.slice(start, start + this.chunkSize), start);",
      "    }",
      "  }",
    ]),
  },
  {
    path: "src/uploads/UploadButton.tsx",
    status: "M",
    additions: 38,
    deletions: 41,
    diff: [
      "diff --git a/src/uploads/UploadButton.tsx b/src/uploads/UploadButton.tsx",
      "--- a/src/uploads/UploadButton.tsx",
      "+++ b/src/uploads/UploadButton.tsx",
      "@@ -12,9 +12,10 @@ export function UploadButton({ onUploaded }: Props) {",
      "   async function upload(file: File) {",
      "-    const response = await fetch(\"/api/photos\", { method: \"POST\", body: file });",
      "-    onUploaded(await response.json());",
      "+    const upload = new ResumableUpload(file);",
      "+    await upload.resume(await upload.acknowledgedOffset());",
      "+    onUploaded(await upload.result());",
      "   }",
    ].join("\n"),
  },
  {
    path: "src/settings/SettingsPage.tsx",
    status: "M",
    additions: 26,
    deletions: 17,
    diff: WORKING_TREE_FILES[0].diff,
  },
];

const GITHUB_REPOSITORY = {
  owner: "lumen-photos",
  name: "lumen",
  nameWithOwner: "lumen-photos/lumen",
  url: "https://github.com/lumen-photos/lumen",
};

const UPLOADS_PULL = {
  number: 214,
  title: "Resume interrupted photo uploads",
  state: "OPEN",
  draft: false,
  author: "mira-k",
  labels: ["uploads"],
  comments: 1,
  reviews: 1,
  commits: 3,
  additions: 186,
  deletions: 41,
  changedFiles: 2,
  baseRefName: "main",
  baseRefOid: "1e9b2c4d6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
  baseRepository: { nameWithOwner: GITHUB_REPOSITORY.nameWithOwner, url: GITHUB_REPOSITORY.url },
  headRefName: "resumable-uploads",
  headRefOid: "7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
  headRepository: { nameWithOwner: GITHUB_REPOSITORY.nameWithOwner, url: GITHUB_REPOSITORY.url },
  body:
    "Large uploads restart from zero when the connection drops. This sends each photo in " +
    "5 MB chunks and resumes from the last acknowledged chunk.\n\n" +
    "- Adds `ResumableUpload`\n- Uses it from `UploadButton`\n- Keeps the old path for files under 5 MB",
  bodyHtml:
    "<p>Large uploads restart from zero when the connection drops. This sends each photo in " +
    "5 MB chunks and resumes from the last acknowledged chunk.</p>" +
    "<ul><li>Adds <code>ResumableUpload</code></li><li>Uses it from <code>UploadButton</code></li>" +
    "<li>Keeps the old path for files under 5 MB</li></ul>",
  createdAt: "2026-09-23T09:12:00Z",
  updatedAt: "2026-09-24T11:40:00Z",
  url: `${GITHUB_REPOSITORY.url}/pull/214`,
  conversationComments: [
    {
      author: "sam-dev",
      body: "Could we keep the chunk size configurable for slow connections?",
      bodyHtml: "<p>Could we keep the chunk size configurable for slow connections?</p>",
      createdAt: "2026-09-24T10:02:00Z",
      updatedAt: "2026-09-24T10:02:00Z",
      url: `${GITHUB_REPOSITORY.url}/pull/214#issuecomment-1`,
    },
  ],
  reviewComments: [
    {
      author: "sam-dev",
      state: "APPROVED",
      body: "Tested on a throttled connection; resuming works.",
      bodyHtml: "<p>Tested on a throttled connection; resuming works.</p>",
      submittedAt: "2026-09-24T11:40:00Z",
    },
  ],
  commitSummaries: [
    pullCommit("9c1e4a7", "Add ResumableUpload", "2026-09-23T09:05:00Z"),
    pullCommit("3f8b2d0", "Upload photos in chunks from UploadButton", "2026-09-23T09:10:00Z"),
    pullCommit("e51a9c3", "Keep single-request uploads for small files", "2026-09-24T08:52:00Z"),
  ],
};

function pullCommit(shortSha, subject, committedAt) {
  return {
    sha: `${shortSha}${"0".repeat(33)}`,
    shortSha,
    subject,
    authorName: "Mira K.",
    committedAt,
    url: `${GITHUB_REPOSITORY.url}/commit/${shortSha}`,
  };
}

const NOTES_TREE = {
  "": {
    directories: [
      { id: "dir-lumen", name: "Lumen", updatedAtMs: MANUAL_NOW - 3 * 60_000, directoryCount: 1, noteCount: 1 },
      { id: "dir-launch", name: "Launch", updatedAtMs: MANUAL_NOW - 26 * 60 * 60_000, directoryCount: 0, noteCount: 1 },
    ],
    notes: [{ id: "note-inbox", name: "Inbox", updatedAtMs: MANUAL_NOW - 2 * 60 * 60_000 }],
  },
  "dir-lumen": {
    directories: [
      { id: "dir-decisions", name: "Decisions", updatedAtMs: MANUAL_NOW - 3 * 60_000, directoryCount: 0, noteCount: 2 },
    ],
    notes: [{ id: "note-release-checklist", name: "Release checklist", updatedAtMs: MANUAL_NOW - 3 * 24 * 60 * 60_000 }],
  },
  "dir-decisions": {
    directories: [],
    notes: [
      { id: "note-resumable-uploads", name: "Resumable uploads", updatedAtMs: MANUAL_NOW - 41 * 60_000 },
      { id: MANUAL_NOTE_ID, name: "Theme tokens", updatedAtMs: MANUAL_NOW - 3 * 60_000 },
    ],
  },
  "dir-launch": {
    directories: [],
    notes: [{ id: "note-announcement", name: "Announcement outline", updatedAtMs: MANUAL_NOW - 26 * 60 * 60_000 }],
  },
};

const NOTES = {
  [MANUAL_NOTE_ID]: {
    id: MANUAL_NOTE_ID,
    name: "Theme tokens",
    content: [
      "# Theme tokens",
      "",
      "Every color comes from a CSS variable in `src/styles/theme.css`. Components never use a literal color.",
      "",
      "| Token | Light | Dark |",
      "| --- | --- | --- |",
      "| `--surface` | `#ffffff` | `#141414` |",
      "| `--text` | `#1d1d1f` | `#ededed` |",
      "| `--accent` | `#0a7c59` | `#6fd3ae` |",
      "",
      "## Decisions",
      "",
      "- **System** is the default, and a choice is remembered per browser.",
      "- New components add a token here before using a new color.",
      "",
    ].join("\n"),
    location: [
      { id: "dir-lumen", name: "Lumen" },
      { id: "dir-decisions", name: "Decisions" },
    ],
    createdAtMs: MANUAL_NOW - 3 * 24 * 60 * 60_000,
    updatedAtMs: MANUAL_NOW - 3 * 60_000,
    createdBy: { threadId: MANUAL_TASKS.pagination.threadId, state: "active", displayName: MANUAL_TASKS.pagination.title },
    updatedBy: { threadId: MANUAL_TASKS.darkTheme.threadId, state: "active", displayName: MANUAL_TASKS.darkTheme.title },
  },
};
