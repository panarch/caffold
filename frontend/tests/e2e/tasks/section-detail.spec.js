import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { taskDetailFixture } from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("selects a Section and opens fixed-directory Task creation", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_section_entry",
    threadId: "thread_section_entry",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section entry Task",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section entry summary",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto("/");
  const section = page.locator(
    'caffold-active-task-list .task-repository-select[data-section-id="fixture-section-1"]',
  );
  const sectionHeader = page.locator(
    'caffold-active-task-list caffold-active-task-section[data-section-id="fixture-section-1"] > .task-repository-header',
  );
  const sectionCount = sectionHeader.locator(".task-repository-count");
  await expect(section).toBeVisible();
  await expect(section).toHaveJSProperty("tagName", "BUTTON");
  await expect.poll(() => sectionCount.evaluate((count) => {
    const bounds = count.getBoundingClientRect();
    return document
      .elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      )
      ?.closest(".task-repository-select")?.tagName ?? "";
  })).toBe("BUTTON");
  const headerBounds = await sectionHeader.boundingBox();
  const countBounds = await sectionCount.boundingBox();
  await sectionHeader.click({
    position: {
      x: countBounds.x + countBounds.width / 2 - headerBounds.x,
      y: countBounds.y + countBounds.height / 2 - headerBounds.y,
    },
  });

  await expect(page).toHaveURL("/?section=fixture-section-1");
  await expect(section).toHaveAttribute("aria-current", "page");
  const selectionPresentation = await section.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.background = "var(--selection-bg)";
    document.body.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(element.parentElement);
    return {
      actualBackground: style.backgroundColor,
      borderLeftWidth: style.borderLeftWidth,
      expectedBackground,
    };
  });
  expect(selectionPresentation.actualBackground).toBe(
    selectionPresentation.expectedBackground,
  );
  expect(selectionPresentation.borderLeftWidth).toBe("0px");
  const detail = page.locator("caffold-detail-layout");
  await expect(detail.locator("caffold-section-detail-summary h2")).toHaveText(
    "tests/fixtures/home",
  );
  await expect(detail.locator("caffold-section-detail textarea[name=prompt]")).toBeVisible();
  await expect(detail.locator("caffold-section-detail")).toContainText(
    "tests/fixtures/home",
  );
  await expect(
    detail.locator('caffold-section-detail [data-composer-action="browse-cwd"]'),
  ).toHaveCount(0);
  await expect(
    detail.locator("caffold-section-github-shortcuts"),
  ).toBeHidden();
  await expect(detail.locator("caffold-detail-view-switch")).toBeHidden();
});

test("offers GitHub work shortcuts from repository Task creation", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const rootPath = "tests/fixtures/home";
  const repository = { rootPath, branch: "main", dirty: false };
  const github = {
    owner: "panarch",
    name: "caffold",
    nameWithOwner: "panarch/caffold",
    url: "https://github.com/panarch/caffold",
  };
  const task = {
    id: "thread_section_github_shortcuts",
    threadId: "thread_section_github_shortcuts",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section GitHub shortcuts",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath: `${rootPath}/.caffold-worktrees/github-shortcuts`,
      repositoryRootPath: rootPath,
      branch: "feature/github-shortcuts",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section GitHub shortcuts",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(rootPath);
    return route.fulfill({
      json: {
        repository,
        github,
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });
  await page.route(/\/api\/github\/issues(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        github,
        state: "open",
        issues: [],
        page: 1,
        perPage: 50,
        totalIssues: 0,
        totalPages: 0,
        hasPrevious: false,
        hasNext: false,
      },
    })
  );

  await page.goto("/?section=fixture-section-1");
  const detail = page.locator("caffold-detail-layout");
  const shortcuts = detail.locator("caffold-section-github-shortcuts");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "panarch/caffold",
  );
  await expect(shortcuts.getByRole("button")).toHaveText([
    "Issues",
    "Pull Requests",
  ]);

  const composerPanel = detail.locator(
    "caffold-section-detail .task-composer-panel",
  );
  const expectedGap = await page.evaluate(() =>
    window.innerWidth <= 959 ? 10 : 14
  );
  const measureAlignment = async () => {
    const [composerBox, shortcutBox] = await Promise.all([
      composerPanel.boundingBox(),
      shortcuts.boundingBox(),
    ]);
    if (!composerBox || !shortcutBox) {
      return null;
    }
    return {
      left: Math.abs(shortcutBox.x - composerBox.x),
      right: Math.abs(
        shortcutBox.x + shortcutBox.width - composerBox.x - composerBox.width,
      ),
      gap: shortcutBox.y - composerBox.y - composerBox.height,
    };
  };
  await expect.poll(async () => {
    const alignment = await measureAlignment();
    return alignment ? Math.max(alignment.left, alignment.right) : Infinity;
  }).toBeLessThanOrEqual(0.5);
  await expect.poll(async () => {
    const alignment = await measureAlignment();
    return alignment ? Math.abs(alignment.gap - expectedGap) : Infinity;
  }).toBeLessThanOrEqual(1);

  const [issuesBox, pullsBox] = await Promise.all([
    shortcuts.getByRole("button", { name: "Issues" }).boundingBox(),
    shortcuts.getByRole("button", { name: "Pull Requests" }).boundingBox(),
  ]);
  expect(issuesBox).not.toBeNull();
  expect(pullsBox).not.toBeNull();
  if (!issuesBox || !pullsBox) {
    throw new Error("GitHub shortcut rows did not render");
  }
  expect(pullsBox.y).toBeGreaterThanOrEqual(issuesBox.y + issuesBox.height);

  await shortcuts.getByRole("button", { name: "Issues" }).click();
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=github&tool=issues",
  );
  await expect(detail.locator("caffold-github-issues-list-page")).toBeVisible();
});

