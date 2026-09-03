import { expect, test } from "@playwright/test";
import { actionHintBadgePresentation } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { TASK_PERMISSION_FIXTURE } from "../support/task-api-fixture.js";
import {
  activeTaskProjection,
  canonicalTaskState,
  captureReviewScreenshot,
  installEventSourceMock,
  mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("shows only declared visible targets in frozen visual order", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const pageErrors = [];
  const browserErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      browserErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  const tasks = actionHintTasks(48);
  await installActionHintFixture(page, tasks);
  await page.goto("/tasks");
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  expect(pageErrors).toEqual([]);
  expect(browserErrors).toEqual([]);

  const surface = page.locator(".task-workspace-surface");
  const newTask = page.locator(".task-list-new-task");
  await expect(newTask).toBeVisible();
  await newTask.focus();
  await page.keyboard.press("f");

  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":scope > .action-hint-instructions"))
    .toHaveCount(0);
  await expect(dialog.locator(":scope > .sr-only")).toHaveCount(3);
  const eligible = await visibleTaskTitles(page);
  expect(eligible.length).toBeGreaterThan(0);
  expect(eligible.length).toBeLessThan(tasks.length);
  const taskBadges = dialog.locator(
    'button[data-action-hint-code^="T"]',
  );
  await expect(taskBadges).toHaveCount(eligible.length);
  expect(await taskBadges.evaluateAll((badges) =>
    badges.map((badge) => badge.getAttribute("aria-label")
      .replace(/^[A-Z]+ — Open task(?: recovery)?: /, ""))
  )).toEqual(eligible);
  await expect(dialog.locator('[data-action-hint-code="TA"]')).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="N"]')).toHaveAttribute(
    "aria-label",
    "N — Create a new task",
  );
  await expect(dialog.getByLabel(/Open section:/i)).toHaveCount(1);

  const createPrompt = page.locator(
    'caffold-task-new textarea[name="prompt"]',
  );
  if (await createPrompt.isVisible()) {
    await expect(dialog.locator('[data-action-hint-code="M"]')).toBeVisible();
    await expect(dialog.locator('[data-action-hint-code="P"]')).toBeVisible();
    await expect(dialog.getByLabel(/Browse Files/)).toBeVisible();
  } else {
    await expect(dialog.locator('[data-action-hint-code="M"]')).toHaveCount(0);
    await expect(dialog.locator('[data-action-hint-code="P"]')).toHaveCount(0);
    await expect(dialog.getByLabel(/Browse Files/)).toHaveCount(0);
  }

  const anchored = await page.evaluate(() => {
    const control = document.querySelector(".task-list-new-task");
    const badge = document.querySelector(
      'caffold-action-hint-dialog [data-action-hint-code="N"]',
    );
    const controlRect = control.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    return {
      left: Math.abs(controlRect.left - badgeRect.left),
      top: Math.abs(controlRect.top - badgeRect.top),
    };
  });
  expect(anchored.left).toBeLessThanOrEqual(1);
  expect(anchored.top).toBeLessThanOrEqual(1);

  const touchPolicy = await dialog.evaluate((element) => {
    const dispatch = (touchCount) => {
      const event = new Event("touchmove", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "touches", {
        value: Array.from({ length: touchCount }, () => ({})),
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { panPrevented: dispatch(1), pinchPrevented: dispatch(2) };
  });
  expect(touchPolicy).toEqual({ panPrevented: true, pinchPrevented: false });

  await captureReviewScreenshot(page, testInfo, "action-hints-overlay");
  const routeBeforeOverlayCancel = page.url();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(routeBeforeOverlayCancel);
  await expect(newTask).toBeFocused();
  await page.keyboard.press("f");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newTask).toBeFocused();
  await expect(surface).toBeVisible();
});

test("opens global shortcut help from Normal and replaces Action Hints", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/tasks");

  const opener = page.locator(".task-workspace-surface");
  const help = page.locator(
    "caffold-keyboard-shortcut-dialog > dialog:modal",
  );
  await opener.focus();
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "Keyboard shortcuts" }))
    .toBeVisible();
  await expect(help.getByText("Show available actions", { exact: true }))
    .toBeVisible();
  await expect(help.getByText("Scroll left or right", { exact: true }))
    .toBeVisible();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-keyboard-shortcut-help",
    "open",
  );
  await captureReviewScreenshot(page, testInfo, "keyboard-shortcut-help");

  await page.keyboard.press("?");
  await expect(help).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("f");
  const hints = actionHintDialog(page);
  await expect(hints).toBeVisible();
  await page.keyboard.press("?");
  await expect(hints).toBeHidden();
  await expect(help).toBeVisible();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "shortcut-help",
  );

  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(hints).toBeHidden();
  await expect(opener).toBeFocused();
});

test("closes Hint when printable input cannot match an action", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/tasks");

  const opener = page.locator(".task-list-new-task");
  await opener.focus();
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="TA"]')).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code^="TX"]')).toHaveCount(0);

  await page.keyboard.press("t");
  await expect(dialog).toHaveAttribute("data-input-state", "partial");
  await page.keyboard.press("x");

  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "no-match",
  );

  await page.keyboard.press("f");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("1");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "no-match",
  );

  await page.keyboard.press("f");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("keeps Hint ownership across an unrelated disclosure change", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/tasks");
  await enterActionHints(page);
  const hint = actionHintDialog(page);

  await page.evaluate(() => {
    const details = document.createElement("details");
    details.dataset.actionHintUnrelatedDisclosure = "";
    details.append(document.createElement("summary"));
    document.body.append(details);
  });
  await page.locator("details[data-action-hint-unrelated-disclosure]").evaluate(
    (details) => {
      details.open = true;
    },
  );

  await expect(hint).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await page.locator("details[data-action-hint-unrelated-disclosure]").evaluate(
    (details) => details.remove(),
  );
});

