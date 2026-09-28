import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
} from "../support/task-fixtures.js";
import { openCompletedTaskForReview } from "../support/task-review-test.js";

// These tests use the backend's real terminals: a shell on a PTY and its
// WebSocket. Every test, in every project and repetition, names its own Task
// or Section so no two share a terminal, and kills it at the end. A test that
// only looks at the terminal screen's layout answers the terminal's requests
// itself instead.

test.afterEach(async ({ request, baseURL }, testInfo) => {
  for (const subject of testInfo.annotations
    .filter(({ type }) => type === "terminal")
    .map(({ description }) => description)) {
    await request.delete(`/api/terminal?${subject}`, {
      headers: { origin: baseURL },
    });
  }
});

test("the header button opens the Task's terminal and returns to the conversation", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("header");
  await openTask(page, threadId);
  const button = terminalButton(page);
  const historyLength = await page.evaluate(() => history.length);

  await button.click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/terminal$`));
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expectLive(page);
  await expectPrompt(page);
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.type("echo caffold-$((20 + 3))");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("caffold-23");

  await button.click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("caffold-task-detail")).toBeVisible();
  await expect(page.locator("caffold-terminal-page")).toBeHidden();
  // Terminal and conversation are sibling screens, so moving between them
  // replaces the history entry.
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("a terminal screen opened by link resumes the running shell with its output", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("resume");
  await openTask(page, threadId, "/terminal");
  const terminal = page.locator("caffold-terminal-page");

  await expect(terminal).toHaveAttribute("data-terminal-node", "empty");
  await expect(terminal.getByText("No terminal is running here.")).toBeVisible();
  await terminal.getByRole("button", { name: "Open terminal" }).click();
  await expectLive(page);
  await expectPrompt(page);
  await page.keyboard.type("echo before-$((1 + 1)); printf 'caf\\033[1;32mgreen\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("before-2");
  await expect(terminalRows(page)).toContainText("cafgreen");

  await page.reload();
  await emitTaskDetailBootstrap(page, terminalDetail(threadId));

  await expectLive(page);
  await expect(terminalRows(page)).toContainText("before-2");
  const green = terminalRows(page).getByText("green", { exact: true });
  await expect(green).toBeVisible();
  // A resumed screen does not take focus from wherever the person was.
  await expect(terminalInput(page)).not.toBeFocused();
});

test("Ctrl+` and ⌘J move in and out of the terminal even with keyboard navigation off", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("keyboard");
  await page.addInitScript(() => {
    localStorage.setItem("caffold:settings", JSON.stringify({ actionHintsEnabled: false }));
  });
  await openTask(page, threadId);
  const composer = page.locator("caffold-task-detail textarea").first();
  await composer.click();

  await page.keyboard.press("Control+Backquote");

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/terminal$`));
  await expectLive(page);
  await expectPrompt(page);
  await expect(terminalInput(page)).toBeFocused();
  // Escape belongs to the program running in the terminal.
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("^[");
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.press("Control+C");

  await page.keyboard.press("Control+Backquote");

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(page.locator("caffold-terminal-page")).toBeHidden();

  // ⌘J does the same on Apple keyboards.
  await composer.click();
  await page.keyboard.press("Meta+KeyJ");
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/terminal$`));
  await expectLive(page);
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.press("Meta+KeyJ");
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
});

test("the terminal takes the full width, and the side panel keys never reach its shell", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const threadId = terminalTaskId("side-pane-keys");
  await openTask(page, threadId);
  const navigator = page.locator(".task-workspace-master-pane");
  const toggle = page.locator(".task-workspace-side-pane-toggle");
  await expect(navigator).toBeVisible();
  await expect(toggle).toBeEnabled();

  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  // Like the code surfaces, the terminal leaves out the Task list, and it has
  // no side pane of its own for the corner toggle to open.
  await expect(navigator).toBeHidden();
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  const edges = await page.evaluate(() => ({
    workspace: document.querySelector("caffold-task-workspace").getBoundingClientRect().left,
    terminal: document.querySelector("caffold-terminal-page").getBoundingClientRect().left,
  }));
  expect(edges.terminal).toBeCloseTo(edges.workspace, 1);
  await captureReviewScreenshot(page, testInfo, "terminal-full-width");

  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+KeyB");
  await page.keyboard.press("Control+Shift+KeyB");
  await expect(toggle).toBeDisabled();
  await expect(terminalInput(page)).toBeFocused();

  // cat shows a Ctrl+B it receives as ^B; neither combination sent one, and
  // the shell's own Ctrl+B still arrives.
  await page.keyboard.type("before");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("beforebefore");
  await expect(terminalRows(page)).not.toContainText("^B");
  await page.keyboard.press("Control+KeyB");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("^B");
  await page.keyboard.press("Control+C");

  await page.keyboard.press("Meta+KeyJ");
  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(navigator).toBeVisible();
  await expect(toggle).toBeEnabled();
});