test("returns a missing Section route to Tasks home", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: { sections: [], unsectioned: [] } })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto("/?section=missing-section");
  await expect(page).toHaveURL("/");
});

test("keeps a repository Section draft while switching shared surfaces", { tag: "@all-viewports" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const task = {
    id: "thread_repository_section",
    threadId: "thread_repository_section",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Repository Section Task",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "",
    worktree: {
      rootPath: "tests/fixtures/home/.caffold-worktrees/repository-section",
      repositoryRootPath: "tests/fixtures/home",
      branch: "feature/section-detail",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Repository Section summary",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto("/");
  await page.locator(
    'caffold-active-task-list .task-repository-select[data-section-id="fixture-section-1"]',
  ).click();

  const detail = page.locator("caffold-detail-layout");
  const switcher = detail.locator("caffold-detail-view-switch");
  await expect(switcher).toBeVisible();
  await expect(switcher.locator("button")).toHaveText([
    "New Task",
    "Working Tree",
    "Branch",
  ]);
  await expect(detail.locator("caffold-task-detail-git")).toBeVisible();
  await expect(detail.locator("caffold-task-detail-github")).toBeVisible();
  if (await page.evaluate(() => window.innerWidth > 520)) {
    const rightAlignment = await detail.evaluate((element) => {
      const header = element.querySelector(".detail-layout-summary");
      const visibleActionButtons = [
        ...element.querySelectorAll(".detail-layout-actions button"),
      ].filter((button) => button.getBoundingClientRect().width > 0);
      const rightmostButton = visibleActionButtons.reduce((rightmost, button) =>
        button.getBoundingClientRect().right > rightmost.getBoundingClientRect().right
          ? button
          : rightmost
      );
      const headerBox = header.getBoundingClientRect();
      const buttonBox = rightmostButton.getBoundingClientRect();
      return {
        headerPaddingRight: Number.parseFloat(
          getComputedStyle(header).paddingRight,
        ),
        rightInset: headerBox.right - buttonBox.right,
      };
    });
    expect(
      Math.abs(rightAlignment.rightInset - rightAlignment.headerPaddingRight),
    ).toBeLessThanOrEqual(0.5);
  }

  const prompt = detail.locator("caffold-section-detail textarea[name=prompt]");
  await prompt.evaluate((textarea) => {
    textarea.value = "Preserve this Section draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await switcher.locator('button[data-detail-view="working"]').click();
  await expect(page).toHaveURL(
    "/?section=fixture-section-1&surface=review",
  );
  await expect(detail.locator(".detail-review-slot")).toBeVisible();

  await switcher.locator('button[data-detail-view="new"]').click();
  await expect(page).toHaveURL("/?section=fixture-section-1");
  await expect(prompt).toHaveValue("Preserve this Section draft");
});

test("replaces the New Task context when a selected Section path changes", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const sectionId = "section-path-rebind";
  const task = {
    id: "thread_section_path_rebind",
    threadId: "thread_section_path_rebind",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section path rebind",
    cwd: "tests/fixtures/home",
    cwdPath: "tests/fixtures/home",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section path rebind",
  };
  let projection = {
    sections: [{
      id: sectionId,
      name: "tests/fixtures/home",
      repository: true,
      tasks: [task],
    }],
    unsectioned: [],
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: projection })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  let staleStatusRoute = null;
  await page.route(/\/api\/github\/status(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "tests/fixtures/home") {
      staleStatusRoute = route;
      return;
    }
    expect(path).toBe("tests/fixtures/other");
    return route.fulfill({
      json: {
        repository: { rootPath: path, branch: "main", dirty: false },
        github: {
          owner: "fixture",
          name: "other",
          nameWithOwner: "fixture/other",
          url: "https://github.com/fixture/other",
        },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    });
  });

  await page.goto(`/?section=${sectionId}`);
  const sectionDetail = page.locator("caffold-section-detail");
  const shortcuts = sectionDetail.locator(
    "caffold-section-github-shortcuts",
  );
  const prompt = sectionDetail.locator("textarea[name=prompt]");
  await expect(sectionDetail).toContainText("tests/fixtures/home");
  await expect.poll(() => Boolean(staleStatusRoute)).toBe(true);
  await expect(shortcuts).toBeHidden();
  await prompt.fill("Discard this stale Section draft");

  projection = {
    sections: [{
      id: sectionId,
      name: "tests/fixtures/other",
      repository: true,
      tasks: [task],
    }],
    unsectioned: [],
  };
  await page.locator("caffold-active-task-list").evaluate((list) => {
    void list.loadTasks({ force: true });
  });

  await expect(page).toHaveURL(`/?section=${sectionId}`);
  await expect(sectionDetail).toContainText("tests/fixtures/other");
  await expect(sectionDetail.locator("textarea[name=prompt]")).toHaveValue("");
  await expect.poll(() =>
    sectionDetail.locator("caffold-task-create").evaluate((taskCreate) => taskCreate.cwd)
  ).toBe("tests/fixtures/other");
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "fixture/other",
  );

  await staleStatusRoute.fulfill({
    json: {
      repository: {
        rootPath: "tests/fixtures/home",
        branch: "main",
        dirty: false,
      },
      github: {
        owner: "fixture",
        name: "home",
        nameWithOwner: "fixture/home",
        url: "https://github.com/fixture/home",
      },
      ghAvailable: true,
      authenticated: true,
      issuesAvailable: true,
      pullsAvailable: true,
      message: null,
    },
  });
  await expect(shortcuts.locator(".section-github-name")).toHaveText(
    "fixture/other",
  );
});

test("uses the Section's last composer settings for its next Task request", { tag: "@desktop" }, async ({ page }) => {
  await installEventSourceMock(page);
  await mockCodexModels(page);
  const sectionId = "section-composer-seed";
  const rootPath = "tests/fixtures/home";
  const task = {
    id: "thread_section_composer_seed",
    threadId: "thread_section_composer_seed",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section composer seed",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section composer seed",
  };
  const projection = {
    sections: [{
      id: sectionId,
      name: rootPath,
      repository: false,
      composerSettings: {
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
      tasks: [task],
    }],
    unsectioned: [],
  };
  let submittedBody = null;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      submittedBody = route.request().postDataJSON();
      return route.fulfill({
        json: taskDetailFixture({
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          fastMode: true,
        }),
      });
    }
    return route.fulfill({ json: projection });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto(`/?section=${sectionId}`);
  const form = page.locator('caffold-section-detail .task-new-form[data-task-form="create"]');
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");

  await form.getByRole("textbox", { name: "New task prompt" }).fill("Use the Section settings");
  await form.getByRole("textbox", { name: "New task prompt" }).press("Enter");

  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toMatchObject({
    cwd: rootPath,
    prompt: "Use the Section settings",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fastMode: true,
  });
});

test("falls back stale Section settings and applies targeted updates without reloading", { tag: "@desktop" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { registryKey: "__sectionComposerSources" });
  await mockCodexModels(page);
  const sectionId = "section-composer-update";
  const rootPath = "tests/fixtures/home";
  const task = {
    id: "thread_section_composer_update",
    threadId: "thread_section_composer_update",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section composer update",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section composer update",
  };
  let taskListReads = 0;
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    taskListReads += 1;
    return route.fulfill({
      json: {
        sections: [{
          id: sectionId,
          name: rootPath,
          repository: false,
          composerSettings: {
            model: "retired-model",
            effort: "retired-effort",
            fastMode: false,
          },
          tasks: [task],
        }],
        unsectioned: [],
      },
    });
  });
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );

  await page.goto(`/?section=${sectionId}`);
  const form = page.locator('caffold-section-detail .task-new-form[data-task-form="create"]');
  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("low");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("false");
  await expect.poll(() => page.evaluate(() =>
    window.__sectionComposerSources.some((source) =>
      source.url.startsWith("/api/tasks/stream")
    )
  )).toBe(true);

  await page.evaluate((id) => {
    const source = window.__sectionComposerSources.find((candidate) =>
      candidate.url.startsWith("/api/tasks/stream")
    );
    source.emit("section-composer-settings", {
      sectionId: id,
      composerSettings: {
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
    });
  }, sectionId);

  await expect(form.locator('input[name="model"]')).toHaveValue("gpt-5.6-sol");
  await expect(form.locator('input[name="effort"]')).toHaveValue("xhigh");
  await expect(form.locator('input[name="fastMode"]')).toHaveValue("true");
  expect(taskListReads).toBe(1);
});