test("activates a Task through its existing route and responsive focus owner", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const tasks = actionHintTasks(2);
  await installActionHintFixture(page, tasks);
  await page.goto("/tasks");

  await enterActionHints(page);
  await page.keyboard.press("t");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(`/tasks/${tasks[0].threadId}`);
  await expect(actionHintDialog(page)).toBeHidden();
  if (testInfo.project.name === "phone") {
    await expect(page.locator(".tasks-detail-pane")).toBeFocused();
  } else {
    await expect(
      page.locator(`.task-row[data-thread-id="${tasks[0].threadId}"]`),
    ).toBeFocused();
  }
  await expect(
    page.locator(
      ".task-follow-up-form textarea[name='prompt']",
    ),
  ).toBeVisible();
  const streamedPatch = page.locator(
    ".task-conversation [data-action-hint-conversation-patch]",
  );
  await page.locator(".task-conversation").evaluate((list) => {
    const patch = document.createElement("li");
    patch.dataset.actionHintConversationPatch = "";
    patch.setAttribute("aria-hidden", "true");
    patch.style.blockSize = "1px";
    patch.style.overflow = "hidden";
    patch.textContent = "Streamed Conversation patch A";
    list.append(patch);
  });
  if (testInfo.project.name === "phone") {
    await page.locator(".tasks-detail-pane").focus();
  } else {
    await page.locator(
      `.task-row[data-thread-id="${tasks[0].threadId}"]`,
    ).focus();
  }
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await streamedPatch.evaluate((patch) => {
    patch.textContent = "Streamed Conversation patch B";
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="M"]')).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="P"]')).toHaveAttribute(
    "aria-label",
    "P — Edit follow-up prompt",
  );
  await page.locator(".task-list-scroll").evaluate((scroller) => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  if (testInfo.project.name === "phone") {
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    await expect(dialog).toBeHidden();
  }
});

test("allocates Settings navigation automatically and accepts F inside Hint mode", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/settings");

  await enterActionHints(page);
  const dialog = actionHintDialog(page);
  await page.locator(".settings-navigator-list").evaluate((scroller) => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(dialog).toBeHidden();
  await enterActionHints(page);
  const codes = await dialog.locator("button[data-action-hint-code]").evaluateAll(
    (badges) => badges.map((badge) => badge.dataset.actionHintCode),
  );
  expect(codes.length).toBeGreaterThanOrEqual(4);
  expect(new Set(codes.map((code) => code.length)).size).toBe(1);
  expect(codes.every((code) => !["N", "M", "P", "T"].includes(code[0])))
    .toBe(true);
  const fBadge = dialog.locator('[data-action-hint-code="F"]');
  await expect(fBadge).toBeVisible();
  await page.keyboard.press("f");
  await expect(dialog).toBeHidden();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "activated:F",
  );

  await page.goto("/settings");
  await enterActionHints(page);
  await dialog.getByLabel(/Open Tasks$/).click();
  await expect(page).toHaveURL("/");

  await page.goto("/settings/keyboard");
  await enterActionHints(page);
  await expect(dialog.getByLabel(/Open Keyboard settings$/)).toHaveCount(0);
  await expect(dialog.getByLabel(/Action Hints/)).toHaveCount(0);
  await page.locator(".settings-navigator-list").evaluate((scroller) => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  if (testInfo.project.name === "phone") {
    await expect(dialog).toBeVisible();
  } else {
    await expect(dialog).toBeHidden();
    await enterActionHints(page);
  }
  const back = dialog.getByLabel(/Back to settings$/);
  if (testInfo.project.name === "phone") {
    await expect(back).toBeVisible();
    const code = await back.getAttribute("data-action-hint-code");
    await page.keyboard.type(code.toLowerCase());
    await expect(page).toHaveURL("/settings");
  } else {
    await expect(back).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
});

test("keeps badge Tab order and native click, Enter, and Space activation", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const tasks = actionHintTasks(1);
  await installActionHintFixture(page, tasks);
  await page.goto("/tasks");

  await enterActionHints(page);
  const dialog = actionHintDialog(page);
  await page.keyboard.press("Tab");
  await expect(dialog.locator("button:focus")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await enterActionHints(page);
  const newTaskBadge = dialog.locator('[data-action-hint-code="N"]');
  await newTaskBadge.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/tasks/new");

  await page.goto("/tasks");
  await enterActionHints(page);
  await dialog.locator('[data-action-hint-code="N"]').click();
  await expect(page).toHaveURL("/tasks/new");

  await page.goto("/tasks");
  await enterActionHints(page);
  await dialog.locator('[data-action-hint-code="TA"]').focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(`/tasks/${tasks[0].threadId}`);
});

test("activates New Task through its existing route and autofocus policy", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/tasks");

  await enterActionHints(page);
  await page.keyboard.press("n");
  await expect(page).toHaveURL("/tasks/new");
  await expect(actionHintDialog(page)).toBeHidden();
  const prompt = page.locator(
    'caffold-task-new textarea[name="prompt"]',
  );
  await expect(prompt).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await expect(prompt).toBeFocused();
  } else {
    await expect(prompt).not.toBeFocused();
  }
});

