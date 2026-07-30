import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PASTED_IMAGE_BASE64,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  isScrolledToBottom,
  mockCodexModels,
  mockCodexStatus,
  openHeaderActionGroup,
  pasteImage,
  scrollTop,
  stabilizeDynamicText,
} from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/codex\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockCodexStatus()),
    }),
  );

  await page.route(/\/api\/codex\/permissions(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        defaultMode: "approveForMe",
        options: [
          {
            mode: "askForApproval",
            label: "Ask for approval",
            description: "Ask before crossing the workspace boundary.",
            allowed: true,
            dangerous: false,
          },
          {
            mode: "approveForMe",
            label: "Approve for me",
            description: "Review eligible requests automatically.",
            allowed: true,
            dangerous: false,
          },
          {
            mode: "fullAccess",
            label: "Full access",
            description: "Run without sandbox restrictions.",
            allowed: true,
            dangerous: true,
          },
        ],
      }),
    }),
  );

  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await page.route("https://esm.sh/**", (route) => {
    if (route.request().url() === "https://esm.sh/marked@15.0.12") {
      return route.fulfill({
        contentType: "text/javascript",
        body: `
          const escapeHtml = (value) => value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          const inline = (value) => value
            .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
            .replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>")
            .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
          export const marked = {
            parse(source) {
              const escaped = escapeHtml(source);
              const blocks = escaped.split(/\\n{2,}/);
              return blocks.map((block) => {
                if (block.startsWith("\\x60\\x60\\x60")) {
                  const lines = block.split("\\n");
                  return '<pre><code>' + lines.slice(1, -1).join("\\n") + '</code></pre>';
                }
                const heading = block.match(/^(#{1,6}) (.+)$/);
                if (heading) {
                  const level = heading[1].length;
                  return '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
                }
                const lines = block.split("\\n");
                if (lines.every((line) => line.startsWith("- "))) {
                  return '<ul>' + lines.map((line) => '<li>' + inline(line.slice(2)) + '</li>').join("") + '</ul>';
                }
                if (lines.length >= 2 && lines[0].startsWith("|") && lines[1].includes("---")) {
                  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
                  const header = cells(lines[0]);
                  const rows = lines.slice(2).map(cells);
                  return '<table><thead><tr>' + header.map((cell) => '<th>' + inline(cell) + '</th>').join("") + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join("") + '</tr>').join("") + '</tbody></table>';
                }
                return '<p>' + inline(lines.join(" ")) + '</p>';
              }).join("");
            },
          };
        `,
      });
    }

    if (route.request().url() !== "https://esm.sh/lucide@1.22.0") {
      return route.abort();
    }

    return route.fulfill({
      contentType: "text/javascript",
      body: `
        export const File = [["path", { d: "M6 3h8l4 4v14H6z" }]];
        export const FileArchive = File;
        export const FileCode = [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "m10 9-3 3 3 3" }], ["path", { d: "m14 9 3 3-3 3" }]];
        export const FileCog = File;
        export const FileDiff = FileCode;
        export const FileImage = File;
        export const FileJson = FileCode;
        export const FileQuestion = File;
        export const FileTerminal = FileCode;
        export const FileText = [["path", { d: "M6 3h12v18H6z" }], ["path", { d: "M9 8h6" }], ["path", { d: "M9 12h6" }]];
        export const CircleAlert = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 8v4" }], ["path", { d: "M12 16h.01" }]];
        export const CircleCheck = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m8 12 2.5 2.5L16 9" }]];
        export const CircleDot = [["circle", { cx: "12", cy: "12", r: "10" }], ["circle", { cx: "12", cy: "12", r: "2" }]];
        export const CircleSlash = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m5 5 14 14" }]];
        export const ChevronFirst = [["path", { d: "m17 18-6-6 6-6" }], ["path", { d: "M7 6v12" }]];
        export const ChevronLast = [["path", { d: "m7 18 6-6-6-6" }], ["path", { d: "M17 6v12" }]];
        export const ChevronLeft = [["path", { d: "m15 18-6-6 6-6" }]];
        export const ChevronRight = [["path", { d: "m9 18 6-6-6-6" }]];
        export const Folder = [["path", { d: "M3 6h7l2 2h9v10H3z" }]];
        export const FolderGit2 = Folder;
        export const FolderOpen = Folder;
        export const FolderSymlink = Folder;
        export const GitCompare = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["path", { d: "M6 9v7a2 2 0 0 0 2 2h3" }]];
        export const GitPullRequest = [["circle", { cx: "18", cy: "18", r: "3" }], ["circle", { cx: "6", cy: "6", r: "3" }], ["path", { d: "M6 9v12" }], ["path", { d: "M18 15V5" }], ["path", { d: "M18 5h-5" }]];
        export const ArrowLeft = [
          ["path", { d: "m12 19-7-7 7-7" }],
          ["path", { d: "M19 12H5" }],
        ];
        export const History = [["path", { d: "M3 12a9 9 0 1 0 3-6.7" }], ["path", { d: "M3 3v6h6" }], ["path", { d: "M12 7v5l3 2" }]];
        export const Info = [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]];
        export const ListTodo = [["rect", { x: "3", y: "5", width: "6", height: "6", rx: "1" }], ["path", { d: "M13 7h8" }], ["path", { d: "M13 15h8" }], ["path", { d: "m4 16 2 2 4-4" }]];
        export const Database = [["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }], ["path", { d: "M4 5v10c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }]];
        export const Link = [["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" }]];
        export const Lock = [["rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 10V7a4 4 0 0 1 8 0v3" }]];
        export const PanelTopOpen = [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }]];
        export const Pencil = [["path", { d: "M17 3a2.8 2.8 0 0 1 4 4L7 21H3v-4z" }]];
        export const Plus = [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]];
        export const RefreshCw = [["path", { d: "M20 6v5h-5" }], ["path", { d: "M4 18v-5h5" }], ["path", { d: "M18.4 9A7 7 0 0 0 6 6.6L4 9" }], ["path", { d: "M5.6 15A7 7 0 0 0 18 17.4l2-2.4" }]];
        export const Settings = [["path", { d: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" }], ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.09.38.3.73.6 1 .3.27.68.4 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z" }]];
        export const Square = [["rect", { x: "5", y: "5", width: "14", height: "14", rx: "1" }]];
        export const TriangleAlert = [["path", { d: "M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]];
        export const Trash2 = [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }]];
        export const X = [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]];
        export function createElement(iconNode, attrs = {}) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          const baseAttrs = {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            ...attrs,
          };
          for (const [name, value] of Object.entries(baseAttrs)) {
            svg.setAttribute(name, String(value));
          }
          for (const [tag, childAttrs] of iconNode) {
            const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [name, value] of Object.entries(childAttrs)) {
              child.setAttribute(name, String(value));
            }
            svg.appendChild(child);
          }
          return svg;
        }
      `,
    });
  });
});

test("loads additional task-list pages only after a cursor request", async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const task = (threadId, title, updatedMs) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree: null,
    createdMs: updatedMs,
    updatedMs,
    recencyMs: updatedMs,
    lastEventSummary: `${title} summary`,
  });
  const cursors = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        cursor
          ? { tasks: [task("thread-page-2", "Older paged task", 10)], nextCursor: null }
          : { tasks: [task("thread-page-1", "Newest paged task", 20)], nextCursor: "page-2" },
      ),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-row")).toHaveCount(1);
  await expect(tasksPage).toContainText("Newest paged task");
  await expect(tasksPage).not.toContainText("Older paged task");

  await tasksPage.getByRole("button", { name: "Load more tasks" }).click();

  await expect(tasksPage.locator(".task-row")).toHaveCount(2);
  await expect(tasksPage).toContainText("Older paged task");
  await expect(tasksPage.getByRole("button", { name: "Load more tasks" })).toHaveCount(0);
  expect(cursors).toEqual([null, "page-2"]);
});

test("clears stale task rows when canonical list reload fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError() {
        this.readyState = 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const task = {
    id: "thread_stale_list",
    threadId: "thread_stale_list",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Must not survive failed reload",
    preview: "Stale projection",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: 1,
    updatedMs: 2,
    recencyMs: 2,
    lastEventSummary: "Stale projection",
  };
  let taskReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskReads += 1;
    if (taskReads === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [task], nextCursor: null }),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Canonical task list unavailable" }),
    });
  });

  await page.goto("/tasks");
  const navigator = page.locator("caffold-task-navigator");
  await expect(navigator).toContainText("Must not survive failed reload");
  await page.evaluate(() => {
    window.__taskListEventSource.emitOpen();
    window.__taskListEventSource.emitError();
    window.__taskListEventSource.emitOpen();
  });

  await expect(navigator).not.toContainText("Must not survive failed reload");
  await expect(navigator.getByRole("alert")).toContainText(
    "Canonical task list unavailable",
  );
  expect(taskReads).toBe(2);
});

test("opens global Tasks without local registry state", async ({ page }, testInfo) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);

  const threadId = "thread_global_fixture";
  let createdTaskRequest = null;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Global task",
    preview: "Hello from a cwd-backed task",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree: null,
    createdMs: 1_767_200_000_000,
    updatedMs: 1_767_200_000_000,
    recencyMs: 1_767_200_000_000,
    lastEventSummary: "Assistant response",
  };
  const detail = {
    task,
    events: [
      {
        id: "event_prompt",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Say hello globally" },
        createdMs: task.createdMs,
      },
      {
        id: "event_answer",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Hello from a global Codex thread." },
        createdMs: task.createdMs + 1,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  const taskListQueries = [];

  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      taskListQueries.push({ cwd: url.searchParams.get("cwd") });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createdTaskRequest = request.postDataJSON();
      expect(createdTaskRequest.cwd).toBe("src");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    }

    return route.continue();
  });
  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== ".") {
      return route.continue();
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        root: "tests/fixtures/home",
        path: ".",
        git: { rootPath: ".", branch: "main", dirty: true },
        entries: [
          {
            name: "src",
            path: "src",
            kind: "directory",
            isSymlink: false,
            supported: true,
            gitIgnored: false,
            size: null,
            modifiedMs: null,
            git: null,
          },
          {
            name: "README.md",
            path: "README.md",
            kind: "file",
            isSymlink: false,
            supported: true,
            gitIgnored: false,
            size: 24,
            modifiedMs: null,
            git: null,
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        additions: 1,
        deletions: 0,
        files: [
          {
            path: "README.md",
            repoRelativePath: "README.md",
            status: "??",
            category: "untracked",
            staged: false,
            unstaged: false,
            untracked: true,
          },
        ],
      }),
    }),
  );
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    expect(url.searchParams.get("file")).toBe("README.md");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          rootPath: ".",
          branch: "main",
          dirty: true,
        },
        path: "README.md",
        repoRelativePath: "README.md",
        kind: "untracked",
        diff: [
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1 @@",
          "+Global worktree review",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: ".", branch: "main", dirty: true },
        github: { owner: "example", name: "caffold" },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      }),
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe(".");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: ".", branch: "main", dirty: true },
        github: { owner: "example", name: "caffold" },
        state: "open",
        issues: [],
        page: 1,
        perPage: 50,
        totalIssues: 0,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      }),
    });
  });

  await page.goto("/");
  await expect(page).toHaveURL("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(
    page.locator("caffold-codex-workspace .codex-workspace-close"),
  ).toBeHidden();

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect(tasksPage).toContainText("No Caffold tasks yet.");

  await page.goto("/tasks");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect(tasksPage).toContainText("No Caffold tasks yet.");

  await page.goto("/tasks?cwd=.");
  await expect(page).toHaveURL("/tasks");
  await expect
    .poll(() => taskListQueries.at(-1))
    .toEqual({ cwd: null });

  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL("/tasks/new");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL("/tasks");
  await tasksPage
    .locator(".tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL("/tasks/new");
  await tasksPage.locator('textarea[name="prompt"]').fill("Say hello globally");
  await tasksPage.getByRole("button", { name: "Browse Files" }).click();
  const cwdBrowser = tasksPage.locator(".task-new-cwd-browser caffold-file-browser");
  await expect(cwdBrowser).toBeVisible();
  await cwdBrowser.locator('button[data-entry-path="src"]').click();
  await tasksPage.getByRole("button", { name: "Use This Folder" }).click();
  await expect(page).toHaveURL("/tasks/new?cwd=src");
  await expect(tasksPage.locator('textarea[name="prompt"]')).toHaveValue(
    "Say hello globally",
  );
  await expect(tasksPage.locator(".task-composer-context")).toContainText("src");
  await tasksPage.locator('textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createdTaskRequest?.prompt).toBe("Say hello globally");
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");
  const openDiff = tasksPage.getByRole("button", { name: "Open Diff" });
  await expect(openDiff).toBeDisabled();
  await expect(tasksPage.getByRole("button", { name: "Git unavailable" })).toBeDisabled();
  await expect(tasksPage.getByRole("button", { name: "GitHub unavailable" })).toBeDisabled();
  await expect(tasksPage).toContainText("Unavailable outside a Git worktree.");

  Object.assign(task, {
    worktree: {
      rootPath: ".",
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "",
      linked: false,
    },
  });
  await page.reload();
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main");
  await expect(tasksPage.locator(".task-review-menu")).toHaveCount(2);

  await tasksPage
    .locator('.task-review-menu summary[aria-label="Open Git workspace"]')
    .click();
  await captureReviewScreenshot(page, testInfo, "tasks-global-git-menu");
  await tasksPage
    .locator('button[data-task-action="open-git-tool"][data-review-kind="diff"]')
    .click();
  await expect(page).toHaveURL("/git/diff?cwd=.");
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "git",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage
    .locator('.task-review-menu summary[aria-label="Open GitHub workspace"]')
    .click();
  await captureReviewScreenshot(page, testInfo, "tasks-global-github-menu");
  await tasksPage
    .locator('button[data-task-action="open-github-tool"][data-review-kind="issues"]')
    .click();
  await expect(page).toHaveURL("/github/issues?cwd=.");
  await expect(page.locator("caffold-review-workspace")).toHaveAttribute(
    "data-workspace-mode",
    "github",
  );
  await page.getByRole("button", { name: "Close review workspace" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage).toContainText("Hello from a global Codex thread.");

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFiles = tasksPage.locator(".task-files-view");
  await expect(
    taskFiles.locator('button[data-entry-path="README.md"]'),
  ).toBeVisible();
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );

  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  const taskDiff = tasksPage.locator(".task-diff-view");
  const readmeChange = taskDiff.locator(
    'caffold-git-diff-changes-tree button[data-repo-relative-path="README.md"]',
  );
  await expect(readmeChange).toBeVisible();
  await readmeChange.click();
  await expect(
    taskDiff.locator(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
    ),
  ).toContainText("Global worktree review");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
});

test("keeps a large task usable while conversation history is loading", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve() },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_large_history";
  const now = 1_767_300_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Large task history",
    preview: "Most recent response",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "tests/fixtures/home",
    worktree: null,
    createdMs: now,
    updatedMs: now + 1,
    recencyMs: now + 1,
    lastEventSummary: "Assistant response",
  };
  const pendingDetail = {
    revision: 1,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: true,
  };

  await page.route("**/api/tasks**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method() === "GET" && segments.length === 2) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [task] }),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === threadId
    ) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pendingDetail),
      });
    }
    return route.continue();
  });

  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-detail-heading h2")).toContainText(
    "Large task history",
  );
  await expect(tasksPage.getByText("Loading task...")).toHaveCount(0);
  await expect(tasksPage.getByText("Loading conversation...")).toBeVisible();

  const composer = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await composer.fill("Keep this draft while history arrives");
  await expect
    .poll(() =>
      page.evaluate(() => window.__caffoldMockEventSources.length),
    )
    .toBeGreaterThan(0);

  const canonicalDetail = {
    ...pendingDetail,
    revision: 2,
    historyLoading: false,
    events: [
      {
        id: "event_user",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: { text: "Load the recent history" },
        createdMs: now,
      },
      {
        id: "event_assistant",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { text: "Recent history is ready." },
        createdMs: now + 1,
      },
    ],
  };
  await page.evaluate(({ threadId, canonicalDetail }) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: canonicalDetail.revision,
      detail: canonicalDetail,
      reason: "initial",
    });
  }, { threadId, canonicalDetail });

  await expect(tasksPage.getByText("Loading conversation...")).toHaveCount(0);
  await expect(tasksPage.getByText("Recent history is ready.")).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft while history arrives");
});

