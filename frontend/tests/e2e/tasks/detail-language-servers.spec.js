import { expect, test } from "@playwright/test";
import {
  activateActionHintIntoPopover,
  popoverActionHintDialog,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  createdTaskResponse,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

// What the Lucide stub in browser-defaults draws for the icons the section
// shows.
const CODE_XML_ICON = 'svg path[d="m14.5 4-5 16"]';
const BOT_ICON = 'svg path[d="M12 8V4H8"]';
const BUSY_ICON = '.task-detail-action-icon.is-busy svg path[d="M21 12a9 9 0 1 1-6.2-8.6"]';
const DESCRIPTION = "Go to definition and Find references.";
const GIB = 1024 ** 3;
const HOME = "Users/me";
const RUST_TOOLCHAIN = "1.94-aarch64-apple-darwin";
const RUST_NOT_INSTALLED = {
  kind: "notInstalled",
  toolchain: RUST_TOOLCHAIN,
  installCommand: `rustup component add rust-analyzer rust-src --toolchain ${RUST_TOOLCHAIN}`,
  checkCommand: `rustup run ${RUST_TOOLCHAIN} rust-analyzer --version`,
};
const TYPESCRIPT_NOT_INSTALLED = {
  kind: "notInstalled",
  installCommand: "npm install --global typescript-language-server typescript",
  checkCommand: "typescript-language-server --version",
};

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

function summaryTask(threadId, rootPath) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Inspect the planner changes",
    preview: "Inspect the planner changes",
    cwd: `${rootPath}/src`,
    cwdPath: `${rootPath}/src`,
    relativeCwd: "src",
    worktree: {
      rootPath,
      repositoryRootPath: rootPath,
      branch: "main",
      headSha: "0123456789abcdef",
      relativeCwd: "src",
      linked: false,
    },
    createdMs: 100,
    updatedMs: 100,
    recencyMs: 100,
    lastEventSummary: "Inspect the planner changes",
  };
}

function summaryDetail(task) {
  return {
    provider: "codex",
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
    permissionMode: null,
    model: null,
    reasoningEffort: null,
  };
}

function rust(state, fields = {}) {
  return {
    repositoryPath: "",
    language: "rust",
    languageName: "Rust",
    serverName: "rust-analyzer",
    state,
    ...fields,
  };
}

function typescript(state, fields = {}) {
  return {
    ...rust(state, fields),
    language: "typescript",
    languageName: "TypeScript/JavaScript",
    serverName: "typescript-language-server",
  };
}

// Opens a Task whose repository answers from test-local state: `servers` is
// what the repository lists, and `enabled` its switch. A switch lists the
// servers `afterTurn` gives, looking again those `afterLookingAgain` gives,
// and every request is recorded.
async function openTask(page, repository, { servers, enabled = false }) {
  const task = summaryTask("thread_language_servers", repository);
  const state = {
    enabled,
    servers: servers.map((server) => ({ ...server, repositoryPath: repository })),
    afterTurn: () => state.servers,
    afterLookingAgain: () => state.servers,
  };
  const requests = { reads: [], lookedAgain: [], turns: [] };
  const answer = () => ({
    path: repository,
    enabled: state.enabled,
    servers: state.servers,
  });
  // Integrated Review reads the same repository to know whether names can be
  // pressed, so the section's own reads are told apart by who asked.
  await page.addInitScript(() => {
    window.__languageServerSectionReads = 0;
    const fetch = window.fetch;
    window.fetch = function (input, init) {
      if (
        `${input}`.includes("/api/language-servers/repository?") &&
        new Error().stack.includes("/info/components/actions/language-servers.js")
      ) {
        window.__languageServerSectionReads += 1;
      }
      return fetch.call(this, input, init);
    };
  });
  await installEventSourceMock(page, {
    registryKey: "__taskLanguageServerEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${task.threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: summaryDetail(task) }),
  );
  await page.route(/\/api\/language-servers\/repository(?:\?|$)/, (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      requests.turns.push(body);
      state.enabled = body.enabled;
      state.servers = state
        .afterTurn(body.enabled)
        .map((server) => ({ ...server, repositoryPath: repository }));
      return route.fulfill({ json: answer() });
    }
    requests.reads.push(new URL(request.url()).searchParams.get("path"));
    return route.fulfill({ json: answer() });
  });
  await page.route(/\/api\/language-servers\/repository\/check$/, (route) => {
    requests.lookedAgain.push(route.request().postDataJSON().path);
    state.servers = state
      .afterLookingAgain()
      .map((server) => ({ ...server, repositoryPath: repository }));
    return route.fulfill({ json: answer() });
  });

  await page.goto(`/tasks/${task.threadId}`);
  await emitTaskDetailBootstrap(page, summaryDetail(task));
  const summary = page.locator("caffold-task-detail-summary");
  return {
    task,
    state,
    requests,
    sectionReads: () =>
      page.evaluate(() => window.__languageServerSectionReads),
    summary,
    detailsButton: summary.getByRole("button", { name: /Task details/ }),
    popover: summary.locator(".task-detail-popover"),
    section: summary.locator(".task-detail-language-servers-action"),
    toggle: summary.getByRole("switch", { name: "Language servers" }),
    // What hangs under the row: each language's line, an error, and the
    // install button.
    under: summary.locator(
      ".task-detail-language-servers-action + .task-detail-action-under",
    ),
  };
}

