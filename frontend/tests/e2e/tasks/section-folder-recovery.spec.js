import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { TASK_PERMISSION_FIXTURE } from "../support/task-api-fixture.js";
import { enterActionHints } from "../support/action-hints.js";
import {
  installEventSourceMock,
  mockAgentModels,
  canonicalTaskState,
  captureReviewScreenshot
} from "../support/task-fixtures.js";

const OLD = "Users/me/Workspace/rust/codger";
const PARENT = "Users/me/Projects";
const MOVED = `${PARENT}/codger`;

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
  await page.route("**/api/agent/permissions*", (route) =>
    route.fulfill({ json: TASK_PERMISSION_FIXTURE })
  );
});

async function fixture(
  page,
  {
    status = "missing",
    original = OLD,
    holdCheck,
    holdPost,
    failFirst = false,
    beforePostReply
  } = {}
) {
  const state = { path: original, status, posts: [], checks: 0 };
  const updatedMs = Date.now() - 120_000;
  const snapshot = () => ({
    sectionId: "source",
    path: state.path,
    directory: {
      status: state.status,
      message: state.status === "unavailable" ? "Permission denied" : null
    },
    browsePath: PARENT,
    reconnectUnavailableReason: null
  });
  await page.route("**/api/health*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        root: "/",
        homePath: "Users/me",
        initialPath: "Users/me"
      }
    });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        sections: [
          {
            id: "source",
            name: state.path,
            repository: true,
            directory: snapshot().directory,
            tasks: [
              {
                threadId: "one",
                title: "Section folder recovery",
                ...canonicalTaskState("idle"),
                worktree: true,
                updatedMs,
                recencyMs: updatedMs
              }
            ]
          },
          {
            id: "other",
            name: "Users/me/Projects/gluesql",
            repository: false,
            tasks: [
              {
                threadId: "two",
                title: "Query review",
                ...canonicalTaskState("idle"),
                worktree: false,
                updatedMs,
                recencyMs: updatedMs
              }
            ]
          }
        ],
        unsectioned: []
      }
    })
  );
  await page.route("**/api/tasks/sections/source/directory", async (route) => {
    state.checks += 1;
    await holdCheck;
    await route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/tasks/sections/source/reconnect", async (route) => {
    state.posts.push(route.request().postDataJSON());
    await holdPost;
    if (failFirst && state.posts.length === 1) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "section_reconnect_busy",
            message: "A Task is still running. Try again after it finishes."
          }
        }
      });
    } else {
      state.path = state.posts.at(-1).path;
      state.status = "available";
      await beforePostReply?.();
      await route.fulfill({ json: snapshot() });
    }
  });
  await page.route(/\/api\/list(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    const names =
      path === PARENT
        ? ["codger", "gluesql"]
        : ["caffold", "desktop", "docs", "frontend"];
    return route.fulfill({
      json: {
        root: "/",
        path,
        git: null,
        entries: names.map((name) => ({
          name,
          path: `${path}/${name}`,
          kind: "directory",
          isSymlink: false,
          supported: true,
          gitIgnored: false,
          git: null
        }))
      }
    });
  });
  return state;
}

test("a late GitHub answer cannot uncover shortcuts during folder recovery", { tag: "@viewport-independent" }, async ({ page }) => {
  let releaseCheck;
  const holdCheck = new Promise((resolve) => { releaseCheck = resolve; });
  let releaseGitHub;
  const holdGitHub = new Promise((resolve) => { releaseGitHub = resolve; });
  const state = await fixture(page, { status: "available", holdCheck });
  let githubRequests = 0;
  await page.route("**/api/github/status*", async (route) => {
    githubRequests += 1;
    await holdGitHub;
    await route.fulfill({ json: {
      repository: { rootPath: OLD, branch: "main", dirty: false },
      github: { owner: "example", name: "project", nameWithOwner: "example/project", url: "https://github.com/example/project" },
      ghAvailable: true,
      authenticated: true,
      issuesAvailable: true,
      pullsAvailable: true,
      message: null,
    } });
  });
  await page.goto("/?section=source");
  await expect.poll(() => state.checks).toBeGreaterThan(0);
  await expect.poll(() => githubRequests).toBeGreaterThan(0);
  const shortcuts = page.locator("caffold-section-github-shortcuts");
  state.status = "missing";
  releaseCheck();
  await expect(page.locator("caffold-section-folder-recovery")).toBeVisible();
  await expect(shortcuts).toBeHidden();
  releaseGitHub();
  // Wait for the answer's rendered content, rather than an unrelated turn
  // of the event loop, before checking that the deactivated row stays hidden.
  await expect(shortcuts.locator(".section-github-name")).toHaveText("example/project");
  await expect(shortcuts).toHaveAttribute("hidden", "");
  await expect(shortcuts).toBeHidden();
  await expect(page.locator("caffold-section-detail caffold-task-create")).toBeHidden();
  await expect(page.locator("caffold-section-conversation-shortcuts")).toBeHidden();

  state.status = "available";
  await page.locator("caffold-section-folder-recovery").getByRole("button", { name: "Check again" }).click();
  await expect(page.locator("caffold-section-folder-recovery")).toBeHidden();
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole("button", { name: "Issues", exact: true })).toBeEnabled();
  await expect(page.locator("caffold-section-detail caffold-task-create")).toBeVisible();
  await expect(page.locator("caffold-section-conversation-shortcuts")).toBeVisible();
});