test("recovers task detail and prompt submission across bootstrap races", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve() },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_300_100_000;
  const taskRecord = (threadId, title) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} response`,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: `${title} response`,
  });
  const detailFor = (task, revision, response) => ({
    revision,
    task,
    events: [
      {
        id: `${task.threadId}_assistant`,
        threadId: task.threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: `${task.threadId}_turn`, text: response },
        createdMs: now,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
  });
  const taskBeforeFailure = taskRecord(
    "thread_sync_before_failure",
    "Sync before request failure",
  );
  const taskAfterFailure = taskRecord(
    "thread_sync_after_failure",
    "Sync after request failure",
  );
  const detailBeforeFailure = detailFor(
    taskBeforeFailure,
    2,
    "The stream arrived before the failed request.",
  );
  const detailAfterFailure = detailFor(
    taskAfterFailure,
    2,
    "The stream recovered the failed request.",
  );

  let releaseFirstDetail;
  const firstDetailStarted = new Promise((resolve) => {
    releaseFirstDetail = { started: resolve, route: null };
  });
  const submittedPrompts = [];

  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    if (request.method() === "GET" && segments.length === 2) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: [taskBeforeFailure, taskAfterFailure] }),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === taskBeforeFailure.threadId
    ) {
      releaseFirstDetail.route = route;
      releaseFirstDetail.started();
      await new Promise((resolve) => {
        releaseFirstDetail.fulfill = resolve;
      });
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "codex_process_unavailable",
            message: "Codex app-server is unavailable.",
          },
        }),
      });
    }
    if (
      request.method() === "GET" &&
      segments.length === 3 &&
      segments[2] === taskAfterFailure.threadId
    ) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "codex_process_unavailable",
            message: "Codex app-server is unavailable.",
          },
        }),
      });
    }
    if (
      request.method() === "POST" &&
      segments.length === 4 &&
      segments[3] === "prompts"
    ) {
      const body = request.postDataJSON();
      submittedPrompts.push({ threadId: segments[2], prompt: body.prompt });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId: segments[2],
          turnId: `${segments[2]}_follow_up`,
          steered: false,
        }),
      });
    }
    return route.continue();
  });

  const emitTaskSync = async (threadId, detail) => {
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.__caffoldMockEventSources.some((source) =>
              source.url.includes(`/api/tasks/${id}/stream`),
            ),
          threadId,
        ),
      )
      .toBe(true);
    await page.evaluate(({ threadId, detail }) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: detail.revision,
        detail,
        reason: "canonical-bootstrap",
      });
    }, { threadId, detail });
  };

  await page.goto(`/tasks/${taskBeforeFailure.threadId}?cwd=src`);
  await firstDetailStarted;
  const tasksPage = page.locator("caffold-tasks-page");
  await emitTaskSync(taskBeforeFailure.threadId, detailBeforeFailure);
  await expect(tasksPage).toContainText(
    "The stream arrived before the failed request.",
  );
  releaseFirstDetail.fulfill();
  await expect(tasksPage).not.toContainText("Codex app-server is unavailable.");

  let form = tasksPage.locator(".task-follow-up-form");
  let prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Submitted after the delayed failure");
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => submittedPrompts).toEqual([
    {
      threadId: taskBeforeFailure.threadId,
      prompt: "Submitted after the delayed failure",
    },
  ]);

  await page.goto(`/tasks/${taskAfterFailure.threadId}?cwd=src`);
  await expect(tasksPage).toContainText("Codex app-server is unavailable.");
  await emitTaskSync(taskAfterFailure.threadId, detailAfterFailure);
  await expect(tasksPage).toContainText(
    "The stream recovered the failed request.",
  );
  await expect(tasksPage).not.toContainText(
    "The stream arrived before the failed request.",
  );
  await expect(tasksPage).not.toContainText("Codex app-server is unavailable.");

  form = tasksPage.locator(".task-follow-up-form");
  prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Submitted after stream recovery");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    {
      threadId: taskBeforeFailure.threadId,
      prompt: "Submitted after the delayed failure",
    },
    {
      threadId: taskAfterFailure.threadId,
      prompt: "Submitted after stream recovery",
    },
  ]);
});

test("uses a global grouped Tasks master-detail list", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
      }

      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const now = 1_767_300_000_000;
  const taskRecord = (overrides) => ({
    id: overrides.threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: overrides.title,
    preview: `${overrides.title} preview`,
    cwd: overrides.cwd,
    cwdPath: overrides.cwd,
    relativeCwd: overrides.relativeCwd ?? "",
    worktree: overrides.worktree ?? null,
    createdMs: now,
    updatedMs: overrides.updatedMs,
    recencyMs: overrides.updatedMs,
    lastEventSummary: `${overrides.title} summary`,
    ...overrides,
  });
  const mainWorktree = {
    rootPath: "src",
    repositoryRootPath: "src",
    branch: "main",
    headSha: "1111111111111111111111111111111111111111",
    relativeCwd: "",
    linked: false,
  };
  const tasks = [
    taskRecord({
      threadId: "thread_main_root",
      title: "Main root task",
      cwd: "src",
      worktree: mainWorktree,
      updatedMs: now + 300,
    }),
    taskRecord({
      threadId: "thread_main_core",
      title: "Main core task",
      cwd: "src/core",
      relativeCwd: "core",
      worktree: { ...mainWorktree, relativeCwd: "core" },
      updatedMs: now + 200,
    }),
    taskRecord({
      threadId: "thread_feature",
      title: "Feature worktree task",
      cwd: "worktrees/feature",
      ...canonicalTaskState("active", {
        turnId: "turn_feature",
        latestTurnStatus: "inProgress",
      }),
      worktree: {
        rootPath: "worktrees/feature",
        repositoryRootPath: "src",
        branch: "feature/long-worktree-branch-name",
        headSha: "2222222222222222222222222222222222222222",
        relativeCwd: "",
        linked: true,
      },
      updatedMs: now + 400,
    }),
    taskRecord({
      threadId: "thread_docs",
      title: "Documentation directory task with an intentionally long title",
      cwd: "docs",
      ...canonicalTaskState("active", {
        activeFlags: ["waitingOnApproval"],
        latestTurnStatus: "inProgress",
      }),
      updatedMs: now + 100,
    }),
  ];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    });
  });
  await page.route(/\/api\/tasks\/thread_[^/?]+(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const threadId = url.pathname.split("/").at(-1);
    const task = tasks.find((candidate) => candidate.threadId === threadId);
    expect(task).toBeTruthy();
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task,
        events: [
          {
            id: `event_${threadId}`,
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: `${task.title} detail response` },
            createdMs: task.updatedMs,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks?cwd=src");
  await expect(page).toHaveURL("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const listPane = tasksPage.locator(".tasks-list-pane");
  const detailPane = tasksPage.locator(".tasks-detail-pane");
  const resizer = tasksPage.locator(".tasks-master-resizer");
  const rows = tasksPage.locator(".task-row");

  await expect(tasksPage.locator(".task-repository-group")).toHaveCount(2);
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Feature worktree task");
  await expect(rows.nth(1)).toContainText("Main root task");
  await expect(rows.nth(2)).toContainText("Main core task");
  await expect(rows.nth(3)).toContainText(
    "Documentation directory task with an intentionally long title",
  );
  await expect(tasksPage.locator(".task-row-summary")).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"] .task-row-worktree'),
  ).toHaveAttribute("title", /feature\/long-worktree-branch-name/);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_main_root"] .task-row-worktree'),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"] .task-status-spinner'),
  ).toBeVisible();
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"]'),
  ).toHaveAttribute("data-task-status", "running");
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_feature"]'),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_main_root"] .task-row-time'),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-row[data-thread-id="thread_docs"] [data-status="waiting_for_approval"]',
    ),
  ).toBeVisible();
  await expect(tasksPage.locator('.task-row .task-status-label')).toHaveCount(0);
  const rowLayout = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const title = element.querySelector(".task-row-title");
      const indicators = element.querySelector(".task-row-indicators");
      return {
        height: Math.round(element.getBoundingClientRect().height),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        indicatorWidth: Math.round(indicators.getBoundingClientRect().width),
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    }),
  );
  const rowHeights = rowLayout.map(({ height }) => height);
  expect(new Set(rowHeights).size).toBe(1);
  expect(rowHeights[0]).toBeLessThanOrEqual(44);
  expect(new Set(rowLayout.map(({ titleWidth }) => titleWidth)).size).toBe(1);
  expect(new Set(rowLayout.map(({ indicatorWidth }) => indicatorWidth))).toEqual(
    new Set([56]),
  );
  expect(rowLayout.every(({ hasHorizontalOverflow }) => !hasHorizontalOverflow)).toBe(true);
  const longTitleLayout = await tasksPage
    .locator('.task-row[data-thread-id="thread_docs"] .task-row-title')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        isTruncated: element.scrollWidth > element.clientWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
  expect(longTitleLayout.textOverflow).toBe("ellipsis");
  expect(longTitleLayout.whiteSpace).toBe("nowrap");

  if (testInfo.project.name === "desktop") {
    expect(longTitleLayout.isTruncated).toBe(true);
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeVisible();
    await expect(resizer).toBeVisible();
    await expect(tasksPage.locator('textarea[name="prompt"]')).toBeVisible();
    const initialLayout = await tasksPage.evaluate((element) => {
      const list = element.querySelector(".tasks-list-pane").getBoundingClientRect();
      const separator = element
        .querySelector(".tasks-master-resizer")
        .getBoundingClientRect();
      return {
        hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
        listWidth: list.width,
        separatorWidth: separator.width,
      };
    });
    expect(initialLayout.hasHorizontalOverflow).toBe(false);
    expect(Math.round(initialLayout.listWidth)).toBe(380);
    expect(Math.round(initialLayout.separatorWidth)).toBe(6);
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-home-composer");

    const separatorBox = await resizer.boundingBox();
    expect(separatorBox).not.toBeNull();
    await page.mouse.move(
      separatorBox.x + separatorBox.width / 2,
      separatorBox.y + separatorBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 40, separatorBox.y + 20);
    await page.mouse.up();
    await expect(resizer).toHaveAttribute("aria-valuenow", "420");

    await resizer.focus();
    await resizer.press("End");
    await expect(resizer).toHaveAttribute("aria-valuenow", "520");
    await resizer.press("Home");
    await expect(resizer).toHaveAttribute("aria-valuenow", "280");
    await resizer.press("ArrowRight");
    await expect(resizer).toHaveAttribute("aria-valuenow", "296");

    const listScrollBeforeSelection = await tasksPage.evaluate(() => {
      const scroller = document.querySelector("caffold-tasks-page .task-list-scroll");
      scroller.style.height = "90px";
      scroller.scrollTop = 40;
      scroller.querySelector(
        '.task-list-section[data-task-section="managed"] .task-list',
      ).dataset.domProbe = "preserved";
      const row = document.querySelector(
        'caffold-tasks-page .task-row[data-thread-id="thread_main_core"]',
      );
      row.dataset.domProbe = "preserved";
      row.closest("li").dataset.domProbe = "preserved";
      return scroller.scrollTop;
    });
    expect(listScrollBeforeSelection).toBeGreaterThan(0);
    await tasksPage.evaluate(() =>
      document
        .querySelector('caffold-tasks-page .task-row[data-thread-id="thread_main_root"]')
        .click(),
    );
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toContainText("Main root task detail response");
    await expect(
      tasksPage.locator('.task-row[data-thread-id="thread_main_root"]'),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      tasksPage
        .locator('.task-list-section[data-task-section="managed"] .task-list')
        .first(),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect(
      tasksPage.locator('li[data-thread-id="thread_main_core"]'),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect(
      tasksPage.locator('.task-row[data-thread-id="thread_main_core"]'),
    ).toHaveAttribute("data-dom-probe", "preserved");
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(listScrollBeforeSelection);
    await tasksPage.locator(".task-list-scroll").evaluate((element) => {
      element.style.height = "";
    });
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-selected");

    await tasksPage.locator('.task-row[data-thread-id="thread_main_core"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_core");
    await expect(detailPane).toContainText("Main core task detail response");
    await expect(detailPane).not.toContainText("Main root task detail response");

    await tasksPage.locator('.task-row[data-thread-id="thread_main_root"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(detailPane).toContainText("Main root task detail response");
    await expect(detailPane).not.toContainText("Main core task detail response");

    await tasksPage.locator('[data-task-action="open-new"]').first().click();
    await expect(page).toHaveURL("/tasks/new?cwd=src");
    await expect(listPane).toBeVisible();
    await expect(detailPane.locator(".task-new-form")).toBeVisible();
    await expect(resizer).toHaveAttribute("aria-valuenow", "296");
    await captureReviewScreenshot(page, testInfo, "tasks-master-detail-new");
  } else {
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
    await expect(resizer).toBeHidden();
    await tasksPage.locator('.task-row[data-thread-id="thread_main_root"]').click();
    await expect(page).toHaveURL("/tasks/thread_main_root");
    await expect(listPane).toBeHidden();
    await expect(detailPane).toBeVisible();
    await expect(detailPane).toContainText("Main root task detail response");
    await captureReviewScreenshot(page, testInfo, "tasks-single-pane-detail");
    await tasksPage.locator('[data-task-action="open-list"]').click();
    await expect(page).toHaveURL("/tasks");
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeHidden();
  }
});

test("keeps the Tasks list DOM stable while opening a managed task", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_300_000_000;
  const tasks = [
    {
      id: "thread_dom_stability",
      threadId: "thread_dom_stability",
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: "DOM stability task",
      preview: "DOM stability task preview",
      cwd: "src",
      cwdPath: "src",
      relativeCwd: "",
      worktree: null,
      createdMs: now,
      updatedMs: now + 200,
      recencyMs: now + 200,
      lastEventSummary: "DOM stability task summary",
      unseen: true,
    },
    {
      id: "thread_dom_sibling",
      threadId: "thread_dom_sibling",
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: "DOM sibling task",
      preview: "DOM sibling task preview",
      cwd: "src",
      cwdPath: "src",
      relativeCwd: "",
      worktree: null,
      createdMs: now,
      updatedMs: now + 100,
      recencyMs: now + 100,
      lastEventSummary: "DOM sibling task summary",
      unseen: false,
    },
  ];
  let seenRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks, nextCursor: null }),
    }),
  );
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_dom_stability\/seen$/, (route) => {
    seenRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...tasks[0], unseen: false }),
    });
  });
  await page.route(/\/api\/tasks\/thread_dom_stability(?:\?|$)/, async (route) => {
    const task = { ...tasks[0], unseen: false };
    await page.evaluate((updatedTask) => {
      window.__taskListEventSource.emit("task-updated", updatedTask);
    }, task);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        managed: true,
        revision: 1,
        task,
        events: [
          {
            id: "event_dom_stability",
            threadId: task.threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: "DOM stability detail response" },
            createdMs: task.updatedMs,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const target = tasksPage.locator(
    '.task-row[data-thread-id="thread_dom_stability"]',
  );
  await expect(target.locator(".task-unseen-complete")).toBeVisible();
  await tasksPage.evaluate((element) => {
    const row = element.querySelector(
      '.task-row[data-thread-id="thread_dom_stability"]',
    );
    row.dataset.domProbe = "preserved";
    row.closest("li").dataset.domProbe = "preserved";
    window.__taskListDomProbe = {
      scroller: element.querySelector(".task-list-scroll"),
      list: row.closest(".task-list"),
      item: row.closest("li"),
      row,
    };
  });

  await target.click();
  await expect(page).toHaveURL("/tasks/thread_dom_stability");
  await expect(tasksPage.locator(".tasks-detail-pane")).toContainText(
    "DOM stability detail response",
  );

  const result = await tasksPage.evaluate((element) => {
    const row = element.querySelector(
      '.task-row[data-thread-id="thread_dom_stability"]',
    );
    const probe = window.__taskListDomProbe;
    return {
      scrollerPreserved: probe.scroller === element.querySelector(".task-list-scroll"),
      listPreserved: probe.list === row.closest(".task-list"),
      itemPreserved: probe.item === row.closest("li"),
      rowPreserved: probe.row === row,
      itemStatePreserved: row.closest("li").dataset.domProbe,
      rowStatePreserved: row.dataset.domProbe,
      selected: row.getAttribute("aria-current"),
      unseenIndicatorCount: row.querySelectorAll(".task-unseen-complete").length,
    };
  });
  expect({ ...result, seenRequests }).toEqual({
    scrollerPreserved: true,
    listPreserved: true,
    itemPreserved: true,
    rowPreserved: true,
    itemStatePreserved: "preserved",
    rowStatePreserved: "preserved",
    selected: "true",
    unseenIndicatorCount: 0,
    seenRequests: 0,
  });
});

test("groups Tasks by repository without worktree accordions", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        if (url.includes("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);
  const now = 1_767_300_000_000;
  const task = (threadId, title, worktree, updatedMs) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: worktree?.rootPath ?? "notes",
    cwdPath: worktree?.rootPath ?? "notes",
    relativeCwd: "",
    worktree,
    createdMs: now,
    updatedMs,
    recencyMs: updatedMs,
    lastEventSummary: `${title} summary`,
  });
  const tasks = [
    task(
      "thread_gluesql_feature",
      "Feature review",
      {
        rootPath: "worktrees/feature/gluesql",
        repositoryRootPath: "Workspace/rust/gluesql",
        branch: "feature/review",
        headSha: "2222222222222222222222222222222222222222",
        relativeCwd: "",
        linked: true,
      },
      now + 400,
    ),
    task(
      "thread_gluesql_main",
      "Main review",
      {
        rootPath: "Workspace/rust/gluesql",
        repositoryRootPath: "Workspace/rust/gluesql",
        branch: "main",
        headSha: "1111111111111111111111111111111111111111",
        relativeCwd: "",
        linked: false,
      },
      now + 300,
    ),
    task(
      "thread_caffold",
      "Caffold review",
      {
        rootPath: "Workspace/rust/codger",
        repositoryRootPath: "Workspace/rust/codger",
        branch: "main",
        headSha: "3333333333333333333333333333333333333333",
        relativeCwd: "",
        linked: false,
      },
      now + 200,
    ),
    task("thread_notes", "Notes task", null, now + 100),
  ];
  const detailEvents = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_gluesql_feature(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        task: tasks[0],
        events: detailEvents,
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const groups = tasksPage.locator(".task-repository-group");
  await expect(tasksPage.locator(".tasks-header")).toContainText(
    "Caffold Tasks and Codex History",
  );
  await expect(
    tasksPage.locator('.tasks-header [data-task-action="open-settings"] svg'),
  ).toBeVisible();
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator(".task-repository-header")).toContainText("gluesql");
  await expect(groups.nth(0).locator(".task-repository-count")).toHaveText("2");
  await expect(groups.nth(0).locator(".task-row")).toHaveCount(2);
  await expect(groups.nth(1).locator(".task-repository-header")).toContainText("codger");
  await expect(groups.nth(2).locator(".task-repository-header")).toContainText("notes");
  await expect(tasksPage.locator('[data-task-action="toggle-task-group"]')).toHaveCount(0);
  await expect(
    groups.nth(0).locator('.task-row[data-thread-id="thread_gluesql_feature"] .task-row-worktree'),
  ).toHaveAttribute("title", /feature\/review/);
  const featureTask = groups.nth(0).locator(
    '.task-row[data-thread-id="thread_gluesql_feature"]',
  );
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-event", {
      threadId: "thread_gluesql_feature",
      revision: 2,
      event: {
        id: "live-running",
        threadId: "thread_gluesql_feature",
        type: "thread_status_changed",
        payload: { status: "running" },
        createdMs: Date.now(),
      },
    });
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  tasks[0] = {
    ...tasks[0],
    ...canonicalTaskState("active", {
      turnId: "turn_elsewhere",
      startedAtMs: now + 500,
      latestTurnStatus: "inProgress",
    }),
  };
  await page.evaluate((detail) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: 3,
      detail,
      reason: "canonical-running",
    });
  }, {
    threadId: "thread_gluesql_feature",
    syncState: "ready",
    task: tasks[0],
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "running");
  await expect(featureTask.locator(".task-status-spinner")).toBeVisible();
  detailEvents.push(
    {
      id: "external-user",
      threadId: "thread_gluesql_feature",
      type: "user_message",
      summary: "User prompt",
      payload: { text: "Continue this task from Codex desktop" },
      createdMs: now + 500,
    },
    {
      id: "external-reasoning",
      threadId: "thread_gluesql_feature",
      type: "reasoning",
      summary: "Reasoning",
      payload: { lifecycle: "started", summary: [], content: [] },
      createdMs: now + 750,
    },
  );
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-event", {
      threadId: "thread_gluesql_feature",
      revision: 4,
      event: {
        id: "live-idle",
        threadId: "thread_gluesql_feature",
        type: "thread_status_changed",
        payload: { status: "idle" },
        createdMs: Date.now(),
      },
    });
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "running");
  const idleTask = {
    ...tasks[0],
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    unseen: true,
  };
  await page.evaluate((detail) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId: detail.threadId,
      revision: 5,
      detail,
      reason: "canonical-idle",
    });
  }, {
    threadId: "thread_gluesql_feature",
    syncState: "ready",
    task: idleTask,
  });
  await expect(featureTask).toHaveAttribute("data-task-status", "idle");
  await expect(featureTask.locator(".task-status-spinner")).toHaveCount(0);
  await expect(featureTask.locator(".task-unseen-complete")).toBeVisible();
  await expect(featureTask.locator(".task-row-time")).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "tasks-completed-unseen");
  await featureTask.click();
  await expect(page).toHaveURL(/\/tasks\/thread_gluesql_feature$/);
  const externalActiveTurn = tasksPage.locator(
    '.task-turn-active[data-turn-id="implicit-0"]',
  );
  await expect(externalActiveTurn).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toHaveCount(1);
  await expect(externalActiveTurn.locator(".task-turn-active-state")).toHaveText(
    "Thinking",
  );
  await expect(featureTask.locator(".task-unseen-complete")).toHaveCount(0);
  await page.goto("/tasks");
  await expect(
    tasksPage.locator(
      '.task-row[data-thread-id="thread_gluesql_feature"] .task-unseen-complete',
    ),
  ).toHaveCount(0);
  await expect(tasksPage.locator('.task-row .task-status-label')).toHaveCount(0);
  await expect(tasksPage.locator(".task-row-summary")).toHaveCount(0);
  const treeLayout = await groups.nth(0).evaluate((group) => {
    const scroller = group.closest(".task-list-scroll");
    const header = group.querySelector(".task-repository-header");
    const headerIcon = header.querySelector(".task-repository-icon");
    const headerLabel = header.querySelector(".task-repository-label");
    const row = group.querySelector(".task-row");
    const rowTitle = row.querySelector(".task-row-title");
    return {
      bottomPadding: Number.parseFloat(getComputedStyle(scroller).paddingBottom),
      headerBackground: getComputedStyle(header).backgroundColor,
      rowBorderBottom: getComputedStyle(row).borderBottomWidth,
      rowTitleOffset: Math.round(
        rowTitle.getBoundingClientRect().left - headerLabel.getBoundingClientRect().left,
      ),
      titleIsIndentedPastIcon:
        rowTitle.getBoundingClientRect().left > headerIcon.getBoundingClientRect().left,
    };
  });
  expect(treeLayout.bottomPadding).toBeGreaterThanOrEqual(20);
  expect(treeLayout.headerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(treeLayout.rowBorderBottom).toBe("0px");
  expect(Math.abs(treeLayout.rowTitleOffset)).toBeLessThanOrEqual(4);
  expect(treeLayout.titleIsIndentedPastIcon).toBe(true);
  const secondGroupGap = await groups.nth(1).evaluate((group) =>
    Number.parseFloat(getComputedStyle(group).marginTop),
  );
  expect(secondGroupGap).toBeGreaterThanOrEqual(6);
  if (testInfo.project.name === "phone") {
    const newTaskButton = tasksPage.locator(
      '.tasks-header [data-task-action="open-new"]',
    );
    await expect(newTaskButton).toContainText("New Task");
    await expect
      .poll(() =>
        newTaskButton.evaluate((element) => element.getBoundingClientRect().width > 32),
      )
      .toBe(true);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-all-repository-groups");
  await page.evaluate(() => {
    window.__taskListEventSource.emit("task-removed", {
      threadId: "thread_notes",
      reason: "archived",
    });
  });
  await expect(
    tasksPage.locator('.task-row[data-thread-id="thread_notes"]'),
  ).toHaveCount(0);
  await expect(groups).toHaveCount(2);
  await expect(
    tasksPage.locator('.task-repository-group[data-task-repository-key="directory:notes"]'),
  ).toHaveCount(0);
});

test("continues a Codex History thread into Caffold Tasks", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}
      close() {}
    };
  });
  await mockCodexModels(page);
  const task = {
    id: "thread_history_continue",
    threadId: "thread_history_continue",
    ...canonicalTaskState("idle"),
    title: "History task",
    preview: "History metadata only",
    cwd: "/tmp/project",
    cwdPath: "tmp/project",
    relativeCwd: "tmp/project",
    worktree: null,
    createdMs: 10,
    updatedMs: 20,
    recencyMs: 20,
    lastEventSummary: "History metadata only",
    unseen: false,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_history_continue\/continue$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(task) }),
  );
  await page.route(/\/api\/tasks\/thread_history_continue(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        managed: true,
        revision: 1,
        task,
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
        historyLoading: false,
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_history_continue\/seen$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(task) }),
  );

  await page.goto("/tasks");
  const tasksPage = page.locator("caffold-tasks-page");
  const managed = tasksPage.locator('[data-task-section="managed"]');
  const history = tasksPage.locator('[data-task-section="history"]');
  await expect(managed.locator('li[data-thread-id="thread_history_continue"]')).toHaveCount(0);
  await expect(history.locator('li[data-thread-id="thread_history_continue"]')).toHaveCount(1);

  await history
    .locator('[data-thread-id="thread_history_continue"] [data-task-action="continue-history-task"]')
    .click();

  await expect(page).toHaveURL("/tasks/thread_history_continue");
  await expect(managed.locator('li[data-thread-id="thread_history_continue"]')).toHaveCount(1);
  await expect(history.locator('li[data-thread-id="thread_history_continue"]')).toHaveCount(0);
  await expect(tasksPage.locator(".tasks-detail-region")).toContainText("History task");
});

test("opens Tasks from Codex header and runs a minimal task loop", async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve(),
      },
    });
    window.__caffoldMockEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__caffoldMockEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });

  const contextPath = "src";
  await mockCodexModels(page);
  const now = 1_767_000_000_000;
  let task = null;
  let events = [];
  let createTaskRequests = 0;
  let followUpRequests = 0;
  let taskDetailReadRequests = 0;
  let approvalRequests = 0;
  let gitStatusRequests = 0;
  let gitRefsRequests = 0;
  let gitCompareRequests = 0;
  let gitCompareDiffRequests = 0;
  let includeTaskDiffLiveFile = false;
  let omitCompletedCommandFromDetail = false;
  let resolveFollowUpRequest;
  let releaseFollowUpResponse;
  let resolveCanonicalFollowUpRequest;
  let releaseCanonicalFollowUpResponse;
  const followUpRequested = new Promise((resolve) => {
    resolveFollowUpRequest = resolve;
  });
  const followUpResponseReleased = new Promise((resolve) => {
    releaseFollowUpResponse = resolve;
  });
  const canonicalFollowUpRequested = new Promise((resolve) => {
    resolveCanonicalFollowUpRequest = resolve;
  });
  const canonicalFollowUpResponseReleased = new Promise((resolve) => {
    releaseCanonicalFollowUpResponse = resolve;
  });
  const threadId = "thread_12345678";
  const completedAssistantResponse = [
    "## Review ready",
    "",
    "The planner changes are **ready** to review. Open `Diff` next.",
    "",
    "- Verified planner behavior",
    "- Confirmed fixture coverage",
    "",
    "```text",
    "cargo test",
    "```",
    "",
    "한국어와 English가 함께 있는 결과입니다. [Planner notes](https://example.com/planner)",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Planner | Pass |",
    "",
    `Long token: ${"planner".repeat(24)}`,
    "",
    "Malformed **marker stays readable.",
    "",
    ...Array.from(
      { length: 36 },
      (_, index) =>
        `Review note ${index + 1}: verified planner behavior and fixture coverage.`,
    ),
  ].join("\n");

  const eventRecord = (id, type, summary, payload = null, offset = 0) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const detailResponse = (overrides = {}) => ({
    threadId,
    syncState: "ready",
    revision: overrides.revision ?? 1,
    task: overrides.task ?? task,
    events: overrides.events ?? events,
    eventsPage: { nextCursor: null, ...(overrides.eventsPage ?? {}) },
    pendingApprovals: [],
  });
  const updateTask = (updates) => {
    task = {
      ...task,
      ...updates,
      updatedMs: now + events.length + 1,
      lastEventSummary: updates.lastEventSummary ?? task.lastEventSummary,
    };
  };

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) => {
    gitStatusRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        additions: includeTaskDiffLiveFile ? 6 : 5,
        deletions: 4,
        files: [
          {
            path: "src/planner.rs",
            repoRelativePath: "planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/tests/planner.rs",
            repoRelativePath: "tests/planner.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/lib.rs",
            repoRelativePath: "lib.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          {
            path: "src/unrelated.rs",
            repoRelativePath: "unrelated.rs",
            status: " M",
            category: "unstaged",
            staged: false,
            unstaged: true,
            untracked: false,
          },
          ...(includeTaskDiffLiveFile
            ? [
                {
                  path: "src/live-update.rs",
                  repoRelativePath: "live-update.rs",
                  status: "??",
                  category: "untracked",
                  staged: false,
                  unstaged: false,
                  untracked: true,
                },
              ]
            : []),
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/diff(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: url.searchParams.get("kind"),
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          "index 1111111..2222222 100644",
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old planner behavior",
          "+new planner behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) => {
    gitRefsRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
          { name: "origin/release", kind: "remote" },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      }),
    });
  });
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) => {
    gitCompareRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const baseRef = url.searchParams.get("base");
    const path = baseRef === "origin/release" ? "src/release.rs" : "src/planner.rs";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        baseRef,
        headRef: "main",
        additions: baseRef === "origin/release" ? 7 : 3,
        deletions: baseRef === "origin/release" ? 2 : 1,
        files: [
          {
            path,
            repoRelativePath: path.replace(/^src\//, ""),
            status: baseRef === "origin/release" ? "A" : "M",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/git\/compare-diff(?:\?|$)/, (route) => {
    gitCompareDiffRequests += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("src");
    expect(url.searchParams.get("head")).toBe("main");
    const file = url.searchParams.get("file");
    const relativePath = file.replace(/^src\//, "");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: true },
        path: file,
        repoRelativePath: relativePath,
        kind: `${url.searchParams.get("base")}...main`,
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          "@@ -1 +1 @@",
          "-old branch behavior",
          "+new branch behavior",
        ].join("\n"),
      }),
    });
  });
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/task-image(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("path")).toBe("/tmp/planner-layout.png");
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.route("**/api/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const method = request.method();

    if (segments.length === 2 && method === "GET") {
      expect(url.searchParams.get("cwd")).toBeNull();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tasks: task ? [task] : [] }),
      });
    }

    if (segments.length === 2 && method === "POST") {
      createTaskRequests += 1;
      const body = request.postDataJSON();
      expect(body.cwd).toBe(contextPath);
      expect(body.prompt).toBe("Inspect the planner changes");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("xhigh");
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      task = {
        id: threadId,
        threadId,
        ...canonicalTaskState("active", {
          activeFlags: ["waitingOnApproval"],
          turnId: "turn_1",
          latestTurnStatus: "inProgress",
        }),
        title: "Inspect the planner changes",
        preview: "Inspect the planner changes",
        cwd: "src",
        cwdPath: "src",
        relativeCwd: "",
        worktree: {
          rootPath: "src",
          branch: "main",
          headSha: "0123456789abcdef0123456789abcdef01234567",
          relativeCwd: "",
          linked: false,
        },
        createdMs: now,
        updatedMs: now + 4,
        recencyMs: now + 4,
        lastEventSummary: "Command approval requested",
      };
      events = [
        eventRecord("event_1", "prompt_sent", "Prompt sent", { prompt: body.prompt }, 1),
        eventRecord(
          "event_1_user",
          "user_message",
          "User prompt",
          {
            prompt: "",
            text: [
              "# Files mentioned by the user:",
              "",
              "## planner-layout.png: /tmp/planner-layout.png",
              "",
              "## My request for Codex:",
              body.prompt,
            ].join("\n"),
            turnId: "turn_1",
            item: {
              content: [
                {
                  type: "text",
                  text: body.prompt,
                },
                {
                  type: "image",
                  url: body.images[0],
                  name: "planner-layout.png",
                },
                {
                  type: "localImage",
                  path: "/tmp/planner-layout.png",
                  name: "server-reference.png",
                },
              ],
            },
          },
          2,
        ),
        eventRecord(
          "event_2",
          "thread_started",
          "Thread started",
          { threadId: "thread_12345678" },
          3,
        ),
        eventRecord("event_3", "turn_started", "Turn started", { turnId: "turn_1" }, 4),
        eventRecord(
          "event_4",
          "approval_requested",
          "Command approval requested",
          {
            approvalId: "approval_1",
            kind: "command",
            method: "item/commandExecution/requestApproval",
            params: {
              command: "cargo test",
              cwd: "src",
              reason: "Run the test suite",
              availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
            },
          },
          5,
        ),
      ];

      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (segments.length === 3 && segments[2] === threadId && method === "GET") {
      taskDetailReadRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          detailResponse({
            events: omitCompletedCommandFromDetail
              ? events.filter((event) => event.type !== "command_execution")
              : events,
          }),
        ),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "prompts" &&
      method === "POST"
    ) {
      const body = request.postDataJSON();
      followUpRequests += 1;
      if (body.prompt === "Prompt that fails") {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Prompt request failed" }),
        });
      }
      if (body.prompt === "한글 버튼 제출") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: `turn_${followUpRequests}`,
            steered: body.activeTurnId !== null,
          }),
        });
      }
      if (body.prompt === "Canonical sync unlocks composer") {
        resolveCanonicalFollowUpRequest();
        await canonicalFollowUpResponseReleased;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_canonical_ack",
            steered: false,
          }),
        });
      }
      if (body.prompt === "Enter after canonical sync") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            threadId,
            turnId: "turn_after_canonical_ack",
            steered: false,
          }),
        });
      }
      expect(body.prompt).toBe("Please tighten the tests");
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.effort).toBe("ultra");
      expect(body.activeTurnId).toBeNull();
      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatch(/^data:image\/png;base64,/);
      resolveFollowUpRequest();
      await followUpResponseReleased;
      events = [
        ...events,
        eventRecord(
          "event_6",
          "prompt_sent",
          "Follow-up prompt sent",
          { prompt: body.prompt },
          13,
        ),
        eventRecord(
          "event_6_user",
          "user_message",
          "User prompt",
          {
            text: body.prompt,
            turnId: "turn_2",
            item: {
              content: [
                { type: "text", text: body.prompt },
                { type: "image", url: body.images[0], name: "follow-up.png" },
              ],
            },
          },
          14,
        ),
        eventRecord(
          "event_6_turn",
          "turn_started",
          "Turn started",
          { turnId: "turn_2" },
          15,
        ),
        eventRecord(
          "command_follow_up",
          "command_execution",
          "Command inProgress",
          {
            turnId: "turn_2",
            itemId: "command_follow_up",
            lifecycle: "started",
            command: "cargo test --workspace",
            cwd: "src",
            status: "inProgress",
          },
          16,
        ),
      ];
      updateTask({
        ...canonicalTaskState("active", {
          turnId: "turn_2",
          latestTurnStatus: "inProgress",
        }),
        lastEventSummary: "Command inProgress",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn_2",
          steered: false,
        }),
      });
    }

    if (
      segments.length === 4 &&
      segments[2] === threadId &&
      segments[3] === "interrupt" &&
      method === "POST"
    ) {
      events = [
        ...events,
        eventRecord("event_7", "turn_interrupted", "Interrupt requested", null, 17),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
        lastEventSummary: "Interrupt requested",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    if (
      segments.length === 5 &&
      segments[2] === threadId &&
      segments[3] === "approvals" &&
      segments[4] === "approval_1" &&
      method === "POST"
    ) {
      approvalRequests += 1;
      const body = request.postDataJSON();
      expect(body.decision).toBe("accept");
      events = [
        ...events,
        eventRecord(
          "event_5",
          "approval_resolved",
          "Approval resolved: accept",
          { approvalId: "approval_1", decision: "accept", turnId: "turn_1" },
          5,
        ),
        eventRecord(
          "item-9",
          "assistant_message",
          "Assistant response",
          {
            phase: "commentary",
            text: "I am checking the planner diff before the final answer.",
          },
          11,
        ),
        eventRecord(
          "event_8",
          "reasoning",
          "Reasoning summary",
          {
            summary: ["Checked the planner diff.", "Confirmed the fixture coverage path."],
          },
          8,
        ),
        eventRecord(
          "event_9",
          "plan",
          "Plan updated",
          {
            text: "1. Inspect planner behavior\n2. Run focused tests",
          },
          9,
        ),
        eventRecord(
          "event_9_command_live",
          "command_execution",
          "Command started",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "inProgress",
          },
          9,
        ),
        eventRecord(
          "event_9_command",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
            aggregatedOutput:
              "test result: ok. 12 passed.\n" +
              "command-output-with-an-intentionally-long-unbroken-token-".repeat(18),
          },
          9,
        ),
        eventRecord(
          "event_10",
          "file_change",
          "File changes: 2",
          {
            status: "completed",
            changeCount: 2,
            changes: [{ path: "src/planner.rs" }, { path: "tests/planner.rs" }],
          },
          10,
        ),
        eventRecord(
          "event_9_command_completed",
          "command_execution",
          "Command completed",
          {
            turnId: "turn_1",
            itemId: "command_1",
            command: "cargo test",
            cwd: "src",
            status: "completed",
          },
          11,
        ),
        eventRecord(
          "event_10_repeat",
          "file_change",
          "File changes: 1",
          {
            status: "completed",
            changeCount: 1,
            changes: [{ path: "src/lib.rs" }],
          },
          10,
        ),
        eventRecord(
          "item-10",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_11_duplicate",
          "assistant_message",
          "Assistant response",
          {
            turnId: "turn_1",
            phase: "final",
            text: completedAssistantResponse,
          },
          11,
        ),
        eventRecord(
          "event_12",
          "turn_completed",
          "Turn completed",
          { turnId: "turn_1", status: "completed" },
          12,
        ),
      ];
      updateTask({
        ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
        lastEventSummary: "Turn completed",
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(detailResponse()),
      });
    }

    return route.continue();
  });

  await page.goto(`/files?cwd=${encodeURIComponent(contextPath)}`);
  const codexPopover = await openHeaderActionGroup(page, "codex");
  await codexPopover.locator('button[data-action="open-tasks"]').click();
  await expect(page).toHaveURL("/tasks");
  const codexWorkspace = page.locator("caffold-codex-workspace");
  await expect(codexWorkspace).toBeVisible();
  await expect
    .poll(() =>
      codexWorkspace.evaluate((element) => element.parentElement?.tagName.toLowerCase()),
    )
    .toBe("caffold-app-shell");
  const appShellBox = await page.locator("caffold-app-shell").boundingBox();
  const codexWorkspaceBox = await codexWorkspace.boundingBox();
  expect(Math.round(codexWorkspaceBox?.y ?? -1)).toBe(Math.round(appShellBox?.y ?? -2));
  expect(Math.round(codexWorkspaceBox?.height ?? -1)).toBe(
    Math.round(appShellBox?.height ?? -2),
  );
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "list",
  );
  await expect(page.locator("caffold-tasks-page")).toContainText("No Caffold tasks yet.");

  await page
    .locator("caffold-tasks-page .tasks-empty")
    .getByRole("button", { name: "New Task", exact: true })
    .click();
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(contextPath)}`);
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute(
    "data-tasks-view",
    "new",
  );
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-new"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('caffold-tasks-page .tasks-header [data-task-action="open-list"]'),
  ).toHaveCount(0);
  await expect(page.locator("caffold-tasks-page .tasks-header h1")).toHaveText(
    "New Task",
  );
  const newTaskHeaderMetrics = await page.evaluate(() => {
    const closeButton = document
      .querySelector("caffold-codex-workspace .codex-workspace-close")
      .getBoundingClientRect();
    const title = document
      .querySelector("caffold-tasks-page .tasks-header h1")
      .getBoundingClientRect();
    return {
      closeRight: closeButton.right,
      titleLeft: title.left,
    };
  });
  expect(newTaskHeaderMetrics.titleLeft).toBeGreaterThanOrEqual(
    newTaskHeaderMetrics.closeRight + 8,
  );
  const newTaskComposer = page.locator("caffold-tasks-page .task-new-form");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("GPT-5.6-Sol");
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Light");
  await newTaskComposer.locator(".task-model-button").click();
  const modelPopover = page.locator("caffold-tasks-page .task-model-popover");
  await expect(modelPopover).toBeVisible();
  const modelPopoverMetrics = await newTaskComposer.evaluate((form) => {
    const button = form.querySelector(".task-model-button").getBoundingClientRect();
    const panel = form.querySelector(".task-composer-panel").getBoundingClientRect();
    const popover = form.querySelector(".task-model-popover").getBoundingClientRect();
    const firstDescription = form.querySelector(".task-model-option small");
    const descriptionStyle = firstDescription
      ? window.getComputedStyle(firstDescription)
      : null;
    return {
      buttonBottom: button.bottom,
      buttonLeft: button.left,
      panelBottom: panel.bottom,
      panelLeft: panel.left,
      panelRight: panel.right,
      backdropVisible: Boolean(
        form.querySelector(".task-model-backdrop") &&
          window.getComputedStyle(form.querySelector(".task-model-backdrop")).display !==
            "none",
      ),
      popoverBottom: popover.bottom,
      popoverLeft: popover.left,
      popoverRight: popover.right,
      popoverTop: popover.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      descriptionWhiteSpace: descriptionStyle?.whiteSpace ?? "",
    };
  });
  expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportWidth - 9,
  );
  expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(9);
  expect(modelPopoverMetrics.popoverBottom).toBeLessThanOrEqual(
    modelPopoverMetrics.viewportHeight - 9,
  );
  expect(modelPopoverMetrics.descriptionWhiteSpace).not.toBe("nowrap");
  if (testInfo.project.name !== "phone") {
    expect(modelPopoverMetrics.backdropVisible).toBe(false);
    expect(
      Math.abs(modelPopoverMetrics.popoverLeft - modelPopoverMetrics.buttonLeft),
    ).toBeLessThanOrEqual(2);
    expect(modelPopoverMetrics.popoverTop).toBeGreaterThanOrEqual(
      modelPopoverMetrics.buttonBottom + 6,
    );
    expect(
      modelPopoverMetrics.popoverTop - modelPopoverMetrics.buttonBottom,
    ).toBeLessThanOrEqual(14);
  } else {
    expect(modelPopoverMetrics.backdropVisible).toBe(true);
    expect(modelPopoverMetrics.popoverLeft).toBeGreaterThanOrEqual(9);
    expect(modelPopoverMetrics.popoverRight).toBeLessThanOrEqual(
      modelPopoverMetrics.viewportWidth - 9,
    );
    expect(
      modelPopoverMetrics.viewportHeight - modelPopoverMetrics.popoverBottom,
    ).toBeLessThanOrEqual(14);
    await newTaskComposer.locator(".task-model-backdrop").click({
      position: { x: 8, y: 8 },
    });
    await expect(modelPopover).toBeHidden();
    await newTaskComposer.locator(".task-model-button").click();
    await expect(modelPopover).toBeVisible();
  }
  await captureReviewScreenshot(page, testInfo, "tasks-model-popover");
  await expect(modelPopover.locator('[data-effort="xhigh"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="max"]')).toBeVisible();
  await expect(modelPopover.locator('[data-effort="ultra"]')).toBeVisible();
  await modelPopover.locator('[data-effort="xhigh"]').click();
  await expect(newTaskComposer.locator(".task-model-button")).toContainText("Extra High");
  const newPromptTextarea = newTaskComposer.locator('textarea[name="prompt"]');
  const initialTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      rows: textarea.getAttribute("rows"),
    };
  });
  expect(initialTextareaMetrics.rows).toBe("2");

  await newPromptTextarea.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const expandedTextareaMetrics = await newPromptTextarea.evaluate((textarea) => {
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    return {
      clientHeight: textarea.clientHeight,
      height: textarea.getBoundingClientRect().height,
      maxHeight: lineHeight * 10.5 + padding,
      overflowY: styles.overflowY,
      scrollHeight: textarea.scrollHeight,
    };
  });
  expect(expandedTextareaMetrics.height).toBeGreaterThan(
    initialTextareaMetrics.height + 20,
  );
  expect(expandedTextareaMetrics.height).toBeLessThanOrEqual(
    expandedTextareaMetrics.maxHeight + 2,
  );
  expect(expandedTextareaMetrics.scrollHeight).toBeGreaterThan(
    expandedTextareaMetrics.clientHeight,
  );
  expect(expandedTextareaMetrics.overflowY).toBe("auto");

  await newPromptTextarea.fill("Inspect the planner changes");
  await pasteImage(newPromptTextarea, "planner-layout.png");
  const newTaskAttachment = page.locator(
    'form[data-task-form="create"] .task-composer-attachment',
  );
  await expect(newTaskAttachment).toHaveCount(1);
  await expect(newTaskAttachment.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await newTaskAttachment.getByRole("button", { name: "Remove planner-layout.png" }).click();
  await expect(newTaskAttachment).toHaveCount(0);
  await pasteImage(newPromptTextarea, "planner-layout.png");
  await expect(newTaskAttachment).toHaveCount(1);
  const newTaskFormState = await page.locator("caffold-tasks-page").evaluate((element) => {
    const form = element.querySelector('form[data-task-form="create"]');
    return {
      data: Object.fromEntries(new FormData(form).entries()),
      valid: form.checkValidity(),
    };
  });
  expect(newTaskFormState).toEqual({
    data: {
      effort: "xhigh",
      model: "gpt-5.6-sol",
      permissionMode: "approveForMe",
      prompt: "Inspect the planner changes",
    },
    valid: true,
  });
  await page.locator('caffold-tasks-page textarea[name="prompt"]').press("Enter");

  await expect.poll(() => createTaskRequests).toBe(1);
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toHaveCount(1);
  await expect(tasksPage).toHaveAttribute("data-tasks-view", "detail");
  await expect(tasksPage).toContainText("Inspect the planner changes");
  await expect(tasksPage).toContainText("Thread thread_1");
  await expect(tasksPage.locator(".task-detail-meta")).toContainText("main · src");
  await expect(tasksPage.locator(".task-conversation")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary h2")).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(tasksPage.locator(".task-detail-meta")).toHaveCSS("font-size", "12px");
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).toContainText(
    "Inspect the planner changes",
  );
  const userAttachments = tasksPage.locator(".task-message-attachment");
  await expect(userAttachments).toHaveCount(2);
  await expect(userAttachments.nth(0).locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(userAttachments.nth(0).locator("figcaption")).toContainText(
    "planner-layout.png",
  );
  await expect(userAttachments.nth(1).locator("img")).toBeVisible();
  await expect(userAttachments.nth(1).locator("img")).toHaveAttribute(
    "src",
    /\/api\/task-image\?path=%2Ftmp%2Fplanner-layout\.png$/,
  );
  await expect(userAttachments.nth(1).locator("figcaption")).toContainText(
    "server-reference.png",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "Files mentioned by the user",
  );
  await expect(tasksPage.locator('.task-message[data-message-role="user"]')).not.toContainText(
    "/tmp/planner-layout.png",
  );
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"] .task-message-content'),
  ).toHaveCSS("font-size", "15px");
  await expect(tasksPage).toContainText("Command Approval");
  await expect(tasksPage).toContainText("cargo test");
  await expect(tasksPage).toContainText("Run the test suite");
  await expect(tasksPage.locator(".task-conversation .task-approval-flow")).toHaveCount(1);
  await expect(tasksPage.locator(".task-turn-active-state")).toHaveText(
    "Waiting for approval",
  );
  await expect
    .poll(() => tasksPage.evaluate((element) => element.selectedThreadId))
    .toBe(threadId);
  await expect
    .poll(() =>
      tasksPage
        .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
        .evaluate((button) => ({
          action: button.dataset.taskAction,
          approvalId: button.dataset.approvalId,
          decision: button.dataset.decision,
        })),
    )
    .toEqual({ action: "approval", approvalId: "approval_1", decision: "accept" });

  await tasksPage
    .locator('.task-approval-card button[data-task-action="approval"][data-decision="accept"]')
    .click();
  expect(pageErrors).toEqual([]);
  await expect.poll(() => approvalRequests).toBe(1);
  await expect(tasksPage).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.evaluate((element) =>
        element
          .querySelector("caffold-task-detail")
          .events.map((event) => event.type),
      ),
    )
    .toContain("approval_resolved");
  await expect(tasksPage.locator(".task-conversation .task-approval-flow")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toContainText(
    "The planner changes are ready to review.",
  );
  const assistantMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"] caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("h2")).toHaveText("Review ready");
  await expect(assistantMarkdown.locator("strong")).toHaveText("ready");
  await expect(assistantMarkdown.locator("li")).toHaveCount(2);
  await expect(assistantMarkdown.locator("pre code")).toHaveText("cargo test");
  await expect(assistantMarkdown.getByRole("link", { name: "Planner notes" })).toHaveAttribute(
    "href",
    "https://example.com/planner",
  );
  await expect(assistantMarkdown.locator("table")).toContainText("Planner");
  await expect(assistantMarkdown).toContainText("Malformed **marker stays readable.");
  await expect
    .poll(() =>
      assistantMarkdown.evaluate((element) => {
        const body = element.shadowRoot.querySelector(".markdown-body");
        return body.scrollWidth <= body.clientWidth;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(() => {
        const probe = document.createElement("caffold-task-markdown");
        probe.textContent = "Fallback content";
        document.body.append(probe);
        const fallback = probe.shadowRoot.querySelector(".markdown-fallback");
        const style = getComputedStyle(fallback);
        const result = {
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderWidth,
          margin: style.margin,
          padding: style.padding,
        };
        probe.remove();
        return result;
      }),
    )
    .toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      margin: "0px",
      padding: "0px",
    });
  await tasksPage.evaluate(() => {
    const probe = document.createElement("caffold-task-markdown");
    probe.hidden = true;
    probe.textContent = "[unsafe](javascript:alert(1))";
    document.body.append(probe);
  });
  await expect(page.locator("caffold-task-markdown").last()).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(page.locator("caffold-task-markdown").last().locator("a")).toHaveCount(0);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-message[data-message-role="assistant"][data-message-phase="final"]',
    ),
  ).toHaveCount(1);
  await expect(tasksPage.locator('.task-message[data-message-role="assistant"]')).not.toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator(".task-turn-work")).toContainText("Worked for");
  await expect(tasksPage.locator(".task-turn-work")).toContainText("6 updates");
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const work = element.querySelector(".task-turn-work");
        const assistant = element.querySelector('.task-message[data-message-role="assistant"]');
        const position = work && assistant ? work.compareDocumentPosition(assistant) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-work-item")).toHaveCount(6);
  await expect(tasksPage.locator(".task-work-item").first()).not.toBeVisible();
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(tasksPage.locator('.task-work-item[data-event-type="assistant_message"]')).toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="plan"]')).toContainText(
    "Run focused tests",
  );
  const completedCommand = tasksPage.locator(
    '.task-work-item[data-event-type="command_execution"]',
  );
  await expect(tasksPage.locator(".task-turn-work").last()).toContainText("Command");
  await expect(completedCommand.locator("details")).not.toHaveAttribute("open", "");
  await completedCommand.locator("summary").click();
  await expect(completedCommand).toContainText("cargo test");
  await expect(completedCommand).toContainText("cwd: src");
  await expect(completedCommand).toContainText("completed");
  await expect(completedCommand).toContainText(
    "test result: ok",
  );
  const completedCommandOutput = completedCommand.locator("pre");
  await expect
    .poll(() =>
      completedCommandOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const workItemOrder = await tasksPage.locator(".task-work-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-event-type")),
  );
  expect(workItemOrder).toEqual([
    "approval_resolved",
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "assistant_message",
  ]);
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator(".task-turn-work > details > summary").click();
  await expect(tasksPage.locator(".task-turn-work > details")).not.toHaveAttribute("open", "");
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  await expect(tasksPage.locator(".task-follow-up-form")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(tasksPage).not.toContainText("assistant message");
  await expect(tasksPage).not.toContainText("user message");
  await expect(tasksPage).not.toContainText("turn started");
  const taskDetailsButton = tasksPage.getByRole("button", { name: /Task details/ });
  await expect(taskDetailsButton).toBeVisible();
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: idle");
  await taskDetailsButton.click();
  const taskDetailsPopover = tasksPage.locator(".task-detail-popover");
  await expect(taskDetailsPopover).toBeVisible();
  await expect(taskDetailsPopover).toContainText("idle");
  await expect(taskDetailsPopover).toContainText(threadId);
  await expect(taskDetailsPopover).toContainText("src");
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  if (testInfo.project.name === "phone") {
    const mobileHeaderMetrics = await tasksPage.evaluate((element) => {
      const header = element.querySelector(".tasks-header").getBoundingClientRect();
      const summary = element.querySelector(".task-detail-summary").getBoundingClientRect();
      const actions = [
        ...element.querySelectorAll(
          ".task-detail-actions > button, .task-detail-actions > details > summary",
        ),
      ].map((control) => control.getBoundingClientRect());
      const details = element
        .querySelector(".task-detail-info-button")
        .getBoundingClientRect();
      return {
        headerHeight: header.height,
        summaryHeight: summary.height,
        overflow: element.scrollWidth > element.clientWidth,
        actionSizes: [...actions, details].map((box) => ({
          height: box.height,
          width: box.width,
        })),
      };
    });
    expect(mobileHeaderMetrics.headerHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.summaryHeight).toBeLessThanOrEqual(50);
    expect(mobileHeaderMetrics.overflow).toBe(false);
    for (const size of mobileHeaderMetrics.actionSizes) {
      expect(Math.round(size.width)).toBe(32);
      expect(Math.round(size.height)).toBe(32);
    }
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
  const conversationScroller = tasksPage.locator(".task-conversation-scroll");
  const conversationBeforeFiles = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeFiles.maxScrollTop).toBeGreaterThan(0);
  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-persist-probe", "kept"));
  const taskMasterStateBeforeTools =
    testInfo.project.name === "desktop"
      ? await tasksPage.evaluate((element) => {
          const separator = element.querySelector(".tasks-master-resizer");
          separator.focus();
          separator.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
          );
          const listScroll = element.querySelector(".task-list-scroll");
          const listRegion = element.querySelector(".tasks-list-region");
          listScroll.style.height = "90px";
          listRegion.style.minHeight = "240px";
          listScroll.scrollTop = 40;
          return {
            listWidth: Math.round(
              element.querySelector(".tasks-list-pane").getBoundingClientRect().width,
            ),
            listScrollTop: listScroll.scrollTop,
          };
        })
      : null;

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  const taskFilesView = tasksPage.locator(".task-files-view");
  await expect(taskFilesView).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeHidden();
  await expect(tasksPage.locator(".task-detail-summary")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskFilesLayout = await page.evaluate(() => {
    const codex = document.querySelector("caffold-codex-workspace");
    const appHeader = document.querySelector("caffold-app-shell .app-header");
    const pathbar = document.querySelector("caffold-pathbar");
    const filesHeader = document.querySelector(".task-files-header");
    const filesView = document.querySelector(".task-files-view");
    const filesTitle = document.querySelector(".task-files-header h3");
    const browser = document.querySelector(".task-files-view caffold-file-browser");
    const fileList = document.querySelector(".task-files-view caffold-file-list");

    const coveredByCodex = (element) => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        inCodex: Boolean(topElement?.closest("caffold-codex-workspace")),
        inSelf: topElement === element || element.contains(topElement),
      };
    };

    const codexRect = codex.getBoundingClientRect();
    const filesHeaderRect = filesHeader.getBoundingClientRect();
    const filesViewRect = filesView.getBoundingClientRect();
    const browserRect = browser.getBoundingClientRect();
    const fileListRect = fileList.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      appHeaderCoveredByCodex:
        coveredByCodex(appHeader).inCodex && !coveredByCodex(appHeader).inSelf,
      pathbarCoveredByCodex:
        coveredByCodex(pathbar).inCodex && !coveredByCodex(pathbar).inSelf,
      filesHeaderTop: filesHeaderRect.top,
      codexTop: codexRect.top,
      filesViewLeft: filesViewRect.left,
      codexLeft: codexRect.left,
      filesViewRight: filesViewRect.right,
      codexRight: codexRect.right,
      filesViewBottom: filesViewRect.bottom,
      codexBottom: codexRect.bottom,
      browserHeight: browserRect.height,
      fileListWidth: fileListRect.width,
      titleFits: filesTitle.clientWidth >= filesTitle.scrollWidth,
    };
  });
  expect(taskFilesLayout.appHeaderCoveredByCodex).toBe(true);
  expect(taskFilesLayout.pathbarCoveredByCodex).toBe(true);
  expect(taskFilesLayout.filesHeaderTop).toBeLessThanOrEqual(taskFilesLayout.codexTop + 1);
  expect(Math.abs(taskFilesLayout.filesViewLeft - taskFilesLayout.codexLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(taskFilesLayout.filesViewRight - taskFilesLayout.codexRight)).toBeLessThanOrEqual(1);
  expect(taskFilesLayout.filesViewBottom).toBeGreaterThanOrEqual(taskFilesLayout.codexBottom - 1);
  expect(taskFilesLayout.browserHeight).toBeGreaterThan(400);
  if (taskFilesLayout.viewportWidth >= 861) {
    expect(taskFilesLayout.fileListWidth).toBeGreaterThanOrEqual(300);
  }
  expect(taskFilesLayout.titleFits).toBe(true);
  const filesTitleLeft = await taskFilesView
    .locator(".task-files-header h3")
    .evaluate((element) => element.getBoundingClientRect().left);
  const codexCloseRight = await page
    .locator("caffold-codex-workspace .codex-workspace-close")
    .evaluate((element) => element.getBoundingClientRect().right);
  expect(filesTitleLeft).toBeGreaterThan(codexCloseRight);
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect(taskFilesView.locator("caffold-file-browser")).toHaveAttribute(
    "data-browser-view",
    "list",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  const embeddedLiveName = `task-live-${testInfo.project.name}.txt`;
  const embeddedLivePath = resolve("tests/fixtures/home/src", embeddedLiveName);
  try {
    await writeFile(embeddedLivePath, "Codex Files live update\n");
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 2,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toBeVisible();
  } finally {
    await rm(embeddedLivePath, { force: true });
    await page.evaluate((logicalPath) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.startsWith("/api/watch?"),
      );
      source?.emit("change", {
        revision: 3,
        paths: [logicalPath],
        gitStatusChanged: true,
        gitRefsChanged: false,
        overflow: false,
      });
    }, `src/${embeddedLiveName}`);
    await expect(
      taskFilesView.locator(`button[data-entry-path="src/${embeddedLiveName}"]`),
    ).toHaveCount(0);
  }
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser-list");
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(page.locator("caffold-codex-workspace")).toBeVisible();
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator('button[data-task-action="toggle-files"]').click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "files",
  );
  await expect(taskFilesView.locator('button[data-entry-path="src/alpha.rs"]')).toBeVisible();
  await taskFilesView.locator('button[data-entry-path="src/alpha.rs"]').click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText(
    "alpha.rs",
  );
  await expect(taskFilesView.locator("caffold-file-viewer")).toContainText("pub const ALPHA");
  await expect(page.locator("caffold-files-page")).toBeHidden();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-file-browser");
  if (testInfo.project.name === "phone") {
    await taskFilesView.getByRole("button", { name: "Back to files" }).click();
  }
  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(taskFilesView).toBeHidden();
  await expect(tasksPage.locator(".task-conversation-pane")).toBeVisible();
  await expect(tasksPage.locator(".tasks-header")).toBeVisible();
  await expect(tasksPage.locator(".task-detail-summary")).toBeVisible();
  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-persist-probe",
    "kept",
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeFiles.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    codexWorkspace.getByRole("button", { name: "Close Codex workspace" }),
  ).toBeVisible();

  await tasksPage.locator(".task-follow-up-form .task-model-button").click();
  await expect(modelPopover).toBeVisible();
  await modelPopover.locator('[data-effort="ultra"]').click();
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );
  const followUpTextarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await followUpTextarea.fill("Please tighten the tests");
  await pasteImage(followUpTextarea, "follow-up.png");
  await expect(
    tasksPage.locator('.task-follow-up-form .task-composer-attachment'),
  ).toHaveCount(1);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "data-thread-id",
    threadId,
  );
  await tasksPage.evaluate((element) => {
    element.querySelector("caffold-task-detail").selectedThreadId = "";
  });
  await tasksPage
    .locator('.task-follow-up-form button[type="submit"]')
    .click();
  await followUpRequested;
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await followUpTextarea.fill("Keep this next draft while the request runs");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(1);
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toBeVisible();
  await expect(
    tasksPage
      .locator('.task-message[data-message-role="user"]')
      .filter({ hasText: "Please tighten the tests" })
      .locator('.task-message-attachment img'),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(tasksPage).not.toContainText("Follow-up prompt sent");
  releaseFollowUpResponse();
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(followUpTextarea).toHaveValue(
    "Keep this next draft while the request runs",
  );
  await page.evaluate((detail) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
    );
    source?.emit("task-sync", {
      threadId: detail.task.threadId,
      revision: detail.revision,
      detail,
      reason: "test",
    });
  }, detailResponse({
    revision: 2,
    task: {
      ...task,
      ...canonicalTaskState("active", {
        turnId: "turn_2",
        startedAtMs: now + 7,
        latestTurnStatus: "inProgress",
      }),
    },
  }));
  const runningStatus = tasksPage.locator(
    '.task-detail-summary .task-status-chip[data-status="running"]',
  );
  await expect(
    runningStatus,
  ).toBeVisible();
  await expect(runningStatus.locator(".task-status-spinner")).toBeVisible();
  await expect(runningStatus.locator(".task-status-label")).toHaveCount(0);
  const activeTurn = tasksPage.locator('.task-turn-active[data-turn-id="turn_2"]');
  await expect(activeTurn).toBeVisible();
  await expect(activeTurn.locator(".task-turn-active-duration")).toContainText(
    "Working for",
  );
  await expect(activeTurn.locator(".task-turn-active-state")).toHaveText(
    "Running command",
  );
  const activeDuration = await activeTurn.locator(".task-turn-active-duration").textContent();
  await expect
    .poll(() => activeTurn.locator(".task-turn-active-duration").textContent())
    .not.toBe(activeDuration);
  const stableActiveTurnStartedMs = await activeTurn.getAttribute(
    "data-active-turn-started-ms",
  );
  for (let revision = 3; revision <= 5; revision += 1) {
    await page.evaluate((detail) => {
      const source = window.__caffoldMockEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
      );
      source?.emit("task-sync", {
        threadId: detail.task.threadId,
        revision: detail.revision,
        detail,
        reason: "canonical-refresh",
      });
    }, detailResponse({
      revision,
      task: {
        ...task,
        ...canonicalTaskState("active", {
          turnId: "turn_2",
          startedAtMs: Number(stableActiveTurnStartedMs),
          latestTurnStatus: "inProgress",
        }),
      },
    }));
  }
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    stableActiveTurnStartedMs,
  );
  await tasksPage.evaluate((element) => {
    const conversation = element.querySelector("caffold-task-conversation");
    conversation.stopActiveTurnClock();
    conversation.connectedCallback();
  });
  const durationAfterReconnect = await activeTurn
    .locator(".task-turn-active-duration")
    .textContent();
  await expect
    .poll(() => activeTurn.locator(".task-turn-active-duration").textContent())
    .not.toBe(durationAfterReconnect);
  const runningTaskRow = tasksPage.locator(
    `.task-row[data-thread-id="${threadId}"]`,
  );
  await expect(runningTaskRow).toHaveAttribute("data-task-status", "running");
  await expect(runningTaskRow).toHaveAttribute("aria-busy", "true");
  await expect(runningTaskRow.locator(".task-status-spinner")).toHaveCount(1);
  if (testInfo.project.name === "desktop") {
    await expect(runningTaskRow.locator(".task-status-spinner")).toBeVisible();
  }
  await expect(followUpTextarea).toBeFocused();
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Please tighten the tests",
    }),
  ).toHaveCount(1);

  await tasksPage
    .locator(".task-conversation-pane")
    .evaluate((element) => element.setAttribute("data-review-persist-probe", "kept"));
  await followUpTextarea.fill("Keep this draft while reviewing");
  const conversationBeforeDiff = await conversationScroller.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maxScrollTop / 2);
    return { maxScrollTop, scrollTop: element.scrollTop };
  });
  expect(conversationBeforeDiff.maxScrollTop).toBeGreaterThan(0);
  const taskDetailReadsBeforeDiff = taskDetailReadRequests;
  await tasksPage.getByRole("button", { name: "Open Diff" }).click();
  await expect(page).toHaveURL(`/tasks/${threadId}`);
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "diff",
  );
  await expect(codexWorkspace).toBeVisible();
  await expect(page.locator("caffold-review-workspace")).toBeHidden();
  const taskDiffView = tasksPage.locator(".task-diff-view");
  await expect(taskDiffView).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-list-pane")).toBeHidden();
  await expect(tasksPage.locator(".tasks-master-resizer")).toBeHidden();
  const taskDiffLayout = await tasksPage.evaluate((element) => {
    const pageRect = element.getBoundingClientRect();
    const diffRect = element.querySelector(".task-diff-view").getBoundingClientRect();
    return {
      leftGap: Math.abs(diffRect.left - pageRect.left),
      rightGap: Math.abs(diffRect.right - pageRect.right),
    };
  });
  expect(taskDiffLayout.leftGap).toBeLessThanOrEqual(1);
  expect(taskDiffLayout.rightGap).toBeLessThanOrEqual(1);
  const taskDiffTree = taskDiffView.locator("caffold-git-diff-changes-tree");
  await expect(taskDiffTree.locator("button[data-change-path]")).toHaveCount(4);
  await expect(taskDiffTree.locator('button[data-task-related="true"]')).toHaveCount(3);
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="unrelated.rs"]'),
  ).not.toHaveAttribute("data-task-related", "true");
  await taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]').click();
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  const taskDiffViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="working"] caffold-review-file-viewer',
  );
  await expect(taskDiffViewer).toContainText("planner.rs");
  await expect(taskDiffViewer).toContainText(
    "new planner behavior",
  );
  const statusRequestsBeforeWatchChange = gitStatusRequests;
  includeTaskDiffLiveFile = true;
  await page.evaluate(() => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.startsWith("/api/watch?"),
    );
    source?.emit("change", {
      revision: 4,
      paths: ["src/live-update.rs"],
      gitStatusChanged: true,
      gitRefsChanged: false,
      overflow: false,
    });
  });
  await expect.poll(() => gitStatusRequests).toBeGreaterThan(statusRequestsBeforeWatchChange);
  const liveUpdateChange = taskDiffTree.locator(
    'button[data-repo-relative-path="live-update.rs"]',
  );
  await expect(liveUpdateChange).toHaveCount(1);
  if (testInfo.project.name === "phone") {
    await expect(liveUpdateChange).toBeHidden();
  } else {
    await expect(liveUpdateChange).toBeVisible();
  }
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-related-diff");

  const refsBeforeBranch = gitRefsRequests;
  const compareBeforeBranch = gitCompareRequests;
  await taskDiffView.getByRole("button", { name: "Branch" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "branch");
  await expect.poll(() => gitRefsRequests).toBeGreaterThan(refsBeforeBranch);
  await expect.poll(() => gitCompareRequests).toBeGreaterThan(compareBeforeBranch);
  await expect(taskDiffView.locator("select[data-task-compare-base]")).toHaveValue(
    "origin/main",
  );
  await expect(taskDiffView.locator("[data-task-compare-head]")).toHaveText("main");
  const taskCompareTree = taskDiffView.locator("caffold-git-compare-tree");
  const taskCompareFile = taskCompareTree.locator(
    'button[data-compare-path="src/planner.rs"]',
  );
  await expect(taskCompareFile).toBeVisible();
  await taskCompareFile.click();
  await expect.poll(() => gitCompareDiffRequests).toBeGreaterThan(0);
  const taskCompareViewer = taskDiffView.locator(
    '.task-diff-panel[data-task-diff-panel="branch"] caffold-review-file-viewer',
  );
  await expect(taskCompareViewer).toContainText("new branch behavior");
  await taskDiffView.locator("select[data-task-compare-base]").selectOption("origin/release");
  await expect(taskCompareTree.locator('button[data-compare-path="src/release.rs"]')).toBeVisible();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-branch-compare");

  await taskDiffView.getByRole("button", { name: "Working Tree" }).click();
  await expect(taskDiffView).toHaveAttribute("data-task-diff-mode", "working");
  await expect(
    taskDiffTree.locator('button[data-repo-relative-path="planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(taskDiffViewer).toContainText("new planner behavior");

  await page.locator("caffold-codex-workspace .codex-workspace-close").click();
  await expect(tasksPage.locator(".task-detail")).toHaveAttribute(
    "data-task-detail-view",
    "conversation",
  );
  await expect(tasksPage.locator(".task-conversation-pane")).toHaveAttribute(
    "data-review-persist-probe",
    "kept",
  );
  await expect(followUpTextarea).toHaveValue("Keep this draft while reviewing");
  await expect(tasksPage.locator(".task-follow-up-form .task-model-button")).toContainText(
    "Ultra",
  );

  if (taskMasterStateBeforeTools) {
    await expect(tasksPage.locator(".tasks-list-pane")).toBeVisible();
    await expect(tasksPage.locator(".tasks-master-resizer")).toBeVisible();
    await expect
      .poll(() =>
        tasksPage
          .locator(".tasks-list-pane")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(taskMasterStateBeforeTools.listWidth);
    await expect
      .poll(() =>
        tasksPage.locator(".task-list-scroll").evaluate((element) => element.scrollTop),
      )
      .toBe(taskMasterStateBeforeTools.listScrollTop);
  }
  await expect
    .poll(async () =>
      Math.abs(
        (await conversationScroller.evaluate((element) => element.scrollTop)) -
          conversationBeforeDiff.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(taskDetailReadRequests).toBe(taskDetailReadsBeforeDiff);

  await followUpTextarea.fill("한글 버튼 제출");
  await page.evaluate(() => {
    Object.defineProperty(HTMLFormElement.prototype, "prompt", {
      configurable: true,
      get() {
        throw new Error("Legacy named form access is unavailable");
      },
    });
  });
  await tasksPage.locator('.task-follow-up-form button[type="submit"]').click();
  await expect.poll(() => followUpRequests).toBe(2);
  await expect(followUpTextarea).toHaveValue("");
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Canonical sync unlocks composer");
  await tasksPage.locator('.task-follow-up-form button[type="submit"]').click();
  await canonicalFollowUpRequested;
  await expect.poll(() => followUpRequests).toBe(3);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "true",
  );

  const canonicalPromptEvent = eventRecord(
    "event_canonical_prompt",
    "user_message",
    "User prompt",
    {
      text: "Canonical sync unlocks composer",
      turnId: "turn_canonical_ack",
      item: {
        content: [{ type: "text", text: "Canonical sync unlocks composer" }],
      },
    },
    30,
  );
  events = [...events, canonicalPromptEvent];
  updateTask({
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    lastEventSummary: "Canonical prompt accepted",
  });
  await page.evaluate((detail) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${detail.task.threadId}/stream`),
    );
    source?.emit("task-sync", {
      threadId: detail.task.threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-prompt-ack",
    });
  }, detailResponse({ revision: 20 }));
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Enter after canonical sync");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(4);
  await expect(followUpTextarea).toHaveValue("");
  releaseCanonicalFollowUpResponse();
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await followUpTextarea.fill("Prompt that fails");
  await followUpTextarea.press("Enter");
  await expect.poll(() => followUpRequests).toBe(5);
  await expect(tasksPage.locator(".task-follow-up-form")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(followUpTextarea).toBeFocused();
  await expect(followUpTextarea).toHaveValue("Prompt that fails");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Prompt that fails",
    }),
  ).toHaveCount(0);

  omitCompletedCommandFromDetail = true;
  const openTaskListButton = tasksPage.locator('[data-task-action="open-list"]');
  if (await openTaskListButton.isVisible()) {
    await openTaskListButton.click();
  }
  await tasksPage.locator(`.task-row[data-thread-id="${threadId}"]`).click();
  await expect(followUpTextarea).toHaveValue("Prompt that fails");
  await tasksPage
    .locator(
      '.task-turn-work:has(.task-work-item[data-event-type="command_execution"]) > details > summary',
    )
    .click();
  await expect(
    tasksPage.locator('.task-work-item[data-event-type="command_execution"]'),
  ).toContainText("test result: ok");
});