test("clears shared repository context when the selected Section loses capability", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installEventSourceMock(page, { registryKey: "__sectionDetailWatchSources" });
  await mockCodexModels(page);
  const sectionId = "section-context-rebind";
  const rootPath = "tests/fixtures/home";
  const repository = { rootPath, branch: "main", dirty: false };
  const task = {
    id: "thread_section_context_rebind",
    threadId: "thread_section_context_rebind",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section context rebind",
    cwd: rootPath,
    cwdPath: rootPath,
    relativeCwd: "",
    worktree: {
      rootPath,
      repositoryRootPath: rootPath,
      branch: "main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section context rebind",
  };
  let projection = {
    sections: [{ id: sectionId, name: rootPath, repository: true, tasks: [task] }],
    unsectioned: [],
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: projection })
  );
  await page.route(/\/api\/tasks\/archived(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [], nextCursor: null } })
  );
  await page.route(/\/api\/git\/refs(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        refs: [
          { name: "main", kind: "local" },
          { name: "origin/main", kind: "remote" },
        ],
        currentRef: "main",
        defaultBaseRef: "origin/main",
        defaultHeadRef: "main",
      },
    })
  );
  await page.route(/\/api\/git\/compare(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        repository,
        baseRef: "origin/main",
        headRef: "main",
        additions: 0,
        deletions: 0,
        files: [],
      },
    })
  );

  await page.goto(
    `/?section=${sectionId}&surface=git&tool=compare&base=origin%2Fmain&head=main`,
  );
  const git = page.locator("caffold-task-git-layout");
  await expect(git).toBeVisible();
  await expect.poll(() =>
    git.evaluate((layout) => ({
      active: layout.active,
      rootPath: layout.repository?.rootPath ?? null,
    }))
  ).toEqual({ active: true, rootPath });

  projection = {
    sections: [{
      id: sectionId,
      name: rootPath,
      repository: false,
      tasks: [{ ...task, worktree: null }],
    }],
    unsectioned: [],
  };
  await page.locator("caffold-active-task-list").evaluate((list) => {
    void list.loadTasks({ force: true });
  });

  await expect(page).toHaveURL(`/?section=${sectionId}`);
  await expect(page.locator("caffold-section-detail")).toBeVisible();
  await expect(git).toBeHidden();
  await expect.poll(() =>
    git.evaluate((layout) => ({
      active: layout.active,
      rootPath: layout.repository?.rootPath ?? null,
      watchScopePath: layout.watchScopePath ?? null,
    }))
  ).toEqual({ active: false, rootPath: null, watchScopePath: null });
});
