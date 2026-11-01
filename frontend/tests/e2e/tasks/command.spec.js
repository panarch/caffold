import { expect, test } from "@playwright/test";
import {
  activateActionHint,
  enterActionHints,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await installEventSourceMock(page, {
    registryKey: "__commandEventSources",
    autoOpen: true,
  });
  await mockAgentModels(page);
});

test("owns active disclosure state and terminal presentation across canonical updates", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const threadId = "thread_command_component";
  const turnId = "turn_command_component";
  const now = 1_767_450_000_000;
  const task = activeTask(threadId, turnId, now);
  const started = turnEvent(
    "event_turn_started",
    "turn_started",
    now,
    turnId,
    { status: "inProgress" },
  );
  const commandStarted = commandEvent(now + 1_000, turnId, {
    status: "inProgress",
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(task, [started, commandStarted], 1) }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(
    page,
    taskDetail(task, [started, commandStarted], 1),
  );
  const command = page.locator(".task-command > caffold-task-command");
  const disclosure = command.locator(":scope > details.task-command-active");
  const summary = disclosure.locator(":scope > summary");
  const collapsedChevron = summary.locator(
    ".task-command-disclosure-chevron-collapsed",
  );
  const expandedChevron = summary.locator(
    ".task-command-disclosure-chevron-expanded",
  );
  const outputSeam = () =>
    disclosure.evaluate((element) => {
      const summaryRow = element.querySelector(":scope > summary");
      const output = element.querySelector(
        ":scope > .task-command-active-output",
      );
      const line = (node, side) =>
        Boolean(node) && node.checkVisibility() &&
        parseFloat(getComputedStyle(node)[side]) > 0;
      return {
        output: output.checkVisibility(),
        lines: [
          line(summaryRow, "borderBottomWidth"),
          line(output, "borderTopWidth"),
        ].filter(Boolean).length,
      };
    });

  await expect(command).toHaveCount(1);
  expect(await command.evaluate((element) => element.localName)).toBe(
    "caffold-task-command",
  );
  await expect(command).toHaveAttribute("data-command-status", "inProgress");
  await expect(command).not.toHaveAttribute("data-command-terminal", "");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(collapsedChevron).not.toBeVisible();
  await expect(expandedChevron).toBeVisible();
  await expect.poll(outputSeam).toEqual({ output: true, lines: 1 });
  await expect.poll(() => page.locator("caffold-task-conversation").evaluate(
    (conversation) => conversation.scrollSurfaceScope().surfaces
      .map(({ label }) => label),
  )).toContain("Command output");
  await rememberCommandIdentity(command);

  const summaryOffset = await disclosureOffset(summary);
  const commandHints = await enterActionHints(page);
  await expect(commandHints.getByLabel(/Collapse Command$/)).toBeVisible();
  await captureReviewScreenshot(
    page,
    testInfo,
    "task-command-disclosure-hints",
  );
  await page.keyboard.press("Escape");
  await activateActionHint(page, /Collapse Command$/);
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect.poll(outputSeam).toEqual({ output: false, lines: 0 });
  await expect
    .poll(() => summary.evaluate((element) => element.getRootNode().activeElement === element))
    .toBe(true);
  await expect(collapsedChevron).toBeVisible();
  await expect(expandedChevron).not.toBeVisible();
  await expect
    .poll(() => disclosureOffset(summary))
    .toBeCloseTo(summaryOffset, 1);

  const commandUpdated = commandEvent(now + 2_000, turnId, {
    status: "inProgress",
    output: "Compiling caffold v0.6.0",
  });
  await emitTaskEvent(page, threadId, commandUpdated, 2);
  await expect(command).toContainText("Compiling caffold v0.6.0");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expectCommandIdentity(page, { activeStructure: true });

  await activateActionHint(page, /Expand Command$/);
  await expect(disclosure).toHaveAttribute("open", "");
  await expect.poll(outputSeam).toEqual({ output: true, lines: 1 });
  await expect
    .poll(() =>
      summary.evaluate((element) => {
        const label = element.querySelector(".task-command-active-label");
        const icon = element.querySelector(
          ".task-command-disclosure-chevron-expanded",
        );
        const labelRect = label.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return Math.abs(
          labelRect.top + labelRect.height / 2 -
            (iconRect.top + iconRect.height / 2),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await captureReviewScreenshot(page, testInfo, "command-active-expanded");

  const commandCompleted = commandEvent(now + 3_000, turnId, {
    status: "completed",
    exitCode: 0,
    durationMs: 1_600,
    output: "test result: ok",
  });
  await emitTaskEvent(page, threadId, commandCompleted, 3);
  await expect(command).toHaveAttribute("data-command-terminal", "");
  await expect(command).toHaveAttribute("data-command-status", "completed");
  await expect(command.locator(":scope > details")).toHaveCount(0);
  await expect(command).toContainText("Completed");
  await expect(command).toContainText("cargo test");
  await expect(command).toContainText("2s");
  await expect(command).not.toContainText("test result: ok");
  await expect(
    command.getByRole("button", { name: "View output" }),
  ).toBeVisible();
  await expectCommandIdentity(page, { activeStructure: false });
  await captureReviewScreenshot(page, testInfo, "command-terminal");

  const completed = turnEvent(
    "event_turn_completed",
    "turn_completed",
    now + 4_000,
    turnId,
    { status: "completed" },
  );
  const completedTask = {
    ...task,
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    updatedMs: now + 4_000,
    recencyMs: now + 4_000,
  };
  await emitTaskSync(
    page,
    threadId,
    taskDetail(
      completedTask,
      [started, commandCompleted, completed],
      4,
    ),
    4,
  );
  await expect(page.locator(".task-command")).toHaveCount(0);
  const workDetails = page.locator("caffold-task-work-details > details");
  await activateActionHint(page, /Expand (?:Worked for|Work details)/);
  await expect(workDetails).toHaveAttribute("open", "");
  const completedCommand = workDetails.locator(
    ".task-work-details-command > caffold-task-command",
  );
  await expect(completedCommand).toHaveAttribute("data-command-terminal", "");
  await expect(completedCommand).toContainText("Completed");
  expect(await completedCommand.evaluate((element) => element.localName)).toBe(
    "caffold-task-command",
  );
});

test("a multi-line script reads as one line in the row and as its lines in the dialog", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  // The row shows the model's one-line form (why it exists is
  // commandPresentation's to say); the dialog shows the script's own lines.
  // The long first line is deliberate: it forces the ellipsis in the row and
  // wrapped lines in the dialog, the inconvenient halves of both contracts.
  const threadId = "thread_command_component";
  const turnId = "turn_command_script";
  const now = 1_767_450_000_000;
  const script =
    "sed -n '1,180p' docs/development/deeply/nested/runbooks/for-review-surfaces/macos-local-application-development-runbook-notes.md\nprintf 'x'\ngit status --short --branch";
  const task = activeTask(threadId, turnId, now);
  const started = turnEvent(
    "event_turn_started",
    "turn_started",
    now,
    turnId,
    { status: "inProgress" },
  );
  const scriptCompleted = commandEvent(now + 1_000, turnId, {
    command: script,
    status: "completed",
    exitCode: 0,
    durationMs: 900,
    output: "ok",
  });

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(task, [started, scriptCompleted], 1) }),
  );

  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(
    page,
    taskDetail(task, [started, scriptCompleted], 1),
  );

  const command = page.locator(".task-command > caffold-task-command");
  await expect(command).toHaveAttribute("data-command-terminal", "");
  const label = command.locator(".task-command-summary-label");
  await expect(label).toHaveText(
    "sed -n '1,180p' docs/development/deeply/nested/runbooks/for-review-surfaces/macos-local-application-development-runbook-notes.md printf 'x' git status --short --branch",
  );
  // The load-bearing assertion: toHaveText normalizes whitespace, so it would
  // match a label still carrying the raw newlines this test exists to refuse.
  expect(
    await label.evaluate((element) => element.textContent.includes("\n")),
  ).toBe(false);

  await activateActionHint(page, /View output$/);
  const dialog = page.locator("caffold-task-command-dialog > dialog");
  await expect(dialog).toHaveAttribute("open", "");
  const commandField = dialog
    .locator(".task-command-dialog-details > div")
    .filter({ has: page.getByText("Command", { exact: true }) })
    .locator("code");
  expect(await commandField.evaluate((element) => element.textContent)).toBe(
    script,
  );
  const renderedLines = await commandField.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / parseFloat(style.lineHeight);
  });
  expect(renderedLines).toBeGreaterThanOrEqual(2.5);
  await captureReviewScreenshot(page, testInfo, "command-script-dialog");
});