test("keeps the visible conversation anchor while loading older events by cursor", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);
  const threadId = "thread_cursor_fixture";
  const detailCursors = [];
  const now = 1_767_100_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("notLoaded"),
    title: "Long running thread",
    preview: "Latest answer",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 10,
    recencyMs: now + 10,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const latestEvents = Array.from({ length: 12 }, (_, index) => {
    const isUserPrompt = index % 2 === 0;
    const blockNumber = index + 1;
    return eventRecord(
      `event_latest_${index}`,
      isUserPrompt ? "user_message" : "assistant_message",
      isUserPrompt ? "User prompt" : "Assistant response",
      {
        text: `${isUserPrompt ? "This is the latest prompt block" : "This is the latest answer block"} ${blockNumber}.\n\n${"Latest transcript line. ".repeat(18)}`,
      },
      10 + index,
    );
  });
  const olderPrompt = Array.from(
    { length: 28 },
    (_, index) => `Older prompt line ${index + 1} keeps the prepended page tall.`,
  ).join("\n");
  let releaseOlderImage;
  const olderImageGate = new Promise((resolve) => {
    releaseOlderImage = resolve;
  });
  const olderEvents = [
    eventRecord(
      "event_older",
      "user_message",
      "User prompt",
      {
        text: olderPrompt,
        content: [{ type: "localImage", path: "/tmp/older-image.png" }],
      },
      1,
    ),
  ];
  const ancientEvents = [
    eventRecord(
      "event_ancient",
      "assistant_message",
      "Assistant response",
      {
        text: Array.from(
          { length: 20 },
          (_, index) => `Ancient answer line ${index + 1} expands the next page.`,
        ).join("\n"),
      },
      0,
    ),
  ];

  await page.route(/\/api\/task-image(?:\?|$)/, async (route) => {
    await olderImageGate;
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(PASTED_IMAGE_BASE64, "base64"),
    });
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    });
  });

  await page.route(/\/api\/tasks\/thread_cursor_fixture(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cwd")).toBeNull();
    const cursor = url.searchParams.get("cursor");
    detailCursors.push(cursor);
    const events = cursor === "older_cursor"
      ? olderEvents
      : cursor === "ancient_cursor"
        ? ancientEvents
        : latestEvents;
    const nextCursor = cursor === "older_cursor"
      ? "ancient_cursor"
      : cursor === "ancient_cursor"
        ? null
        : "older_cursor";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: cursor === "ancient_cursor" ? 4 : cursor === "older_cursor" ? 3 : 1,
        task,
        events,
        eventsPage: { nextCursor },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto("/tasks?cwd=src");
  const tasksPage = page.locator("caffold-tasks-page");
  const taskRow = tasksPage.locator(".task-row", { hasText: "Long running thread" });
  await expect(taskRow.locator(".task-row-time")).toBeVisible();
  await expect(taskRow).not.toContainText("notLoaded");
  await taskRow.click();
  await expect(tasksPage.locator(".task-detail-summary")).not.toContainText("notLoaded");
  await expect(tasksPage).toContainText("This is the latest answer block 12.");
  await expect(tasksPage).not.toContainText("This is the older prompt.");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);
  await page.evaluate(
    ({ threadId, task }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", {
        threadId,
        revision: 2,
        reason: "session-bootstrap",
        detail: {
          revision: 2,
          task,
          events: [],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
          historyLoading: true,
        },
      });
    },
    { threadId, task },
  );
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(1);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollHeight > element.clientHeight;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => {
        return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
      }),
    )
    .toBe(true);

  const visibleAnchor = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => {
      element.scrollTop = 0;
      const scrollerRect = element.getBoundingClientRect();
      const anchor = [...element.querySelectorAll(".task-event[data-event-id]")].find(
        (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
      );
      const snapshot = {
        eventId: anchor?.dataset.eventId ?? "",
        offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : null,
      };
      element.dispatchEvent(new Event("scroll"));
      return snapshot;
    });
  expect(visibleAnchor.eventId).toBe("event_latest_0");
  await expect.poll(() => detailCursors).toContain("older_cursor");
  await expect(tasksPage).toContainText("Older prompt line 1");
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-event[data-event-id="event_older"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  await expect
    .poll(async () => {
      const currentOffset = await tasksPage
        .locator('.task-event[data-event-id="event_latest_0"]')
        .evaluate((anchor) => {
          const scroller = anchor.closest(".task-conversation-scroll");
          return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
      return Math.abs(currentOffset - visibleAnchor.offset);
    })
    .toBeLessThan(0.5);

  releaseOlderImage();
  const olderImage = tasksPage.locator(
    '.task-event[data-event-id="event_older"] .task-message-attachment img',
  );
  await expect
    .poll(() => olderImage.evaluate((image) => image.naturalHeight))
    .toBeGreaterThan(0);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const offsetAfterImageLoad = await tasksPage
    .locator('.task-event[data-event-id="event_latest_0"]')
    .evaluate((anchor) => {
      const scroller = anchor.closest(".task-conversation-scroll");
      return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  expect(Math.abs(offsetAfterImageLoad - visibleAnchor.offset)).toBeLessThan(0.5);

  const secondPageAnchor = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => {
      element.scrollTop = 0;
      const scrollerRect = element.getBoundingClientRect();
      const anchor = [...element.querySelectorAll(".task-event[data-event-id]")].find(
        (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
      );
      const snapshot = {
        eventId: anchor?.dataset.eventId ?? "",
        offset: anchor ? anchor.getBoundingClientRect().top - scrollerRect.top : null,
      };
      element.dispatchEvent(new Event("scroll"));
      return snapshot;
    });
  expect(secondPageAnchor.eventId).toBe("event_older");
  await expect.poll(() => detailCursors).toContain("ancient_cursor");
  await expect(tasksPage).toContainText("Ancient answer line 1");
  await expect(tasksPage.locator(".task-load-older")).toHaveCount(0);
  await expect(
    tasksPage.locator(
      '.task-event[data-event-id="event_ancient"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  await expect
    .poll(async () => {
      const currentOffset = await tasksPage
        .locator('.task-event[data-event-id="event_older"]')
        .evaluate((anchor) => {
          const scroller = anchor.closest(".task-conversation-scroll");
          return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
      return Math.abs(currentOffset - secondPageAnchor.offset);
    })
    .toBeLessThan(0.5);
});

test("keeps task context and retries after an initial detail timeout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const threadId = "thread_detail_timeout_fixture";
  const now = 1_767_200_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle"),
    title: "Recover delayed task detail",
    preview: "Canonical task summary",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Canonical task summary",
  };
  let detailRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_detail_timeout_fixture(?:\?|$)/, (route) => {
    detailRequests += 1;
    if (detailRequests === 1) {
      return route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "Codex app-server request timed out." }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 2,
        task,
        events: [
          {
            id: "event_recovered",
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: { text: "Recovered canonical response." },
            createdMs: now,
          },
        ],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Task details are temporarily unavailable.",
  );
  await expect(tasksPage.locator(".task-detail-load-error")).toContainText(
    "Codex app-server request timed out.",
  );
  await expect(tasksPage).toContainText("Recover delayed task detail");

  await tasksPage.locator('[data-task-action="retry-task-detail"]').click();
  await expect.poll(() => detailRequests).toBe(2);
  await expect(tasksPage).toContainText("Recovered canonical response.");
  await expect(tasksPage.locator(".task-detail-load-error")).toHaveCount(0);
});

test("keeps the latest conversation when older history times out", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);
  const threadId = "thread_history_timeout_fixture";
  const now = 1_767_300_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle"),
    title: "Preserve latest task history",
    preview: "Latest canonical response",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Latest canonical response",
  };
  const latestEvents = Array.from({ length: 12 }, (_, index) => ({
    id: `event_latest_timeout_${index}`,
    threadId,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    summary: index % 2 === 0 ? "User prompt" : "Assistant response",
    payload: {
      text: `${index % 2 === 0 ? "Latest prompt" : "Latest response"} ${index + 1}. ${"Keep this visible. ".repeat(24)}`,
    },
    createdMs: now + index,
  }));
  let olderRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_history_timeout_fixture(?:\?|$)/, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === "older-timeout-cursor") {
      olderRequests += 1;
      if (olderRequests === 1) {
        return route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({ error: "Codex app-server request timed out." }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          revision: 2,
          task,
          events: [
            {
              id: "event_older_recovered",
              threadId,
              type: "user_message",
              summary: "User prompt",
              payload: { text: "Recovered older prompt." },
              createdMs: now - 1,
            },
          ],
          eventsPage: { nextCursor: null },
          pendingApprovals: [],
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: 1,
        task,
        events: latestEvents,
        eventsPage: { nextCursor: "older-timeout-cursor" },
        pendingApprovals: [],
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const conversation = tasksPage.locator(".task-conversation-scroll");
  const textarea = tasksPage.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await expect(tasksPage).toContainText("Latest response 12.");
  await textarea.fill("Draft survives history timeout");

  await conversation.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => olderRequests).toBe(1);
  await expect(tasksPage.locator(".task-history-error")).toContainText(
    "Older messages are temporarily unavailable.",
  );
  await expect(tasksPage).toContainText("Latest response 12.");
  await expect(textarea).toHaveValue("Draft survives history timeout");

  await tasksPage.locator('[data-task-action="retry-task-history"]').click();
  await expect.poll(() => olderRequests).toBe(2);
  await expect(tasksPage).toContainText("Recovered older prompt.");
  await expect(tasksPage.locator(".task-history-error")).toHaveCount(0);
  await expect(textarea).toHaveValue("Draft survives history timeout");
});

test("starts a completed task follow-up clock only from canonical turn metadata", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Follow-up clock regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_follow_up_clock";
  const firstTurnStartedMs = Date.now() - 2 * 60 * 60 * 1_000;
  const firstTurnCompletedMs = firstTurnStartedMs + 30_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Follow-up clock fixture",
    preview: "Initial answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: firstTurnStartedMs,
    updatedMs: firstTurnCompletedMs,
    recencyMs: firstTurnCompletedMs,
    lastEventSummary: "Initial answer",
  };
  const firstTurnEvents = [
    {
      id: "turn_initial:started",
      threadId,
      type: "turn_started",
      summary: "Turn started",
      payload: { turnId: "turn_initial" },
      createdMs: firstTurnStartedMs,
    },
    {
      id: "turn_initial:answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_initial",
        phase: "final",
        text: "Initial answer",
      },
      createdMs: firstTurnCompletedMs - 1,
    },
    {
      id: "turn_initial:completed",
      threadId,
      type: "turn_completed",
      summary: "Turn completed",
      payload: { turnId: "turn_initial", status: "completed" },
      createdMs: firstTurnCompletedMs,
    },
  ];
  const detail = (overrides = {}) => ({
    threadId,
    syncState: "ready",
    revision: overrides.revision ?? 1,
    task: { ...task, ...(overrides.task ?? {}) },
    events: overrides.events ?? firstTurnEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
  });

  let markPromptRequested;
  const promptRequested = new Promise((resolve) => {
    markPromptRequested = resolve;
  });
  let releasePromptResponse;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail()),
    }),
  );
  await page.route(
    new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`),
    async (route) => {
      await new Promise((resolve) => {
        releasePromptResponse = resolve;
        markPromptRequested();
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          threadId,
          turnId: "turn_follow_up",
          steered: false,
        }),
      });
    },
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  await prompt.fill("Start a fresh timed turn");
  await prompt.press("Enter");
  await promptRequested;

  const activeTurn = tasksPage.locator(".task-turn-active");
  await expect(activeTurn).toHaveCount(0);

  releasePromptResponse();
  await expect(form).toHaveAttribute("aria-busy", "false");
  const canonicalStartedMs = Date.now();
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-follow-up",
    });
  }, {
    threadId,
    detail: detail({
      revision: 2,
      task: {
        ...canonicalTaskState("active", {
          turnId: "turn_follow_up",
          startedAtMs: canonicalStartedMs,
          latestTurnStatus: "inProgress",
        }),
        updatedMs: canonicalStartedMs,
        recencyMs: canonicalStartedMs,
      },
      events: [
        ...firstTurnEvents,
        {
          id: "turn_follow_up:started",
          threadId,
          type: "turn_started",
          summary: "Turn started",
          payload: { turnId: "turn_follow_up" },
          createdMs: canonicalStartedMs,
        },
      ],
    }),
  });

  await expect(activeTurn).toHaveAttribute("data-turn-id", "turn_follow_up");
  await expect(activeTurn).toHaveAttribute(
    "data-active-turn-started-ms",
    `${canonicalStartedMs}`,
  );
});

test("submits completed task follow-ups and reloads canonical messages", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_completed_follow_up";
  const now = 1_767_190_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Completed follow-up fixture",
    preview: "Initial canonical answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial canonical answer",
  };
  const initialEvent = {
    id: "event_initial_answer",
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: "turn_initial", text: "Initial canonical answer" },
    createdMs: now,
  };
  let revision = 1;
  let canonicalEvents = [initialEvent];
  const submittedPrompts = [];
  const submittedBodies = [];
  let rejectedAttempts = 0;
  let timedOutAttempts = 0;
  let blockNextDetailRequest = false;
  let releaseStaleDetailRequest = null;
  let markStaleDetailRequestStarted = null;
  const staleDetailRequestStarted = new Promise((resolve) => {
    markStaleDetailRequestStarted = resolve;
  });
  const detail = () => ({
    revision,
    task,
    events: canonicalEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    const response = detail();
    if (blockNextDetailRequest) {
      blockNextDetailRequest = false;
      markStaleDetailRequestStarted();
      await new Promise((resolve) => {
        releaseStaleDetailRequest = resolve;
      });
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    submittedBodies.push(body);
    if (body.prompt === "Rejected image prompt" && rejectedAttempts++ === 0) {
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Follow-up rejected by fixture" }),
      });
    }
    if (body.prompt === "Timed out prompt" && timedOutAttempts++ === 0) {
      return route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "codex_app_server_timeout",
            message: "Codex app-server request timed out.",
          },
        }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId,
        turnId: `turn_follow_up_${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  const send = form.locator('button[type="submit"]');
  await expect(tasksPage).toContainText("Initial canonical answer");

  const runningEvent = {
    id: "event_external_running",
    threadId,
    type: "assistant_message",
    summary: "Assistant update",
    payload: {
      turnId: "turn_external_running",
      text: "External work is still running",
      status: "inProgress",
      startedAt: Math.floor(now / 1000),
    },
    createdMs: now + 1,
  };
  Object.assign(
    task,
    canonicalTaskState("active", {
      turnId: "turn_external_running",
      latestTurnStatus: "inProgress",
    }),
  );
  canonicalEvents = [...canonicalEvents, runningEvent];
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-canonical-running",
    });
  }, { threadId, detail: detail() });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toBeVisible();

  const conversation = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
    element.dispatchEvent(new Event("scroll"));
  });
  const scrollBeforeSync = await conversation.evaluate((element) => element.scrollTop);

  // Synchronization progress is transport state. It must never replace the
  // canonical running task/turn state or reset the current conversation.
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-sync-start",
    });
  }, { threadId, detail: detail() });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect(tasksPage.locator(".task-turn-active")).toBeVisible();
  await expect(tasksPage).toContainText("External work is still running");
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(scrollBeforeSync);
  await expect(send).toBeEnabled();

  blockNextDetailRequest = true;
  await page.evaluate(() => {
    document
      .querySelector("caffold-task-detail")
      ?.requestSelectedTaskRefresh();
  });
  await staleDetailRequestStarted;

  await prompt.fill("Submitted by button");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual(["Submitted by button"]);
  await expect(tasksPage).toContainText("Submitted by button");
  releaseStaleDetailRequest();
  await expect(tasksPage).toContainText("Submitted by button");
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toBeFocused();

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_button_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: { turnId: "turn_follow_up_1", text: "Submitted by button" },
      createdMs: now + 1,
    },
    {
      id: "event_button_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_follow_up_1", text: "Button response" },
      createdMs: now + 2,
    },
  ];
  Object.assign(
    task,
    canonicalTaskState("idle", { latestTurnStatus: "completed" }),
  );
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-button-response",
    });
  }, { threadId, detail: detail() });
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(tasksPage).toContainText("Button response");

  await prompt.fill("Submitted by Enter");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    "Submitted by button",
    "Submitted by Enter",
  ]);
  await expect(tasksPage).toContainText("Submitted by Enter");

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_enter_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: { turnId: "turn_follow_up_2", text: "Submitted by Enter" },
      createdMs: now + 3,
    },
    {
      id: "event_enter_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_follow_up_2", text: "Latest canonical response" },
      createdMs: now + 4,
    },
  ];
  revision += 1;
  await page.reload();
  await expect(tasksPage).toContainText("Submitted by Enter");
  await expect(tasksPage).toContainText("Latest canonical response");

  await prompt.fill("Rejected image prompt");
  await pasteImage(prompt, "retry-after-failure.png");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await send.click();
  await expect.poll(() => submittedPrompts.at(-1)).toBe("Rejected image prompt");
  expect(submittedBodies.at(-1).images).toHaveLength(1);
  expect(submittedBodies.at(-1).images[0]).toMatch(/^data:image\/png;base64,/);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue("Rejected image prompt");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(tasksPage).toContainText("Follow-up rejected by fixture");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Rejected image prompt",
    }),
  ).toHaveCount(0);

  await send.click();
  await expect.poll(() => submittedPrompts.slice(-2)).toEqual([
    "Rejected image prompt",
    "Rejected image prompt",
  ]);
  expect(submittedBodies.at(-1).images).toHaveLength(1);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toHaveValue("");
  await expect(form.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Rejected image prompt",
    }),
  ).toBeVisible();

  await prompt.fill("Timed out prompt");
  await send.click();
  await expect.poll(() => timedOutAttempts).toBe(1);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(prompt).toHaveValue("");
  await expect(prompt).toBeFocused();
  await expect(tasksPage).toContainText("Codex app-server request timed out.");
  await expect(
    tasksPage.locator('.task-message[data-message-role="user"]').filter({
      hasText: "Timed out prompt",
    }),
  ).toHaveAttribute("data-delivery-state", "outcomeUnknown");
});

