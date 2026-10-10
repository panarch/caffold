import { expect, test } from "@playwright/test";
import { actionHintDialog, enterActionHints } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { TASK_PERMISSION_FIXTURE } from "../support/task-api-fixture.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { activeTaskProjection, canonicalTaskState } from "../support/task-fixtures.js";

const HOME = "Users/me";
const LONG = "a-folder-whose-name-runs-on-long-enough-to-overflow-any-phone-width";

// A filesystem as the server lists it, below a server root of `/`.
const LISTINGS = {
  "": ["Users", "private"],
  Users: ["me"],
  [HOME]: [".config", "Applications", ".cache", "notes.txt", "Workspace", "Library", "Many"],
  [`${HOME}/Applications`]: [],
  [`${HOME}/Workspace`]: ["rust", LONG],
  [`${HOME}/Workspace/${LONG}`]: [`${LONG}-inside`],
  [`${HOME}/Workspace/${LONG}/${LONG}-inside`]: [],
  [`${HOME}/Workspace/rust`]: ["gluesql", "codger", "glues", "gleam"],
  [`${HOME}/Workspace/rust/glues`]: [],
  [`${HOME}/Workspace/rust/gleam`]: [],
  [`${HOME}/Workspace/rust/codger`]: ["src"],
  [`${HOME}/Many`]: Array.from({ length: 40 }, (_, index) => `folder-${String(index).padStart(2, "0")}`),
  private: ["tmp"],
  "private/tmp": [],
};

const FAILURES = {
  [`${HOME}/Library`]: [403, "permission_denied", "permission denied: Users/me/Library"],
};

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

// Serves the listings above and a server rooted at `/` with a home directory.
// A path in `hold` answers only once its promise settles.
async function installDirectories(page, { hold = new Map() } = {}) {
  const requests = [];
  await page.route(/\/api\/health(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({
      response,
      json: { ...health, root: "/", initialPath: HOME, homePath: HOME },
    });
  });
  await page.route("**/api/agent/permissions*", (route) =>
    route.fulfill({ json: TASK_PERMISSION_FIXTURE }),
  );
  await page.route(/\/api\/list(?:\?|$)/, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    requests.push(path);
    await hold.get(path);
    const failure = FAILURES[path];
    if (failure || !(path in LISTINGS)) {
      const [status, code, message] = failure ?? [404, "not_found", `path not found: ${path}`];
      await route.fulfill({ status, json: { error: { code, message } } });
      return;
    }
    await route.fulfill({
      json: {
        root: "/",
        path,
        git: null,
        entries: LISTINGS[path].map((name) => ({
          name,
          path: [path, name].filter(Boolean).join("/"),
          kind: name.endsWith(".txt") ? "file" : "directory",
          isSymlink: false,
          supported: true,
          gitIgnored: false,
          git: null,
        })),
      },
    });
  });
  return requests;
}

async function openNewTask(page, cwd = "") {
  await installTaskLoopFixture(page);
  const requests = await installDirectories(page);
  await page.goto(cwd ? `/tasks/new?cwd=${encodeURIComponent(cwd)}` : "/tasks/new");
  const field = directoryField(page);
  await expect(field).toHaveAttribute("data-node", "closed");
  return { field, requests };
}

function directoryField(page) {
  return page.locator("caffold-task-new caffold-task-directory-field");
}

function rowNames(field) {
  return field.locator("caffold-file-tree .file-tree-name").allTextContents();
}

function folderRow(field, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`^${escaped}$`);
  return field.locator("caffold-file-tree button.file-tree-entry").filter({
    has: field.page().locator(".file-tree-name", { hasText: exact }),
  });
}