test("a terminal that ends goes back to the screen before it and hands focus to the Detail pane", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("ended");
  await openTask(page, threadId);
  const terminal = page.locator("caffold-terminal-page");
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);

  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(terminal).toBeHidden();
  await expect(terminalButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".tasks-detail-pane")).toBeFocused();

  // The button starts a new shell, and killing it goes back the same way.
  await terminalButton(page).click();
  await expectLive(page);
  await terminal.getByRole("button", { name: "Kill terminal" }).click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(terminal).toBeHidden();
  await expect(page.locator(".tasks-detail-pane")).toBeFocused();
});

test("opening the terminal on another screen takes it, and the first screen can take it back", { tag: "@desktop" }, async ({
  page,
  context,
}) => {
  const threadId = terminalTaskId("screens");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  await page.keyboard.type("echo first-$((2 + 2))");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("first-4");

  const other = await context.newPage();
  await openTask(other, threadId, "/terminal", { annotate: false });
  const otherTerminal = other.locator("caffold-terminal-page");
  await expect(otherTerminal).toHaveAttribute("data-terminal-node", "elsewhere");
  await expect(otherTerminal.getByText("This terminal is open on another screen.")).toBeVisible();

  await otherTerminal.getByRole("button", { name: "Open here" }).click();

  await expectLive(other);
  await expect(terminalRows(other)).toContainText("first-4");
  await expect(page.locator("caffold-terminal-page")).toHaveAttribute(
    "data-terminal-node",
    "elsewhere",
  );

  // The toggle on a screen that lost the terminal brings it back there.
  await terminalButton(page).click();
  await expectLive(page);
  await expect(otherTerminal).toHaveAttribute("data-terminal-node", "elsewhere");
  await other.close();
});

test("a Task's terminal starts in the Task's working directory", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("task-directory");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);

  await page.keyboard.type(PRINT_DIRECTORY);
  await page.keyboard.press("Enter");

  // The fixture Task works in `src` below the test root, `home`.
  await expect(terminalRows(page)).toContainText("in-home-src");
});

test("a Section's terminal starts in the Section's directory", { tag: "@desktop" }, async ({
  page,
}) => {
  const sectionId = terminalTaskId("section-directory");
  const projection = activeTaskProjection([terminalDetail(sectionId).task]);
  projection.sections[0].id = sectionId;
  projection.sections[0].name = "src/planner";
  await installTaskApiFixture(page);
  await page.route("**/api/tasks", (route) => route.fulfill({ json: projection }));
  test.info().annotations.push({ type: "terminal", description: `section=${sectionId}` });
  await page.goto(`/?section=${sectionId}`);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);

  await page.keyboard.type(PRINT_DIRECTORY);
  await page.keyboard.press("Enter");

  await expect(terminalRows(page)).toContainText("in-src-planner");
});

test("a lost terminal connection shows the recovery notice, and Retry reattaches", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("lost");
  const sockets = [];
  // The first socket stands in for one the network drops: it never reaches
  // the backend, so no stale viewer stays attached there. The shell itself is
  // real, started by the request that precedes the socket.
  await page.routeWebSocket(/\/api\/terminal\/socket/, (socket) => {
    sockets.push(socket);
    if (sockets.length > 1) {
      socket.connectToServer();
      return;
    }
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: "attached" }));
    socket.send(Buffer.from("$ "));
  });
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);

  await sockets[0].close();

  const terminal = page.locator("caffold-terminal-page");
  await expect(terminal).toHaveAttribute("data-terminal-node", "disconnected");
  await expect(terminal.getByText("The terminal connection was lost.")).toBeVisible();
  const notice = page.locator('.app-foreground-recovery[data-recovery-state="unavailable"]');
  await expect(notice).toBeVisible();

  await notice.getByRole("button", { name: "Retry" }).click();

  await expectLive(page);
  await expect(notice).toBeHidden();
  await expectPrompt(page);
  await page.locator("caffold-terminal-page caffold-terminal-view").click();
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.type("echo back-$((3 + 4))");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("back-7");
  expect(sockets).toHaveLength(2);
});

