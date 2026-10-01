import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  activateActionHintIntoPopover,
  popoverActionHintDialog,
  enterActionHints,
  workspaceOcclusionTargets,
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

function primaryDocument(page) {
  return page.locator('caffold-note-document[data-note-side="primary"]');
}

function notesTitle(page) {
  return primaryDocument(page).locator(".notes-workspace-detail-header > h1");
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

test("Note details keeps compact paint, touch targets and native keyboard disclosure across Interface scales", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  await stubNotes(page);
  await page.goto("/notes/storage");
  const button = primaryDocument(page).getByRole("button", { name: "Note details" });
  const popover = primaryDocument(page).locator(".notes-info-popover");
  await expect(button).toBeVisible();
  for (const scale of [90, 120]) {
    await page.evaluate(async (value) => {
      const { setAppearanceRangeSetting } = await import("/assets/settings.js");
      setAppearanceRangeSetting("interfaceScalePercent", value);
    }, scale);
    const metrics = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const root = getComputedStyle(document.documentElement);
      const surface = getComputedStyle(element, "::before");
      return {
        width: rect.width,
        height: rect.height,
        visual: rect.height - parseFloat(surface.top) - parseFloat(surface.bottom),
        expectedVisual: parseFloat(root.fontSize) * 1.875,
        floor: parseFloat(root.getPropertyValue("--interface-target-floor")),
        border: surface.borderTopWidth,
      };
    });
    expect(metrics.width).toBeCloseTo(metrics.height, 1);
    expect(metrics.height).toBeCloseTo(Math.max(metrics.expectedVisual, metrics.floor), 1);
    expect(metrics.visual).toBeCloseTo(metrics.expectedVisual, 1);
    expect(metrics.border).toBe("1px");
  }
  await page.mouse.move(0, 0);
  const idle = await button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  await button.focus();
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).not.toBe(idle);
  await button.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(button).toBeFocused();
  await captureReviewScreenshot(page, testInfo, "notes-compact-button");
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
  await expect(primaryDocument(page).locator(".notes-workspace-status")).toBeHidden();
});

test("the tree opens one directory at a time, directories first, beside the open Note and who wrote it", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  const requests = await stubNotes(page);
  await page.goto("/notes");

  await expect(primaryDocument(page).locator(".notes-workspace-message"))
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
  const workspace = primaryDocument(page);
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

  const workspace = primaryDocument(page);
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
  const details = primaryDocument(page).locator(".notes-info-popover");
  await expect(details).toBeVisible();
  const hint = popoverActionHintDialog(page);
  await expect(hint.getByRole("button", { name: / — Write storage notes$/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await expect(details).toBeHidden();
});

test("Note details copies the Note's path and its Markdown, and has no Markdown to copy for an empty Note", { tag: "@desktop" }, async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubNotes(page);
  await page.goto("/notes/storage");
  await expect(notesTitle(page)).toHaveText("Storage decision");
  // Feedback lasts 1.8 seconds; the paused clock keeps it until the test moves on.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const clipboardText = () => page.evaluate(() => navigator.clipboard.readText());

  const workspace = primaryDocument(page);
  const detailsButton = workspace.getByRole("button", { name: "Note details" });
  await detailsButton.click();
  const details = workspace.locator(".notes-info-popover");
  const copyPath = details.locator("caffold-notes-info-copy-path > button");
  const copyMarkdown = details.locator("caffold-notes-info-copy-markdown > button");
  await expect(copyPath).toHaveText("Copy path");
  await expect(copyMarkdown).toHaveText("Copy Markdown");

  await copyPath.click();
  await expect(copyPath).toHaveText("Copied");
  await expect(details.locator('caffold-notes-info-copy-path > [role="status"]')).toHaveText("Copied");
  await expect(details).toBeVisible();
  await expect.poll(clipboardText).toBe("Projects / Decisions / Storage decision (note id: storage)");
  await page.clock.fastForward(1_800);
  await expect(copyPath).toHaveText("Copy path");

  await copyMarkdown.click();
  await expect(copyMarkdown).toHaveText("Copied");
  await expect.poll(clipboardText).toBe("# Storage\n\nKeep **one** current copy.\n");

  await treeEntry(page, "Blank").click();
  await expect(notesTitle(page)).toHaveText("Blank");
  await expect(details).toBeHidden();
  await detailsButton.click();
  await expect(copyMarkdown).toHaveText("Copy Markdown");
  await expect(copyMarkdown).toBeDisabled();
  await expect(copyPath).toBeEnabled();
});

test("Action Hints copy the Note path from inside Note details", { tag: "@desktop" }, async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubNotes(page);
  await page.goto("/notes/storage");
  await expect(notesTitle(page)).toHaveText("Storage decision");
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));

  await activateActionHintIntoPopover(page, "Note details");
  const hint = popoverActionHintDialog(page);
  await expect(hint.getByRole("button", { name: / — Copy Markdown$/ })).toBeVisible();
  const code = await hint.getByRole("button", { name: / — Copy path$/ })
    .getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await page.keyboard.type(code.toLowerCase());

  const details = primaryDocument(page).locator(".notes-info-popover");
  await expect(details.locator("caffold-notes-info-copy-path > button")).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Projects / Decisions / Storage decision (note id: storage)");
});

