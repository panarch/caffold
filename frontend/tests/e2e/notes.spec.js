import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  activateActionHintIntoPopover,
  popoverActionHintDialog,
} from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { captureReviewScreenshot, mockAgentModels } from "./support/task-fixtures.js";
import { openCompletedTaskForReview } from "./support/task-review-test.js";

const LONG_DIRECTORY_NAME =
  "Caffold architecture decisions that outgrew a short directory name";
const LONG_NOTE_NAME =
  "Why the Notes store keeps one current copy of every Note and no history yet";

const TREE = {
  directories: [
    { id: "projects", parentId: null, name: "Projects", updatedAtMs: 1_000 },
    { id: "decisions", parentId: "projects", name: "Decisions", updatedAtMs: 1_000 },
    { id: "long", parentId: "projects", name: LONG_DIRECTORY_NAME, updatedAtMs: 1_000 },
  ],
  notes: [
    { id: "inbox", directoryId: null, name: "Inbox", updatedAtMs: 1_000 },
    { id: "storage", directoryId: "decisions", name: "Storage decision", updatedAtMs: 2_000 },
    { id: "history", directoryId: "long", name: LONG_NOTE_NAME, updatedAtMs: 3_000 },
    { id: "blank", directoryId: "decisions", name: "Blank", updatedAtMs: 4_000 },
  ],
};

// What `GET /api/notes` answers for one directory, or for the top of the tree
// when `directoryId` is "".
function treeLevel(tree, directoryId) {
  const holds = (parentId) => (parentId ?? "") === directoryId;
  return {
    directories: tree.directories
      .filter((directory) => holds(directory.parentId))
      .map((directory) => ({
        id: directory.id,
        name: directory.name,
        updatedAtMs: directory.updatedAtMs,
        directoryCount: tree.directories.filter((child) => child.parentId === directory.id).length,
        noteCount: tree.notes.filter((entry) => entry.directoryId === directory.id).length,
      })),
    notes: tree.notes
      .filter((entry) => holds(entry.directoryId))
      .map((entry) => ({ id: entry.id, name: entry.name, updatedAtMs: entry.updatedAtMs })),
  };
}

function treeLocation(directoryId) {
  const location = [];
  let directory = TREE.directories.find((entry) => entry.id === directoryId);
  while (directory) {
    location.unshift({ id: directory.id, name: directory.name });
    directory = TREE.directories.find((entry) => entry.id === directory.parentId);
  }
  return location;
}

function note(id, overrides = {}) {
  const summary = TREE.notes.find((entry) => entry.id === id);
  return {
    id,
    name: summary.name,
    content: `# ${summary.name}\n\nWritten by an agent.\n`,
    location: treeLocation(summary.directoryId),
    createdAtMs: 1_000,
    updatedAtMs: summary.updatedAtMs,
    createdBy: { threadId: "task-writer", state: "active", displayName: "Write storage notes" },
    updatedBy: { threadId: "task-writer", state: "active", displayName: "Write storage notes" },
    ...overrides,
  };
}

const NOTES = {
  inbox: note("inbox"),
  storage: note("storage", {
    content: "# Storage\n\nKeep **one** current copy.\n",
    updatedBy: { threadId: "task-gone", state: "deleted" },
  }),
  history: note("history", {
    content: `# ${LONG_NOTE_NAME}\n\n${"A long paragraph about the store. ".repeat(40)}\n`,
  }),
  blank: note("blank", { content: "" }),
};

async function stubNotes(page, {
  tree = TREE,
  notes = NOTES,
  holdNote = null,
  failLevel = () => false,
} = {}) {
  const requests = { levels: [] };
  await page.route(/\/api\/notes(?:\?|$)/, (route) => {
    const directoryId = new URL(route.request().url()).searchParams.get("directoryId") ?? "";
    requests.levels.push(directoryId);
    if (failLevel(directoryId)) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Notes are unavailable." } }),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(treeLevel(typeof tree === "function" ? tree() : tree, directoryId)),
    });
  });
  await page.route(/\/api\/notes\/[^/?]+(?:\?|$)/, async (route) => {
    const noteId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    if (holdNote?.noteId === noteId) {
      await holdNote.released;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(notes[noteId]),
      }).catch(() => {});
      holdNote.answered();
      return;
    }
    const found = notes[noteId];
    if (!found) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "note_not_found", message: `No Note has the id \`${noteId}\`.` },
        }),
      });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(found) });
  });
  return requests;
}

function notesNavigator(page) {
  return page.locator("caffold-notes-navigator");
}