test("does not enter while a Task route is still loading", { tag: "@desktop" }, async ({
  page,
}) => {
  const tasks = actionHintTasks(1);
  await installActionHintFixture(page, tasks, { bootstrapDetail: false });
  await page.goto("/tasks");

  await enterActionHints(page);
  await page.keyboard.press("t");
  await page.keyboard.press("a");
  await expect(page).toHaveURL(`/tasks/${tasks[0].threadId}`);
  await expect(page.getByText("Loading task...", { exact: true })).toBeVisible();
  const row = page.locator(
    `.task-row[data-thread-id="${tasks[0].threadId}"]`,
  );
  await row.focus();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(row).toBeFocused();
});

test("hands create M to the native model popover and P to prompt editing", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, []);
  await page.goto("/tasks");

  const prompt = page.locator(
    'caffold-task-new textarea[name="prompt"]',
  );
  await expect(prompt).toBeVisible();
  await prompt.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tasks-detail-pane")).toBeFocused();

  await page.keyboard.press("f");
  await page.keyboard.press("m");
  await expect(actionHintDialog(page)).toBeHidden();
  const modelPopover = page.locator(
    "caffold-task-new .task-model-popover",
  );
  await expect(modelPopover).toBeVisible();
  await expect(
    modelPopover.locator(
      '[data-turn-options-action="select-model"][aria-pressed="true"]',
    ),
  ).toBeFocused();
  await page.keyboard.press("f");
  const popoverHint = actionHintDialog(page);
  await expect(popoverHint).toBeVisible();
  await expect(
    popoverHint.getByRole("button", { name: / — low.*Selected$/ }),
  ).toBeVisible();
  const high = popoverHint.getByRole("button", { name: / — high$/ });
  const highCode = await high.getAttribute("data-action-hint-code");
  expect(highCode).toBeTruthy();
  await page.keyboard.type(highCode.toLowerCase());
  await expect(popoverHint).toBeHidden();
  await expect(modelPopover).toBeHidden();
  await expect(
    page.locator("caffold-task-new .task-model-button"),
  ).toContainText("high");

  await page.locator("caffold-task-new .task-model-button").click();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("f");
  await expect(popoverHint).toBeVisible();
  const retained = await page.locator(
    "caffold-task-new caffold-task-turn-options",
  ).evaluate((options) => {
    const root = options.modelPopover();
    const presentation = root.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    options.modelOptions = options.modelOptions.map((option, index) =>
      index === 0
        ? { ...option, displayName: `${option.displayName} Refreshed` }
        : option
    );
    options.render();
    return {
      presentation: root.querySelector(
        ":scope > caffold-keyboard-navigation-presentation",
      ) === presentation,
      root: options.modelPopover() === root,
    };
  });
  expect(retained).toEqual({ presentation: true, root: true });
  await expect(popoverHint).toBeHidden();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("f");
  await expect(popoverHint).toBeVisible();
  await expect(
    popoverHint.getByRole("button", { name: / — GPT-5\.6-Sol Refreshed.*Selected$/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popoverHint).toBeHidden();
  await expect(modelPopover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelPopover).toBeHidden();

  await page.keyboard.press("f");
  await page.keyboard.press("p");
  await expect(prompt).toBeFocused();
  await page.keyboard.type("f");
  await expect(prompt).toHaveValue("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tasks-detail-pane")).toBeFocused();

  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.dataset.actionHintExternalOwner = "";
    dialog.tabIndex = -1;
    const input = document.createElement("input");
    dialog.append(input);
    document.body.append(dialog);
    dialog.showModal();
    dialog.focus();
  });
  const externalDialog = page.locator(
    "dialog[data-action-hint-external-owner]",
  );
  await expect(externalDialog).toBeVisible();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(externalDialog).toBeHidden();
  await externalDialog.evaluate((dialog) => dialog.remove());

  await page.evaluate(() => {
    const popover = document.createElement("div");
    popover.popover = "manual";
    popover.tabIndex = -1;
    popover.dataset.actionHintExternalPopover = "";
    popover.textContent = "External popover owner";
    document.body.append(popover);
    popover.showPopover();
    popover.focus();
  });
  const externalPopover = page.locator(
    "[data-action-hint-external-popover]:popover-open",
  );
  await expect(externalPopover).toBeVisible();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await externalPopover.evaluate((popover) => popover.remove());

  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeVisible();
});

test("hands follow-up M to the native model popover and P to prompt editing", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const [task] = actionHintTasks(1);
  await installActionHintFixture(page, [task]);
  await page.goto(`/tasks/${task.threadId}`);

  const prompt = page.locator(
    '.task-follow-up-form textarea[name="prompt"]',
  );
  await expect(prompt).toBeVisible();
  await enterActionHints(page);
  const dialog = actionHintDialog(page);
  await expect(dialog.locator('[data-action-hint-code="M"]')).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="P"]')).toHaveAttribute(
    "aria-label",
    "P — Edit follow-up prompt",
  );

  await page.keyboard.press("m");
  await expect(dialog).toBeHidden();
  const modelPopover = page.locator(
    "caffold-task-detail .task-follow-up-form .task-model-popover",
  );
  await expect(modelPopover).toBeVisible();
  await expect(
    modelPopover.locator(
      '[data-turn-options-action="select-model"][aria-pressed="true"]',
    ),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modelPopover).toBeHidden();

  await enterActionHints(page);
  await page.keyboard.press("p");
  await expect(prompt).toBeFocused();
  await page.keyboard.type("follow-up f");
  await expect(prompt).toHaveValue("follow-up f");
  await expect(dialog).toBeHidden();
});