test("asks for the Task's worktree and leaves the section out when it lists no server", { tag: "@server-steady" }, async ({ page }) => {
  const { requests, detailsButton, popover, section } = await openTask(
    page,
    "repo-plain",
    { servers: [] },
  );
  // The section reads its repository once before the popover opens, and
  // again as it opens, looking again for failed servers.
  await expect.poll(() => requests.reads).toEqual(["repo-plain"]);
  await detailsButton.click();
  await expect(popover).toBeVisible();
  await expect.poll(() => requests.lookedAgain).toEqual(["repo-plain"]);
  expect(requests.reads).toEqual(["repo-plain"]);
  await expect(popover.locator('[data-task-info-action="pin"]')).toBeVisible();
  await expect(section).toHaveCount(0);
});

test("turns language servers on, shows each language getting ready, and reads again only while open", { tag: "@server-changes" }, async ({ page }) => {
  await page.clock.install();
  const { state, requests, sectionReads, detailsButton, popover, section, toggle, under } =
    await openTask(page, "repo-rust", { servers: [rust("off")] });
  state.afterTurn = (on) =>
    on ? [rust("starting", { progress: "Indexing 12/407 (caffold)" })] : [rust("off")];

  await detailsButton.click();
  await expect(section).toBeVisible();
  // The row follows Pin task.
  await expect(
    popover.locator('[data-task-info-action="pin"] + .task-detail-language-servers-action'),
  ).toHaveCount(1);
  const description = section.locator(".task-detail-action-description");
  await expect(description).toHaveText(DESCRIPTION);
  await expect(under).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(section.locator(CODE_XML_ICON)).toHaveCount(1);

  // The whole row turns the switch.
  await section.locator(".task-detail-action-label").click();
  await expect.poll(() => requests.turns).toEqual([
    { path: "repo-rust", enabled: true },
  ]);
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    "Rust: getting ready · Indexing 12/407 (caffold)",
  ]);
  await expect(description).toHaveText("Starting language servers...");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(section.locator(BUSY_ICON)).toHaveCount(1);

  const reads = await sectionReads();
  state.servers = [rust("ready", { repositoryPath: "repo-rust", memoryBytes: 2.8 * GIB })];
  await page.clock.runFor(1_000);
  await expect.poll(sectionReads).toBeGreaterThan(reads);
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    "Rust: ready · rust-analyzer · 2.8 GB",
  ]);
  await expect(description).toHaveText(DESCRIPTION);
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  const ready = await sectionReads();
  await page.clock.runFor(5_000);
  expect(await sectionReads()).toBe(ready);

  await toggle.click();
  await expect.poll(() => requests.turns).toEqual([
    { path: "repo-rust", enabled: true },
    { path: "repo-rust", enabled: false },
  ]);
  await expect(toggle).not.toBeChecked();
  await expect(under).toHaveCount(0);

  // Closed while a server gets ready, the popover reads nothing more.
  state.enabled = true;
  state.servers = [rust("starting", { repositoryPath: "repo-rust" })];
  await detailsButton.click();
  await expect(popover).toBeHidden();
  await detailsButton.click();
  await expect(description).toHaveText("Starting language servers...");
  await detailsButton.click();
  await expect(popover).toBeHidden();
  const closed = await sectionReads();
  await page.clock.runFor(10_000);
  expect(await sectionReads()).toBe(closed);
});