test("Note details actions measure the same as the Task details actions", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const actionGeometry = (section, button) => section.evaluate((element, buttonSelector) => {
    const control = element.querySelector(buttonSelector);
    const style = getComputedStyle(control);
    const frame = getComputedStyle(control, "::before");
    const sectionStyle = getComputedStyle(element);
    return {
      height: control.getBoundingClientRect().height,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      paddingInline: [style.paddingLeft, style.paddingRight],
      frame: [frame.top, frame.bottom, frame.borderTopWidth, frame.borderTopLeftRadius],
      section: [sectionStyle.marginTop, sectionStyle.paddingTop, sectionStyle.borderTopWidth],
    };
  }, button);

  await mockAgentModels(page);
  await openCompletedTaskForReview(page);
  await page.locator("caffold-task-detail-info .task-detail-info-button").click();
  const taskSection = page.locator(".task-detail-popover .task-detail-fork-action");
  await expect(taskSection).toBeVisible();
  const task = await actionGeometry(taskSection, ':scope > button[data-task-info-action="fork"]');

  await stubNotes(page);
  await page.goto("/notes/storage");
  await expect(notesTitle(page)).toHaveText("Storage decision");
  const workspace = primaryDocument(page);
  await workspace.getByRole("button", { name: "Note details" }).click();
  const notesSection = workspace.locator(".notes-info-popover > .notes-info-actions");
  await expect(notesSection).toBeVisible();
  const copyPath = await actionGeometry(
    notesSection,
    ":scope > caffold-notes-info-copy-path > button",
  );
  const copyMarkdown = await actionGeometry(
    notesSection,
    ":scope > caffold-notes-info-copy-markdown > button",
  );

  expect(copyPath).toEqual(task);
  expect(copyMarkdown).toEqual(task);
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
  const notesButton = primaryDocument(page).getByRole("button", { name: "Note details" });
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

  await primaryDocument(page).getByRole("button", { name: "Back to notes" }).click();
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
  await primaryDocument(page).getByRole("button", { name: "Back to notes" }).click();
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
  const workspace = primaryDocument(page);
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
  const workspace = primaryDocument(page);
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
  await expect(primaryDocument(page).locator("caffold-markdown-preview h1")).toHaveText("Inbox");
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
  await expect(primaryDocument(page).locator("caffold-markdown-preview h1")).toHaveText("Inbox");
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

function documentPane(page, side) {
  return page.locator(`caffold-note-document[data-note-side="${side}"]`);
}

test("side-by-side selection replaces either pane, cancels, and closes to the committed primary", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await stubNotes(page);
  await page.goto("/notes/storage");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  await primary.getByRole("button", { name: "View side by side" }).click();
  await expect(primary).toBeVisible();
  await expect(treeEntry(page, "Storage decision")).toBeDisabled();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await notesNavigator(page).getByRole("button", { name: "Cancel note selection" }).click();
  await expect(primary.getByRole("button", { name: "View side by side" })).toBeFocused();
  await primary.getByRole("button", { name: "View side by side" }).click();
  await treeEntry(page, "Inbox").click();
  await expect(page).toHaveURL(/\/notes\/storage\?beside=inbox$/);
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Inbox");
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await expect(treeEntry(page, "Inbox")).toBeDisabled();
  await secondary.getByRole("button", { name: "Close side by side" }).click();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(notesNavigator(page).locator("caffold-workspace-brand")).toBeVisible();

  await primary.getByRole("button", { name: "View side by side" }).click();
  await treeEntry(page, "Inbox").click();
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await treeEntry(page, "Blank").click();
  await expect(page).toHaveURL(/\/notes\/blank\?beside=inbox$/);
  await expect(primary.locator(".notes-workspace-message")).toHaveText("This note is empty.");
  await secondary.getByRole("button", { name: /choose another note/ }).click();
  await notesNavigator(page).getByRole("button", { name: "Cancel note selection" }).press("Escape");
  await expect(secondary.getByRole("button", { name: /choose another note/ })).toBeFocused();
  await secondary.getByRole("button", { name: /choose another note/ }).click();
  await notesNavigator(page).getByRole("button", { name: "Close side by side" }).click();
  await expect(page).toHaveURL(/\/notes\/blank$/);
  await captureReviewScreenshot(page, testInfo, "notes-side-by-side-closed");
});