test("unlocks a completed task when canonical item content arrives before the prompt response", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Canonical prompt acknowledgement regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_canonical_item_ack";
  const now = 1_767_190_300_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Canonical item acknowledgement",
    preview: "Initial response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial response",
  };
  let revision = 1;
  let canonicalEvents = [
    {
      id: "event_initial_response",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_initial", text: "Initial response" },
      createdMs: now,
    },
  ];
  const submittedPrompts = [];
  let releaseFirstPrompt;
  const firstPromptGate = new Promise((resolve) => {
    releaseFirstPrompt = resolve;
  });
  const detail = () => ({
    revision,
    task,
    events: canonicalEvents,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail()) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    if (submittedPrompts.length === 1) {
      await firstPromptGate;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId,
        turnId: `turn_${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const prompt = form.locator('textarea[name="prompt"]');
  const send = form.locator('button[type="submit"]');
  await expect(tasksPage).toContainText("Initial response");

  await prompt.fill("Canonical item prompt");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual(["Canonical item prompt"]);
  await expect(form).toHaveAttribute("aria-busy", "true");

  canonicalEvents = [
    ...canonicalEvents,
    {
      id: "event_canonical_item_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_1",
        item: {
          id: "item_canonical_item_prompt",
          type: "userMessage",
          content: [{ type: "input_text", text: "Canonical item prompt" }],
        },
      },
      createdMs: now + 1,
    },
  ];
  Object.assign(
    task,
    canonicalTaskState("active", {
      turnId: "turn_1",
      latestTurnStatus: "inProgress",
    }),
  );
  revision += 1;
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-item-ack",
    });
  }, { threadId, detail: detail() });

  await expect(tasksPage).toContainText("Canonical item prompt");
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(send).toBeEnabled();

  await prompt.fill("Submitted after canonical item acknowledgement");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical item prompt",
    "Submitted after canonical item acknowledgement",
  ]);

  releaseFirstPrompt();
  await expect(form).toHaveAttribute("aria-busy", "false");
});

test("unlocks canonical follow-ups after switching tasks with a pending response", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Wide task-switch regression");
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}
      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_190_300_000;
  const taskA = {
    id: "thread_pending_a",
    threadId: "thread_pending_a",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Pending response task",
    preview: "Initial A response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial A response",
  };
  const taskB = {
    id: "thread_running_b",
    threadId: "thread_running_b",
    ...canonicalTaskState("active", {
      turnId: "turn_running_b",
      latestTurnStatus: "inProgress",
    }),
    title: "Externally running task",
    preview: "External work is running",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now - 100,
    updatedMs: now + 100,
    recencyMs: now + 100,
    lastEventSummary: "External work is running",
  };
  const revisions = new Map([
    [taskA.threadId, 1],
    [taskB.threadId, 1],
  ]);
  const eventsByThread = new Map([
    [
      taskA.threadId,
      [
        {
          id: "event_a_initial",
          threadId: taskA.threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: { turnId: "turn_a_initial", text: "Initial A response" },
          createdMs: now,
        },
      ],
    ],
    [
      taskB.threadId,
      Array.from({ length: 24 }, (_, index) => ({
        id: `event_b_progress_${index}`,
        threadId: taskB.threadId,
        type: "assistant_message",
        summary: "Assistant update",
        payload: {
          turnId: "turn_running_b",
          text: `External running update ${index + 1}`,
        },
        createdMs: now + index,
      })),
    ],
  ]);
  const taskFor = (threadId) =>
    threadId === taskA.threadId ? taskA : taskB;
  const detailFor = (threadId) => ({
    revision: revisions.get(threadId),
    task: taskFor(threadId),
    events: eventsByThread.get(threadId),
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const submittedPrompts = [];
  let releaseFirstPrompt;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [taskA, taskB] }),
    }),
  );
  await page.route(/\/api\/tasks\/(thread_pending_a|thread_running_b)(?:\?|$)/, (route) => {
    const threadId = route.request().url().match(/\/api\/tasks\/([^?]+)/)?.[1];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailFor(threadId)),
    });
  });
  await page.route(/\/api\/tasks\/thread_pending_a\/prompts(?:\?|$)/, async (route) => {
    const body = route.request().postDataJSON();
    submittedPrompts.push(body.prompt);
    if (submittedPrompts.length === 1) {
      await new Promise((resolve) => {
        releaseFirstPrompt = resolve;
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        threadId: taskA.threadId,
        turnId: `turn_a_follow_up_${submittedPrompts.length}`,
        steered: false,
      }),
    });
  });

  await page.goto(`/tasks/${taskA.threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  let form = tasksPage.locator(".task-follow-up-form");
  let prompt = form.locator('textarea[name="prompt"]');
  let send = form.locator('button[type="submit"]');

  await prompt.fill("Canonical while response is pending");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "true");

  eventsByThread.set(taskA.threadId, [
    ...eventsByThread.get(taskA.threadId),
    {
      id: "event_a_canonical_prompt",
      threadId: taskA.threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_a_follow_up_1",
        text: "Canonical while response is pending",
      },
      createdMs: now + 200,
    },
    {
      id: "event_a_canonical_answer",
      threadId: taskA.threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_a_follow_up_1",
        text: "Canonical A response",
      },
      createdMs: now + 201,
    },
  ]);
  revisions.set(taskA.threadId, 2);

  await tasksPage.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await expect(tasksPage).toContainText("External running update 24");
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  const conversation = tasksPage.locator(".task-conversation-scroll");
  await conversation.evaluate((element) => {
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
  });
  const savedScrollTop = await conversation.evaluate((element) => element.scrollTop);
  expect(savedScrollTop).toBeGreaterThan(0);

  await tasksPage.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect(tasksPage).toContainText("Canonical A response");
  form = tasksPage.locator(".task-follow-up-form");
  prompt = form.locator('textarea[name="prompt"]');
  send = form.locator('button[type="submit"]');
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(send).toBeEnabled();

  await prompt.fill("Sent after canonical unlock");
  await send.click();
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
    "Sent after canonical unlock",
  ]);
  await expect(form).toHaveAttribute("aria-busy", "false");

  await prompt.fill("Enter after canonical unlock");
  await prompt.press("Enter");
  await expect.poll(() => submittedPrompts).toEqual([
    "Canonical while response is pending",
    "Sent after canonical unlock",
    "Enter after canonical unlock",
  ]);

  await tasksPage.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(savedScrollTop);

  releaseFirstPrompt?.();
});

