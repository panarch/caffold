import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockCodexModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("limits terminal command output activation to View output", async ({
  page,
}, testInfo) => {
  await installEventSourceMock(page, {
    registryKey: "__commandOutputActivationSources",
    autoOpen: true,
  });
  await mockCodexModels(page);

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
  const event = (id, type, createdMs, turnId, payload = {}) => ({
    id,
    threadId,
    type,
    summary: type,
    payload: { threadId, turnId, ...payload },
    createdMs,
  });
  const command = (id, createdMs, turnId, status) =>
    event(id, "command_execution", createdMs, turnId, {
      itemId: id,
      lifecycle: "completed",
      command:
        status === "failed"
          ? "cargo test --package intentionally-missing"
          : "cargo test --workspace --all-targets",
      cwd: "src",
      status,
      exitCode: status === "failed" ? 101 : 0,
      durationMs: status === "failed" ? 2_400 : 1_250,
      aggregatedOutput:
        status === "failed"
          ? "error: package `intentionally-missing` was not found"
          : "test result: ok",
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
          phase: "commentary",
          text: `Command review update ${index + 1}: preserve the scrolling boundary.`,
        },
      ),
    ),
    command("active_turn_success", now + 13_000, activeTurnId, "completed"),
    command("active_turn_failure", now + 14_000, activeTurnId, "failed"),
  ];
  const detail = {
    revision: 1,
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
  const tasksPage = page.locator("caffold-tasks-page");
  const workDetails = tasksPage.locator(
    `.task-turn-work[data-turn-id="${completedTurnId}"] caffold-task-work-details > details`,
  );
  await expect(workDetails).toHaveCount(1);
  await workDetails.locator(":scope > summary").click();
  await expect(workDetails).toHaveAttribute("open", "");

  const dialog = tasksPage.locator("caffold-task-command-dialog dialog");
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
    await dialog.getByRole("button", { name: "Close command output" }).click();
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
  await openWithKeyboardAndRestoreFocus(
    page,
    dialog,
    surfaces[1].failed.action,
    "Space",
  );

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
  await dialog.getByRole("button", { name: "Close command output" }).click();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(action).toBeFocused();
}

async function openWithKeyboardAndRestoreFocus(page, dialog, action, key) {
  await action.focus();
  await action.press(key);
  await expect(dialog).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(action).toBeFocused();
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