function notesWorkspace(page) {
  return page.locator("caffold-notes-workspace");
}

function notesTitle(page) {
  return notesWorkspace(page).locator(".notes-workspace-detail-header > h1");
}

function treeNames(page) {
  return notesNavigator(page).locator("button.file-tree-entry .file-tree-name");
}

function treeEntry(page, name) {
  const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return notesNavigator(page).locator("button.file-tree-entry").filter({
    has: page.locator(".file-tree-name", { hasText: exactName }),
  });
}

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("the Notes tab sits between Tasks and Settings and reads the server's empty store", { tag: "@desktop" }, async ({
  page,
}) => {
  await page.goto("/");
  const tabs = page.locator("caffold-task-workspace-navigation button[data-workspace-mode]");
  await expect(tabs).toHaveText(["Tasks", "Notes", "Settings"]);

  await tabs.nth(1).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(tabs.nth(1)).toHaveAttribute("aria-current", "");
  await expect(notesNavigator(page).locator(".notes-navigator-message"))
    .toHaveText("No notes yet. Ask an agent in a Task to save one.");
  await expect(notesNavigator(page).locator("caffold-file-tree")).toBeHidden();
  await expect(notesWorkspace(page).locator(".notes-workspace-status")).toBeHidden();
});

test("the tree opens one directory at a time, directories first, beside the open Note and who wrote it", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const requests = await stubNotes(page);
  await page.goto("/notes");

  await expect(notesWorkspace(page).locator(".notes-workspace-message"))
    .toHaveText("Choose a note to read it.");
  await expect(treeNames(page)).toHaveText(["Projects", "Inbox"]);
  expect(requests.levels).toEqual([""]);

  await treeEntry(page, "Projects").click();
  await expect(treeNames(page)).toHaveText([
    "Projects",
    LONG_DIRECTORY_NAME,
    "Decisions",
    "Inbox",
  ]);
  await treeEntry(page, "Decisions").click();
  await expect(treeNames(page)).toHaveText([
    "Projects",
    LONG_DIRECTORY_NAME,
    "Decisions",
    "Blank",
    "Storage decision",
    "Inbox",
  ]);
  expect(requests.levels).toEqual(["", "projects", "decisions"]);

  await activateActionHint(page, "Open Storage decision");
  await expect(page).toHaveURL(/\/notes\/storage$/);
  const workspace = notesWorkspace(page);
  await expect(notesTitle(page)).toHaveText("Storage decision");
  await expect(workspace.locator(".notes-workspace-location")).toHaveText("Projects / Decisions");
  await expect(workspace.locator("caffold-markdown-preview strong")).toHaveText("one");
  await expect(treeEntry(page, "Storage decision")).toHaveAttribute("aria-current", "true");

  const detailsButton = workspace.getByRole("button", { name: "Note details" });
  await detailsButton.click();
  const details = workspace.locator(".notes-info-popover");
  await expect(details).toBeVisible();
  await expect(details.locator("dl > div:not([hidden]) > dt")).toHaveText([
    "Updated",
    "Created",
    "Created in",
    "Changed in",
  ]);
  expect(await details.locator("time").evaluateAll((times) => times.map((time) => time.dateTime)))
    .toEqual([new Date(2_000).toISOString(), new Date(1_000).toISOString()]);
  await expect(details.getByRole("link", { name: "Write storage notes" }))
    .toHaveAttribute("href", "/tasks/task-writer");
  await expect(details.locator("dl > div:not([hidden]) > dd").last()).toHaveText("a deleted task");
  await captureReviewScreenshot(page, testInfo, "notes-open-note");
  await detailsButton.click();
  await expect(details).toBeHidden();

  await treeEntry(page, LONG_DIRECTORY_NAME).click();
  await treeEntry(page, LONG_NOTE_NAME).click();
  await expect(page).toHaveURL(/\/notes\/history$/);
  const title = notesTitle(page);
  await expect(title).toHaveText(LONG_NOTE_NAME);
  await expect(title).toHaveAttribute("title", LONG_NOTE_NAME);
  const headers = await page.evaluate(() => {
    const bottom = (selector) => document.querySelector(selector).getBoundingClientRect().bottom;
    return {
      navigator: bottom("caffold-notes-navigator > .notes-navigator-header"),
      notes: bottom("caffold-notes-workspace .notes-workspace-detail-header"),
    };
  });
  expect(headers.notes).toBe(headers.navigator);
  await captureReviewScreenshot(page, testInfo, "notes-long-names");
});