test("renders normalized Codex user messages instead of raw ambient context", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Codex message normalization regression");
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      addEventListener() {}
      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_normalized_user_message";
  const now = 1_767_190_400_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Normalized user message",
    preview: "Only this request should be visible.",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Only this request should be visible.",
  };
  const rawAmbientPrompt = [
    "# Files mentioned by the user:",
    "",
    "codex-clipboard-example.png: /tmp/codex-clipboard-example.png",
    "",
    '<in-app-browser-context source="ambient-ui-state">',
    "# In app browser:",
    "- Current URL: http://127.0.0.1:5178/tasks/example",
    "</in-app-browser-context>",
    "",
    "## My request for Codex:",
    "Only this request should be visible.",
  ].join("\n");
  const detail = {
    revision: 1,
    task,
    events: [
      {
        id: "event_normalized_user_prompt",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn_initial",
          item: {
            id: "item_normalized_user_prompt",
            type: "userMessage",
            content: [{ type: "input_text", text: rawAmbientPrompt }],
          },
        },
        createdMs: now,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [task] }) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail) }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Only this request should be visible.");
  await expect(tasksPage).not.toContainText("in-app-browser-context");
  await expect(tasksPage).not.toContainText("Files mentioned by the user");
});

test("accepts canonical task detail after stream revisions restart", async ({ page }) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_stream_bootstrap_after_completion";
  const now = 1_767_190_450_000;
  const staleTask = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_initial",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Stream bootstrap regression",
    preview: "Waiting for canonical response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Working",
  };
  const rawAmbientPrompt = [
    "This block is automatically supplied ambient UI state, not part of the user's request.",
    "## My request for Codex:",
    "Show only the canonical request.",
  ].join("\n");
  const userEvent = {
    id: "event_bootstrap_user_prompt",
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      turnId: "turn_initial",
      item: {
        id: "item_bootstrap_user_prompt",
        type: "userMessage",
        content: [{ type: "input_text", text: rawAmbientPrompt }],
      },
    },
    createdMs: now,
  };
  const staleDetail = {
    revision: 43,
    task: staleTask,
    events: [userEvent],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  const canonicalDetail = {
    revision: 1,
    task: {
      ...staleTask,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      preview: "Canonical response arrived before the stream connected.",
      updatedMs: now + 2,
      lastEventSummary: "Canonical response arrived before the stream connected.",
    },
    events: [
      userEvent,
      {
        id: "event_bootstrap_assistant_response",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_initial",
          text: "Canonical response arrived before the stream connected.",
        },
        createdMs: now + 2,
      },
    ],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [staleTask] }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(staleDetail) }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Show only the canonical request.");
  await expect(tasksPage).not.toContainText("automatically supplied ambient UI state");

  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__taskEventSources.some((source) =>
            source.url.includes(`/api/tasks/${id}/stream`),
          ),
        threadId,
      ),
    )
    .toBe(true);
  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "stream-bootstrap",
    });
  }, { threadId, detail: canonicalDetail });

  await expect(tasksPage).toContainText(
    "Canonical response arrived before the stream connected.",
  );
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toHaveCount(0);
  await expect(tasksPage).not.toContainText("Working for");
  await expect(tasksPage.locator(".task-detail-loading")).toHaveCount(0);
});

