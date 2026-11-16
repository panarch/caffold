import { expect, test } from "@playwright/test";
import { workspaceTargets } from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { captureReviewScreenshot } from "./support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

const GIB = 1024 ** 3;
const INTRO =
  "Language servers answer Go to definition and Find references in the code viewers. Turn a language on here, then turn language servers on for a repository in Task details, which also offers to install a missing server.";

function rust({ enabled = false } = {}) {
  return { id: "rust", name: "Rust", enabled, serverName: "rust-analyzer" };
}

function typescript({ enabled = false } = {}) {
  return {
    id: "typescript",
    name: "TypeScript/JavaScript",
    enabled,
    serverName: "typescript-language-server",
  };
}

function runningServer(repositoryPath, state, fields = {}) {
  return {
    repositoryPath,
    language: "rust",
    languageName: "Rust",
    serverName: "rust-analyzer",
    state,
    ...fields,
  };
}

function running(servers) {
  return {
    servers,
    totalMemoryBytes: servers.reduce(
      (total, server) => total + (server.memoryBytes ?? 0),
      0,
    ),
  };
}

// Answers the Language Servers API from test-local state, and records what
// the page asks to change.
async function installLanguageServers(page, { languages, servers = [] }) {
  const state = { languages, running: running(servers) };
  const requests = { patches: [], stops: [], languageReads: 0, runningReads: 0 };
  await page.route(/\/api\/language-servers(?:\?|$)/, (route) => {
    requests.languageReads += 1;
    return route.fulfill({ json: { languages: state.languages } });
  });
  await page.route(/\/api\/language-servers\/settings$/, (route) => {
    const body = route.request().postDataJSON();
    requests.patches.push(body);
    state.languages = state.languages.map((language) => ({
      ...language,
      enabled: body.languages.includes(language.id),
    }));
    return route.fulfill({ json: { languages: state.languages } });
  });
  await page.route(/\/api\/language-servers\/running$/, (route) => {
    requests.runningReads += 1;
    return route.fulfill({ json: state.running });
  });
  await page.route(/\/api\/language-servers\/repository$/, (route) => {
    const body = route.request().postDataJSON();
    requests.stops.push(body);
    state.running = running(
      state.running.servers.filter(
        (server) => server.repositoryPath !== body.path,
      ),
    );
    return route.fulfill({
      json: { path: body.path, enabled: body.enabled, servers: [] },
    });
  });
  return { state, requests };
}

function languageRow(page, id) {
  return page.locator(
    `caffold-settings-language-servers-page .settings-language-server[data-language="${id}"]`,
  );
}

function runningRows(page) {
  return page.locator(
    "caffold-settings-language-servers-page .settings-language-server-running",
  );
}

test("turns each language on and off, naming its server, and offers nothing to install", { tag: "@server-steady" }, async ({ page }) => {
  const { requests } = await installLanguageServers(page, {
    languages: [rust(), typescript({ enabled: true })],
  });
  await page.goto("/settings/language-servers");
  const settingsPage = page.locator("caffold-settings-language-servers-page");

  await expect(
    page.getByRole("heading", { level: 1, name: "Language Servers" }),
  ).toBeVisible();
  await expect(settingsPage.locator("header p")).toHaveText(INTRO);

  await expect(
    settingsPage.locator(".settings-language-server .settings-language-server-copy"),
  ).toHaveText(
    ["Rust\nrust-analyzer", "TypeScript/JavaScript\ntypescript-language-server"],
    { useInnerText: true },
  );
  await expect(settingsPage.locator("input[type=text], code")).toHaveCount(0);
  await expect(settingsPage.getByRole("button", { name: /install/i })).toHaveCount(0);

  const rustSwitch = settingsPage.getByRole("switch", { name: "Rust" });
  const typescriptSwitch = settingsPage.getByRole("switch", {
    name: "TypeScript/JavaScript",
  });
  await expect(rustSwitch).toHaveAccessibleDescription("rust-analyzer");
  await expect(rustSwitch).not.toBeChecked();
  await expect(typescriptSwitch).toBeChecked();
  await expect(rustSwitch).toBeEnabled();
  await expect
    .poll(() => workspaceTargets(page, "settings:language-servers:"))
    .toEqual([
      ["language:rust", "Turn Rust on"],
      ["language:typescript", "Turn TypeScript/JavaScript off"],
    ]);

  const runningReads = requests.runningReads;
  await rustSwitch.click();
  await expect.poll(() => requests.patches).toEqual([
    { languages: ["rust", "typescript"] },
  ]);
  await expect(rustSwitch).toBeChecked();
  // A language turned on or off changes which servers run.
  await expect.poll(() => requests.runningReads).toBeGreaterThan(runningReads);

  await typescriptSwitch.click();
  await expect.poll(() => requests.patches).toEqual([
    { languages: ["rust", "typescript"] },
    { languages: ["rust"] },
  ]);
  await expect(typescriptSwitch).not.toBeChecked();
  expect(requests.languageReads).toBe(1);
});