test("an archived Task that wrote a Note is named without a link", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page, {
    notes: {
      ...NOTES,
      inbox: note("inbox", {
        createdBy: { threadId: "task-archived", state: "archived", displayName: "Draft the inbox" },
      }),
    },
  });
  await page.goto("/notes/inbox");
  await expect(notesTitle(page)).toHaveText("Inbox");

  const workspace = notesWorkspace(page);
  await workspace.getByRole("button", { name: "Note details" }).click();
  const details = workspace.locator(".notes-info-popover");
  await expect(details.locator("dl > div:not([hidden]) > dd").nth(2))
    .toHaveText("Draft the inbox (archived)");
  await expect(details.getByRole("link")).toHaveText(["Write storage notes"]);
});

test("Action Hints open Note details and continue inside them until Escape closes them", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes/storage");
  await expect(notesTitle(page)).toHaveText("Storage decision");

  await activateActionHintIntoPopover(page, "Note details");
  const details = notesWorkspace(page).locator(".notes-info-popover");
  await expect(details).toBeVisible();
  const hint = popoverActionHintDialog(page);
  await expect(hint.getByRole("button", { name: / — Write storage notes$/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(details).toBeHidden();
});

test("a Note address opens the directories that hold it", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes/storage");

  await expect(notesTitle(page)).toHaveText("Storage decision");
  await expect(treeNames(page)).toHaveText([
    "Projects",
    LONG_DIRECTORY_NAME,
    "Decisions",
    "Blank",
    "Storage decision",
    "Inbox",
  ]);
  await expect(treeEntry(page, "Storage decision")).toHaveAttribute("aria-current", "true");
});

test("a directory that fails to load says so and loads again when it is opened again", { tag: "@desktop" }, async ({
  page,
}) => {
  let failures = 1;
  await stubNotes(page, {
    failLevel: (directoryId) => directoryId === "projects" && failures-- > 0,
  });
  await page.goto("/notes");

  await treeEntry(page, "Projects").click();
  await expect(notesNavigator(page).locator("li.file-tree-status.is-error"))
    .toHaveText("Notes are unavailable.");
  await treeEntry(page, "Projects").click();
  await expect(treeNames(page)).toHaveText(["Projects", "Inbox"]);

  const reread = page.waitForRequest((request) =>
    new URL(request.url()).searchParams.get("directoryId") === "projects");
  await treeEntry(page, "Projects").click();
  await reread;
  await expect(treeNames(page)).toHaveText([
    "Projects",
    LONG_DIRECTORY_NAME,
    "Decisions",
    "Inbox",
  ]);
  await expect(notesNavigator(page).locator("li.file-tree-status")).toHaveCount(0);
});

test("the Note header measures the same as the Settings header it follows", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await stubNotes(page);
  const headerGeometry = (headerSelector) => page.evaluate((selector) => {
    const header = document.querySelector(selector);
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width === 0
        ? null
        : { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    };
    const title = header.querySelector(":scope > h1").getBoundingClientRect();
    return {
      header: box(header),
      back: box(header.querySelector(":scope > button")),
      titleLeft: title.left,
      titleCenter: title.top + title.height / 2,
    };
  }, headerSelector);

  await page.goto("/settings/appearance");
  await expect(page.locator("caffold-settings-workspace .settings-workspace-detail-header")).toBeVisible();
  const settings = await headerGeometry("caffold-settings-workspace .settings-workspace-detail-header");

  await page.goto("/notes/inbox");
  await expect(notesTitle(page)).toHaveText("Inbox");
  const notes = await headerGeometry("caffold-notes-workspace .notes-workspace-detail-header");

  expect(notes).toEqual(settings);
});

test("the Note details button sits where the Task details button does", { tag: "@all-viewports" }, async ({
  page,
}) => {
  // Task Detail stacks its view switch under the title row on a phone, so the
  // button is placed against the title it shares a row with.
  const buttonGeometry = (button, { header, title }) => button.evaluate((element, selectors) => {
    const round = (value) => Math.round(value * 100) / 100;
    const headerElement = element.closest(selectors.header);
    const headerBox = headerElement.getBoundingClientRect();
    const titleBox = headerElement.querySelector(selectors.title).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      width: round(box.width),
      height: round(box.height),
      rightGap: round(headerBox.right - box.right),
      offsetFromTitleCenter: round(
        box.top + box.height / 2 - (titleBox.top + titleBox.height / 2),
      ),
    };
  }, { header, title });

  await mockAgentModels(page);
  await openCompletedTaskForReview(page);
  const taskButton = page.locator("caffold-task-detail-info .task-detail-info-button");
  await expect(taskButton).toBeVisible();
  const task = await buttonGeometry(taskButton, {
    header: ".detail-layout-summary",
    title: ".task-detail-heading > h2",
  });

  await stubNotes(page);
  await page.goto("/notes/inbox");
  await expect(notesTitle(page)).toHaveText("Inbox");
  const notesButton = notesWorkspace(page).getByRole("button", { name: "Note details" });
  await expect(notesButton).toBeVisible();
  const notes = await buttonGeometry(notesButton, {
    header: ".notes-workspace-detail-header",
    title: ":scope > h1",
  });

  expect(notes).toEqual(task);
});