test("a live list refresh before the mutation reply leaves the completed Section ready", { tag: "@viewport-independent" }, async ({ page }) => {
  await fixture(page, {
    beforePostReply: async () => {
      await page.evaluate(() => window.__taskListSource.emit("task-list-refresh", {}));
      await expect(page.locator("caffold-section-folder-recovery")).toBeHidden();
    },
  });
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  await recovery.getByRole("button", { name: "Show folders", exact: true }).click();
  await recovery.locator(".file-tree-entry").filter({
    has: page.locator(".file-tree-name", { hasText: /^codger$/ }),
  }).click();
  await recovery.getByRole("button", { name: "Reconnect folder", exact: true }).click();
  await expect(recovery).toBeHidden();
  await expect(page.locator("caffold-section-detail caffold-task-create")).toBeVisible();
  await expect(page.locator("caffold-section-detail")).not.toContainText("may fail to restore");
});

test(
  "reconnects inside the Section with the existing folder picker",
  { tag: "@all-viewports" },
  async ({ page }, testInfo) => {
    const state = await fixture(page);
    await page.goto("/?section=source");
    const recovery = page.locator("caffold-section-folder-recovery");
    await expect(
      recovery.getByRole("heading", { name: "Reconnect folder", exact: true })
    ).toBeVisible();
    await expect(
      page.locator("caffold-section-detail caffold-task-create")
    ).toBeHidden();
    await expect(page.locator(".section-folder-warning")).toHaveCount(1);
    await expect(recovery.locator(".previous-path")).toHaveText(
      "~/Workspace/rust/codger"
    );
    await expect(
      recovery.getByRole("button", { name: "Reconnect folder", exact: true })
    ).toBeDisabled();
    const picker = recovery.locator("caffold-task-directory-field");
    await picker
      .getByRole("button", { name: "Show folders", exact: true })
      .click();
    await expect(
      picker.locator(".file-tree-name", { hasText: /^codger$/ })
    ).toBeVisible();
    expect(state.posts).toHaveLength(0);
    await picker
      .locator(".file-tree-entry")
      .filter({ has: page.locator(".file-tree-name", { hasText: /^codger$/ }) })
      .click();
    await expect(picker.locator(".task-directory-field-path")).toHaveText(
      "~/Projects/codger"
    );
    await expect(
      recovery.getByRole("button", { name: "Reconnect folder", exact: true })
    ).toBeEnabled();
    const presentation = await recovery.evaluate((host) => {
      const root = host.shadowRoot;
      const button = (selector) => {
        const style = getComputedStyle(root.querySelector(selector));
        return [
          style.backgroundColor,
          style.color,
          style.borderColor,
          style.borderRadius,
          style.minHeight,
          style.fontSize
        ];
      };
      const heading = getComputedStyle(root.querySelector("h2"));
      const card = getComputedStyle(host);
      const section = host.getRootNode().host;
      return {
        reconnect: button(".reconnect"),
        recheck: button(".recheck"),
        heading: [heading.fontSize, heading.fontWeight],
        card: [card.backgroundColor, card.borderColor, card.borderRadius],
        topInset:
          host.getBoundingClientRect().top - section.getBoundingClientRect().top
      };
    });
    expect(presentation.reconnect).toEqual(presentation.recheck);
    expect(presentation.topInset).toBeGreaterThanOrEqual(12);
    expect(state.posts).toHaveLength(0);
    await captureReviewScreenshot(page, testInfo, "section-folder-reconnect");
    const bounds = await recovery.boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await recovery
      .getByRole("button", { name: "Reconnect folder", exact: true })
      .click();
    await expect(recovery).toBeHidden();
    await expect(
      page.locator("caffold-section-detail .task-create-fixed-directory-path")
    ).toHaveText("~/Projects/codger");
    await expect(page.locator(".section-folder-warning")).toHaveCount(0);
    await expect(page).toHaveURL("/?section=source");
    expect(state.posts).toEqual([{ expectedPath: OLD, path: MOVED }]);
    const existing = page.locator("caffold-section-conversation-shortcuts");
    await expect(existing).toBeVisible();
    const reference = await existing.evaluate((host) => {
      const heading = getComputedStyle(host.shadowRoot.querySelector("h2"));
      const card = getComputedStyle(host);
      return {
        heading: [heading.fontSize, heading.fontWeight],
        card: [card.backgroundColor, card.borderColor, card.borderRadius]
      };
    });
    expect(presentation.heading).toEqual(reference.heading);
    expect(presentation.card).toEqual(reference.card);
  }
);