test("the output is a code block whose Copy and Wrap act on the output alone", { tag: "@server-steady" }, async ({
  page,
}) => {
  const threadId = "thread_command_component";
  const turnId = "turn_command_output_block";
  const now = 1_767_450_000_000;
  const output = [
    `error: ${"the dependency graph names a package this workspace no longer has; ".repeat(4)}`,
    "  --> Cargo.toml:12:1",
    "help: remove the entry or restore the package",
  ].join("\n");
  const task = activeTask(threadId, turnId, now);
  const events = [
    turnEvent("event_turn_started", "turn_started", now, turnId, {
      status: "inProgress",
    }),
    turnEvent("event_build", "command_execution", now + 1_000, turnId, {
      itemId: "build",
      command: "cargo build",
      cwd: "src",
      status: "failed",
      exitCode: 101,
      output,
    }),
    turnEvent("event_progress", "assistant_message", now + 1_500, turnId, {
      itemId: "progress",
      phase: "progress",
      text: "Checking that nothing else prints.",
    }),
    turnEvent("event_quiet", "command_execution", now + 2_000, turnId, {
      itemId: "quiet",
      command: "true",
      cwd: "src",
      status: "completed",
      exitCode: 0,
      output: "",
    }),
  ];
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([task]) }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: taskDetail(task, events, 1) }),
  );
  await page.goto(`/tasks/${threadId}`);
  await emitTaskDetailBootstrap(page, taskDetail(task, events, 1));
  await page.evaluate(() => {
    window.__copiedCode = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        window.__copiedCode.push(text);
      },
    });
  });

  const commands = page.locator(".task-command > caffold-task-command");
  await expect(commands).toHaveCount(2);
  const dialog = page.locator("caffold-task-command-dialog > dialog");
  const outputSection = dialog.locator(".task-command-dialog-output");
  const block = outputSection.locator(":scope > caffold-task-code-block");
  const pre = block.locator("pre");

  await commands.nth(0).getByRole("button", { name: "View output" }).click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(block.locator(".code-block-label")).toHaveText("Plain text");
  expect(await pre.evaluate((element) => element.textContent)).toBe(output);

  await block.getByRole("button", { name: "Copy code" }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedCode)).toEqual([output]);
  await expect(block.locator(".code-block-label")).toHaveText("Copied");

  await expect
    .poll(() => pre.evaluate((element) => element.scrollWidth > element.clientWidth + 1))
    .toBe(true);
  await pre.evaluate((element) => {
    element.scrollLeft = 80;
  });
  await block.getByRole("button", { name: "Wrap code lines" }).click();
  await expect(block).toHaveAttribute("data-code-wrap", "on");
  expect(await pre.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await block.getByRole("button", { name: "Stop wrapping code lines" }).click();
  await expect(block).toHaveAttribute("data-code-wrap", "off");
  await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBe(80);

  // Each opening starts over, even for the same command.
  await block.getByRole("button", { name: "Wrap code lines" }).click();
  await expect(block).toHaveAttribute("data-code-wrap", "on");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await commands.nth(0).getByRole("button", { name: "View output" }).click();
  await expect(block).toHaveAttribute("data-code-wrap", "off");
  await page.keyboard.press("Escape");

  // A command that printed nothing leaves a note, not a code block.
  await commands.nth(1).getByRole("button", { name: "View output" }).click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(block).toHaveCount(0);
  await expect(outputSection.locator(":scope > pre")).toHaveText("(No output)");
});