test("keeps same-named models distinct by provider through native selection", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, []);
  await page.route(/\/api\/agent\/models(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        models: [
          {
            provider: "codex",
            model: "shared-model",
            displayName: "Codex Shared",
            isDefault: true,
            defaultEffort: "medium",
            efforts: ["medium"],
            supportsFastMode: false,
          },
          {
            provider: "claude",
            model: "shared-model",
            displayName: "Claude Shared",
            isDefault: false,
            defaultEffort: "high",
            efforts: ["high"],
            supportsFastMode: false,
          },
        ],
        unavailable: [],
      },
    })
  );
  await page.goto("/tasks");

  const options = page.locator("caffold-task-new caffold-task-turn-options");
  await options.locator(".task-model-button").click();
  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Codex Shared.*Selected$/ }),
  ).toBeVisible();
  const claude = hint.getByRole("button", { name: / — Claude Shared$/ });
  const claudeCode = await claude.getAttribute("data-action-hint-code");
  expect(claudeCode).toBeTruthy();
  await page.keyboard.type(claudeCode.toLowerCase());

  await expect(options.locator(".task-model-popover")).toBeHidden();
  await expect(options.locator(".task-model-button")).toContainText(
    "Claude Shared",
  );
  await expect.poll(() => options.evaluate((element) =>
    element.submissionOptions()
  )).toMatchObject({ provider: "claude", model: "shared-model" });
});

test("uses a mouse-open Permission context and preserves its existing confirmation", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, []);
  await page.goto("/tasks");

  const permissionButton = page.locator(
    "caffold-task-new .task-permission-button",
  );
  const permissionPopover = page.locator(
    "caffold-task-new .task-permission-popover",
  );
  await expect(permissionButton).toBeEnabled();
  await permissionButton.click();
  await expect(permissionPopover).toBeVisible();

  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Approve for me.*Selected$/ }),
  ).toBeVisible();
  let fullAccess = hint.getByRole("button", { name: / — Full access/ });
  let fullAccessCode = await fullAccess.getAttribute("data-action-hint-code");
  expect(fullAccessCode).toBeTruthy();
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("Full access removes sandbox restrictions");
    await dialog.dismiss();
  });
  await page.keyboard.type(fullAccessCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(permissionPopover).toBeVisible();
  await expect(
    permissionPopover.locator(
      '[data-permission-mode="approveForMe"][aria-pressed="true"]',
    ),
  ).toBeVisible();
  await expect(
    permissionPopover.locator('[data-permission-mode="fullAccess"]'),
  ).toBeFocused();

  await page.keyboard.press("f");
  await expect(hint).toBeVisible();
  fullAccess = hint.getByRole("button", { name: / — Full access/ });
  fullAccessCode = await fullAccess.getAttribute("data-action-hint-code");
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.keyboard.type(fullAccessCode.toLowerCase());
  await expect(hint).toBeHidden();
  await expect(permissionPopover).toBeHidden();
  await expect(permissionButton).toContainText("Full access");
});