test("the missing-folder warning stays beside short and truncated Section names", {
  tag: ["@desktop", "@foldable"]
}, async ({ page }) => {
  const state = await fixture(page);
  for (const name of ["codger", "a-long-repository-name-".repeat(12)]) {
    state.path = `Users/me/Workspace/rust/${name}`;
    await page.goto("/?section=source");
    const section = page.locator(
      'caffold-active-task-section[data-section-id="source"]'
    );
    await expect(section.locator(".task-repository-name")).toHaveText(name);
    const bounds = await section.evaluate((host) => {
      const root = host.shadowRoot;
      const label = root.querySelector(".task-repository-name");
      const warning = root.querySelector(".section-folder-warning");
      const count = root.querySelector(".task-repository-count");
      return {
        gap:
          warning.getBoundingClientRect().left -
          label.getBoundingClientRect().right,
        warningRight: warning.getBoundingClientRect().right,
        countLeft: count.getBoundingClientRect().left,
        truncated: label.scrollWidth > label.clientWidth
      };
    });
    expect(bounds.gap).toBeGreaterThanOrEqual(0);
    expect(bounds.gap).toBeLessThanOrEqual(12);
    expect(bounds.warningRight).toBeLessThan(bounds.countLeft);
    expect(bounds.truncated).toBe(name !== "codger");
  }
});

test("locks submission, retains a rejected candidate, and retries explicitly", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  let release;
  const holdPost = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { holdPost, failFirst: true });
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  const picker = recovery.locator("caffold-task-directory-field");
  await picker
    .getByRole("button", { name: "Type a path", exact: true })
    .click();
  await picker.getByRole("combobox").fill("~/Projects/codger/");
  await picker.getByRole("combobox").press("Enter");
  const reconnect = recovery.getByRole("button", {
    name: "Reconnect folder",
    exact: true
  });
  await expect(reconnect).toBeEnabled();
  await reconnect.click();
  await expect(
    recovery.getByRole("button", { name: "Reconnecting…" })
  ).toBeDisabled();
  await expect(
    picker.getByRole("button", { name: "Show folders", exact: true })
  ).toBeDisabled();
  await expect.poll(() => state.posts.length).toBe(1);
  release();
  await expect(recovery.getByRole("alert")).toContainText(
    "A Task is still running"
  );
  await expect(picker.locator(".task-directory-field-path")).toHaveText(
    "~/Projects/codger"
  );
  expect(state.posts).toHaveLength(1);
  await reconnect.click();
  await expect(recovery).toBeHidden();
  expect(state.posts).toHaveLength(2);
});

test("an old folder check cannot replace another Section", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  let release;
  const holdCheck = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { holdCheck });
  await page.goto("/?section=source");
  await expect(page.locator("caffold-section-folder-recovery")).toBeVisible();
  await expect.poll(() => state.checks).toBe(1);
  await page
    .locator(
      'caffold-active-task-section[data-section-id="other"] .task-repository-select'
    )
    .click();
  await expect(page).toHaveURL("/?section=other");
  release();
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Projects/gluesql");
  await expect(page.locator("caffold-section-folder-recovery")).toBeHidden();
});

