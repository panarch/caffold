import { expect, test } from "@playwright/test";
import { actionHintDialog } from "../support/action-hints.js";
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
});

test("limits terminal command output activation to View output", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__commandOutputActivationSources",
    autoOpen: true,
  });
  await mockAgentModels(page);

  const threadId = "thread_command_output_activation";
  const completedTurnId = "turn_completed";
  const activeTurnId = "turn_active";
  const now = 1_767_450_000_000;
  const task = {
    id: threadId,
    threadId,
    ...canonicalTaskState("active", {
      turnId: activeTurnId,
      startedAtMs: now + 10_000,
      latestTurnStatus: "inProgress",
    }),
    title: "Command output activation",
    preview: "Keep command rows scrollable",
    cwd: "src",
    cwdPath: "src",
    relativeCwd: "",
    createdMs: now,
    updatedMs: now + 20_000,
    recencyMs: now + 20_000,
    lastEventSummary: "Checking command output actions",
  };
  const event = (id, type, anchorMs, turnId, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: { threadId, turnId, ...payload },
    position: { anchorMs, index: 0 },
  });
  const command = (id, anchorMs, turnId, status) =>
    event(id, "command_execution", anchorMs, turnId, {
      itemId: id,
      command:
        status === "failed"
          ? "cargo test --package intentionally-missing"
          : "cargo test --workspace --all-targets",
      cwd: "src",
      status,
      exitCode: status === "failed" ? 101 : 0,
      durationMs: status === "failed" ? 2_400 : 1_250,
      output:
        status === "failed"
          ? "error: package `intentionally-missing` was not found"
          : Array.from(
              { length: 24 },
              (_, index) => `test result ${index + 1}: ${
                "intrinsically-wide-command-output-segment-".repeat(12)
              }`,
            ).join("\n"),
    });
  const events = [
    event("completed_user", "user_message", now, completedTurnId, {
      text: "Review the completed commands.",
    }),
    command("completed_turn_success", now + 1_000, completedTurnId, "completed"),
    command("completed_turn_failure", now + 2_000, completedTurnId, "failed"),
    event("completed_final", "assistant_message", now + 3_000, completedTurnId, {
      itemId: "completed_final",
      phase: "final",
      text: "The completed commands are ready to inspect.",
    }),
    event("completed_marker", "turn_completed", now + 4_000, completedTurnId, {
      status: "completed",
    }),
    event("active_user", "user_message", now + 10_000, activeTurnId, {
      text: "Keep the active command rows usable while scrolling.",
    }),
    ...Array.from({ length: 18 }, (_, index) =>
      event(
        `active_update_${index}`,
        "assistant_message",
        now + 11_000 + index * 100,
        activeTurnId,
        {
          itemId: `active_update_${index}`,
          phase: "progress",
          text: `Command review update ${index + 1}: preserve the scrolling boundary.`,
        },
      ),
    ),
    command("active_turn_success", now + 13_000, activeTurnId, "completed"),
    command("active_turn_failure", now + 14_000, activeTurnId, "failed"),
  ];
  const detail = {
    revision: 1,
    eventRevision: 1,
    task,
    events,
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection([task])),
    }),
  );
  await page.route(new RegExp(`/api/tasks/${threadId}(?:\\?|$)`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );

  await page.goto(`/tasks/${threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, detail);
  const tasksPage = page.locator("caffold-tasks-page");
  const workDetails = tasksPage.locator(
    `.task-turn-work[data-turn-id="${completedTurnId}"] caffold-task-work-details > details`,
  );
  await expect(workDetails).toHaveCount(1);
  await workDetails.locator(":scope > summary").click();
  await expect(workDetails).toHaveAttribute("open", "");

  const dialog = tasksPage.locator("caffold-task-command-dialog > dialog");
  const surfaces = [
    commandSurface(
      "timeline",
      tasksPage.locator(
        ".task-command:has(> caffold-task-command[data-command-terminal])",
      ),
      {
        action: ".task-command-summary-action",
        label: ".task-command-summary-label",
        meta: ".task-command-summary-meta",
        row: "caffold-task-command",
        status: ".task-command-summary-status",
      },
    ),
    commandSurface(
      "work details",
      workDetails.locator(".task-work-details-command"),
      {
        action: ".task-command-summary-action",
        label: ".task-command-summary-label",
        meta: ".task-command-summary-meta",
        row: "caffold-task-command",
        status: ".task-command-summary-status",
      },
    ),
  ];

  for (const surface of surfaces) {
    await expect(surface.commands).toHaveCount(2);
    for (const entry of [surface.completed, surface.failed]) {
      await expect(entry.row).toBeVisible();
      expect(await entry.row.evaluate((element) => element.localName)).toBe(
        "caffold-task-command",
      );
      await expect(entry.row.locator("button")).toHaveCount(1);
      await expect(entry.action).toHaveAttribute("aria-haspopup", "dialog");
      await expect(entry.action).toHaveAttribute(
        "data-command-action",
        "command-output",
      );
      await expect(entry.action).toHaveAttribute("data-command-key", /.+/);
      await expect(entry.row).not.toHaveAttribute("aria-haspopup", "dialog");
      await expect(entry.row).not.toHaveAttribute("data-command-key", /.+/);
      await expect(entry.label).toHaveCSS("user-select", "text");
      const target = await entry.action.evaluate((action) => {
        const root = getComputedStyle(document.documentElement);
        const actionBox = action.getBoundingClientRect();
        const rowBox = action
          .closest("caffold-task-command")
          .getBoundingClientRect();
        return {
          actionHeight: actionBox.height,
          rowHeight: rowBox.height,
          targetFloor: Number.parseFloat(
            root.getPropertyValue("--interface-target-floor"),
          ),
        };
      });
      expect(target.actionHeight).toBeGreaterThanOrEqual(target.targetFloor);
      expect(target.actionHeight).toBeLessThanOrEqual(target.rowHeight);
    }

    for (const entry of [surface.completed, surface.failed]) {
      const nonActionContent = [entry.status, entry.label];
      if (await entry.meta.isVisible()) {
        nonActionContent.push(entry.meta);
      }
      for (const content of nonActionContent) {
        await content.click();
        await expect(dialog).not.toHaveAttribute("open", "");
      }
      const rowBox = await entry.row.boundingBox();
      await page.mouse.click(rowBox.x + 2, rowBox.y + 2);
      await expect(dialog).not.toHaveAttribute("open", "");
    }
  }

  await surfaces[0].completed.row.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, testInfo, "command-output-timeline-actions");
  await surfaces[1].completed.row.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, testInfo, "command-output-work-details-actions");

  const keyboardOpener = surfaces[0].completed.action;
  await keyboardOpener.click();
  await expect(dialog).toHaveAttribute("open", "");
  const closeControl = dialog.getByRole("button", {
    name: "Close command output",
    exact: true,
  });
  await expect(closeControl).toBeFocused();
  await page.keyboard.press("f");
  const commandHint = actionHintDialog(page);
  const closeHint = commandHint.getByRole("button", {
    name: / — Close command output$/,
  });
  await expect(closeHint).toBeVisible();
  const closeCode = await closeHint.getAttribute("data-action-hint-code");
  expect(closeCode).toBeTruthy();
  await page.keyboard.type(closeCode.toLowerCase());
  await expect(commandHint).toBeHidden();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(keyboardOpener).toBeFocused();

  await keyboardOpener.click();
  const commandBody = dialog.locator(".task-command-dialog-body");
  const commandOutput = commandBody.locator(
    ":scope > .task-command-dialog-output > pre",
  );
  await commandBody.evaluate((element) => {
    element.style.height = "220px";
    element.style.maxHeight = "220px";
  });
  await expect.poll(() => commandBody.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await expect.poll(() => commandOutput.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  )).toBe(true);
  await commandBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await closeControl.focus();
  await page.keyboard.press("s");
  const commandSelector = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation " +
      "caffold-scroll-surface-selector > dialog:modal",
  );
  const commandHud = dialog.locator(
    "caffold-keyboard-navigation-presentation caffold-scroll-mode-hud",
  );
  await expect(commandSelector).toBeVisible();
  const commandBadges = commandSelector.locator(
    "button[data-scroll-surface-code]",
  );
  await expect(commandBadges).toHaveCount(2);
  expect(new Set(await commandBadges.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")
      .replace(/^[A-Z]+ — /, ""))
  ))).toEqual(new Set(["Command dialog", "Command output"]));
  await expect(commandSelector.getByLabel(/ — Conversation$/)).toHaveCount(0);
  await expect(commandSelector.getByLabel(/ — Task list$/)).toHaveCount(0);
  await captureReviewScreenshot(
    page,
    testInfo,
    "command-output-scroll-selector",
  );
  const bodyBeforeOutputScroll = await commandBody.evaluate(
    (element) => element.scrollTop,
  );
  await commandSelector.getByLabel(/^[A-Z]+ — Command output$/).click();
  await expect(commandHud).toContainText("Scroll: Command output");
  await expect(commandHud.locator("[data-scroll-mode-shortcut-help]"))
    .toContainText("?");
  await page.keyboard.press("l");
  await expect.poll(() => commandOutput.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  expect(await commandBody.evaluate((element) => element.scrollTop)).toBe(
    bodyBeforeOutputScroll,
  );
  await page.keyboard.press("Escape");

  await commandBody.evaluate((element) => {
    element.style.height = "48px";
    element.style.maxHeight = "48px";
    element.scrollTop = 0;
  });
  await closeControl.focus();
  await page.keyboard.press("s");
  await expect(commandSelector).toBeHidden();
  await expect(commandHud).toContainText("Scroll: Command dialog");
  await expect(commandHud.locator("[data-scroll-mode-shortcut-help]"))
    .toContainText("?");
  await page.keyboard.press("j");
  await expect.poll(() => commandBody.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(commandHud).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(keyboardOpener).toBeFocused();

  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, nextTheme) => {
      root.dataset.theme = nextTheme;
      root.style.colorScheme = nextTheme;
    }, theme);
    const colors = await resolvedThemeColors(page);
    for (const surface of surfaces) {
      await expect(surface.completed.status).toHaveCSS("color", colors.muted);
      await expect(surface.failed.status).toHaveCSS("color", colors.danger);
      await expect(surface.completed.action).toHaveCSS("color", colors.link);
      await expect(surface.failed.action).toHaveCSS("color", colors.link);
    }
  }

  if (testInfo.project.name === "desktop") {
    const entry = surfaces[0].completed;
    const rowBackground = await entry.row.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await entry.status.hover();
    await expect(entry.row).toHaveCSS("background-color", rowBackground);
    const colors = await resolvedThemeColors(page);
    await entry.action.hover();
    await expect(entry.action).toHaveCSS("background-color", colors.hover);
    await page.mouse.down();
    await expect(entry.action).toHaveCSS("background-color", colors.active);
    await page.mouse.up();
    await expect(dialog).toHaveAttribute("open", "");
    await closeDialog(dialog, () =>
      dialog.getByRole("button", {
        name: "Close command output",
        exact: true,
      }).click(),
    );
    await expect(entry.action).toBeFocused();
  }

  await openWithKeyboardAndRestoreFocus(
    page,
    dialog,
    surfaces[0].failed.action,
    "Enter",
  );
  await openWithPointerAndRestoreFocus(
    dialog,
    surfaces[1].completed.action,
  );
  // A queued close event must not steal a newer focus move after native close.
  await surfaces[1].completed.action.click();
  await expect(dialog).toHaveAttribute("open", "");
  await closeDialogAndMoveFocus(dialog, surfaces[1].failed.action);

  const reconciledDetail = {
    ...detail,
    revision: 2,
    eventRevision: 2,
    task: {
      ...detail.task,
      updatedMs: now + 30_000,
      recencyMs: now + 30_000,
    },
    events: [
      ...detail.events,
      event("active_refresh", "assistant_message", now + 15_000, activeTurnId, {
        itemId: "active_refresh",
        phase: "progress",
        text: "Keep the exact command output opener during reconciliation.",
      }),
    ],
  };
  const repeatCount = testInfo.project.name === "foldable" ? 5 : 1;
  for (let attempt = 0; attempt < repeatCount; attempt += 1) {
    await openWithKeyboardAndRestoreFocus(
      page,
      dialog,
      surfaces[1].failed.action,
      "Space",
      attempt === 0
        ? async () => {
            await emitTaskDetailBootstrap(page, reconciledDetail);
            await expect(surfaces[1].failed.action).toHaveAttribute(
              "data-command-key",
              "item:thread_command_output_activation:turn_completed:completed_turn_failure",
            );
          }
        : undefined,
    );
  }

  if (testInfo.project.use.hasTouch) {
    for (const surface of surfaces) {
      await touchScrollFrom(page, surface.completed.label);
      await expect(dialog).not.toHaveAttribute("open", "");
    }
  }
});

function commandSurface(name, commands, selectors) {
  const entry = (status) => {
    const command = commands.filter({
      hasText: status === "failed" ? "Failed" : "Completed",
    });
    const row = command.locator(selectors.row);
    return {
      action: row.locator(selectors.action),
      command,
      label: row.locator(selectors.label),
      meta: row.locator(selectors.meta),
      row,
      status: row.locator(selectors.status),
    };
  };
  return {
    name,
    commands,
    completed: entry("completed"),
    failed: entry("failed"),
  };
}

async function resolvedThemeColors(page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const color = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = {
      active: color("--control-active-bg"),
      danger: color("--danger"),
      hover: color("--control-hover-bg"),
      link: color("--link-fg"),
      muted: color("--muted"),
    };
    probe.remove();
    return colors;
  });
}

async function openWithPointerAndRestoreFocus(dialog, action) {
  await action.click();
  await expect(dialog).toHaveAttribute("open", "");
  await closeDialog(dialog, () =>
    dialog.getByRole("button", {
      name: "Close command output",
      exact: true,
    }).click(),
  );
  await expect(action).toBeFocused();
}

async function openWithKeyboardAndRestoreFocus(
  page,
  dialog,
  action,
  key,
  beforeClose,
) {
  await action.focus();
  await action.press(key);
  await expect(dialog).toHaveAttribute("open", "");
  await beforeClose?.();
  await closeDialog(dialog, () => page.keyboard.press("Escape"));
  await expect(action).toBeFocused();
}

async function closeDialog(dialog, close) {
  const closeCount = await observeDialogClose(dialog);
  await close();
  await expectDialogClose(dialog, closeCount);
}

async function closeDialogAndMoveFocus(dialog, action) {
  const closeCount = await observeDialogClose(dialog);
  await action.evaluate((nextAction) => {
    const closeButton = nextAction.ownerDocument.querySelector(
      'caffold-task-command-dialog [data-command-dialog-action="close"]',
    );
    closeButton.click();
    nextAction.focus();
  });
  await expectDialogClose(dialog, closeCount);
  await expect(action).toBeFocused();
}

async function observeDialogClose(dialog) {
  return dialog.evaluate((element) => {
    if (!Number.isInteger(element.caffoldTestCloseCount)) {
      element.caffoldTestCloseCount = 0;
      element.addEventListener("close", () => {
        element.caffoldTestCloseCount += 1;
      });
    }
    return element.caffoldTestCloseCount;
  });
}

async function expectDialogClose(dialog, closeCount) {
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.caffoldTestCloseCount),
    )
    .toBe(closeCount + 1);
  await expect(dialog).not.toHaveAttribute("open", "");
}

async function touchScrollFrom(page, target) {
  await target.scrollIntoViewIfNeeded();
  const before = await target.evaluate((element) => {
    const scroller = element.closest(".task-conversation-scroll");
    const box = element.getBoundingClientRect();
    return {
      maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    };
  });
  expect(before.maxScrollTop).toBeGreaterThan(0);
  const delta = before.scrollTop > before.maxScrollTop / 2 ? 48 : -48;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: before.x, y: before.y }],
  });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: before.x,
          y: Math.round(before.y + delta * fraction),
        },
      ],
    });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
  await expect
    .poll(() =>
      target.evaluate(
        (element) => element.closest(".task-conversation-scroll").scrollTop,
      ),
    )
    .not.toBe(before.scrollTop);
}