test("selects Reorder through its declared popover and entered-mode contexts", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installActionHintFixture(page, actionHintTasks(2));
  await page.goto("/tasks");

  await enterActionHints(page);
  let hint = actionHintDialog(page);
  const reorderOpener = hint.getByRole("button", {
    name: / — Choose what to reorder$/,
  });
  const openerCode = await reorderOpener.getAttribute("data-action-hint-code");
  expect(openerCode).toBeTruthy();
  await page.keyboard.type(openerCode.toLowerCase());

  const navigator = page.locator("caffold-task-navigator");
  const popover = navigator.locator(".task-list-reorder-popover");
  await expect(popover).toBeVisible();
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(
    hint.getByRole("button", { name: / — Reorder Sections$/ }),
  ).toBeVisible();
  const tasks = hint.getByRole("button", { name: / — Reorder Tasks$/ });
  await expect(tasks).toHaveAttribute("data-match", "true");
  await expect.poll(() => actionHintBadgePresentation(tasks)).toEqual({
    backgroundMatches: true,
    borderVisible: true,
    colorMatches: true,
    hasBlockPadding: true,
    position: "absolute",
  });
  await captureReviewScreenshot(
    page,
    testInfo,
    "action-hints-reorder-popover",
  );
  const tasksCode = await tasks.getAttribute("data-action-hint-code");
  expect(tasksCode).toBeTruthy();
  await page.keyboard.type(tasksCode.toLowerCase());

  await expect(popover).toBeHidden();
  await expect(navigator).toHaveAttribute("data-reorder-mode", "tasks");
  await page.keyboard.press("f");
  hint = actionHintDialog(page);
  await expect(hint).toBeVisible();
  await expect(hint.getByLabel(/ — Finish reordering Tasks$/)).toBeVisible();
  await expect(
    hint.getByLabel(/Use Up and Down arrow keys to move\.$/),
  ).toHaveCount(2);
  await expect(hint.getByLabel(/ — Open task:/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await navigator.getByRole("button", {
    name: "Finish reordering Tasks",
  }).click();
  await expect(navigator).toHaveAttribute("data-reorder-mode", "none");
});

test("honors the setting, editing ownership, and composition-safe Latin fallback", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, []);
  await page.goto("/settings/keyboard");

  const setting = page.getByRole("switch", { name: "Keyboard navigation" });
  await expect(setting).toBeChecked();
  await setting.uncheck();
  await page.goto("/tasks");
  const offPrompt = page.locator(
    'caffold-task-new textarea[name="prompt"]',
  );
  await offPrompt.focus();
  await page.keyboard.press("Escape");
  await expect(offPrompt).toBeFocused();
  await page.locator(".tasks-detail-pane").focus();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await page.keyboard.press("?");
  await expect(page.locator(
    "caffold-keyboard-shortcut-dialog > dialog:modal",
  )).toBeHidden();

  await page.goto("/settings/keyboard");
  await setting.check();
  await page.goto("/tasks");
  const prompt = page.locator(
    'caffold-task-new textarea[name="prompt"]',
  );
  await prompt.focus();
  await page.keyboard.press("f");
  await expect(prompt).toHaveValue("f");
  await expect(actionHintDialog(page)).toBeHidden();
  await page.keyboard.press("?");
  await expect(prompt).toHaveValue("f?");
  await expect(page.locator(
    "caffold-keyboard-shortcut-dialog > dialog:modal",
  )).toBeHidden();

  await prompt.evaluate((textarea) => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "ㅎ",
    }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Escape",
      isComposing: true,
      key: "Escape",
    }));
  });
  await expect(prompt).toBeFocused();
  await prompt.evaluate((textarea) => {
    textarea.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "ㅎ",
    }));
  });
  await page.keyboard.press("Escape");
  const detail = page.locator(".tasks-detail-pane");
  await expect(detail).toBeFocused();
  const ignoredKeys = await detail.evaluate((region) => {
    const dispatch = (init) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyF",
        key: "f",
        ...init,
      });
      region.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      ctrl: dispatch({ ctrlKey: true }),
      repeat: dispatch({ repeat: true }),
    };
  });
  expect(ignoredKeys).toEqual({ ctrl: false, repeat: false });
  await expect(actionHintDialog(page)).toBeHidden();
  await detail.evaluate((region) => {
    region.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyF",
      key: "ㄹ",
    }));
  });
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "ㅎ",
    }));
    element.dispatchEvent(new Event("cancel", {
      cancelable: true,
    }));
  });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "ㅎ",
    }));
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("keeps harmless row patches but cancels on actionability, scroll, and topology changes", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await installActionHintFixture(page, actionHintTasks(48));
  await page.goto("/tasks");
  await enterActionHints(page);

  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  const rowIdentity = await page.locator("caffold-active-task-list").evaluate(
    (list) => {
      const task = list.taskFor("action_hint_01");
      window.__actionHintRow = list.querySelector(
        '.task-row[data-thread-id="action_hint_01"]',
      );
      list.upsertCanonicalTask({
        ...task,
        title: "Renamed Action Hint Task 01",
        latestTurnStatus: "inProgress",
        threadStatus: { type: "active", activeFlags: [] },
        activeTurn: { id: "turn_action_hint", startedAtMs: Date.now() },
      });
      return Boolean(window.__actionHintRow);
    },
  );
  expect(rowIdentity).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-action-hint-code="TA"]')).toHaveAttribute(
    "aria-label",
    "TA — Open task: Renamed Action Hint Task 01",
  );
  expect(await page.evaluate(() =>
    window.__actionHintRow === document.querySelector(
      '.task-row[data-thread-id="action_hint_01"]',
    )
  )).toBe(true);

  const offscreenRow = page.locator(
    'button.task-row[data-thread-id="action_hint_48"]',
  );
  await expect(offscreenRow).not.toBeInViewport();
  await offscreenRow.evaluate((button) => {
    button.disabled = true;
  });
  await expect(dialog).toBeHidden();
  await offscreenRow.evaluate((button) => {
    button.disabled = false;
  });
  await enterActionHints(page);

  const scroll = page.locator(".task-list-scroll");
  const routeBeforeCancel = page.url();
  const before = await scroll.evaluate((element) => element.scrollTop);
  await page.mouse.move(5, 5);
  await page.mouse.wheel(0, 240);
  await expect(dialog).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before);

  await scroll.evaluate((element) => {
    element.scrollTop += 24;
  });
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(routeBeforeCancel);

  await enterActionHints(page);
  await expect(dialog).toBeVisible();
  await page.locator("caffold-active-task-list").evaluate((list) => {
    list.removeTask("action_hint_02");
  });
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(routeBeforeCancel);
});

test("cancels a Conversation Hint on target topology change without losing the reading anchor", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const [task] = actionHintTasks(1);
  await installActionHintFixture(page, [task]);
  await page.goto(`/tasks/${task.threadId}`);
  const conversation = page.locator("caffold-task-conversation");
  await expect(conversation).toBeVisible();
  await conversation.evaluate((element, threadId) => {
    const now = 1_780_000_100_000;
    element.setSnapshot({
      ...element.snapshot,
      events: Array.from({ length: 28 }, (_, index) => ({
        id: `conversation_hint_anchor_${index + 1}`,
        threadId,
        type: "user_message",
        summary: "User prompt",
        payload: {
          text: `Conversation anchor line ${index + 1}. ${
            "Retain this exact reading position. ".repeat(2)
          }`,
        },
        position: { anchorMs: now + index, index: 0 },
      })),
    });
  }, task.threadId);
  const scroller = conversation.locator(".task-conversation-scroll");
  await expect.poll(() => scroller.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  const anchor = await scroller.evaluate((element) => {
    element.scrollTop = Math.round(
      (element.scrollHeight - element.clientHeight) * 0.45,
    );
    element.dispatchEvent(new Event("scroll"));
    const bounds = element.getBoundingClientRect();
    const events = [
      ...element.querySelectorAll(".task-event[data-event-id]"),
    ];
    const event = events.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= bounds.top + 1 && rect.top < bounds.bottom - 1;
    }) ?? events.find(
      (candidate) => candidate.getBoundingClientRect().bottom > bounds.top + 1,
    );
    const eventIndex = events.indexOf(event);
    const target = events.slice(eventIndex + 1).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top < bounds.bottom - 1 && rect.bottom > bounds.top + 1;
    });
    return {
      eventId: event?.dataset.eventId ?? "",
      targetEventId: target?.dataset.eventId ?? "",
      offset: event ? event.getBoundingClientRect().top - bounds.top : null,
    };
  });
  expect(anchor.eventId).toBeTruthy();
  expect(anchor.targetEventId).toBeTruthy();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));

  const dialog = actionHintDialog(page);
  await page.keyboard.press("f");
  await expect(dialog).toBeVisible();
  await expect.poll(() => scroller.evaluate((element, expected) => {
    const event = element.querySelector(
      `.task-event[data-event-id="${expected.eventId}"]`,
    );
    return event
      ? Math.abs(
          event.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            expected.offset,
        )
      : Infinity;
  }, anchor)).toBeLessThan(1);
  await conversation.evaluate((element, targetEventId) => {
    element.setSnapshot({
      ...element.snapshot,
      updateKind: "live",
      events: element.snapshot.events.map((event) =>
        event.id === targetEventId
          ? {
              ...event,
              payload: {
                ...event.payload,
                content: [{
                  type: "localImage",
                  path: "/tmp/conversation-hint-topology.png",
                  name: "conversation-hint-topology.png",
                }],
              },
            }
          : event
      ),
    });
  }, anchor.targetEventId);
  await expect(dialog).toBeHidden();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await expect(conversation.locator(
    'button[data-conversation-action="preview-image"]',
  )).toHaveCount(1);
  await expect.poll(() => scroller.evaluate((element, expected) => {
    const event = element.querySelector(
      `.task-event[data-event-id="${expected.eventId}"]`,
    );
    return event
      ? Math.abs(
          event.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            expected.offset,
        )
      : Infinity;
  }, anchor)).toBeLessThan(1);
});