test("an inactive normal Section ignores its old check and rechecks on return", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  let release;
  const holdCheck = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { status: "available", holdCheck });
  await page.goto("/?section=source");
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Workspace/rust/codger");
  await expect(page.locator("caffold-section-folder-recovery")).toBeHidden();
  await expect.poll(() => state.checks).toBe(1);

  state.status = "missing";
  await page
    .locator(
      'caffold-active-task-section[data-section-id="other"] .task-repository-select'
    )
    .click();
  await expect(page).toHaveURL("/?section=other");
  release();
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Projects/gluesql");
  await expect(page.locator("caffold-section-folder-recovery")).toBeHidden();

  await page
    .locator(
      'caffold-active-task-section[data-section-id="source"] .task-repository-select'
    )
    .click();
  await expect(page).toHaveURL("/?section=source");
  await expect(
    page.locator("caffold-section-folder-recovery").getByRole("heading", {
      name: "Reconnect folder",
      exact: true
    })
  ).toBeVisible();
  expect(state.checks).toBeGreaterThanOrEqual(2);
  expect(state.posts).toHaveLength(0);
});

test("an unreadable folder offers recheck without claiming it is missing", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  await fixture(page, { status: "unavailable" });
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  await expect(recovery.getByRole("heading")).toHaveText(
    "Section folder unavailable"
  );
  await expect(recovery).toContainText("Permission denied");
  await expect(recovery.locator("caffold-task-directory-field")).toHaveCount(0);
  await expect(page.locator(".section-folder-warning")).toHaveCount(0);
  await expect(
    recovery.getByRole("button", { name: "Check again" })
  ).toBeEnabled();
});

test("a restored original returns to normal Section creation after recheck", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  await expect(
    recovery.getByRole("heading", { name: "Reconnect folder", exact: true })
  ).toBeVisible();
  state.status = "available";
  await recovery.getByRole("button", { name: "Check again" }).click();
  await expect(recovery).toBeHidden();
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Workspace/rust/codger");
  expect(state.posts).toHaveLength(0);
});

test("a mutation finishing after navigation leaves the selected Section intact", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  let release;
  const holdPost = new Promise((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, { holdPost });
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  const picker = recovery.locator("caffold-task-directory-field");
  await picker
    .getByRole("button", { name: "Type a path", exact: true })
    .click();
  await picker.getByRole("combobox").fill("~/Projects/codger/");
  await picker.getByRole("combobox").press("Enter");
  await expect(picker.locator(".task-directory-field-path")).toHaveText(
    "~/Projects/codger"
  );
  await recovery
    .getByRole("button", { name: "Reconnect folder", exact: true })
    .click();
  await expect.poll(() => state.posts.length).toBe(1);
  await page
    .locator(
      'caffold-active-task-section[data-section-id="other"] .task-repository-select'
    )
    .click();
  await expect(page).toHaveURL("/?section=other");
  release();
  await expect.poll(() => state.path).toBe(MOVED);
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Projects/gluesql");
  await page.goto("/?section=source");
  await expect(
    page.locator("caffold-section-detail .task-create-fixed-directory-path")
  ).toHaveText("~/Projects/codger");
  expect(state.posts).toHaveLength(1);
});

test("the recovery picker keeps editing Escape and exposes its own Action Hints", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  await fixture(page);
  await page.goto("/?section=source");
  const recovery = page.locator("caffold-section-folder-recovery");
  const picker = recovery.locator("caffold-task-directory-field");
  await picker
    .getByRole("button", { name: "Type a path", exact: true })
    .click();
  await picker.getByRole("combobox").press("Escape");
  await expect(picker).toHaveAttribute("data-node", "browsing");
  await expect(page).toHaveURL("/?section=source");
  await picker
    .getByRole("button", { name: "Type a path", exact: true })
    .click();
  await picker.getByRole("combobox").fill("~/Projects/codger/");
  await picker.getByRole("combobox").press("Enter");
  await expect(
    recovery.getByRole("button", { name: "Reconnect folder", exact: true })
  ).toBeEnabled();
  const hints = await enterActionHints(page);
  await expect(
    hints.getByRole("button", { name: / — Reconnect folder$/ })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hints).toBeHidden();
  await expect(
    page.locator("caffold-section-detail caffold-task-create")
  ).toBeHidden();
});