test("a pair uses two equal columns across foldable widths and retains the route on a narrow screen", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await stubNotes(page);
  await page.goto("/notes/history?beside=inbox");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  for (const width of [641, 736, 899, 900, 933, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(primary).toBeVisible();
    await expect(secondary).toBeVisible();
    const a = await primary.boundingBox();
    const b = await secondary.boundingBox();
    expect(a.x).toBe(0);
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
    expect(b.x).toBeCloseTo(a.width + 1, 0);
    await expect(notesNavigator(page)).toBeHidden();
    await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await captureReviewScreenshot(page, testInfo, "notes-side-by-side");
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(primary).toBeVisible();
  await expect(secondary).toBeHidden();
  await expect(notesNavigator(page)).toBeHidden();
  await expect(page).toHaveURL(/\/notes\/history\?beside=inbox$/);
  await page.setViewportSize({ width: 736, height: 800 });
  await expect(notesNavigator(page)).toBeVisible();
  await expect(primary).toBeHidden();
  await secondary.getByRole("button", { name: "Close side by side" }).click();
  await expect(page).toHaveURL(/\/notes\/history$/);
});

test("the primary preview retains its reading position through placement, picker cancellation and tab return", { tag: ["@desktop", "@foldable"] }, async ({ page }) => {
  const longNotes = { ...NOTES, inbox: note("inbox", { content: "# Inbox\n\n" + "Text\n\n".repeat(200) }), storage: note("storage", { content: "# Storage\n\n" + "Text\n\n".repeat(200) }) };
  await stubNotes(page, { notes: longNotes });
  await page.goto("/notes/storage");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  const preview = primary.locator("caffold-markdown-preview");
  await expect(preview.locator("h1")).toHaveText("Storage");
  await preview.evaluate((element) => { element.scrollTop = 250; element.dataset.retained = "yes"; });
  await primary.getByRole("button", { name: "View side by side" }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBe(250);
  await treeEntry(page, "Inbox").click();
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Inbox");
  await secondary.locator("caffold-markdown-preview").evaluate((element) => { element.scrollTop = 180; });
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await notesNavigator(page).getByRole("button", { name: "Cancel note selection" }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBe(250);
  const tabs = page.locator("caffold-task-workspace-navigation");
  await tabs.getByRole("button", { name: "Notes", exact: true }).click();
  await tabs.locator('button[data-workspace-mode="settings"]').click();
  await tabs.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/storage\?beside=inbox$/);
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBe(250);
  await expect.poll(() => secondary.locator("caffold-markdown-preview").evaluate((element) => element.scrollTop)).toBe(180);
  await expect(preview).toHaveAttribute("data-retained", "yes");
  await page.reload();
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Inbox");
});

test("a missing secondary leaves the primary readable and each pane owns its Info and Scroll targets", { tag: ["@desktop", "@foldable"] }, async ({ page }) => {
  await stubNotes(page);
  await page.goto("/notes/storage?beside=missing");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(secondary.locator(".notes-workspace-message")).toHaveText("This note no longer exists.");
  await secondary.getByRole("button", { name: /choose another note/ }).click();
  await treeEntry(page, "Inbox").click();
  for (const pane of [primary, secondary]) {
    await pane.getByRole("button", { name: "Note details" }).click();
    await expect(pane.locator(".notes-info-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pane.locator(".notes-info-popover")).toBeHidden();
  }
  const scope = await page.locator("caffold-notes-workspace").evaluate((element) => ({
    targets: element.actionHintScope().targets.map((target) => target.id),
    surfaces: element.scrollSurfaceScope().surfaces.map((surface) => surface.id),
  }));
  expect(new Set(scope.targets).size).toBe(scope.targets.length);
  expect(scope.surfaces).toHaveLength(2);
});

test("a paired URL on phone retains the pair while showing only the primary and semantic Back", { tag: "@phone" }, async ({ page }) => {
  await stubNotes(page);
  await page.goto("/notes/storage?beside=inbox");
  await expect(documentPane(page, "primary").locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(documentPane(page, "secondary")).toBeHidden();
  await expect(notesNavigator(page)).toBeHidden();
  await documentPane(page, "primary").getByRole("button", { name: "Back to notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(notesNavigator(page)).toBeVisible();
});

test("a failed companion retries independently and foreground recovery refreshes both committed documents", { tag: "@desktop" }, async ({ page }) => {
  const notes = { ...NOTES };
  let failCompanion = true;
  const counts = { storage: 0, inbox: 0 };
  await stubNotes(page, { notes });
  await page.route(/\/api\/notes\/(storage|inbox)$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    counts[id] += 1;
    return route.fulfill(id === "inbox" && failCompanion
      ? { status: 500, json: { error: { code: "internal", message: "Companion unavailable" } } }
      : { json: notes[id] });
  });
  await page.goto("/notes/storage?beside=inbox");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(secondary.locator(".notes-workspace-message")).toHaveText("Companion unavailable");
  const primaryReads = counts.storage;
  failCompanion = false;
  await secondary.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Inbox");
  expect(counts.storage).toBe(primaryReads);
  notes.storage = note("storage", { content: "# Refreshed primary" });
  notes.inbox = note("inbox", { content: "# Refreshed companion" });
  await page.evaluate(() => document.querySelector("caffold-notes-workspace").reload());
  await expect(primary.locator("caffold-markdown-preview h1")).toHaveText("Refreshed primary");
  await expect(secondary.locator("caffold-markdown-preview h1")).toHaveText("Refreshed companion");
});

test("a pair preserves the shared collapsed preference and swaps at one history depth", { tag: "@desktop" }, async ({ page }) => {
  await stubNotes(page);
  await page.goto("/notes/storage");
  await page.getByRole("button", { name: "Hide navigation pane" }).click();
  await documentPane(page, "primary").getByRole("button", { name: "View side by side" }).click();
  await expect(page.locator("caffold-task-workspace-navigation")).toBeVisible();
  await treeEntry(page, "Inbox").click();
  await expect(page).toHaveURL(/\/notes\/storage\?beside=inbox$/);
  await documentPane(page, "secondary").getByRole("button", { name: "Close side by side" }).click();
  await expect(page.getByRole("button", { name: "Show navigation pane" })).toBeVisible();
  await expect(notesNavigator(page)).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/notes$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/notes\/storage$/);
});

test("constrained pairs keep long headings and horizontal code inside their panes at appearance extremes", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await stubNotes(page, { notes: { ...NOTES, history: note("history", {
    content: "# Long code\n\n```text\n" + "long_value_".repeat(100) + "\n```\n",
  }) } });
  await page.setViewportSize({ width: 736, height: 704 });
  await page.goto("/notes/history?beside=inbox");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  for (const [scale, theme] of [[90, "light"], [120, "dark"]]) {
    await page.evaluate(async ({ scale, theme }) => {
      const settings = await import("/assets/settings.js");
      settings.setAppearanceRangeSetting("interfaceScalePercent", scale);
      settings.setThemeMode(theme);
    }, { scale, theme });
    for (const pane of [primary, secondary]) {
      const metrics = await pane.evaluate((element) => {
        const header = element.querySelector("header").getBoundingClientRect();
        const title = element.querySelector("h1").getBoundingClientRect();
        const actions = element.querySelector(".note-document-actions").getBoundingClientRect();
        return { header: header.height, titleEnd: title.right, actionsStart: actions.left,
          width: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      expect(metrics.titleEnd).toBeLessThanOrEqual(metrics.actionsStart);
      expect(metrics.scrollWidth).toBe(metrics.width);
    }
    await expect(primary.locator("pre")).toBeVisible();
    expect(await primary.locator("pre").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(736);
    await captureReviewScreenshot(page, testInfo, `notes-constrained-${theme}`);
  }
});

test("paired Notes size three equal floating tabs from the selected font and keep that width across viewports", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await stubNotes(page);
  await page.goto("/notes/storage?beside=inbox");
  await expect(documentPane(page, "primary").locator("caffold-markdown-preview h1")).toHaveText("Storage");
  await expect(documentPane(page, "secondary").locator("caffold-markdown-preview h1")).toHaveText("Inbox");
  const footer = page.locator("caffold-task-workspace-navigation");
  const fontWidths = [];
  for (const preset of ["geist-sans", "inter", "pretendard", "system"]) {
    for (const [scale, theme] of [[100, "light"], [90, "light"], [120, "dark"]]) {
      await page.setViewportSize({ width: 1920, height: 704 });
      await page.evaluate(async ({ scale, theme, preset }) => {
        const settings = await import("/assets/settings.js");
        settings.setUiTypefacePreset(preset);
        settings.setAppearanceRangeSetting("interfaceScalePercent", scale);
        settings.setThemeMode(theme);
        document.querySelector("caffold-task-workspace-navigation").getBoundingClientRect();
        await document.fonts.ready;
      }, { scale, theme, preset });
      const naturalWidth = (await footer.boundingBox()).width;
      fontWidths.push({ preset, scale, naturalWidth });
      for (const width of [641, 736, 761, 763, 933, 1280, 1920]) {
        await page.setViewportSize({ width, height: 704 });
        await expect(footer).toBeVisible();
        const geometry = await footer.evaluate((element) => {
          const buttons = [...element.querySelectorAll("button")];
          const box = element.getBoundingClientRect();
          const pane = element.parentElement;
          const paneBox = pane.getBoundingClientRect();
          const primary = pane.querySelector("caffold-note-document").getBoundingClientRect();
          const secondary = document.querySelector('caffold-note-document[data-note-side="secondary"]').getBoundingClientRect();
          const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
          const hostStyle = getComputedStyle(element);
          const frameWidth = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
            .reduce((total, property) => total + Number.parseFloat(hostStyle[property]), 0);
          const largestContentWidth = Math.max(...buttons.map((button) => {
            const style = getComputedStyle(button);
            return [...button.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
              + Number.parseFloat(style.columnGap) + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
          }));
          return {
            inset: rootFontSize * 0.5,
            width: box.width, paneWidth: paneBox.width,
            neededWidth: largestContentWidth * 3 + frameWidth,
            buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
            leftInset: box.left - paneBox.left, bottomInset: paneBox.bottom - box.bottom,
            primaryBottom: primary.bottom, secondaryBottom: secondary.bottom, paneBottom: paneBox.bottom,
            labelsFit: buttons.every((button) => {
              const buttonBox = button.getBoundingClientRect();
              return [...button.children].every((child) => {
                const childBox = child.getBoundingClientRect();
                return childBox.left >= buttonBox.left && childBox.right <= buttonBox.right;
              });
            }),
            pageWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.paneWidth).toBeCloseTo((width - 1) / 2, 1);
        expect(geometry.width).toBeCloseTo(Math.min(geometry.paneWidth - 2 * geometry.inset, naturalWidth), 1);
        if (width === 1920) expect(geometry.width).toBeCloseTo(geometry.neededWidth, 0);
        expect(Math.max(...geometry.buttonWidths) - Math.min(...geometry.buttonWidths)).toBeLessThan(0.02);
        expect(geometry.leftInset).toBeCloseTo(geometry.inset, 1);
        expect(geometry.bottomInset).toBeCloseTo(geometry.inset, 1);
        expect(geometry.primaryBottom).toBeCloseTo(geometry.paneBottom, 1);
        expect(geometry.secondaryBottom).toBeCloseTo(geometry.primaryBottom, 1);
        expect(geometry.labelsFit).toBe(true);
        expect(geometry.pageWidth).toBe(width);
        if ((preset === "geist-sans" && scale === 100 && [736, 1920].includes(width)) ||
            (preset === "pretendard" && scale === 120 && width === 641)) {
          await captureReviewScreenshot(page, testInfo, `notes-intrinsic-${preset}-${scale}-${width}`);
        }
      }
    }
  }
  await testInfo.attach("floating-font-widths", {
    body: JSON.stringify(fontWidths, null, 2),
    contentType: "application/json",
  });
});

test("the primary Note can scroll its last paragraph above the floating panel without padding the companion", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await page.context().route("https://example.com/floating-note", (route) => route.fulfill({ body: "Opened the last link." }));
  await stubNotes(page, { notes: {
    ...NOTES,
    storage: note("storage", { content: "# Storage\n\n" + "Read here.\n\n".repeat(80) + "[Last paragraph](https://example.com/floating-note)" }),
    inbox: note("inbox", { content: "# Inbox\n\n" + "Companion.\n\n".repeat(80) + "Companion end." }),
  } });
  await page.setViewportSize({ width: 736, height: 440 });
  await page.goto("/notes/storage?beside=inbox");
  const primary = documentPane(page, "primary").locator("caffold-markdown-preview");
  const secondary = documentPane(page, "secondary").locator("caffold-markdown-preview");
  await expect(primary.getByRole("link", { name: "Last paragraph" })).toBeAttached();
  await expect(secondary).toContainText("Companion end.");
  const top = await primary.locator("h1").boundingBox();
  const previewBox = await primary.boundingBox();
  expect(top.y - previewBox.y).toBeGreaterThan(0);
  for (const preview of [primary, secondary]) await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const panel = await page.locator("caffold-task-workspace-navigation").boundingBox();
  const last = primary.getByRole("link", { name: "Last paragraph" });
  const lastBox = await last.boundingBox();
  expect(lastBox.y + lastBox.height).toBeLessThan(panel.y);
  const pads = await Promise.all([primary, secondary].map((preview) => preview.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom))));
  expect(pads[0] - pads[1]).toBeGreaterThan(panel.height);
  await captureReviewScreenshot(page, testInfo, "notes-floating-scroll-end");
  const opened = page.waitForEvent("popup");
  await last.click();
  const popup = await opened;
  await expect(popup).toHaveURL("https://example.com/floating-note");
  await popup.close();
});

test("the last Note remains selectable above the floating panel in the list and primary picker", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    id: `floating-note-${index}`, directoryId: null, name: `Floating Note ${String(index).padStart(2, "0")}`, updatedAtMs: 1_000,
  }));
  await stubNotes(page, {
    tree: { directories: [], notes: entries },
    notes: { ...NOTES, ...Object.fromEntries(entries.map((entry) => [entry.id, note("inbox", { id: entry.id, name: entry.name })])) },
  });
  await page.setViewportSize({ width: 736, height: 440 });
  await page.goto("/notes");
  for (const paired of [false, true]) {
    if (paired) {
      await page.goto("/notes/storage?beside=inbox");
      await documentPane(page, "primary").locator(".note-document-title-picker").click();
    }
    const navigator = page.locator(".task-workspace-master-pane > caffold-notes-navigator");
    const scroll = navigator.locator(".file-tree-scroll");
    const last = navigator.getByRole("button", { name: "Floating Note 39", exact: true });
    await expect(last).toBeAttached();
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastBox = await last.boundingBox();
    const panel = await page.locator("caffold-task-workspace-navigation").boundingBox();
    expect(lastBox.y + lastBox.height).toBeLessThan(panel.y);
    await captureReviewScreenshot(page, testInfo, paired ? "notes-floating-picker-end" : "notes-floating-tree-end");
    await last.click();
    await expect(page).toHaveURL(paired ? "/notes/floating-note-39?beside=inbox" : "/notes/floating-note-39");
  }
  await documentPane(page, "secondary").locator(".note-document-title-picker").click();
  const right = page.locator('caffold-notes-workspace > caffold-notes-navigator');
  const rows = right.locator(".file-tree-rows");
  await expect(rows).toBeVisible();
  expect(await rows.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom))).toBeLessThan(8);
});


test("changing the primary through an empty Note resets only that preview and closing retains the committed reading position", { tag: ["@desktop", "@foldable"] }, async ({ page }) => {
  await stubNotes(page, { notes: {
    ...NOTES,
    storage: note("storage", { content: "# Storage\n\n" + "Read here.\n\n".repeat(150) }),
    inbox: note("inbox", { content: "# Inbox\n\n" + "Companion.\n\n".repeat(150) }),
  } });
  await page.goto("/notes/storage?beside=inbox");
  const primary = documentPane(page, "primary");
  const secondary = documentPane(page, "secondary");
  const a = primary.locator("caffold-markdown-preview");
  const b = secondary.locator("caffold-markdown-preview");
  await expect(a.locator("h1")).toHaveText("Storage");
  await expect(b.locator("h1")).toHaveText("Inbox");
  await a.evaluate((element) => { element.scrollTop = 220; });
  await b.evaluate((element) => { element.scrollTop = 180; });
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await treeEntry(page, "Blank").click();
  await expect(primary.locator(".notes-workspace-message")).toHaveText("This note is empty.");
  await primary.getByRole("button", { name: /choose another note/ }).click();
  await treeEntry(page, "Storage decision").click();
  await expect(a).toBeVisible();
  await expect(a.locator("h1")).toHaveText("Storage");
  await expect.poll(() => a.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => b.evaluate((element) => element.scrollTop)).toBe(180);
  await a.evaluate((element) => { element.scrollTop = 220; });
  await secondary.getByRole("button", { name: "Close side by side" }).click();
  await expect(page).toHaveURL(/\/notes\/storage$/);
  await expect.poll(() => a.evaluate((element) => element.scrollTop)).toBe(220);
});


test("floating navigation excludes covered Notes tree and picker rows while leaving the companion picker available", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    id: `occlusion-note-${index}`, directoryId: null, name: `Occlusion Note ${String(index).padStart(2, "0")}`, updatedAtMs: 1_000,
  }));
  await stubNotes(page, { tree: { directories: [], notes: entries }, notes: {
    ...NOTES, ...Object.fromEntries(entries.map((entry) => [entry.id, note("inbox", { id: entry.id, name: entry.name })])),
  } });
  await page.setViewportSize({ width: 736, height: 440 });
  for (const side of ["list", "primary", "secondary"]) {
    await page.goto(side === "list" ? "/notes" : "/notes/storage?beside=inbox");
    if (side !== "list") await documentPane(page, side).locator(".note-document-title-picker").click();
    const selector = side === "secondary" ? "caffold-notes-workspace > caffold-notes-navigator" : ".task-workspace-master-pane > caffold-notes-navigator";
    await expect(page.locator(selector).getByRole("button", { name: "Occlusion Note 39", exact: true })).toBeAttached();
    const initial = await workspaceOcclusionTargets(page, selector);
    expect(initial.covered.length > 0).toBe(side !== "secondary");
    expect(initial.clear.length).toBeGreaterThan(0);
    const dialog = await enterActionHints(page);
    for (const label of initial.covered) await expect(dialog.getByLabel(new RegExp(` — ${label}$`))).toHaveCount(0);
    for (const label of initial.clear) await expect(dialog.getByLabel(new RegExp(` — ${label}$`))).toBeVisible();
    await expect(dialog.getByLabel(/Open Tasks$/)).toBeVisible();
    await captureReviewScreenshot(page, testInfo, `floating-notes-hints-${side}`);
    await page.keyboard.press("Escape");
    await page.locator(selector).locator(".file-tree-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await enterActionHints(page);
    const last = dialog.getByLabel(/ — Open Occlusion Note 39$/);
    await expect(last).toBeVisible();
    await page.keyboard.type((await last.getAttribute("data-action-hint-code")).toLowerCase());
    await expect(page).toHaveURL(side === "list" ? "/notes/occlusion-note-39" : side === "primary" ? "/notes/occlusion-note-39?beside=inbox" : "/notes/storage?beside=occlusion-note-39");
  }
});