test("cancels on geometry, actionability, ownership, viewport, and route changes", { tag: "@desktop" }, async ({
  page,
}) => {
  await installActionHintFixture(page, actionHintTasks(8));
  await page.goto("/tasks");
  await expect(page.locator("caffold-active-task-row")).toHaveCount(8);
  const dialog = actionHintDialog(page);
  const workspace = page.locator("caffold-app-shell");
  const newTask = page.locator(".task-list-new-task");

  await enterActionHints(page);
  await newTask.evaluate((button) => {
    button.style.width = `${button.getBoundingClientRect().width + 20}px`;
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await newTask.evaluate((button) => button.style.removeProperty("width"));

  await enterActionHints(page);
  await newTask.evaluate((button) => {
    button.disabled = true;
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await newTask.evaluate((button) => {
    button.disabled = false;
  });

  const firstRow = page.locator(
    'button.task-row[data-thread-id="action_hint_01"]',
  );
  await enterActionHints(page);
  await firstRow.evaluate((button) => {
    button.dataset.activeTaskRowAction = "unknown-action";
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await firstRow.evaluate((button) => {
    button.dataset.activeTaskRowAction = "open-task";
  });

  const modelButton = page.locator("caffold-task-new .task-model-button");
  const modelPopoverTarget = await modelButton.getAttribute("popovertarget");
  await enterActionHints(page);
  await modelButton.evaluate((button) => {
    button.setAttribute("popovertarget", "missing-model-popover");
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await modelButton.evaluate((button, target) => {
    button.setAttribute("popovertarget", target);
  }, modelPopoverTarget);

  await enterActionHints(page);
  await page.locator("caffold-task-navigator").evaluate((navigator) => {
    navigator.setReorderMode("tasks");
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await page.locator("caffold-task-navigator").evaluate((navigator) => {
    navigator.setReorderMode("none");
  });

  await enterActionHints(page);
  const permissionPopover = page.locator(
    "caffold-task-new .task-permission-popover",
  );
  await permissionPopover.evaluate((popover) => popover.showPopover());
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "interaction-owner",
  );
  await expect(permissionPopover).toBeVisible();
  await permissionPopover.evaluate((popover) => popover.hidePopover());

  await enterActionHints(page);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: viewport.width - 20,
    height: viewport.height,
  });
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    /^(?:viewport|snapshot-invalidated)$/,
  );

  await enterActionHints(page);
  await workspace.evaluate((element) => {
    element.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: { route: { kind: "tasks", new: true } },
      }),
    );
  });
  await expect(page).toHaveURL("/tasks/new");
  await expect(dialog).toBeHidden();
  await expect(workspace).toHaveAttribute(
    "data-action-hint-last-exit",
    "route",
  );

  await enterActionHints(page);
  const disconnected = await workspace.evaluate((element) => {
    const controller = element.actionHints;
    window.__actionHintDetachedShell = element;
    element.remove();
    return {
      connected: controller.connected,
      hasSession: Boolean(controller.session),
    };
  });
  expect(disconnected).toEqual({ connected: false, hasSession: false });
  await expect(dialog).toBeHidden();

  await page.evaluate(() => {
    document.body.append(window.__actionHintDetachedShell);
  });
  await expect.poll(() => workspace.evaluate(
    (element) => element.actionHints.connected,
  )).toBe(true);
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("f");
  await expect(dialog).toBeVisible();
  await expect(page.locator("caffold-action-hint-dialog > dialog:modal"))
    .toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("keeps badges aligned and legible at appearance and zoom extremes", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  await installActionHintFixture(page, actionHintTasks(8));
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "New Task" })).toBeVisible();
  await expect(page.locator("caffold-active-task-row")).toHaveCount(8);
  const devtools = await context.newCDPSession(page);

  for (const scenario of [
    { interfaceScalePercent: 90, pageScaleFactor: 1, themeMode: "light" },
    { interfaceScalePercent: 120, pageScaleFactor: 1.25, themeMode: "dark" },
  ]) {
    await page.evaluate(async ({ interfaceScalePercent, themeMode }) => {
      const { setAppearanceRangeSetting, setThemeMode } = await import(
        "/assets/settings.js"
      );
      setAppearanceRangeSetting("interfaceScalePercent", interfaceScalePercent);
      setThemeMode(themeMode);
    }, scenario);
    await devtools.send("Emulation.setPageScaleFactor", {
      pageScaleFactor: scenario.pageScaleFactor,
    });
    await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
      .toBeCloseTo(scenario.pageScaleFactor, 2);
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));

    await enterActionHints(page);
    const visual = await captureActionHintVisualState(page);
    expect(visual.scale).toBeCloseTo(scenario.pageScaleFactor, 2);
    expect(visual.alignmentErrors).toEqual([]);
    expect(visual.viewportEscapes).toEqual([]);
    expect(visual.contrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(visual.outlineStyle).not.toBe("none");
    expect(visual.outlineWidth).toBeGreaterThanOrEqual(2);
    if (scenario.interfaceScalePercent === 120) {
      await captureReviewScreenshot(
        page,
        testInfo,
        "action-hints-appearance-max-zoom",
      );
    }
    await page.keyboard.press("Escape");
  }
});