test("Task errors lead to the same Section recovery surface", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  await fixture(page);
  await page.route("**/api/tasks/one", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "managed_worktree_unavailable",
          message: "The original repository is unavailable.",
          allowedActions: ["retry"]
        }
      }
    })
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Section folder recovery/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__caffoldTaskSse.source("one")))
    )
    .toBe(true);
  await page.evaluate(() =>
    window.__caffoldTaskSse.source("one").emit("task-sync", {
      threadId: "one",
      revision: 0,
      reason: "stream-bootstrap",
      detail: {
        threadId: "one",
        revision: 0,
        eventRevision: 0,
        syncState: "loading",
        task: null,
        events: [],
        eventsPage: { nextCursor: null }
      },
      error: {
        code: "managed_worktree_unavailable",
        message: "The original repository is unavailable.",
        allowedActions: ["retry"]
      }
    })
  );
  await page
    .getByRole("button", { name: "Reconnect Section folder", exact: true })
    .click();
  await expect(page).toHaveURL("/?section=source");
  await expect(
    page
      .locator("caffold-section-folder-recovery")
      .getByRole("heading", { name: "Reconnect folder", exact: true })
  ).toBeVisible();
});

test("a missing individual worktree keeps its deletion flow", {
  tag: "@viewport-independent"
}, async ({ page }) => {
  await fixture(page);
  await page.route("**/api/tasks/one", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "managed_worktree_missing",
          message: "The worktree folder is missing.",
          allowedActions: ["deleteTask"],
          worktreeId: "missing-owned",
          worktreePath: "/managed/missing-owned",
          worktreeMissing: true
        }
      }
    })
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Section folder recovery/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__caffoldTaskSse.source("one")))
    )
    .toBe(true);
  await page.evaluate(() =>
    window.__caffoldTaskSse.source("one").emit("task-sync", {
      threadId: "one",
      revision: 0,
      reason: "stream-bootstrap",
      detail: {
        threadId: "one",
        revision: 0,
        eventRevision: 0,
        syncState: "loading",
        task: null,
        events: [],
        eventsPage: { nextCursor: null }
      },
      error: {
        code: "managed_worktree_missing",
        message: "The worktree folder is missing.",
        allowedActions: ["deleteTask"],
        worktreeId: "missing-owned",
        worktreePath: "/managed/missing-owned",
        worktreeMissing: true
      }
    })
  );
  await expect(
    page.getByRole("button", { name: "Delete task", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect Section folder", exact: true })
  ).toHaveCount(0);
});

test(
  "long original paths fit the existing layout in dark mode at larger Interface scale",
  { tag: "@all-viewports" },
  async ({ page }, testInfo) => {
    const long = `${OLD}/${"a-long-original-folder-name/".repeat(8)}repository`;
    await fixture(page, { original: long });
    await page.goto("/?section=source");
    await page.evaluate(async () => {
      const settings = await import("/assets/settings.js");
      settings.setAppearanceRangeSetting("interfaceScalePercent", 120);
      settings.setThemeMode("dark");
    });
    const recovery = page.locator("caffold-section-folder-recovery");
    await expect(
      recovery.getByRole("heading", { name: "Reconnect folder", exact: true })
    ).toBeVisible();
    const previous = recovery.locator(".previous-path");
    await expect(previous).toHaveText(long.replace("Users/me", "~"));
    await expect
      .poll(() =>
        previous.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
      .toBe(true);
    await expect(
      page.locator("caffold-section-detail caffold-task-create")
    ).toBeHidden();
    await recovery
      .locator("caffold-task-directory-field")
      .getByRole("button", { name: "Show folders", exact: true })
      .click();
    await expect(
      recovery.locator(".file-tree-name", { hasText: /^codger$/ })
    ).toBeVisible();
    await captureReviewScreenshot(
      page,
      testInfo,
      "section-folder-reconnect-dark-long"
    );
    const reconnect = recovery.getByRole("button", {
      name: "Reconnect folder",
      exact: true
    });
    await reconnect.scrollIntoViewIfNeeded();
    const button = await reconnect.boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.y + button.height).toBeLessThanOrEqual(
      page.viewportSize().height
    );
  }
);