test("accepts canonical task sync after stream revisions restart", async ({ page }) => {
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        if (url.startsWith("/api/tasks/stream")) {
          window.__taskListEventSource = this;
        }
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      emitOpen() {
        this.readyState = 1;
        this.listeners.get("open")?.({});
      }

      emitError() {
        this.readyState = 0;
        this.listeners.get("error")?.({});
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_list_revision_restart";
  const now = 1_767_190_475_000;
  let task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Task list revision restart",
    preview: "Initial result",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial result",
  };
  let taskListRequests = 0;

  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskListRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    });
  });
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );

  await page.goto("/tasks");
  const row = page.locator(
    `caffold-tasks-page .task-row[data-thread-id="${threadId}"]`,
  );
  await expect(row).toHaveAttribute("data-task-status", "idle");

  await page.evaluate((threadId) => {
    window.__taskListEventSource.emit("task-event", {
      threadId,
      revision: 43,
      event: {
        id: "event_running_before_restart",
        threadId,
        type: "thread_status_changed",
        payload: { status: "running" },
        createdMs: Date.now(),
      },
    });
  }, threadId);
  await expect(row).toHaveAttribute("data-task-status", "idle");

  task = {
    ...task,
    ...canonicalTaskState("active", {
      turnId: "turn_before_restart",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
  };
  await page.evaluate(() => {
    window.__taskListEventSource.emitError();
    window.__taskListEventSource.emitOpen();
  });
  await expect.poll(() => taskListRequests).toBe(2);
  await expect(row).toHaveAttribute("data-task-status", "running");

  await page.evaluate(({ threadId, task }) => {
    window.__taskListEventSource.emit("task-sync", {
      threadId,
      revision: 1,
      detail: {
        threadId,
        syncState: "ready",
        task,
      },
      reason: "canonical-idle-after-restart",
    });
  }, {
    threadId,
    task: {
      ...task,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    },
  });
  await expect(row).toHaveAttribute("data-task-status", "idle");
});