test("opening the details looks again, so a server installed since it failed gets ready", { tag: "@server-steady" }, async ({ page }) => {
  await page.clock.install();
  const { state, requests, detailsButton, popover, under } = await openTask(
    page,
    "repo-installed",
    {
      enabled: true,
      servers: [rust("failed", { failure: RUST_NOT_INSTALLED })],
    },
  );
  await expect.poll(() => requests.reads).toEqual(["repo-installed"]);
  state.afterLookingAgain = () => [rust("starting", { progress: "Indexing 3/407" })];

  await detailsButton.click();
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    "Rust: getting ready · Indexing 3/407",
  ]);
  expect(requests.lookedAgain).toEqual(["repo-installed"]);
  await expect(under.getByRole("button", { name: /Ask an agent to install/ })).toHaveCount(0);

  state.servers = [rust("ready", { repositoryPath: "repo-installed", memoryBytes: GIB })];
  await page.clock.runFor(1_000);
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    "Rust: ready · rust-analyzer · 1.0 GB",
  ]);
  // Reads while it got ready only read.
  expect(requests.lookedAgain).toEqual(["repo-installed"]);

  // Opened again while it is still missing, the section says so.
  state.servers = [rust("failed", { failure: RUST_NOT_INSTALLED })];
  state.afterLookingAgain = () => state.servers;
  await detailsButton.click();
  await expect(popover).toBeHidden();
  await detailsButton.click();
  await expect.poll(() => requests.lookedAgain.length).toBe(2);
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    `Rust: rust-analyzer is not installed for the ${RUST_TOOLCHAIN} toolchain.`,
  ]);
});

test("reports why turning on failed under the row and turns the switch back", { tag: "@server-steady" }, async ({ page }) => {
  const { detailsButton, toggle, under } = await openTask(page, "repo-refused", {
    servers: [rust("off")],
  });
  await page.route(/\/api\/language-servers\/repository$/, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 403,
          json: { error: { code: "forbidden", message: "Requests must come from this page." } },
        })
      : route.fallback(),
  );
  await detailsButton.click();
  await toggle.click();
  await expect(under.getByRole("alert")).toHaveText(
    "Requests must come from this page.",
  );
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
});

test("reaches the Language servers switch from the keyboard inside Task details", { tag: "@server-steady" }, async ({ page }) => {
  const { requests, popover, section } = await openTask(page, "repo-keys", {
    servers: [rust("off")],
  });
  // The repository is read before the popover opens, so the session that
  // opens it already has the section's button.
  await expect.poll(() => requests.reads.length).toBe(1);
  await activateActionHintIntoPopover(page, /Task details, idle$/);
  await expect(section).toBeVisible();
  const hint = popoverActionHintDialog(page);
  const turnOn = hint.getByRole("button", { name: / — Turn on language servers$/ });
  await expect(turnOn).toBeVisible();
  const code = await turnOn.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());
  await expect.poll(() => requests.turns).toEqual([
    { path: "repo-keys", enabled: true },
  ]);
});

test("says which check failed for each language and offers one install under the row, keeping every line inside narrow screens", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const { detailsButton, popover, section, toggle, under } = await openTask(page, "repo-missing", {
    enabled: true,
    servers: [
      rust("failed", { failure: RUST_NOT_INSTALLED }),
      typescript("failed", {
        failure: {
          kind: "couldNotStart",
          reason:
            "env: node: No such file or directory; typescript-language-server needs Node.js on the search path Caffold started with.",
        },
      }),
    ],
  });
  await detailsButton.click();
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    `Rust: rust-analyzer is not installed for the ${RUST_TOOLCHAIN} toolchain.`,
    "TypeScript/JavaScript: typescript-language-server could not start.",
    "env: node: No such file or directory; typescript-language-server needs Node.js on the search path Caffold started with.",
  ]);
  await expect(toggle).toBeChecked();
  const buttons = under.locator(":scope > button");
  await expect(buttons).toHaveText(["Ask an agent to install rust-analyzer"]);
  await expect(buttons.nth(0).locator(BOT_ICON)).toHaveCount(1);
  await expect(section.locator(CODE_XML_ICON)).toHaveCount(1);

  // What hangs under the row starts where the row's words start, and every
  // line and the button stay inside the popover.
  const layout = await under.evaluate((element) => {
    const popover = element.getRootNode().host
      .getRootNode()
      .querySelector(".task-detail-popover");
    const content = popover.getBoundingClientRect();
    const words = element.previousElementSibling
      .querySelector(".task-detail-action-label")
      .getBoundingClientRect();
    const inside = (rect) =>
      rect.left >= words.left - 0.5 && rect.right <= content.right + 0.5;
    const parts = [...element.children].map((part) => part.getBoundingClientRect());
    return {
      popoverScrolls: popover.scrollWidth > popover.clientWidth,
      startsWithWords: parts.every((rect) => Math.abs(rect.left - words.left) <= 0.5),
      inside: parts.every(inside),
      linesWhole: [...element.querySelectorAll(":scope > p")].every(
        (line) => line.scrollWidth <= line.clientWidth + 1,
      ),
    };
  });
  expect(layout).toEqual({
    popoverScrolls: false,
    startsWithWords: true,
    inside: true,
    linesWhole: true,
  });
  await captureReviewScreenshot(page, testInfo, "task-details-language-servers-missing");
  await expect(popover).toBeVisible();
});