test("lists the running servers by branch with their memory and turns a repository off", { tag: "@server-steady" }, async ({ page }) => {
  const worktree =
    "Users/me/Library/Application Support/Caffold/data/worktrees/6d1c544d";
  const plain = "Users/me/notes";
  const { requests } = await installLanguageServers(page, {
    languages: [rust({ enabled: true })],
    servers: [
      runningServer(worktree, "ready", {
        repositoryBranch: "lsp-code-navigation",
        memoryBytes: 2.8 * GIB,
      }),
      runningServer("Users/me/Workspace/codger", "sleeping", {
        repositoryBranch: "main",
      }),
      runningServer(plain, "failed", {
        failure: {
          kind: "notInstalled",
          toolchain: "1.94-aarch64-apple-darwin",
          installCommand:
            "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin",
          checkCommand: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version",
        },
      }),
      runningServer("Users/me/site", "failed", {
        language: "typescript",
        languageName: "TypeScript/JavaScript",
        serverName: "typescript-language-server",
        failure: { kind: "stopped" },
      }),
    ],
  });
  await page.goto("/settings/language-servers");
  const settingsPage = page.locator("caffold-settings-language-servers-page");

  await expect(
    settingsPage.getByRole("heading", { name: "Running · 2.8 GB in total" }),
  ).toBeVisible();
  const rows = runningRows(page);
  await expect(rows.locator("strong")).toHaveText([
    "lsp-code-navigation",
    "main",
    "notes",
    "site",
  ]);
  // A failed server says which check failed; Task details shows the rest.
  await expect(rows.locator(".settings-language-server-copy > span")).toHaveText([
    "Rust · Ready · 2.8 GB",
    "Rust · Sleeping",
    "Rust · Not installed for the 1.94-aarch64-apple-darwin toolchain",
    "TypeScript/JavaScript · Stopped",
  ]);
  await expect
    .poll(() =>
      rows
        .locator(".settings-language-server-path")
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
    )
    .toEqual([worktree, "Users/me/Workspace/codger", plain, "Users/me/site"]);
  await expect(rows.first().getByRole("textbox", { name: "Path of lsp-code-navigation" })).toHaveJSProperty(
    "readOnly",
    true,
  );
  await expect
    .poll(async () =>
      (await workspaceTargets(page, "settings:language-servers:turn-off:"))
        .map(([, label]) => label),
    )
    .toEqual([
      "Turn off language servers in lsp-code-navigation",
      "Turn off language servers in main",
      "Turn off language servers in notes",
      "Turn off language servers in site",
    ]);

  const reads = requests.runningReads;
  await rows.nth(1).getByRole("button", { name: "Turn off" }).click();
  await expect.poll(() => requests.stops).toEqual([
    { path: "Users/me/Workspace/codger", enabled: false },
  ]);
  await expect(rows.locator("strong")).toHaveText([
    "lsp-code-navigation",
    "notes",
    "site",
  ]);
  expect(requests.runningReads).toBeGreaterThan(reads);
});