test("keeps task list and detail revisions independent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Wide task stream regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, payload) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) });
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_independent_stream_revisions";
  const now = 1_767_190_500_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Independent task stream revisions",
    preview: "Initial answer",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Initial answer",
  };
  const initialEvents = [
    {
      id: "event_normalized_user_prompt",
      threadId,
      type: "user_message",
      summary: "User prompt",
      payload: {
        turnId: "turn_initial",
        prompt: "Initial prompt",
        text: "Only this request should be visible.",
      },
      createdMs: now,
    },
    {
      id: "event_initial_answer",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: { turnId: "turn_initial", text: "Initial answer" },
      createdMs: now + 1,
    },
  ];
  const detail = (revision, events = initialEvents) => ({
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  const submittedPrompts = [];

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task] }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(detail(1)) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), async (route) => {
    submittedPrompts.push(route.request().postDataJSON().prompt);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ threadId, turnId: "turn_follow_up", steered: false }),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("Only this request should be visible.");

  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThanOrEqual(2);
  await page.evaluate(({ threadId, task }) => {
    const listSource = window.__taskEventSources.find(
      (source) => source.url.startsWith("/api/tasks/stream"),
    );
    listSource.emit("task-sync", {
      threadId,
      revision: 100,
      detail: {
        revision: 100,
        task: { ...task, updatedMs: task.updatedMs + 100 },
        events: [],
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      },
    });
  }, { threadId, task });

  const externalEvent = {
    id: "event_external_detail_update",
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: { turnId: "turn_external", text: "Detail stream update is visible." },
    createdMs: now + 2,
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "external-update",
    });
  }, { threadId, detail: detail(2, [...initialEvents, externalEvent]) });
  await expect(tasksPage).toContainText("Detail stream update is visible.");

  const runningTask = {
    ...task,
    ...canonicalTaskState("active", { latestTurnStatus: "inProgress" }),
    lastEventSummary: "Running command",
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-status-sync",
    });
  }, {
    threadId,
    detail: {
      ...detail(3, [...initialEvents, externalEvent]),
      task: runningTask,
    },
  });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  const historyEvent = {
    id: "event_history_after_status",
    threadId,
    type: "assistant_message",
    summary: "Assistant progress",
    payload: { turnId: "turn_external", text: "History synchronized after status." },
    createdMs: now + 3,
  };
  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-sync",
    });
  }, {
    threadId,
    detail: {
      ...detail(4, [...initialEvents, externalEvent, historyEvent]),
      task: runningTask,
    },
  });
  await expect(tasksPage).toContainText("History synchronized after status.");
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  await page.evaluate(({ threadId, detail }) => {
    const detailSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    detailSource.emit("task-sync", {
      threadId,
      revision: detail.revision,
      detail,
      reason: "canonical-status-sync",
    });
  }, {
    threadId,
    detail: detail(5, [...initialEvents, externalEvent, historyEvent]),
  });
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toHaveCount(0);

  const form = tasksPage.locator(".task-follow-up-form");
  await form.locator('textarea[name="prompt"]').fill("Follow-up after list update");
  await form.getByRole("button", { name: "Send prompt" }).click();
  await expect.poll(() => submittedPrompts).toEqual(["Follow-up after list update"]);
});