test("a connection the network dropped is replaced when the same tab comes back", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("dropped");
  const sockets = [];
  // Closing the page's end leaves the backend's end open, the way a network
  // that drops a connection leaves the backend still attached to it.
  await page.routeWebSocket(/\/api\/terminal\/socket/, (socket) => {
    const server = socket.connectToServer();
    socket.onClose(() => {});
    server.onClose(() => {});
    sockets.push(socket);
  });
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  await page.keyboard.type("echo kept-$((3 + 4))");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("kept-7");

  await sockets[0].close();

  const terminal = page.locator("caffold-terminal-page");
  await expect(terminal).toHaveAttribute("data-terminal-node", "disconnected");
  const notice = page.locator('.app-foreground-recovery[data-recovery-state="unavailable"]');
  await notice.getByRole("button", { name: "Retry" }).click();

  await expectLive(page);
  await expect(terminalRows(page)).toContainText("kept-7");
  expect(sockets).toHaveLength(2);
});

test("a terminal whose library failed to load can open after recovery", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("library");
  await openTask(page, threadId);
  let libraryReachable = false;
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\//, (route) =>
    libraryReachable ? route.fallback() : route.abort("internetdisconnected")
  );
  await terminalButton(page).click();

  const terminal = page.locator("caffold-terminal-page");
  await expect(terminal).toHaveAttribute("data-terminal-node", "disconnected");
  const notice = page.locator('.app-foreground-recovery[data-recovery-state="unavailable"]');
  await expect(notice).toBeVisible();

  libraryReachable = true;
  await notice.getByRole("button", { name: "Retry" }).click();

  // Recovery only looks for a running terminal; the failed open never started one.
  await expect(terminal).toHaveAttribute("data-terminal-node", "empty");
  await terminal.getByRole("button", { name: "Open terminal" }).click();
  await expectLive(page);
  await expectPrompt(page);
});