function activeTask(threadId, turnId, startedAtMs) {
  return {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId,
      startedAtMs,
      latestTurnStatus: "inProgress",
    }),
    title: "Command component ownership",
    preview: "Running cargo test",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    worktree: null,
    createdMs: startedAtMs,
    updatedMs: startedAtMs,
    recencyMs: startedAtMs,
    lastEventSummary: "Running command",
    unseen: false,
  };
}

function commandEvent(anchorMs, turnId, payload) {
  return turnEvent(
    "event_command",
    "command_execution",
    anchorMs,
    turnId,
    {
      itemId: "command_item",
      command: "cargo test",
      cwd: "src",
      ...payload,
    },
  );
}

function turnEvent(id, type, anchorMs, turnId, payload = {}) {
  return {
    id,
    threadId: "thread_command_component",
    type,
    summary: type.replaceAll("_", " "),
    payload: { turnId, ...payload },
    position: { anchorMs, index: 0 },
  };
}

function taskDetail(task, events, revision) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision,
    eventRevision: revision,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    eventsRange: { from: null, to: null },
    historyLoading: false,
  };
}

async function emitTaskEvent(page, threadId, event, revision) {
  await page.evaluate(({ threadId, event, revision }) => {
    const source = window.__commandEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-event", {
      threadId,
      revision,
      eventRevision: revision,
      event,
    });
  }, { threadId, event, revision });
}

async function emitTaskSync(page, threadId, detail, revision) {
  await page.evaluate(({ threadId, detail, revision }) => {
    const source = window.__commandEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-sync", { threadId, revision, detail });
  }, { threadId, detail, revision });
}

async function rememberCommandIdentity(command) {
  await command.evaluate((element) => {
    window.__commandIdentity = {
      element,
      details: element.shadowRoot.querySelector("details"),
      summary: element.shadowRoot.querySelector("details > summary"),
    };
  });
}

async function expectCommandIdentity(page, { activeStructure }) {
  expect(
    await page.evaluate(({ activeStructure, current }) => {
      const identity = window.__commandIdentity;
      return (
        current === identity.element &&
        (activeStructure
          ? current.shadowRoot.querySelector("details") === identity.details &&
            current.shadowRoot.querySelector("details > summary") ===
              identity.summary
          : !identity.details.isConnected && !identity.summary.isConnected)
      );
    }, {
      activeStructure,
      current: await page.locator(".task-command > caffold-task-command").elementHandle(),
    }),
  ).toBe(true);
}

async function disclosureOffset(summary) {
  return summary.evaluate((element, scroller) => (
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top
  ), await summary.page().locator(".task-conversation-scroll").elementHandle());
}