test("isolates task detail responses and conversation scroll by thread", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Wide master-detail regression");
  await page.addInitScript(() => {
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
      }

      addEventListener() {}

      close() {}
    };
  });
  await mockCodexModels(page);

  const now = 1_767_191_000_000;
  const makeTask = (threadId, title, offset) => ({
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title,
    preview: `${title} preview`,
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + offset,
    recencyMs: now + offset,
    lastEventSummary: `${title} preview`,
  });
  const taskA = makeTask("thread_scroll_a", "Thread A", 1);
  const taskB = makeTask("thread_scroll_b", "Thread B", 2);
  const tasks = [taskB, taskA];
  const detailFor = (task) => ({
    revision: 1,
    task,
    model: "gpt-5.6-sol",
    reasoningEffort: task.threadId === taskA.threadId ? "xhigh" : "low",
    permissionMode:
      task.threadId === taskA.threadId
        ? "askForApproval"
        : "approveForMe",
    events: Array.from({ length: 20 }, (_, index) => ({
      id: `${task.threadId}_event_${index}`,
      threadId: task.threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: `${task.threadId}_turn_${index}`,
        text: `${task.title} response ${index + 1}.\n\n${"Thread-specific scroll content. ".repeat(16)}`,
      },
      createdMs: now + index,
    })),
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  let delayThreadA = false;
  let releaseThreadA;
  let threadAResponseGate = Promise.resolve();

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_[ab](?:\?|$)/, async (route) => {
    const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
    if (threadId === taskA.threadId && delayThreadA) {
      await threadAResponseGate;
    }
    const task = threadId === taskA.threadId ? taskA : taskB;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailFor(task)),
    });
  });

  await page.goto(`/tasks/${taskB.threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const followUp = tasksPage.locator(".task-follow-up-form");
  const followUpPrompt = followUp.getByRole("textbox", {
    name: "Follow-up prompt",
  });
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("Light");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Approve for me");
  await followUpPrompt.fill("Draft for thread B");
  await scroller.evaluate((element) => {
    element.scrollTop = 140;
    element.dispatchEvent(new Event("scroll"));
  });

  delayThreadA = true;
  threadAResponseGate = new Promise((resolve) => {
    releaseThreadA = resolve;
  });
  await tasksPage.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await tasksPage.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  releaseThreadA();
  await expect(page).toHaveURL(`/tasks/${taskB.threadId}`);
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(tasksPage).not.toContainText("Thread A response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);

  delayThreadA = false;
  await tasksPage.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(
    tasksPage.locator('caffold-task-markdown[data-render-state="markdown"]'),
  ).toHaveCount(20);
  await expect(followUpPrompt).toHaveValue("");
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("Extra High");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Ask for approval");
  await followUpPrompt.fill("Draft for thread A");
  await pasteImage(followUpPrompt, "thread-a.png");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(1);
  const taskAAnchor = await scroller.evaluate(async (element) => {
    element.scrollTop = Math.min(250, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scrollerRect = element.getBoundingClientRect();
    const messages = [...element.querySelectorAll(".task-message[data-event-id]")];
    const index = messages.findIndex(
      (message) => message.getBoundingClientRect().bottom > scrollerRect.top + 1,
    );
    const message = messages[index];
    return {
      eventId: message?.dataset.eventId ?? "",
      offset: Math.round(message.getBoundingClientRect().top - scrollerRect.top),
    };
  });
  expect(taskAAnchor.eventId).not.toBe("");
  await tasksPage.locator(`.task-row[data-thread-id="${taskB.threadId}"]`).click();
  await expect(tasksPage).toContainText("Thread B response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread B");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(0);
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("Light");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Approve for me");
  await expect
    .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
    .toBe(140);
  await tasksPage.locator(`.task-row[data-thread-id="${taskA.threadId}"]`).click();
  await expect(tasksPage).toContainText("Thread A response 20.");
  await expect(followUpPrompt).toHaveValue("Draft for thread A");
  await expect(followUp.locator(".task-composer-attachment")).toHaveCount(1);
  await expect(
    followUp.getByRole("button", { name: "Choose model and reasoning" }),
  ).toContainText("Extra High");
  await expect(
    followUp.getByRole("button", { name: "Choose approval mode" }),
  ).toContainText("Ask for approval");
  await expect(
    tasksPage.locator('caffold-task-markdown[data-render-state="markdown"]'),
  ).toHaveCount(20);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element, anchor) => {
          const scrollerRect = element.getBoundingClientRect();
          const message = [...element.querySelectorAll(".task-message[data-event-id]")].find(
            (candidate) => candidate.dataset.eventId === anchor.eventId,
          );
          return message
            ? Math.abs(
                Math.round(message.getBoundingClientRect().top - scrollerRect.top) -
                  anchor.offset,
              ) <= 2
            : false;
        },
        taskAAnchor,
      ),
    )
    .toBe(true);
});

test("opens a running conversation at the latest message when stream sync wins the reload race", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Conversation reload scroll regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) });
        }
      }

      close() {}
    };
  });
  await page.route("https://esm.sh/**", (route) => route.abort());
  await mockCodexModels(page);

  const threadId = "thread_reload_scroll_race";
  const now = 1_767_191_500_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_active",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Reload scroll race",
    preview: "Latest running response",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20,
    recencyMs: now + 20,
    lastEventSummary: "Latest running response",
  };
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `event_reload_scroll_${index}`,
    threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: {
      turnId: `turn_reload_scroll_${index}`,
      text: `Reload race response ${index + 1}.\n\n${"Long running conversation content. ".repeat(16)}`,
    },
    createdMs: now + index,
  }));
  const detail = (revision) => ({
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  });
  let releaseDetailResponse;
  const detailResponseGate = new Promise((resolve) => {
    releaseDetailResponse = resolve;
  });

  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    await detailResponseGate;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail(2)),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);

  await page.evaluate(({ threadId, detail }) => {
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: 1,
      detail,
      reason: "stream-bootstrap",
    });
  }, { threadId, detail: detail(1) });
  await expect(tasksPage).toContainText("Reload race response 20.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);

  await page.evaluate(({ threadId, detail }) => {
    const scroller = document.querySelector(
      "caffold-tasks-page .task-conversation-scroll",
    );
    // A browser reload can restore a nested scroller before the async detail
    // request settles. That transient position must not become task history.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    const source = window.__taskEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", {
      threadId,
      revision: 2,
      detail,
      reason: "running-progress",
    });
  }, { threadId, detail: detail(2) });
  const reachedLatestBeforeDetail = await isScrolledToBottom(scroller);
  releaseDetailResponse();

  expect(reachedLatestBeforeDetail).toBe(true);
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
});

test("keeps task event chronology stable through approval, completion, and reload", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Task chronology regression");
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) });
        }
      }

      close() {}
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_event_chronology";
  const turnId = "turn_event_chronology";
  const now = 1_767_192_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId,
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Event chronology",
    preview: "Keep task events ordered",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Working",
  };
  const event = (id, type, createdMs, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: { threadId, turnId, ...payload },
    createdMs,
  });
  const user = event("event_user", "user_message", now, {
    text: "Keep every task event in order.",
  });
  const reasoning = event("event_reasoning", "reasoning", now + 100, {
    itemId: "reasoning_1",
    lifecycle: "completed",
    summary: ["Inspected the current event sequence."],
  });
  const commentary = event("event_commentary", "assistant_message", now + 200, {
    itemId: "commentary_1",
    phase: "commentary",
    text: "I found the ordering boundary.",
  });
  const matchingCommentary = event(
    "event_matching_commentary",
    "assistant_message",
    now + 250,
    {
      itemId: "commentary_2",
      phase: "commentary",
      text: "The event order is stable.",
    },
  );
  const approvalRequested = event(
    "event_approval_requested",
    "approval_requested",
    now + 300,
    {
      approvalId: "approval_chronology",
      kind: "command",
      params: {
        turnId,
        command: "cargo test",
        cwd: "src",
        reason: "Run the regression test",
      },
    },
  );
  const approvalResolved = event(
    "event_approval_resolved",
    "approval_resolved",
    now + 350,
    {
      approvalId: "approval_chronology",
      kind: "command",
      decision: "accept",
    },
  );
  const commandStarted = event(
    "event_command",
    "command_execution",
    now + 400,
    {
      itemId: "command_1",
      lifecycle: "started",
      command: "cargo test",
      cwd: "src",
      status: "inProgress",
    },
  );
  const plan = event("event_plan", "plan", now + 500, {
    itemId: "plan_1",
    lifecycle: "completed",
    text: "Record the stable ordering contract.",
  });
  const commandCompleted = event(
    "event_command",
    "command_execution",
    now + 600,
    {
      itemId: "command_1",
      lifecycle: "completed",
      command: "cargo test",
      cwd: "src",
      status: "completed",
      aggregatedOutput: "test result: ok",
    },
  );
  const finalAnswer = event("event_final", "assistant_message", now + 700, {
    itemId: "final_1",
    phase: "final",
    text: "The event order is stable.",
  });
  const threadIdle = event(
    "event_thread_idle",
    "thread_status_changed",
    now + 725,
    { status: "idle" },
  );
  const turnCompleted = event("event_turn_completed", "turn_completed", now + 800, {
    status: "completed",
  });
  let detailEvents = [user, reasoning, commentary];
  let detailTask = task;
  let detailRevision = 1;

  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: detailRevision,
        task: detailTask,
        events: detailEvents,
        eventsPage: { nextCursor: null },
        pendingApprovals: [],
      }),
    }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage).toContainText("I found the ordering boundary.");
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBeGreaterThan(0);

  const emitTaskEvent = (entry, revision) =>
    page.evaluate(({ threadId, entry, revision }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-event", { threadId, revision, event: entry });
    }, { threadId, entry, revision });
  const emitTaskSync = (detail, revision) =>
    page.evaluate(({ threadId, detail, revision }) => {
      const source = window.__taskEventSources.find((candidate) =>
        candidate.url.includes(`/api/tasks/${threadId}/stream`),
      );
      source.emit("task-sync", { threadId, revision, detail });
    }, { threadId, detail, revision });
  const visibleEventOrder = () =>
    tasksPage.locator(".task-conversation").evaluate((conversation) =>
      [...conversation.children]
        .map((entry) => {
          if (entry.classList.contains("task-turn-active")) {
            return null;
          }
          if (entry.classList.contains("task-approval-flow")) {
            return "approval_requested";
          }
          return entry.dataset.eventType ?? null;
        })
        .filter(Boolean),
    );

  await emitTaskEvent(matchingCommentary, 2);
  await emitTaskEvent(approvalRequested, 3);
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(1);
  expect(await visibleEventOrder()).toEqual([
    "user_message",
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_requested",
  ]);

  await emitTaskEvent(approvalResolved, 4);
  await emitTaskEvent(commandStarted, 5);
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  expect(await visibleEventOrder()).toEqual([
    "user_message",
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_resolved",
    "command_execution",
  ]);

  await emitTaskEvent(finalAnswer, 6);
  await emitTaskEvent(threadIdle, 7);
  await emitTaskEvent(plan, 8);
  await emitTaskEvent(commandCompleted, 9);
  await expect(tasksPage).toContainText("The event order is stable.");
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(0);
  await expect(tasksPage.locator(".task-turn-active")).toHaveCount(1);

  await emitTaskEvent(turnCompleted, 10);
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  await expect(
    tasksPage.locator('.task-detail-summary .task-status-chip[data-status="running"]'),
  ).toBeVisible();

  const canonicalUser = {
    ...user,
    id: "event_canonical_user",
    sortIndex: 1,
  };
  const canonicalCommentary = {
    ...commentary,
    id: "event_canonical_commentary",
    createdMs: now,
    sortIndex: 2,
    payload: { ...commentary.payload, itemId: "summary_commentary" },
  };
  const canonicalFinal = {
    ...finalAnswer,
    id: "event_canonical_final",
    createdMs: now,
    sortIndex: 3,
    payload: {
      ...finalAnswer.payload,
      itemId: "summary_final",
      phase: "final_answer",
    },
  };
  detailEvents = [
    user,
    reasoning,
    commentary,
    matchingCommentary,
    approvalRequested,
    approvalResolved,
    { ...commandCompleted, createdMs: commandStarted.createdMs },
    plan,
    finalAnswer,
    turnCompleted,
    canonicalUser,
    canonicalCommentary,
    canonicalFinal,
  ];
  detailTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: turnCompleted.createdMs,
    recencyMs: turnCompleted.createdMs,
  };
  detailRevision = 12;
  await emitTaskSync(
    {
      revision: detailRevision,
      task: detailTask,
      events: detailEvents,
      eventsPage: { nextCursor: null },
      pendingApprovals: [],
    },
    detailRevision,
  );
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  const completedWorkDetails = tasksPage.locator(".task-turn-work > details");
  await completedWorkDetails.locator(":scope > summary").click();
  const completedWorkOrder = () =>
    tasksPage.locator(".task-work-item").evaluateAll((items) =>
      items.map((item) => item.dataset.eventType),
    );
  expect(await completedWorkOrder()).toEqual([
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_resolved",
    "command_execution",
    "plan",
  ]);
  const completedCommandDetails = tasksPage.locator(
    '.task-work-item[data-event-type="command_execution"] > details',
  );
  await expect(completedCommandDetails).not.toHaveAttribute("open", "");
  await completedCommandDetails.locator("summary").click();
  await expect(completedWorkDetails).toHaveAttribute("open", "");
  await expect(completedCommandDetails).toHaveAttribute("open", "");

  await test.step("keeps opened work disclosures expanded through a live rerender", async () => {
    await emitTaskEvent(turnCompleted, 13);
    await expect(completedWorkDetails).toHaveAttribute("open", "");
    await expect(completedCommandDetails).toHaveAttribute("open", "");
  });
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const final = element
          .querySelector("caffold-task-detail")
          .events.find(
          (entry) =>
            entry.type === "assistant_message" &&
            ["final", "final_answer"].includes(entry.payload?.phase),
        );
        return final?.createdMs;
      }),
    )
    .toBe(finalAnswer.createdMs);
  await expect(
    tasksPage.locator(
      '.task-work-item[data-event-type="assistant_message"]',
    ),
  ).toHaveCount(2);

  await page.reload();
  await expect(tasksPage).toContainText("The event order is stable.");
  await expect(tasksPage.locator(".task-turn-work")).toHaveCount(1);
  await tasksPage.locator(".task-turn-work > details > summary").click();
  expect(await completedWorkOrder()).toEqual([
    "reasoning",
    "assistant_message",
    "assistant_message",
    "approval_resolved",
    "command_execution",
    "plan",
  ]);
});

test("keeps task conversation scroll anchored during live updates", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, data) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(data) });
        }
      }

      emitOpen() {
        this.readyState = 1;
        for (const listener of this.listeners.get("open") ?? []) {
          listener({});
        }
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        for (const listener of this.listeners.get("error") ?? []) {
          listener({});
        }
      }

      close() {
        this.closed = true;
        this.readyState = 2;
      }
    };
  });

  await mockCodexModels(page);
  const threadId = "thread_scroll_fixture";
  const now = 1_767_200_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", { latestTurnStatus: "inProgress" }),
    title: "Scroll fixture",
    preview: "Latest answer",
    cwd: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20,
    recencyMs: now + 20,
    lastEventSummary: "Latest answer",
  };
  const eventRecord = (id, type, summary, payload, offset) => ({
    id,
    threadId,
    type,
    summary,
    payload,
    createdMs: now + offset,
  });
  const events = Array.from({ length: 18 }, (_, index) =>
    eventRecord(
      `event_scroll_${index}`,
      "assistant_message",
      "Assistant response",
      {
        turnId: `turn_scroll_${index}`,
        text: `Existing answer block ${index + 1}.\n\n${"Scrollable transcript content. ".repeat(14)}`,
      },
      index,
    ),
  );
  const taskDetail = {
    revision: 1,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };
  let taskDetailResponse = taskDetail;
  let taskDetailReadRequests = 0;

  await page.route(/\/api\/git\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        files: [],
      }),
    }),
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repository: { rootPath: "src", branch: "main", dirty: false },
        github: null,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: false,
        pullsAvailable: false,
        message: "No GitHub remote detected",
      }),
    }),
  );
  await page.route(/\/api\/tasks\/thread_scroll_fixture(?:\?|$)/, async (route) => {
    taskDetailReadRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(taskDetailResponse),
    });
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const scroller = tasksPage.locator(".task-conversation-scroll");
  await expect(tasksPage).toContainText("Existing answer block 18.");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);
  await page.evaluate(({ threadId, taskDetail }) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitOpen();
    taskSource.emit("task-sync", {
      threadId,
      revision: taskDetail.revision,
      detail: taskDetail,
      reason: "test",
    });
  }, { threadId, taskDetail });
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect.poll(() => taskDetailReadRequests).toBe(1);

  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        threadId,
        revision: 2,
        event: {
          id: "event_live_bottom",
          threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: {
            turnId: "turn_live_bottom",
            text: `Live answer at the bottom.\n\n${"New live transcript content. ".repeat(16)}`,
          },
          createdMs: now + 100,
        },
      });
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Live answer at the bottom.");
  await expect.poll(() => isScrolledToBottom(scroller)).toBe(true);

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      taskSource.emit("task-event", {
        threadId,
        revision: 3,
        event: {
          id: "event_live_preserve",
          threadId,
          type: "assistant_message",
          summary: "Assistant response",
          payload: {
            turnId: "turn_live_preserve",
            text: `Live answer while reading older content.\n\n${"Preserve the reader position. ".repeat(16)}`,
          },
          createdMs: now + 101,
        },
      });
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Live answer while reading older content.");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(16);
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          element.querySelector("caffold-task-detail").taskRefresh === null,
      ),
    )
    .toBe(true);

  const readsBeforeBurst = taskDetailReadRequests;
  await page.evaluate(
    ({ threadId, now }) => {
      const taskSource = window.__taskEventSources.find((source) =>
        source.url.includes(`/api/tasks/${threadId}/stream`),
      );
      for (let index = 0; index < 3; index += 1) {
        taskSource.emit("task-event", {
          threadId,
          revision: 4 + index,
          event: {
            id: `event_burst_${index}`,
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: {
              turnId: "turn_burst",
              text: `Burst update ${index + 1}`,
            },
            createdMs: now + 200 + index,
          },
        });
      }
    },
    { threadId, now },
  );
  await expect(tasksPage).toContainText("Burst update 3");
  await page.waitForTimeout(100);
  expect(taskDetailReadRequests).toBe(readsBeforeBurst);

  const canonicalEvent = eventRecord(
    "event_external_sync",
    "assistant_message",
    "Assistant response",
    {
      turnId: "turn_external_sync",
      text: "Synced from an external Codex process.",
    },
    400,
  );
  await page.evaluate(({ threadId, taskDetail, canonicalEvent }) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emit("task-sync", {
      threadId,
      revision: 7,
      reason: "external-update",
      detail: {
        ...taskDetail,
        revision: 7,
        events: [...taskDetail.events, canonicalEvent],
      },
    });
  }, { threadId, taskDetail, canonicalEvent });
  await expect(tasksPage).toContainText("Synced from an external Codex process.");
  expect(taskDetailReadRequests).toBe(readsBeforeBurst);

  await page.evaluate(({ threadId, taskDetail }) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emit("task-event", {
      threadId,
      revision: 6,
      event: {
        id: "event_stale_revision",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: { turnId: "turn_stale", text: "Stale event must stay hidden." },
        createdMs: Date.now(),
      },
    });
    taskSource.emit("task-sync", {
      threadId,
      revision: 6,
      reason: "stale-test",
      detail: {
        ...taskDetail,
        revision: 6,
        events: [
          ...taskDetail.events,
          {
            id: "snapshot_stale_revision",
            threadId,
            type: "assistant_message",
            summary: "Assistant response",
            payload: {
              turnId: "turn_stale_snapshot",
              text: "Stale snapshot must stay hidden.",
            },
            createdMs: Date.now(),
          },
        ],
      },
    });
  }, { threadId, taskDetail });
  await expect(tasksPage).not.toContainText("Stale event must stay hidden.");
  await expect(tasksPage).not.toContainText("Stale snapshot must stay hidden.");

  const readsBeforeVisibility = taskDetailReadRequests;
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => taskDetailReadRequests).toBe(readsBeforeVisibility + 1);

  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitError();
  }, threadId);
  await expect(
    tasksPage.locator('.task-stream-state[data-stream-state="reconnecting"]'),
  ).toContainText("Caffold server connection lost");
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-live-reconnecting");

  const readsBeforeReconnect = taskDetailReadRequests;
  const reconnectEvent = eventRecord(
    "event_reconnect_sync",
    "assistant_message",
    "Assistant response",
    {
      turnId: "turn_reconnect_sync",
      text: "Synced after reconnect.",
    },
    500,
  );
  taskDetailResponse = {
    ...taskDetail,
    revision: 8,
    task: {
      ...taskDetail.task,
      ...canonicalTaskState("idle"),
    },
    events: [...taskDetail.events, reconnectEvent],
  };
  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    taskSource.emitOpen();
  }, threadId);
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect(tasksPage).toContainText("Synced after reconnect.");
  await expect.poll(() => taskDetailReadRequests).toBe(readsBeforeReconnect + 1);

  const sourcesBeforeRetry = await page.evaluate(() => window.__taskEventSources.length);
  await page.evaluate((threadId) => {
    const taskSource = window.__taskEventSources.find((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`) && !source.closed,
    );
    taskSource.emitError(true);
  }, threadId);
  const streamError = tasksPage.locator(
    '.task-stream-state[data-stream-state="unavailable"]',
  );
  await expect(streamError).toContainText("Caffold server unavailable.");
  await streamError.getByRole("button", { name: "Retry" }).click();
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__taskEventSources.length))
    .toBe(sourcesBeforeRetry + 1);
  await page.evaluate((threadId) => {
    const sources = window.__taskEventSources.filter((source) =>
      source.url.includes(`/api/tasks/${threadId}/stream`),
    );
    sources.at(-1).emitOpen();
  }, threadId);
});

test("makes disconnected task state unavailable and reconciles an uncertain prompt", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__taskEventSources = [];
    window.EventSource = class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.readyState = 0;
        window.__taskEventSources.push(this);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, payload) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener({ data: JSON.stringify(payload) });
        }
      }

      emitOpen() {
        this.readyState = 1;
        for (const listener of this.listeners.get("open") ?? []) {
          listener({});
        }
      }

      emitError(closed = false) {
        this.readyState = closed ? 2 : 0;
        for (const listener of this.listeners.get("error") ?? []) {
          listener({});
        }
      }

      close() {
        this.closed = true;
        this.readyState = 2;
      }
    };
  });
  await mockCodexModels(page);

  const threadId = "thread_self_host_restart";
  const now = 1_767_210_000_000;
  const promptText = "Prompt accepted before the server stopped";
  let task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: "turn_before_restart",
      startedAtMs: now,
      latestTurnStatus: "inProgress",
    }),
    title: "Self-host restart fixture",
    preview: "Work is active",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now,
    recencyMs: now,
    lastEventSummary: "Work is active",
  };
  let revision = 1;
  let reconnectDetailRead = null;
  let releaseReconnectDetailRead = null;
  let events = [
    {
      id: "event_before_restart",
      threadId,
      type: "assistant_message",
      summary: "Assistant response",
      payload: {
        turnId: "turn_before_restart",
        text: "Work is active before the restart.",
      },
      createdMs: now,
    },
  ];
  let promptAccepted = false;
  const detail = () => ({
    threadId,
    syncState: "ready",
    revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    }),
  );
  await page.route(/\/api\/task-history(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), async (route) => {
    await reconnectDetailRead;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail()),
    });
  });
  await page.route(new RegExp(`/api/tasks/${threadId}/prompts(?:\\?|$)`), (route) => {
    promptAccepted = true;
    revision += 1;
    task = {
      ...task,
      ...canonicalTaskState("idle", { latestTurnStatus: "interrupted" }),
      preview: "Restart interrupted the host task",
      updatedMs: now + 2,
      recencyMs: now + 2,
      lastEventSummary: "Restart interrupted the host task",
    };
    events = [
      ...events,
      {
        id: "event_prompt_after_restart",
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: {
          turnId: "turn_after_restart",
          text: promptText,
        },
        createdMs: now + 1,
      },
      {
        id: "event_interrupted_after_restart",
        threadId,
        type: "assistant_message",
        summary: "Assistant response",
        payload: {
          turnId: "turn_after_restart",
          phase: "commentary",
          text: "The host stopped after accepting the prompt.",
        },
        createdMs: now + 2,
      },
    ];
    return route.abort("failed");
  });

  await page.goto(`/tasks/${threadId}?cwd=src`);
  const tasksPage = page.locator("caffold-tasks-page");
  const form = tasksPage.locator(".task-follow-up-form");
  const textarea = form.locator('textarea[name="prompt"]');
  const taskRow = tasksPage.locator(
    `.task-row[data-thread-id="${threadId}"]`,
  );
  await expect(tasksPage).toContainText("Work is active before the restart.");

  reconnectDetailRead = new Promise((resolve) => {
    releaseReconnectDetailRead = resolve;
  });
  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitOpen();
      }
    }
  }, threadId);

  await textarea.fill(promptText);
  await textarea.press("Enter");
  await expect.poll(() => promptAccepted).toBe(true);

  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitError();
      }
    }
  }, threadId);

  const uncertainPrompt = tasksPage
    .locator('.task-message[data-message-role="user"]')
    .filter({ hasText: promptText });
  await expect(uncertainPrompt).toHaveAttribute(
    "data-delivery-state",
    "outcomeUnknown",
  );
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="reconnecting"]',
    ),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="running"]',
    ),
  ).toHaveCount(0);
  await expect(
    tasksPage.locator('[data-task-action="interrupt"]'),
  ).toBeDisabled();
  await expect(textarea).toBeDisabled();
  await expect(taskRow).toHaveAttribute("data-task-status", "reconnecting");
  await expect(
    tasksPage.locator(
      '.task-stream-state[data-stream-state="reconnecting"]',
    ),
  ).toContainText("Caffold server connection lost");

  await page.evaluate((threadId) => {
    for (const source of window.__taskEventSources) {
      if (
        source.url.startsWith("/api/tasks/stream") ||
        source.url.includes(`/api/tasks/${threadId}/stream`)
      ) {
        source.emitOpen();
      }
    }
  }, threadId);

  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="reconnecting"]',
    ),
  ).toBeVisible();
  await expect(
    tasksPage.locator(
      '.task-stream-state[data-stream-state="reconnecting"]',
    ),
  ).toBeVisible();
  releaseReconnectDetailRead();
  reconnectDetailRead = null;
  await expect(tasksPage).toContainText(
    "The host stopped after accepting the prompt.",
  );
  const canonicalPrompt = tasksPage
    .locator('.task-message[data-message-role="user"]')
    .filter({ hasText: promptText });
  await expect(canonicalPrompt).toHaveCount(1);
  await expect(canonicalPrompt).not.toHaveAttribute(
    "data-delivery-state",
    "outcomeUnknown",
  );
  await expect(tasksPage.locator(".task-stream-state")).toHaveCount(0);
  await expect(
    tasksPage.locator(
      '.task-detail-summary .task-status-chip[data-status="running"]',
    ),
  ).toHaveCount(0);
  await expect(taskRow).toHaveAttribute("data-task-status", "idle");
  await expect(textarea).toBeEnabled();

  await page.evaluate(() => {
    const listSource = window.__taskEventSources.find(
      (source) => source.url.startsWith("/api/tasks/stream") && !source.closed,
    );
    listSource.emitError();
  });
  await tasksPage.getByRole("button", { name: "New Task" }).click();
  const newTaskForm = tasksPage.locator(".task-new-form");
  await expect(newTaskForm.locator('textarea[name="prompt"]')).toBeDisabled();
  await expect(
    newTaskForm.getByRole("button", { name: "Start task" }),
  ).toBeDisabled();
});