test("asks an agent to install every missing server on the host from the home folder, returning focus to Task details", { tag: ["@desktop", "@phone"] }, async ({ page }, testInfo) => {
  await page.route(/\/api\/health(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), homePath: HOME },
    });
  });
  const { detailsButton, under } = await openTask(page, "repo-install", {
    enabled: true,
    servers: [
      rust("failed", { failure: RUST_NOT_INSTALLED }),
      typescript("failed", { failure: TYPESCRIPT_NOT_INSTALLED }),
    ],
  });
  const creates = [];
  const created = summaryDetail(summaryTask("thread_install", HOME));
  created.task.title = "Install language servers";
  await page.route(/\/api\/tasks(?:\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      creates.push(route.request().postDataJSON());
      return route.fulfill({
        json: createdTaskResponse(created, {
          section: { id: "fixture-section-1", name: HOME, repository: false },
        }),
      });
    }
    return route.fallback();
  });
  await page.route(/\/api\/tasks\/thread_install(?:\?|$)/, (route) =>
    route.fulfill({ json: created }),
  );
  await page.route(/\/api\/tasks\/thread_install\/prompts(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        threadId: "thread_install",
        turnId: "turn-install",
        userMessageId: "message-install",
        steered: false,
      },
    }),
  );

  await detailsButton.click();
  await expect(under.locator("> p:not(.task-detail-action-error)")).toHaveText([
    `Rust: rust-analyzer is not installed for the ${RUST_TOOLCHAIN} toolchain.`,
    "TypeScript/JavaScript: typescript-language-server is not installed.",
  ]);
  const install = under.getByRole("button", {
    name: "Ask an agent to install 2 servers",
  });
  await install.click();
  const dialog = page.locator("caffold-language-server-install-dialog > dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Install language servers" })).toBeVisible();
  await expect(dialog.locator("header > p")).toHaveText(
    "An agent installs these in a new Task in your home folder, then checks that each runs.",
  );
  await expect(dialog.locator(".language-server-install-list > li")).toHaveText(
    [
      `rust-analyzer for the ${RUST_TOOLCHAIN} toolchain\n${RUST_NOT_INSTALLED.installCommand}`,
      `typescript-language-server\n${TYPESCRIPT_NOT_INSTALLED.installCommand}`,
    ],
    { useInnerText: true },
  );
  await expect(dialog.locator("caffold-task-turn-options")).toBeVisible();

  // The update Task dialog's geometry: 34rem wide, or the phone's width, with
  // every command inside it.
  const viewport = page.viewportSize();
  const rem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const width = (await dialog.boundingBox()).width;
  const expectedWidth = testInfo.project.name === "phone"
    ? viewport.width - rem
    : Math.min(34 * rem, viewport.width - 2 * rem);
  expect(Math.abs(width - expectedWidth)).toBeLessThan(1);
  expect(
    await dialog.evaluate((element) =>
      [...element.querySelectorAll(".language-server-install-list code")].every(
        (code) =>
          code.getBoundingClientRect().right <=
          element.getBoundingClientRect().right,
      ),
    ),
  ).toBe(true);
  await captureReviewScreenshot(page, testInfo, "language-server-install-dialog");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(detailsButton).toBeFocused();

  await detailsButton.click();
  await install.click();
  await dialog.getByRole("button", { name: "Start Install" }).click();
  await expect.poll(() => creates.length).toBe(1);
  expect(creates[0].cwd).toBe(HOME);
  expect(creates[0].titleSource).toContain(
    'Name this Task exactly "Install language servers".',
  );
  for (const failure of [RUST_NOT_INSTALLED, TYPESCRIPT_NOT_INSTALLED]) {
    expect(creates[0].titleSource).toContain(`Install: \`${failure.installCommand}\``);
    expect(creates[0].titleSource).toContain(`Check: \`${failure.checkCommand}\``);
  }
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/tasks\/thread_install$/);
});