function actionHintDialog(page) {
  return page.locator("caffold-action-hint-dialog > dialog:modal");
}

async function enterActionHints(page) {
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("f");
  await expect(actionHintDialog(page)).toBeVisible();
}

function actionHintTasks(count) {
  const now = 1_780_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const number = `${index + 1}`.padStart(2, "0");
    return {
      id: `action_hint_${number}`,
      threadId: `action_hint_${number}`,
      ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      title: `Action Hint Task ${number}`,
      preview: `Action Hint Task ${number} preview`,
      cwd: "frontend/tests/e2e/fixtures/action-hints",
      cwdPath: "frontend/tests/e2e/fixtures/action-hints",
      relativeCwd: "",
      worktree: null,
      createdMs: now - index,
      updatedMs: now - index,
      recencyMs: now - index,
      lastCompletedMs: now - index,
      lastEventSummary: `Action Hint Task ${number} complete`,
    };
  });
}

async function installActionHintFixture(
  page,
  tasks,
  { bootstrapDetail = true } = {},
) {
  await page.exposeFunction(
    "__actionHintTaskDetailBootstrap",
    (threadId) => {
      const task = tasks.find((candidate) => candidate.threadId === threadId);
      return bootstrapDetail && task ? actionHintTaskDetail(task) : null;
    },
  );
  await installEventSourceMock(page, {
    autoOpen: true,
    bootstrapFunctionKey: "__actionHintTaskDetailBootstrap",
  });
  await mockAgentModels(page);
  await page.route(/\/api\/agent\/permissions(?:\?|$)/, (route) =>
    route.fulfill({ json: TASK_PERMISSION_FIXTURE })
  );
  await page.route(/\/api\/current-plan(?:\?|$)/, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    return route.fulfill({
      json: {
        status: "absent",
        watchPath: path,
        plan: null,
        problems: [],
      },
    });
  });
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(activeTaskProjection(tasks)),
    })
  );
  await page.route(
    /\/api\/tasks\/(?!archived(?:[/?]|$))([^/?]+)(?:\?|$)/,
    (route) => {
      const threadId = new URL(route.request().url()).pathname.split("/").at(-1);
      const task = tasks.find((candidate) => candidate.threadId === threadId);
      return route.fulfill({
        status: task ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          task ? actionHintTaskDetail(task) : { error: "Task not found" },
        ),
      });
    },
  );
}

function actionHintTaskDetail(task) {
  return {
    threadId: task.threadId,
    syncState: "ready",
    revision: 1,
    eventRevision: 1,
    task,
    events: [],
    fileLinks: [],
    eventsPage: { nextCursor: null },
    pendingApprovals: [],
    historyLoading: false,
    permissionMode: "approveForMe",
  };
}

async function visibleTaskTitles(page) {
  return page.locator("caffold-task-navigator").evaluate((navigator) => {
    const scroll = navigator.querySelector(":scope > .task-list-scroll");
    const navigatorRect = navigator.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const viewport = {
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
      right:
        (window.visualViewport?.offsetLeft ?? 0) +
        (window.visualViewport?.width ?? document.documentElement.clientWidth),
      bottom:
        (window.visualViewport?.offsetTop ?? 0) +
        (window.visualViewport?.height ?? document.documentElement.clientHeight),
    };
    return [...navigator.querySelectorAll(
      "caffold-active-task-row > button.task-row:not(:disabled)",
    )].filter((row) => {
      const rect = row.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const left = Math.max(rect.left, navigatorRect.left, scrollRect.left, viewport.left);
      const top = Math.max(rect.top, navigatorRect.top, scrollRect.top, viewport.top);
      const right = Math.min(rect.right, navigatorRect.right, scrollRect.right, viewport.right);
      const bottom = Math.min(rect.bottom, navigatorRect.bottom, scrollRect.bottom, viewport.bottom);
      return right > left && bottom > top &&
        centerX >= left && centerX <= right &&
        centerY >= top && centerY <= bottom;
    }).map((row) => row.querySelector(".task-row-title").textContent);
  });
}