test("lines the directory up with the Composer card, joins its list below it, and keeps a long path's end in sight", { tag: "@all-viewports" }, async ({ page }) => {
  const { field } = await openNewTask(page, `${HOME}/Workspace/${LONG}/${LONG}-inside`);
  const path = field.locator(".task-directory-field-path");
  await expect(path).toHaveText(`~/Workspace/${LONG}/${LONG}-inside`);

  const closed = await page.evaluate(() => {
    const boxElement = document.querySelector(".task-directory-field-box");
    const panelElement = document.querySelector("caffold-task-new .task-composer-panel");
    const box = boxElement.getBoundingClientRect();
    const panel = panelElement.getBoundingClientRect();
    const icon = document.querySelector(".task-directory-field-icon").getBoundingClientRect();
    const chevron = document.querySelector(".task-directory-field-chevron").getBoundingClientRect();
    const pathElement = document.querySelector(".task-directory-field-path");
    const text = pathElement.querySelector("span").firstChild;
    const range = document.createRange();
    range.setStart(text, text.length - 1);
    range.setEnd(text, text.length);
    const last = range.getBoundingClientRect();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const first = range.getBoundingClientRect();
    const shown = pathElement.getBoundingClientRect();
    return {
      edges: [box.left - panel.left, box.right - panel.right],
      gap: panel.top - box.bottom,
      corners: [
        getComputedStyle(boxElement).borderBottomLeftRadius,
        getComputedStyle(panelElement).borderBottomLeftRadius,
      ],
      insets: [icon.left - box.left, box.right - chevron.right],
      overflowing: pathElement.scrollWidth > pathElement.clientWidth,
      lastShown: last.left >= shown.left - 0.5 && last.right <= shown.right + 0.5,
      firstClipped: first.left < shown.left,
      pageOverflow: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  });
  expect(closed.edges[0]).toBeCloseTo(0, 0);
  expect(closed.edges[1]).toBeCloseTo(0, 0);
  expect(closed.gap).toBeGreaterThan(0);
  expect(closed.corners[0]).toBe(closed.corners[1]);
  expect(closed.insets[1]).toBeCloseTo(closed.insets[0], 0);
  expect(closed.overflowing).toBe(true);
  expect(closed.lastShown).toBe(true);
  expect(closed.firstClipped).toBe(true);
  expect(closed.pageOverflow).toBeLessThanOrEqual(0);

  // A short folder's list is as tall as its rows; a long one stops at its cap
  // and scrolls inside.
  await page.goto(`/tasks/new?cwd=${encodeURIComponent(`${HOME}/Workspace/rust`)}`);
  await field.getByRole("button", { name: "Show folders" }).click();
  await expect(folderRow(field, "codger")).toBeVisible();
  const joined = await page.evaluate(() => {
    const box = document.querySelector(".task-directory-field-box");
    const list = document.querySelector(".task-directory-field-panel");
    const card = document.querySelector("caffold-task-new .task-composer-panel");
    const boxRect = box.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      gap: listRect.top - boxRect.bottom,
      edges: [listRect.left - boxRect.left, listRect.right - boxRect.right],
      boxBottom: getComputedStyle(box).borderBottomLeftRadius,
      listTop: getComputedStyle(list).borderTopLeftRadius,
      listBottom: getComputedStyle(list).borderBottomLeftRadius,
      card: getComputedStyle(card).borderBottomLeftRadius,
    };
  });
  expect(joined.gap).toBeCloseTo(0, 0);
  expect(joined.edges[0]).toBeCloseTo(0, 0);
  expect(joined.edges[1]).toBeCloseTo(0, 0);
  expect(joined.boxBottom).toBe("0px");
  expect(joined.listTop).toBe("0px");
  expect(joined.listBottom).toBe(joined.card);
  const scroller = field.locator("caffold-file-tree .file-tree-scroll");
  const short = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(short).toBeLessThanOrEqual(0);

  await folderRow(field, "..").click();
  await expect(field.locator(".task-directory-field-path")).toHaveText("~/Workspace");
  await folderRow(field, "..").click();
  await expect(field.locator(".task-directory-field-path")).toHaveText("~");
  await folderRow(field, "Many").click();
  await expect(folderRow(field, "folder-39")).toHaveCount(1);
  const long = await scroller.evaluate((element) => ({
    scrolls: element.scrollHeight > element.clientHeight + 1,
    clientHeight: element.clientHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(long.scrolls).toBe(true);
  expect(long.clientHeight).toBeLessThan(long.viewportHeight / 2 + 1);

  // The pressed edit button keeps an even gap from the box's edges.
  await field.getByRole("button", { name: "Type a path" }).click();
  const inset = await page.evaluate(() => {
    const box = document.querySelector(".task-directory-field-box").getBoundingClientRect();
    const edit = document.querySelector(".task-directory-field-edit").getBoundingClientRect();
    return { top: edit.top - box.top, bottom: box.bottom - edit.bottom };
  });
  expect(Math.abs(inset.top - inset.bottom)).toBeLessThanOrEqual(1);
  expect(inset.top).toBeGreaterThanOrEqual(3);
});

test("Section New shows its fixed directory where New Task shows the field", { tag: "@all-viewports" }, async ({ page }) => {
  const { field } = await openNewTask(page, `${HOME}/Workspace/rust/codger`);
  const measure = (selector, iconSelector, textSelector) => page.evaluate(
    ([rowSelector, icon, text]) => {
      const row = document.querySelector(rowSelector);
      const panel = row.closest("caffold-task-create").querySelector(".task-composer-panel")
        .getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const glyph = row.querySelector(icon).getBoundingClientRect();
      const words = row.querySelector(text).getBoundingClientRect();
      return {
        left: box.left - panel.left,
        right: box.right - panel.right,
        height: box.height,
        icon: glyph.left - panel.left,
        text: words.left - panel.left,
        cardBelow: panel.top - box.top,
      };
    },
    [selector, iconSelector, textSelector],
  );
  await expect(field.locator(".task-directory-field-glyph").first()).toBeVisible();
  const global = await measure(
    ".task-directory-field-box",
    ".task-directory-field-icon svg",
    ".task-directory-field-path",
  );

  const task = {
    id: "thread_directory_section",
    threadId: "thread_directory_section",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    title: "Section Task",
    cwd: `${HOME}/Workspace/rust/codger`,
    cwdPath: `${HOME}/Workspace/rust/codger`,
    relativeCwd: "",
    worktree: null,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    lastEventSummary: "Section summary",
  };
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.goto("/?section=fixture-section-1");
  const fixed = page.locator("caffold-section-detail .task-create-fixed-directory");
  await expect(fixed.locator(".task-create-fixed-directory-path")).toHaveText("~/Workspace/rust/codger");
  await expect(page.locator("caffold-section-detail caffold-task-directory-field")).toHaveCount(0);
  await expect(fixed.locator("svg")).toBeVisible();
  const section = await measure(
    "caffold-section-detail .task-create-fixed-directory",
    "svg",
    ".task-create-fixed-directory-path",
  );
  for (const key of ["left", "right", "height", "icon", "text", "cardBelow"]) {
    expect(section[key], key).toBeCloseTo(global[key], 0);
  }
});

test("browses folders with the parent first and hidden folders last, choosing each one it opens", { tag: "@viewport-independent" }, async ({ page }) => {
  const { field } = await openNewTask(page);
  const path = field.locator(".task-directory-field-path");
  await expect(path).toHaveText("~");
  await expect(field.locator(".task-directory-field-panel")).toBeHidden();

  const toggle = field.getByRole("button", { name: "Show folders" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(field).toHaveAttribute("data-node", "browsing");
  await expect(field.getByRole("button", { name: "Hide folders" })).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => rowNames(field)).toEqual([
    "..",
    "Applications",
    "Library",
    "Many",
    "Workspace",
    ".cache",
    ".config",
  ]);
  await expect(folderRow(field, ".cache")).toHaveAttribute("data-hidden-entry", "");
  await expect(field.getByRole("listbox", { name: "Folders" })).toBeVisible();

  await folderRow(field, "Workspace").click();
  await expect(path).toHaveText("~/Workspace");
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(`${HOME}/Workspace`)}`);
  await expect.poll(() => rowNames(field)).toEqual(["..", LONG, "rust"]);
  await expect(field).toHaveAttribute("data-node", "browsing");

  await folderRow(field, "..").click();
  await expect(path).toHaveText("~");
  await folderRow(field, "Library").click();
  await expect(field.locator(".task-directory-field-error")).toHaveText(
    "permission denied: Users/me/Library",
  );
  await expect(path).toHaveText("~");
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(HOME)}`);
  await expect.poll(() => rowNames(field)).toContain("Library");

  // Choosing a folder replaced the New Task entry, so Back leaves New Task.
  await page.goBack();
  await expect(page).toHaveURL("/");

  await page.goForward();
  await expect(path).toHaveText("~");
  await field.getByRole("button", { name: "Show folders" }).click();
  await field.getByRole("button", { name: "Hide folders" }).click();
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(field.locator(".task-directory-field-panel")).toBeHidden();
});

test("types a path with the list following, completes with Tab, and chooses with Enter", { tag: "@viewport-independent" }, async ({ page }) => {
  const { field } = await openNewTask(page);
  const input = field.getByRole("combobox", { name: "Working directory path" });
  const prompt = page.locator('caffold-task-new textarea[name="prompt"]');

  await field.getByRole("button", { name: "Type a path" }).click();
  await expect(field).toHaveAttribute("data-node", "editing");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("~/");
  await expect(field.getByRole("button", { name: "Stop typing" })).toHaveAttribute("aria-pressed", "true");

  await input.pressSequentially("Workspace/rust/GL");
  await expect.poll(() => rowNames(field)).toEqual(["gleam", "glues", "gluesql"]);
  await expect(folderRow(field, "gleam")).toHaveAttribute("aria-selected", "true");
  const gleamId = await folderRow(field, "gleam").getAttribute("id");
  await expect(input).toHaveAttribute("aria-activedescendant", gleamId);

  await input.press("ArrowDown");
  await expect(folderRow(field, "glues")).toHaveAttribute("aria-selected", "true");
  await input.press("Tab");
  await expect(input).toHaveValue("~/Workspace/rust/glues/");
  await expect(input).toBeFocused();
  await expect(field.locator(".task-directory-field-path")).toHaveText("~");
  await expect(page).toHaveURL("/tasks/new");

  await input.press("Enter");
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(field.locator(".task-directory-field-path")).toHaveText("~/Workspace/rust/glues");
  await expect(page).toHaveURL(
    `/tasks/new?cwd=${encodeURIComponent(`${HOME}/Workspace/rust/glues`)}`,
  );
  await expect(prompt).toBeFocused();

  // A whole path pasted in works the same.
  await field.getByRole("button", { name: "Type a path" }).click();
  await input.fill("/private/tmp");
  await input.press("Enter");
  await expect(field.locator(".task-directory-field-path")).toHaveText("/private/tmp");
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent("private/tmp")}`);

  // A name that is not there, or a path the field cannot read, says why.
  await field.getByRole("button", { name: "Type a path" }).click();
  await input.fill("Workspace");
  await expect(field.locator(".task-directory-field-error")).toHaveText("Start the path with / or ~.");
  await input.fill("~/nowhere");
  await input.press("Enter");
  await expect(field.locator(".task-directory-field-error")).toHaveText(
    `path not found: ${HOME}/nowhere`,
  );
  await expect(field).toHaveAttribute("data-node", "editing");
  await expect(field.locator(".task-directory-field-path")).toHaveText("/private/tmp");
  await expect(field.locator(".task-directory-field-panel")).toBeVisible();
  await expect(field.locator("caffold-file-tree")).toBeHidden();

  // A name nothing starts with says so instead of leaving an empty list.
  await input.fill("~/zzz");
  await expect(field.locator("caffold-file-tree .file-tree-status")).toHaveText("No matching folders.");

  // Typing `.` shows the hidden folders.
  await input.fill("~/.");
  await expect.poll(() => rowNames(field)).toEqual([".cache", ".config"]);
});

test("steps back with Escape and drops typed text when focus leaves", { tag: "@viewport-independent" }, async ({ page }) => {
  const { field } = await openNewTask(page);
  const input = field.getByRole("combobox", { name: "Working directory path" });
  const toggle = field.locator(".task-directory-field-toggle");
  const prompt = page.locator('caffold-task-new textarea[name="prompt"]');

  await field.getByRole("button", { name: "Type a path" }).click();
  await input.pressSequentially("Work");
  await expect.poll(() => rowNames(field)).toEqual(["Workspace"]);
  await input.press("Escape");
  await expect(field).toHaveAttribute("data-node", "browsing");
  await expect(input).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect.poll(() => rowNames(field)).toContain("Applications");
  await page.keyboard.press("Escape");
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(toggle).toBeFocused();

  await field.getByRole("button", { name: "Type a path" }).click();
  await input.pressSequentially("Work");
  await prompt.click();
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(field.locator(".task-directory-field-path")).toHaveText("~");
  await field.getByRole("button", { name: "Type a path" }).click();
  await expect(input).toHaveValue("~/");

  // With nothing highlighted Tab moves on: to the edit button, then out.
  await input.press("Tab");
  await expect(field.getByRole("button", { name: "Stop typing" })).toBeFocused();
  await expect(field).toHaveAttribute("data-node", "editing");
  await page.keyboard.press("Tab");
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(page).toHaveURL("/tasks/new");
});

test("reaches the field, its rows, and its scroll area from the keyboard", { tag: "@viewport-independent" }, async ({ page }) => {
  const { field } = await openNewTask(page);
  const input = field.getByRole("combobox", { name: "Working directory path" });

  let dialog = await enterActionHints(page);
  let badge = dialog.getByLabel(/ — Show folders$/);
  await page.keyboard.type((await badge.getAttribute("data-action-hint-code")).toLowerCase());
  await expect(dialog).toBeHidden();
  await expect(field).toHaveAttribute("data-node", "browsing");
  await expect(field.locator(".task-directory-field-toggle")).toBeFocused();
  await expect(folderRow(field, "Many")).toBeVisible();

  // The keyboard mode's overlay taking focus is not leaving the field.
  await page.keyboard.press("f");
  dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(field).toHaveAttribute("data-node", "browsing");
  badge = dialog.getByLabel(/ — Open Many folder$/);
  await page.keyboard.type((await badge.getAttribute("data-action-hint-code")).toLowerCase());
  await expect(dialog).toBeHidden();
  await expect(field.locator(".task-directory-field-path")).toHaveText("~/Many");
  await expect(field).toHaveAttribute("data-node", "browsing");
  await expect(folderRow(field, "folder-00")).toBeVisible();

  const surfaces = await page.locator("caffold-app-shell").evaluate((shell) =>
    shell.keyboardNavigationContexts()
      .flatMap((context) => context.scroll?.scope?.surfaces ?? [])
      .filter((surface) => surface.isEligible())
      .map((surface) => surface.label)
  );
  expect(surfaces).toContain("Folders");

  await page.keyboard.press("f");
  dialog = actionHintDialog(page);
  badge = dialog.getByLabel(/ — Type a path$/);
  await page.keyboard.type((await badge.getAttribute("data-action-hint-code")).toLowerCase());
  await expect(dialog).toBeHidden();
  await expect(field).toHaveAttribute("data-node", "editing");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("~/Many/");
});

test("leaves keys that finish composing text to the input method", { tag: "@viewport-independent" }, async ({ page }) => {
  const { field } = await openNewTask(page);
  const input = field.getByRole("combobox", { name: "Working directory path" });
  await field.getByRole("button", { name: "Type a path" }).click();
  await input.pressSequentially("Workspace");
  await expect.poll(() => rowNames(field)).toEqual(["Workspace"]);

  for (const key of ["Enter", "Escape", "Tab", "ArrowDown"]) {
    await input.evaluate((element, composingKey) => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: composingKey,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }));
    }, key);
  }
  await expect(field).toHaveAttribute("data-node", "editing");
  await expect(input).toHaveValue("~/Workspace");
  await expect(page).toHaveURL("/tasks/new");
});

test("an answer for a folder left behind does not land", { tag: "@viewport-independent" }, async ({ page }) => {
  await installTaskLoopFixture(page);
  // Records each listing once everything its answer started has run, so the
  // test waits for exactly the answer it is about.
  await page.addInitScript(() => {
    window.__listingsHandled = [];
    const json = Response.prototype.json;
    Response.prototype.json = function readJson(...args) {
      const url = this.url;
      return json.apply(this, args).then((value) => {
        if (url.includes("/api/list")) {
          setTimeout(() => {
            window.__listingsHandled.push(new URL(url).searchParams.get("path"));
          }, 0);
        }
        return value;
      });
    };
  });
  let releaseApplications;
  const applicationsHeld = new Promise((resolve) => {
    releaseApplications = resolve;
  });
  const requests = await installDirectories(page, {
    hold: new Map([[`${HOME}/Applications`, applicationsHeld]]),
  });
  await page.goto("/tasks/new");
  const field = directoryField(page);
  await field.getByRole("button", { name: "Show folders" }).click();
  await folderRow(field, "Applications").click();
  await expect.poll(() => requests.includes(`${HOME}/Applications`)).toBe(true);
  await folderRow(field, "Workspace").click();
  await expect(field.locator(".task-directory-field-path")).toHaveText("~/Workspace");

  await expect.poll(() => rowNames(field)).toEqual(["..", LONG, "rust"]);
  releaseApplications();
  await expect.poll(() => page.evaluate(() => window.__listingsHandled))
    .toContain(`${HOME}/Applications`);
  await expect(field.locator(".task-directory-field-path")).toHaveText("~/Workspace");
  expect(await rowNames(field)).toEqual(["..", LONG, "rust"]);
  await expect(page).toHaveURL(`/tasks/new?cwd=${encodeURIComponent(`${HOME}/Workspace`)}`);
});

test("locks the directory while the Task starts", { tag: "@viewport-independent" }, async ({ page }) => {
  await installTaskLoopFixture(page);
  await installDirectories(page);
  let markCreateRequested;
  const createRequested = new Promise((resolve) => {
    markCreateRequested = resolve;
  });
  let releaseCreate;
  const createHeld = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  await page.route(/\/api\/tasks(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    markCreateRequested(route.request().postDataJSON());
    await createHeld;
    await route.fulfill({
      status: 503,
      json: { error: { code: "unavailable", message: "The Task could not start." } },
    });
  });
  await page.goto("/tasks/new");
  const field = directoryField(page);
  await field.getByRole("button", { name: "Show folders" }).click();
  const prompt = page.locator('caffold-task-new textarea[name="prompt"]');
  await prompt.fill("Start here");
  await prompt.press("Enter");
  expect((await createRequested).cwd).toBe(HOME);
  await expect(field).toHaveAttribute("data-node", "closed");
  await expect(field.locator(".task-directory-field-toggle")).toBeDisabled();
  await expect(field.locator(".task-directory-field-edit")).toBeDisabled();

  releaseCreate();
  await expect(page.locator("caffold-task-new .task-create-status")).toContainText(
    "The Task could not start.",
  );
  await expect(field.locator(".task-directory-field-toggle")).toBeEnabled();
  await expect(field.locator(".task-directory-field-edit")).toBeEnabled();
});
