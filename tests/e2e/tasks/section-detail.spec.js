import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
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
    'caffold-active-task-list .task-repository-header[data-section-id="fixture-section-1"]',
  );
  await expect(section).toBeVisible();
  await section.click();

  await expect(page).toHaveURL("/?section=fixture-section-1");
  await expect(section).toHaveAttribute("aria-current", "page");
  const selectionPresentation = await section.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.background = "var(--selection-bg)";
    document.body.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(element);
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
  await expect(detail.locator("caffold-detail-view-switch")).toBeHidden();
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
    'caffold-active-task-list .task-repository-header[data-section-id="fixture-section-1"]',
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
      repository: false,
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

  await page.goto(`/?section=${sectionId}`);
  const sectionDetail = page.locator("caffold-section-detail");
  const prompt = sectionDetail.locator("textarea[name=prompt]");
  await expect(sectionDetail).toContainText("tests/fixtures/home");
  await prompt.fill("Discard this stale Section draft");

  projection = {
    sections: [{
      id: sectionId,
      name: "tests/fixtures/other",
      repository: false,
      tasks: [task],
    }],
    unsectioned: [],
  };
  await page.locator("caffold-active-task-list").evaluate(async (list) => {
    await list.loadTasks({ force: true });
  });

  await expect(page).toHaveURL(`/?section=${sectionId}`);
  await expect(sectionDetail).toContainText("tests/fixtures/other");
  await expect(sectionDetail.locator("textarea[name=prompt]")).toHaveValue("");
  await expect.poll(() =>
    sectionDetail.locator("caffold-task-create").evaluate((taskCreate) => taskCreate.cwd)
  ).toBe("tests/fixtures/other");
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
  await page.locator("caffold-active-task-list").evaluate(async (list) => {
    await list.loadTasks({ force: true });
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