test("covered Markdown links are excluded and companion frozen hints survive primary scrolling", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  const content = (name) => `# ${name}\n\n` + Array.from({ length: 40 }, (_, index) => `[${name} ${String(index).padStart(2, "0")}](https://example.com/${name}/${index})`).join("\n\n");
  await stubNotes(page, { notes: {
    ...NOTES, storage: note("storage", { content: content("Primary") }), inbox: note("inbox", { content: content("Companion") }),
  } });
  await page.context().route("https://example.com/Primary/39", (route) => route.fulfill({ body: "Last link opened." }));
  await page.setViewportSize({ width: 736, height: 440 });
  await page.goto("/notes/storage?beside=inbox");
  const selector = (side) => `caffold-note-document[data-note-side="${side}"] caffold-markdown-preview`;
  await expect(page.locator(selector("secondary")).getByRole("link", { name: "Companion 00" })).toBeVisible();
  const initial = await workspaceOcclusionTargets(page, selector("primary"));
  const companion = await workspaceOcclusionTargets(page, selector("secondary"));
  expect(initial.covered.length).toBeGreaterThan(0);
  expect(companion.covered).toEqual([]);
  const dialog = await enterActionHints(page);
  for (const label of initial.covered) await expect(dialog.getByLabel(new RegExp(` — ${label}$`))).toHaveCount(0);
  const retained = await dialog.locator("button[data-action-hint-code]").evaluateAll((badges) => badges.filter((badge) => badge.getAttribute("aria-label").includes("Companion")).map((badge) => ({ code: badge.dataset.actionHintCode, label: badge.getAttribute("aria-label") })));
  expect(retained.length).toBe(companion.clear.length);
  await captureReviewScreenshot(page, testInfo, "floating-markdown-hints");
  await page.locator(selector("primary")).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(dialog.getByLabel(/ — Open Primary /)).toHaveCount(0);
  for (const { code, label } of retained) await expect(dialog.locator(`[data-action-hint-code="${code}"]`)).toHaveAttribute("aria-label", label);
  await page.keyboard.press("Escape");
  await enterActionHints(page);
  const last = dialog.getByLabel(/Open Primary 39 in a new tab$/);
  await expect(last).toBeVisible();
  const opened = page.waitForEvent("popup");
  await page.keyboard.type((await last.getAttribute("data-action-hint-code")).toLowerCase());
  const popup = await opened;
  await expect(popup).toHaveURL("https://example.com/Primary/39");
  await popup.close();
});