async function captureActionHintVisualState(page) {
  return page.evaluate(() => {
    const viewport = {
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
      right:
        (window.visualViewport?.offsetLeft ?? 0) +
        (window.visualViewport?.width ?? document.documentElement.clientWidth),
      bottom:
        (window.visualViewport?.offsetTop ?? 0) +
        (window.visualViewport?.height ?? document.documentElement.clientHeight),
    };
    const intersection = (rects) => ({
      left: Math.max(...rects.map((rect) => rect.left)),
      top: Math.max(...rects.map((rect) => rect.top)),
      right: Math.min(...rects.map((rect) => rect.right)),
      bottom: Math.min(...rects.map((rect) => rect.bottom)),
    });
    const target = (element, clips) => {
      if (!element) {
        return null;
      }
      const anchor = element.getBoundingClientRect();
      const visible = intersection([
        anchor,
        ...clips.map((clip) => clip.getBoundingClientRect()),
        viewport,
      ]);
      const centerX = anchor.left + anchor.width / 2;
      const centerY = anchor.top + anchor.height / 2;
      return visible.right > visible.left &&
          visible.bottom > visible.top &&
          centerX >= visible.left && centerX <= visible.right &&
          centerY >= visible.top && centerY <= visible.bottom
        ? visible
        : null;
    };
    const navigator = document.querySelector("caffold-task-navigator");
    const taskScroll = navigator.querySelector(":scope > .task-list-scroll");
    const taskTargets = [...navigator.querySelectorAll(
      "caffold-active-task-row > button.task-row:not(:disabled)",
    )].map((row) => target(row, [navigator, taskScroll])).filter(Boolean);
    const taskNew = document.querySelector("caffold-task-new:not([hidden])");
    const createScroll = taskNew?.querySelector(":scope > .task-new-workspace");
    const fixedTargets = new Map([
      ["N", target(document.querySelector(".task-list-new-task"), [navigator])],
      ["M", target(taskNew?.querySelector(".task-model-button"), [taskNew, createScroll])],
      ["P", target(taskNew?.querySelector("textarea[name='prompt']"), [taskNew, createScroll])],
    ]);
    const automaticTargets = new Map();
    const reorder = navigator.querySelector(":scope .task-list-reorder");
    automaticTargets.set(
      reorder.getAttribute("aria-label"),
      target(reorder, [navigator]),
    );
    const permission = taskNew?.querySelector(".task-permission-button");
    if (permission) {
      automaticTargets.set(
        permission.getAttribute("aria-label"),
        target(permission, [taskNew, createScroll]),
      );
    }
    for (const control of taskNew?.querySelectorAll(
      'button[data-composer-action="browse-cwd"], button[data-composer-action="voice"]',
    ) ?? []) {
      if (control.disabled) {
        continue;
      }
      const label = control.getAttribute("aria-label") ||
        control.textContent?.trim() || "";
      automaticTargets.set(
        label,
        target(control, [taskNew, createScroll]),
      );
    }
    for (const control of document.querySelectorAll(
      'caffold-active-task-section .task-repository-select[data-active-task-section-action="open-section"]',
    )) {
      const name = control.querySelector(".task-repository-label")?.textContent ?? "";
      automaticTargets.set(`Open section: ${name}`, target(control, [navigator, taskScroll]));
    }
    const workspaceNavigation = document.querySelector(
      "caffold-task-workspace-navigation",
    );
    for (const control of workspaceNavigation?.querySelectorAll(
      "button[data-workspace-mode]",
    ) ?? []) {
      if (control.hasAttribute("aria-current")) {
        continue;
      }
      const mode = control.dataset.workspaceMode;
      const label = control.getAttribute("aria-label") ||
        `Open ${mode === "tasks" ? "Tasks" : "Settings"}`;
      automaticTargets.set(label, target(control, [
        document.querySelector("caffold-task-workspace"),
        document.querySelector(".task-workspace-master-pane"),
      ]));
    }
    const workspace = document.querySelector("caffold-task-workspace");
    const masterDetail = workspace?.querySelector(
      ":scope > .task-workspace-surface > .task-workspace-master-detail",
    );
    const workspaceSeparator = workspace?.querySelector(
      ":scope > .task-workspace-surface > .task-workspace-master-detail > .task-workspace-master-resizer",
    );
    if (workspaceSeparator && masterDetail) {
      automaticTargets.set(
        workspaceSeparator.getAttribute("aria-label"),
        target(workspaceSeparator, [workspace, masterDetail]),
      );
    }
    let taskIndex = 0;
    const alignmentErrors = [];
    const viewportEscapes = [];
    const badges = [...document.querySelectorAll(
      "caffold-action-hint-dialog button[data-action-hint-code]",
    )];
    for (const badge of badges) {
      const code = badge.dataset.actionHintCode;
      const label = badge.getAttribute("aria-label")
        ?.replace(new RegExp(`^${code} — `), "") ?? "";
      const visible = code.startsWith("T")
        ? taskTargets[taskIndex++]
        : fixedTargets.get(code) ?? automaticTargets.get(label);
      const bounds = badge.getBoundingClientRect();
      if (!visible) {
        alignmentErrors.push(`${code}:missing-target`);
        continue;
      }
      const expectedLeft = Math.min(
        Math.max(visible.left, viewport.left + 4),
        Math.max(viewport.left + 4, viewport.right - bounds.width - 4),
      );
      const expectedTop = Math.min(
        Math.max(visible.top, viewport.top + 4),
        Math.max(viewport.top + 4, viewport.bottom - bounds.height - 4),
      );
      if (
        Math.abs(bounds.left - expectedLeft) > 1 ||
        Math.abs(bounds.top - expectedTop) > 1
      ) {
        alignmentErrors.push(code);
      }
      if (
        bounds.left < viewport.left - 1 ||
        bounds.top < viewport.top - 1 ||
        bounds.right > viewport.right + 1 ||
        bounds.bottom > viewport.bottom + 1
      ) {
        viewportEscapes.push(code);
      }
    }
    const sample = badges[0];
    sample.focus();
    const style = getComputedStyle(sample);
    return {
      alignmentErrors,
      contrastRatio: colorContrast(style.color, style.backgroundColor),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      scale: window.visualViewport?.scale ?? 1,
      viewportEscapes,
    };

    function colorContrast(foreground, background) {
      const luminance = (value) => {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const linear = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    }
  });
}