test("a phone shows the tree, then one Note, and Back returns to the tree", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
  await stubNotes(page);
  await page.goto("/notes");

  const masterPane = page.locator(".task-workspace-master-pane");
  const detailPane = page.locator(".task-workspace-detail-pane");
  await expect(masterPane).toBeVisible();
  await expect(detailPane).toBeHidden();
  await treeEntry(page, "Inbox").click();

  await expect(page).toHaveURL(/\/notes\/inbox$/);
  await expect(masterPane).toBeHidden();
  await expect(detailPane).toBeVisible();
  await expect(notesTitle(page)).toHaveText("Inbox");
  await captureReviewScreenshot(page, testInfo, "notes-phone-note");

  await notesWorkspace(page).getByRole("button", { name: "Back to notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(masterPane).toBeVisible();
  await expect(detailPane).toBeHidden();

  // Rewound rather than stacked: the Note it left is ahead of here, not behind.
  await page.goForward();
  await expect(page).toHaveURL(/\/notes\/inbox$/);
});

test("opens a Note by address with the tree it sits under beneath it", { tag: "@phone" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes/inbox");
  await expect(notesTitle(page)).toHaveText("Inbox");

  // The tree goes into history under the Note, so leaving the Note rewinds
  // into that entry instead of taking the Note's own.
  await notesWorkspace(page).getByRole("button", { name: "Back to notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/notes\/inbox$/);
  await expect(notesTitle(page)).toHaveText("Inbox");
});

test("a phone places Note details where it places Task details", { tag: "@phone" }, async ({
  page,
}, testInfo) => {
  const popoverPlacement = (popover, headerSelector) => popover.evaluate((element, selector) => {
    const header = document.querySelector(selector).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const label = element.querySelector("dt").getBoundingClientRect();
    const value = element.querySelector("dd").getBoundingClientRect();
    return {
      left: box.left,
      rightGap: document.documentElement.clientWidth - box.right,
      gapBelowHeader: box.top - header.bottom,
      valueUnderLabel: value.top >= label.bottom,
    };
  }, headerSelector);

  await mockAgentModels(page);
  await openCompletedTaskForReview(page);
  await page.locator("caffold-task-detail-info .task-detail-info-button").click();
  const taskDetails = page.locator(".task-detail-popover");
  await expect(taskDetails).toBeVisible();
  const task = await popoverPlacement(taskDetails, "caffold-detail-layout .detail-layout-summary");

  await stubNotes(page);
  await page.goto("/notes/storage");
  await expect(notesTitle(page)).toHaveText("Storage decision");
  const workspace = notesWorkspace(page);
  await workspace.getByRole("button", { name: "Note details" }).click();
  const noteDetails = workspace.locator(".notes-info-popover");
  await expect(noteDetails).toBeVisible();
  const notes = await popoverPlacement(
    noteDetails,
    "caffold-notes-workspace .notes-workspace-detail-header",
  );

  expect(notes).toEqual({ ...task, valueUnderLabel: true });
  await captureReviewScreenshot(page, testInfo, "notes-phone-details");
});

test("choosing the Notes tab again brings the tree back to the top", { tag: "@phone" }, async ({
  page,
}) => {
  await stubNotes(page, {
    tree: {
      directories: [],
      notes: Array.from({ length: 40 }, (_, index) => ({
        id: `note-${index}`,
        directoryId: null,
        name: `Note ${String(index).padStart(2, "0")}`,
        updatedAtMs: 1_000,
      })),
    },
  });
  await page.goto("/notes");

  const scroller = notesNavigator(page).locator(
    ":scope > caffold-file-tree > .file-tree-scroll",
  );
  await expect(treeEntry(page, "Note 39")).toBeAttached();
  const bottom = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(bottom).toBeGreaterThan(0);

  await page
    .locator('caffold-task-workspace-navigation button[data-workspace-mode="notes"]')
    .click();

  await expect.poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(page).toHaveURL(/\/notes$/);
});

test("a Note URL survives reload and browser history", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes");
  const title = notesTitle(page);

  await treeEntry(page, "Inbox").click();
  await expect(page).toHaveURL(/\/notes\/inbox$/);
  await expect(title).toHaveText("Inbox");

  // Another Note sits where this one does, so it takes the same entry.
  await treeEntry(page, "Projects").click();
  await treeEntry(page, "Decisions").click();
  await treeEntry(page, "Storage decision").click();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await expect(title).toHaveText("Storage decision");

  await page.reload();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await expect(title).toHaveText("Storage decision");

  await page.goBack();
  await expect(page).toHaveURL(/\/notes$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await expect(title).toHaveText("Storage decision");
});

test("a missing Note and an empty Note each say what they are", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes/gone");
  const workspace = notesWorkspace(page);
  await expect(notesTitle(page)).toHaveText("Note not found");
  await expect(workspace.locator(".notes-workspace-message")).toHaveText("This note no longer exists.");
  await expect(workspace.locator("caffold-markdown-preview")).toBeHidden();

  await treeEntry(page, "Projects").click();
  await treeEntry(page, "Decisions").click();
  await treeEntry(page, "Blank").click();
  await expect(notesTitle(page)).toHaveText("Blank");
  await expect(workspace.locator(".notes-workspace-message")).toHaveText("This note is empty.");
  await expect(workspace.locator("caffold-markdown-preview")).toBeHidden();
});

test("an answer for a Note that was left never replaces the Note picked after it", { tag: "@desktop" }, async ({
  page,
}) => {
  let release;
  let answered;
  const holdNote = {
    noteId: "storage",
    released: new Promise((resolve) => {
      release = resolve;
    }),
    answered: () => answered(),
  };
  const lateAnswer = new Promise((resolve) => {
    answered = resolve;
  });
  await stubNotes(page, { holdNote });
  const heldRequest = page.waitForRequest(/\/api\/notes\/storage(?:\?|$)/);
  await page.goto("/notes/storage");
  const held = await heldRequest;
  const abandoned = page.waitForEvent("requestfailed", (request) => request === held);

  await treeEntry(page, "Inbox").click();
  const title = notesTitle(page);
  await expect(title).toHaveText("Inbox");
  await abandoned;

  release();
  await lateAnswer;
  await expect(page).toHaveURL(/\/notes\/inbox$/);
  await expect(title).toHaveText("Inbox");
  await expect(notesWorkspace(page).locator("caffold-markdown-preview h1")).toHaveText("Inbox");
});

test("Notes reads again and opens Notes after the app is attached again", { tag: "@desktop" }, async ({
  page,
}) => {
  await stubNotes(page);
  await page.goto("/notes/storage");
  const title = notesTitle(page);
  await expect(title).toHaveText("Storage decision");

  await page.evaluate(() => {
    const shell = document.querySelector("caffold-app-shell");
    window.__notesDetachedShell = shell;
    shell.remove();
  });
  const treeRead = page.waitForRequest(/\/api\/notes(?:\?|$)/);
  await page.evaluate(() => {
    document.body.append(window.__notesDetachedShell);
  });
  await treeRead;

  await treeEntry(page, "Inbox").click();
  await expect(page).toHaveURL(/\/notes\/inbox$/);
  await expect(title).toHaveText("Inbox");
  await expect(notesWorkspace(page).locator("caffold-markdown-preview h1")).toHaveText("Inbox");
});

test("coming back to Notes reads the top and every opened directory again", { tag: "@desktop" }, async ({
  page,
}) => {
  let tree = TREE;
  const requests = await stubNotes(page, { tree: () => tree });
  await page.goto("/notes");
  await treeEntry(page, "Projects").click();
  await expect(treeEntry(page, "Decisions")).toBeVisible();
  const tabs = page.locator("caffold-task-workspace-navigation button[data-workspace-mode]");

  await tabs.nth(0).click();
  await expect(page).toHaveURL(/\/$/);
  tree = {
    directories: TREE.directories,
    notes: [
      ...TREE.notes,
      { id: "added", directoryId: null, name: "Added by an agent", updatedAtMs: 5_000 },
      { id: "plan", directoryId: "projects", name: "Plan added by an agent", updatedAtMs: 5_000 },
    ],
  };
  const readsBefore = requests.levels.length;
  await tabs.nth(1).click();

  await expect(page).toHaveURL(/\/notes$/);
  await expect(treeEntry(page, "Added by an agent")).toBeVisible();
  await expect(treeEntry(page, "Plan added by an agent")).toBeVisible();
  expect(requests.levels.slice(readsBefore).sort()).toEqual(["", "projects"]);
});