test("reads the running servers every few seconds only while the page is shown", { tag: "@server-changes" }, async ({ page }) => {
  const repository = "Users/me/Workspace/codger";
  const { state, requests } = await installLanguageServers(page, {
    languages: [rust({ enabled: true })],
    servers: [
      runningServer(repository, "starting", {
        repositoryBranch: "main",
        progress: "Indexing 12/407 (caffold)",
      }),
    ],
  });
  await page.clock.install();
  await page.goto("/settings/language-servers");
  const rows = runningRows(page);
  await expect(rows.locator(".settings-language-server-copy > span").first()).toHaveText(
    "Rust · Getting ready · Indexing 12/407 (caffold)",
  );
  const settingsPage = page.locator("caffold-settings-language-servers-page");
  await expect(settingsPage.getByRole("heading", { name: "Running · 0 MB in total" })).toBeVisible();

  state.running = running([
    runningServer(repository, "ready", {
      repositoryBranch: "main",
      memoryBytes: 640 * 1024 ** 2,
    }),
  ]);
  const reads = requests.runningReads;
  await page.clock.runFor(3_000);
  await expect.poll(() => requests.runningReads).toBe(reads + 1);
  await expect(rows.locator(".settings-language-server-copy > span").first()).toHaveText(
    "Rust · Ready · 640 MB",
  );
  await expect(settingsPage.getByRole("heading", { name: "Running · 640 MB in total" })).toBeVisible();

  await page
    .locator('caffold-task-workspace-navigation button[data-workspace-mode="tasks"]')
    .click();
  await expect(settingsPage).toBeHidden();
  const away = requests.runningReads;
  await page.clock.runFor(60_000);
  expect(requests.runningReads).toBe(away);
  expect(requests.languageReads).toBe(1);

  await page
    .locator('caffold-task-workspace-navigation button[data-workspace-mode="settings"]')
    .click();
  await expect(settingsPage).toBeVisible();
  await expect.poll(() => requests.runningReads).toBe(away + 1);
  await expect.poll(() => requests.languageReads).toBe(2);
});

test("keeps long branch names inside the page and scrolls long paths inside their boxes", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const deepPath =
    "Users/me/Library/Application Support/Caffold/data/worktrees/6d1c544d-4e3c-4637-961e-f43e29751844-with-an-unusually-long-folder-name/frontend";
  await installLanguageServers(page, {
    languages: [rust({ enabled: true }), typescript()],
    servers: [
      runningServer(deepPath, "ready", {
        repositoryBranch:
          "origin/feature/language-servers-answer-go-to-definition-and-find-references-everywhere",
        memoryBytes: 2.8 * GIB,
      }),
    ],
  });
  await page.goto("/settings/language-servers");
  const settingsPage = page.locator("caffold-settings-language-servers-page");
  await expect(runningRows(page)).toHaveCount(1);
  await expect(languageRow(page, "typescript")).toBeVisible();

  const layout = await settingsPage.evaluate((host) => {
    const root = host.shadowRoot;
    const scroll = root.querySelector(".settings-content-scroll");
    const rect = (element) => element.getBoundingClientRect();
    const inside = (inner, outer) =>
      inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
    const rows = [...root.querySelectorAll(".settings-language-servers-list > li")];
    return {
      scrolls: scroll.scrollWidth > scroll.clientWidth,
      rowsInside: rows.every((row) => inside(rect(row), rect(scroll))),
      clipped: [...root.querySelectorAll(
        ".settings-language-server-copy > :not(.settings-language-server-path), button",
      )]
        .filter((element) => element.checkVisibility())
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent.trim()),
      // Each path keeps one line and scrolls inside its box.
      paths: [...root.querySelectorAll(".settings-language-server-path")].map(
        (input) => ({
          inside: inside(rect(input), rect(input.closest("li"))),
          scrolls: input.scrollWidth > input.clientWidth,
          oneLine: rect(input).height < 2.5 * Number.parseFloat(getComputedStyle(input).lineHeight),
        }),
      ),
      controlsInside: [...root.querySelectorAll(
        ".settings-language-server-state, .settings-language-server-running button",
      )]
        .filter((element) => element.checkVisibility())
        .every((element) =>
          inside(rect(element), rect(element.closest("li")))),
    };
  });
  expect(layout).toEqual({
    scrolls: false,
    rowsInside: true,
    clipped: [],
    paths: [{ inside: true, scrolls: true, oneLine: true }],
    controlsInside: true,
  });
  await captureReviewScreenshot(page, testInfo, "settings-language-servers");
});