test("⇧⌘F and Ctrl+Shift+F reach the terminal's own buttons from inside it", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("hint-keys");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  const hints = page.locator("caffold-action-hint-dialog > dialog:modal");

  await page.keyboard.press("Meta+Shift+KeyF");
  await expect(hints).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hints).toBeHidden();
  await expect(terminalInput(page)).toBeFocused();

  await page.keyboard.press("Control+Shift+KeyF");
  const kill = hints.getByLabel(/ — Kill terminal$/);
  await expect(kill).toBeVisible();
  await expect(hints.getByLabel(/ — Special keys$/)).toBeVisible();
  const code = await kill.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}$`));
  await expect(page.locator("caffold-terminal-page")).toBeHidden();
});

test("F offers the terminal button and the terminal itself", { tag: "@desktop" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("hints");
  await openTask(page, threadId);

  await activateActionHint(page, "Open terminal");

  await expect(page).toHaveURL(new RegExp(`/tasks/${threadId}/terminal$`));
  await expectLive(page);
  await page.locator(".tasks-detail-pane").focus();
  await activateActionHint(page, "Focus terminal");
  await expect(terminalInput(page)).toBeFocused();
});

test("the terminal bar is as tall as the review file header, with its buttons under the header's", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installBrowserDefaults(page);
  await page.route("**/api/terminal", (route) => route.fulfill({ status: 204 }));
  await page.routeWebSocket(/\/api\/terminal\/socket/, (socket) => {
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: "attached" }));
  });
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  const reviewHeader = taskReview
    .locator("caffold-review-file-viewer .viewer-panel > header")
    .filter({ visible: true })
    .first();
  // The review draws the opened file's viewer again as it loads; the header's
  // height comes from CSS alone, so any moment it is on screen gives it.
  let reviewHeight = 0;
  await expect.poll(async () => {
    reviewHeight = (await reviewHeader.boundingBox())?.height ?? 0;
    return reviewHeight;
  }).toBeGreaterThan(0);

  await terminalButton(page).click();
  await expectLive(page);

  const geometry = await page.evaluate(() => {
    // The box a button draws, inside its larger hit area.
    const drawn = (button) => {
      const rect = button.getBoundingClientRect();
      const box = ["::before", "::after"]
        .map((pseudo) => getComputedStyle(button, pseudo))
        .find((style) => style.position === "absolute" && style.content !== "none");
      const inset = box ? parseFloat(box.left) : 0;
      return { left: rect.left + inset, right: rect.right - inset };
    };
    const bar = document.querySelector("caffold-terminal-page > .terminal-page-bar");
    const [keyboard, kill] = [...bar.querySelectorAll(":scope > button")].map(drawn);
    return {
      barHeight: bar.getBoundingClientRect().height,
      terminal: drawn(document.querySelector("caffold-task-detail-terminal > button")),
      info: drawn(
        [...document.querySelectorAll(".task-detail-info-button")]
          .find((button) => button.getClientRects().length),
      ),
      keyboard,
      kill,
    };
  });
  expect(geometry.barHeight).toBeCloseTo(reviewHeight, 1);
  expect(geometry.keyboard.left).toBeCloseTo(geometry.terminal.left, 1);
  expect(geometry.keyboard.right).toBeCloseTo(geometry.terminal.right, 1);
  expect(geometry.kill.left).toBeCloseTo(geometry.info.left, 1);
  expect(geometry.kill.right).toBeCloseTo(geometry.info.right, 1);
});

test("from Working Tree the terminal keeps the header in place and brings no Task list", { tag: ["@desktop", "@foldable"] }, async ({
  page,
}, testInfo) => {
  await installBrowserDefaults(page);
  await page.route("**/api/terminal", (route) => route.fulfill({ status: 204 }));
  await page.routeWebSocket(/\/api\/terminal\/socket/, (socket) => {
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: "attached" }));
  });
  const { tasksPage, taskReview } = await openCompletedTaskForReview(page);
  await tasksPage.getByRole("button", { name: "Working Tree", exact: true }).click();
  await taskReview.locator('button[data-file-tree-relative-path="planner.rs"]').click();
  const navigator = page.locator(".task-workspace-master-pane");
  const toggle = page.locator(".task-workspace-side-pane-toggle");
  const heading = page.locator(".task-detail-heading").filter({ visible: true });
  await expect(navigator).toBeHidden();
  await expect(toggle).toBeEnabled();
  const reviewHeading = await heading.boundingBox();

  await terminalButton(page).click();
  await expectLive(page);
  await expect(navigator).toBeHidden();
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  const terminalHeading = await heading.boundingBox();
  expect(terminalHeading.x).toBeCloseTo(reviewHeading.x, 1);
  expect(terminalHeading.y).toBeCloseTo(reviewHeading.y, 1);
  await captureReviewScreenshot(page, testInfo, "terminal-from-working-tree");

  await terminalButton(page).click();
  await expect(page.locator("caffold-terminal-page")).toBeHidden();
  await expect(taskReview).toBeVisible();
  await expect(toggle).toBeEnabled();
});

test("the terminal button sits beside Task details and matches its size", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = terminalTaskId("header-layout");
  const detail = terminalDetail(threadId, {
    title:
      "Keep a long Task title clipped while the terminal and details buttons stay on its row, across desktop, foldable, and phone widths, without pushing either button out of the header",
  });
  await openTask(page, threadId, "", { detail });

  const geometry = await page.locator("caffold-detail-layout").evaluate((layout) => {
    const box = (selector) => {
      const rect = layout.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    };
    const heading = layout.querySelector(".task-detail-heading > h2");
    return {
      terminal: box("caffold-task-detail-terminal > button"),
      info: box(".task-detail-info-button"),
      heading: box(".task-detail-heading"),
      actions: box(".detail-layout-actions"),
      titleClipped: heading.scrollWidth > heading.clientWidth,
    };
  });
  expect(geometry.terminal.width).toBeCloseTo(geometry.info.width, 1);
  expect(geometry.terminal.height).toBeCloseTo(geometry.info.height, 1);
  expect(geometry.terminal.top).toBeCloseTo(geometry.info.top, 1);
  expect(geometry.terminal.right).toBeLessThanOrEqual(geometry.info.left);
  expect(geometry.titleClipped).toBe(true);
  expect(geometry.heading.right).toBeLessThanOrEqual(geometry.terminal.left);
  if (testInfo.project.name === "phone") {
    // The view and repository actions take the second row.
    expect(geometry.actions.top).toBeGreaterThan(geometry.terminal.top);
  } else {
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.terminal.left);
  }
  await captureReviewScreenshot(page, testInfo, "terminal-header-task");

  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  await page.keyboard.type("printf 'layout-%s\\n' check");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("layout-check");
  await captureReviewScreenshot(page, testInfo, "terminal-screen-task");
});

test("a Section's terminal button is its header's last control", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const sectionId = terminalTaskId("section");
  const projection = activeTaskProjection([terminalDetail(sectionId).task]);
  projection.sections[0].id = sectionId;
  await installTaskApiFixture(page);
  await page.route("**/api/tasks", (route) => route.fulfill({ json: projection }));
  test.info().annotations.push({ type: "terminal", description: `section=${sectionId}` });
  await page.goto(`/?section=${sectionId}`);

  const header = page.locator("caffold-detail-layout .detail-layout-summary");
  const button = terminalButton(page);
  await expect(button).toBeEnabled();
  const geometry = await header.evaluate((element) => {
    const rect = (node) => node.getBoundingClientRect();
    const terminal = rect(element.querySelector("caffold-task-detail-terminal > button"));
    const controls = [...element.querySelectorAll("button")]
      .filter((control) => control.getClientRects().length)
      .map((control) => rect(control));
    const heading = rect(element.querySelector("caffold-section-detail-summary"));
    return {
      lastRight: Math.max(...controls.map(({ right }) => right)),
      terminalRight: terminal.right,
      terminalTop: terminal.top,
      headingTop: heading.top,
      headingBottom: heading.bottom,
    };
  });
  expect(geometry.terminalRight).toBeCloseTo(geometry.lastRight, 1);
  expect(geometry.terminalTop).toBeLessThan(geometry.headingBottom);

  await button.click();
  await expect(page).toHaveURL(new RegExp(`/\\?section=${sectionId}&surface=terminal$`));
  await expectLive(page);
  await captureReviewScreenshot(page, testInfo, "terminal-screen-section");
  await button.click();
  await expect(page).toHaveURL(new RegExp(`/\\?section=${sectionId}$`));
});

test("the terminal ends above the on-screen keyboard and the shell sees the rows left", { tag: "@phone" }, async ({
  page,
}) => {
  // A browser test cannot open the phone's keyboard; the visual viewport the
  // page reads shrinks by the keyboard's height instead, as it does on a phone.
  await page.addInitScript(() => {
    const real = window.visualViewport;
    const viewport = new EventTarget();
    let keyboard = 0;
    for (const name of ["width", "offsetLeft", "offsetTop", "pageLeft", "pageTop", "scale"]) {
      Object.defineProperty(viewport, name, { get: () => real[name] });
    }
    Object.defineProperty(viewport, "height", { get: () => real.height - keyboard });
    Object.defineProperty(window, "visualViewport", { get: () => viewport });
    window.showKeyboard = (height) => {
      keyboard = height;
      viewport.dispatchEvent(new Event("resize"));
    };
  });
  const threadId = terminalTaskId("keyboard-inset");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  const keys = page.locator("caffold-terminal-special-keys");
  const keysBottom = async () => {
    const box = await keys.boundingBox();
    return Math.round(box.y + box.height);
  };
  const screenRows = page.locator("caffold-terminal-page .xterm-rows > div");
  const rowCount = () => screenRows.count();
  const fullBottom = await keysBottom();
  const fullRows = await rowCount();

  await page.evaluate(() => window.showKeyboard(300));

  const visibleBottom = await page.evaluate(() =>
    Math.round(window.visualViewport.offsetTop + window.visualViewport.height)
  );
  await expect.poll(keysBottom).toBe(visibleBottom);
  await expect.poll(rowCount).toBeLessThan(fullRows);
  const rows = await rowCount();
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  await expect(screenRows.filter({ hasText: new RegExp(`^${rows} \\d+\\s*$`) })).toHaveCount(1);

  await page.evaluate(() => window.showKeyboard(0));

  await expect.poll(keysBottom).toBe(fullBottom);
  await expect.poll(rowCount).toBe(fullRows);
});

test("the special key row starts on touch screens and keeps the choice", { tag: "@phone" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("special-keys");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  const keys = page.locator("caffold-terminal-special-keys");
  await expect(keys).toBeVisible();
  const row = await keys.evaluate((element) => ({
    fits: element.scrollWidth <= element.clientWidth,
    buttons: element.querySelectorAll("button").length,
  }));
  expect(row).toEqual({ fits: true, buttons: 7 });

  await page.keyboard.type("cat -v");
  await keys.getByRole("button", { name: "Tab" }).tap();
  await page.keyboard.press("Enter");
  await keys.getByRole("button", { name: "Escape" }).tap();
  await keys.getByRole("button", { name: "Up arrow" }).tap();
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("^[^[[A");
  await keys.getByRole("button", { name: "Control" }).tap();
  await expect(keys.getByRole("button", { name: "Control" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.type("c");
  await expect(keys.getByRole("button", { name: "Control" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(terminalRows(page)).toContainText("$");

  await page.getByRole("button", { name: "Special keys" }).tap();
  await expect(keys).toBeHidden();
  await page.reload();
  await emitTaskDetailBootstrap(page, terminalDetail(threadId));
  await expectLive(page);
  await expect(keys).toBeHidden();
});

test("one finger dragged over the terminal scrolls its history, and two are left to the browser", { tag: "@foldable" }, async ({
  page,
}) => {
  const threadId = terminalTaskId("touch-scroll");
  await openTask(page, threadId);
  await terminalButton(page).click();
  await expectLive(page);
  await expectPrompt(page);
  // Every row shows a three-digit number, and the last is not on the command line.
  await page.keyboard.type("seq $((100 + 1)) $((200 * 2))");
  await page.keyboard.press("Enter");
  await expect(terminalRows(page)).toContainText("400");
  await expectPrompt(page);
  const topRow = async () =>
    Number(await terminalRows(page).locator(":scope > div").first().textContent());
  const bottom = await topRow();

  expect(await dragTerminal(page, 2, 2)).not.toContain(true);
  expect(await dragTerminal(page, 5)).not.toContain(false);

  // Only the one-finger drag moved the history.
  await expect.poll(topRow).toBe(bottom - 5);

  expect(await dragTerminal(page, -3)).not.toContain(false);

  await expect.poll(topRow).toBe(bottom - 2);
});

// Prints the last two parts of the shell's directory, in a form its own
// command line does not contain.
const PRINT_DIRECTORY = 'echo "in-$(basename "$(dirname "$PWD")")-$(basename "$PWD")"';

function terminalTaskId(name) {
  const { project, repeatEachIndex } = test.info();
  return `thread-terminal-${name}-${project.name}-${repeatEachIndex}`;
}

function terminalDetail(threadId, { title = "Terminal task" } = {}) {
  const detail = taskDetailFixture();
  return {
    ...detail,
    threadId,
    task: { ...detail.task, id: threadId, threadId, title },
  };
}

async function openTask(page, threadId, suffix = "", { annotate = true, detail } = {}) {
  if (annotate) {
    test.info().annotations.push({ type: "terminal", description: `task=${threadId}` });
  }
  await installTaskApiFixture(page);
  await page.goto(`/tasks/${threadId}${suffix}`);
  await emitTaskDetailBootstrap(page, detail ?? terminalDetail(threadId));
  await expect(terminalButton(page)).toBeEnabled();
}

function terminalButton(page) {
  return page.locator("caffold-task-detail-terminal > button");
}

function terminalRows(page) {
  return page.locator("caffold-terminal-page .xterm-rows");
}

function terminalInput(page) {
  return page.locator("caffold-terminal-page .xterm-helper-textarea");
}

async function expectLive(page) {
  await expect(page.locator("caffold-terminal-page")).toHaveAttribute(
    "data-terminal-node",
    "live",
  );
}

// Keys typed before the shell reads its first line can be lost, so a test
// types only once the prompt is on screen.
async function expectPrompt(page) {
  await expect(terminalRows(page)).toContainText(/[$#]\s*$/);
}

// Drags `fingers` from the middle of the terminal screen `rows` rows down, or
// up when negative, and answers for each move whether the page kept it from the
// browser. The drag goes half a row further so the last row always counts.
async function dragTerminal(page, rows, fingers = 1) {
  return page.locator("caffold-terminal-page .xterm-screen").evaluate(
    (screen, { rows, fingers }) => {
      const box = screen.getBoundingClientRect();
      const rowHeight = box.height / screen.querySelectorAll(".xterm-rows > div").length;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const target = document.elementFromPoint(x, y);
      const distance = (rows + Math.sign(rows) / 2) * rowHeight;
      const at = (offset) =>
        Array.from({ length: fingers }, (_, identifier) =>
          new Touch({ identifier, target, clientX: x + identifier * rowHeight, clientY: y + offset })
        );
      const send = (type, touches, changedTouches = touches) =>
        target.dispatchEvent(new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches,
        }));
      const steps = 10;
      send("touchstart", at(0));
      const kept = Array.from({ length: steps }, (_, step) =>
        !send("touchmove", at((distance * (step + 1)) / steps))
      );
      send("touchend", [], at(distance));
      return kept;
    },
    { rows, fingers },
  );
}