test("Notes action paint gaps match the compact toolbar while floating shadows scale with the interface", { tag: ["@desktop", "@foldable"] }, async ({ page }, testInfo) => {
  await stubNotes(page);
  await page.setViewportSize({ width: 736, height: 440 });
  await page.goto("/notes/storage");
  const actionGeometry = async (selector) => page.locator(selector).evaluate((element) => {
    const buttons = [...element.querySelectorAll("button")].filter((button) => button.getBoundingClientRect().width > 0);
    const [first, second] = buttons;
    const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
    const aPaint = getComputedStyle(first, "::before"), bPaint = getComputedStyle(second, "::before");
    return { hitGap: b.left - a.right, paintGap: b.left + Number.parseFloat(bPaint.left) - (a.right - Number.parseFloat(aPaint.right)), hitHeight: a.height };
  });
  for (const preset of ["geist-sans", "inter", "pretendard", "system"]) {
    for (const [scale, theme] of [[90, "light"], [100, "light"], [120, "dark"]]) {
      await page.evaluate(async ({ scale, theme, preset }) => {
        const settings = await import("/assets/settings.js");
        settings.setUiTypefacePreset(preset);
        settings.setAppearanceRangeSetting("interfaceScalePercent", scale);
        settings.setThemeMode(theme);
        await document.fonts.ready;
      }, { scale, theme, preset });
      const expected = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.width = "var(--interface-toolbar-gap)";
        document.body.append(probe);
        const gap = Number.parseFloat(getComputedStyle(probe).width);
        probe.remove();
        return { gap, root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) };
      });
      await page.setViewportSize({ width: 933, height: 440 });
      await page.goto("/tasks");
      await expect(page.locator(".task-list-switcher")).toBeVisible();
      const toolbar = await actionGeometry(".task-list-primary-actions");
      expect(toolbar.paintGap).toBeGreaterThanOrEqual(expected.gap - 0.05);
      await page.setViewportSize({ width: 736, height: 440 });
      await page.goto("/notes/storage");
      await expect(documentPane(page, "primary").locator("caffold-markdown-preview h1")).toHaveText("Storage");
      const normal = await actionGeometry('caffold-note-document[data-note-side="primary"] .note-document-actions');
      expect(normal.paintGap).toBeCloseTo(toolbar.paintGap, 1);
      expect(normal.hitGap).toBeGreaterThanOrEqual(0);
      await documentPane(page, "primary").locator(".note-document-split").click();
      await page.locator("caffold-notes-workspace > caffold-notes-navigator").getByRole("button", { name: "Inbox", exact: true }).click();
      await expect(documentPane(page, "secondary").locator("caffold-markdown-preview h1")).toHaveText("Inbox");
      const paired = await actionGeometry('caffold-note-document[data-note-side="secondary"] .note-document-actions');
      expect(paired.paintGap).toBeCloseTo(normal.paintGap, 1);
      expect(paired.hitHeight).toBeCloseTo(normal.hitHeight, 1);
      const shadows = await page.locator("caffold-task-workspace-navigation").evaluate((element) => {
        const shadow = getComputedStyle(element).boxShadow;
        return [...shadow.matchAll(/rgba?\([^)]*\)\s+0px\s+([\d.]+)px\s+([\d.]+)px/g)].map((match) => ({ color: match[0].split(")")[0] + ")", y: Number(match[1]), blur: Number(match[2]) }));
      });
      expect(shadows).toHaveLength(2);
      expect(shadows[0].y).toBeCloseTo(expected.root * 0.125, 2);
      expect(shadows[0].blur).toBeCloseTo(expected.root * 0.375, 2);
      expect(shadows[1].y).toBeCloseTo(expected.root * 0.375, 2);
      expect(shadows[1].blur).toBeCloseTo(expected.root * 1.25, 2);
      expect(shadows[0].color).toContain(theme === "dark" ? "0.24" : "0.12");
      expect(shadows[1].color).toContain(theme === "dark" ? "0.36" : "0.14");
      if (preset === "geist-sans" && [100, 120].includes(scale)) await captureReviewScreenshot(page, testInfo, `floating-shadow-gap-${theme}`);
      await documentPane(page, "secondary").locator(".note-document-close").click();
    }
  }
  await page.setViewportSize({ width: 390, height: 440 });
  expect(await page.locator("caffold-task-workspace-navigation").evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
});
