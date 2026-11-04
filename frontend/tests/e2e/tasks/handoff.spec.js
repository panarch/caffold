import { expect, test } from "@playwright/test";
import { activateActionHint, popoverActionHintDialog } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  AGENT_MODELS_FIXTURE, activeTaskProjection, canonicalTaskState, captureReviewScreenshot,
  createdTaskResponse, emitTaskDetailBootstrap, installEventSourceMock, mockAgentModels,
} from "../support/task-fixtures.js";

test.beforeEach(async ({ page }) => { await installBrowserDefaults(page); });

for (const managed of [true, false]) {
  test(`continues a ${managed ? "managed worktree" : "directory"} in the selected agent and submits only to the target`, { tag: "@all-viewports" }, async ({ page }, info) => {
    await installEventSourceMock(page, { autoOpen: true });
    await mockAgentModels(page);
    await page.route(/\/api\/agent\/models(?:\?|$)/, route => route.fulfill({json: {
      models: [AGENT_MODELS_FIXTURE.models[0], ...["claude", "grok", "antigravity"].map(provider => ({
        provider, model: `${provider}-model`, displayName: `${provider} model`, isDefault: true, efforts: [], supportsFastMode: false,
      }))], unavailable: [],
    }}));
    const task = (id, title) => ({
      id, threadId: id, title, preview: title, ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
      cwd: `src/${"long-directory-name/".repeat(8)}project`,
      cwdPath: `src/${"long-directory-name/".repeat(8)}project`, relativeCwd: "", conversationAvailable: true,
      worktree: null, createdMs: 100, updatedMs: 100, recencyMs: 100,
    });
    const source = task("handoff-source", "Review the remaining implementation");
    const target = task("handoff-target", "Continue the implementation");
    const detail = (task, access, provider = "claude") => ({
      provider, threadId: task.threadId, task, workspaceAccess: access,
      syncState: "ready", revision: 1, eventRevision: 1,
      events: [], eventsPage: { nextCursor: null }, eventsRange: { from: null, to: null },
      pendingApprovals: [], historyLoading: false,
    });
    const writable = { mode: "readWrite", ...(managed ? { ownerTaskId: source.id } : {}) };
    const sourceDetail = detail(source, writable);
    const targetDetail = detail(target, { mode: "readWrite", ...(managed ? { ownerTaskId: target.id } : {}) }, "codex");
    const prompt = "Read the source history with read_task_history. Summarize the situation, then wait for the user's next request. Do not modify files or run tests.";
    let created = false;
    const creations = [];
    const submissions = [];
    await page.route(/\/api\/tasks(?:\?|$)/, route => route.fulfill({ json: activeTaskProjection(created ? [target, source] : [source]) }));
    await page.route(/\/api\/tasks\/handoff-source(?:\?|$)/, route => route.fulfill({ json: sourceDetail }));
    await page.route(/\/api\/tasks\/handoff-target(?:\?|$)/, route => route.fulfill({ json: targetDetail }));
    await page.route("**/api/tasks/handoff-source/handoff", async route => {
      creations.push(route.request().postDataJSON());
      created = true;
      if (managed) sourceDetail.workspaceAccess = { mode: "readOnly", reason: "managedByAnotherTask", ownerTaskId: target.id };
      await route.fulfill({ json: { ...createdTaskResponse(targetDetail), prompt } });
    });
    await page.route(/\/api\/tasks\/[^/]+\/prompts/, async route => {
      submissions.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ json: { threadId: target.id, turnId: "preparation", userItemId: "handoff-prompt", steered: false } });
    });
    await page.goto(`/tasks/${source.id}`);
    await emitTaskDetailBootstrap(page, sourceDetail);
    await expect(page.getByRole("textbox", { name: "Follow-up prompt" })).toBeEnabled();
    const details = page.getByRole("button", { name: /Task details/ });
    await details.click();
    await expect(page.locator('[data-task-info-action="handoff"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    const composer = page.locator(".task-follow-up-form");
    const draft = composer.getByRole("textbox", { name: "Follow-up prompt" });
    await draft.fill("Keep this draft until I send it");
    const modelButton = composer.getByRole("button", { name: /^Choose model/ });
    const permission = composer.getByRole("button", { name: "Choose approval mode" });
    await expect(permission).toHaveAttribute("title", "Approve for me");
    const permissionLabel = await permission.getAttribute("title");
    const modelLabel = await modelButton.innerText();
    await modelButton.click();
    const menu = composer.locator(".task-model-popover");
    await expect(menu.locator(".task-provider-option")).toHaveText(["Codex", "Claude", "Grok", "Antigravity"]);
    await menu.getByRole("button", { name: "Antigravity", exact: true }).click();
    await expect(menu.getByRole("button", { name: "Continue with Antigravity", exact: true })).toBeVisible();
    await expect(menu.locator('[data-turn-options-action="select-model"]')).toHaveCount(0);
    expect(await menu.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (managed) await captureReviewScreenshot(page, info, "handoff-model-picker");
    await menu.getByRole("button", { name: "Codex", exact: true }).click();
    const continueButton = menu.getByRole("button", { name: "Continue with Codex", exact: true });
    await expect(continueButton.locator("svg")).toBeVisible();
    await expect(modelButton).toHaveText(modelLabel);
    await expect(permission).toHaveAttribute("title", permissionLabel);
    await expect(draft).toHaveValue("Keep this draft until I send it");
    await continueButton.scrollIntoViewIfNeeded();
    await continueButton.focus();
    await page.keyboard.press("f");
    const hint = popoverActionHintDialog(page).getByRole("button", { name: / — Continue with Codex$/ });
    await expect(hint).toBeVisible();
    await expect.poll(async () => {
      const control = await continueButton.boundingBox();
      const badge = await hint.boundingBox();
      return Math.abs(control.x + control.width - badge.x - badge.width);
    }).toBeLessThanOrEqual(1);
    const icon = await continueButton.locator("svg").boundingBox();
    const badge = await hint.boundingBox();
    expect(badge.x).toBeGreaterThan(icon.x + icon.width);
    if (managed) await captureReviewScreenshot(page, info, "handoff-action-hint");
    const code = await hint.getAttribute("data-action-hint-code");
    await page.keyboard.type(code.toLowerCase());
    const dialog = page.getByRole("dialog", { name: "Continue with another agent", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Only the selected model runs the preparation turn");
    await expect(dialog).toContainText(managed ? "This worktree moves to the new Task" : "The previous Task remains usable");
    const start = dialog.getByRole("button", { name: "Continue with selected agent", exact: true });
    await expect(start).toBeEnabled();
    await expect(dialog.locator(".task-model-button")).toContainText("5.6 Sol");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const restingBorder = await start.evaluate(element => getComputedStyle(element).borderTopColor);
    await start.focus();
    const focusedBorder = await start.evaluate(element => getComputedStyle(element).borderTopColor);
    expect(focusedBorder).not.toBe(restingBorder);
    await expect(start).toHaveCSS("outline-style", "none");
    await cancel.focus();
    await expect(cancel).toHaveCSS("border-top-color", focusedBorder);
    if (!info.project.use.hasTouch) {
      await start.hover();
      await expect(start).toHaveCSS("border-top-color", focusedBorder);
      await page.mouse.move(0, 0);
    }
    expect(await dialog.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
    const geometry = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const path = element.querySelector(".path");
      const footer = element.querySelector("footer").getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        pathOverflow: path.scrollWidth - path.clientWidth,
        footerBottom: footer.bottom,
      };
    });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.y).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(geometry.pathOverflow).toBeLessThanOrEqual(1);
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.bottom);
    await captureReviewScreenshot(page, info, managed ? "handoff-managed-dialog" : "handoff-directory-dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(modelButton).toBeFocused();
    await expect(draft).toHaveValue("Keep this draft until I send it");
    await expect(modelButton).toHaveText(modelLabel);
    await modelButton.click();
    await menu.getByRole("button", { name: "Codex", exact: true }).click();
    await continueButton.click();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page).toHaveURL(/\/tasks\/handoff-target$/);
    await expect.poll(() => submissions.length).toBe(1);
    expect(creations).toHaveLength(1);
    expect(creations[0].provider).toBe("codex");
    expect(submissions[0].url).toContain("/handoff-target/prompts");
    expect(submissions[0].body.prompt).toBe(prompt);
    expect(submissions.some(({ url }) => url.includes("handoff-source/prompts"))).toBe(false);
    await page.goto(`/tasks/${source.id}`);
    await emitTaskDetailBootstrap(page, sourceDetail);
    if (managed) {
      await expect(page.getByRole("status").filter({ hasText: "This worktree belongs to another Task" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open the current Task" })).toHaveAttribute("href", "/tasks/handoff-target");
      await expect(page.getByRole("textbox", { name: "Follow-up prompt" })).toBeDisabled();
      await captureReviewScreenshot(page, info, "handoff-source-history");
      await activateActionHint(page, /Open the current workspace owner/);
      await expect(page).toHaveURL(/\/tasks\/handoff-target$/);
    } else {
      await expect(page.getByRole("textbox", { name: "Follow-up prompt" })).toBeEnabled();
    }
  });
}

for (const unavailable of [true, false]) {
  test(`keeps the existing model-picker lock for ${unavailable ? "unavailable workspaces" : "active ordinary Tasks"}`, { tag: "@server-steady" }, async ({ page }) => {
    await installEventSourceMock(page, { autoOpen: true });
    await mockAgentModels(page);
    const source = {
      id: "locked-handoff", threadId: "locked-handoff", title: "Inspect the checkout",
      ...canonicalTaskState(unavailable ? "idle" : "active", { latestTurnStatus: unavailable ? "completed" : "inProgress" }),
      cwd: "src", cwdPath: "src", relativeCwd: "", conversationAvailable: true,
      worktree: null, createdMs: 100, updatedMs: 100, recencyMs: 100,
    };
    const detail = {
      provider: "codex", threadId: source.threadId, task: source,
      workspaceAccess: unavailable ? { mode: "unavailable", reason: "The workspace cannot be inspected." } : { mode: "readWrite" },
      syncState: "ready", revision: 1, eventRevision: 1,
      events: [], eventsPage: { nextCursor: null }, eventsRange: { from: null, to: null },
      pendingApprovals: [], historyLoading: false,
    };
    await page.route(/\/api\/tasks(?:\?|$)/, route => route.fulfill({ json: activeTaskProjection([source]) }));
    await page.route(/\/api\/tasks\/locked-handoff(?:\?|$)/, route => route.fulfill({ json: detail }));
    await page.goto(`/tasks/${source.id}`);
    await emitTaskDetailBootstrap(page, detail);
    await expect(page.locator(".task-follow-up-form").getByRole("button", { name: /^Choose model/ })).toBeDisabled();
    await page.getByRole("button", { name: /^Task details/ }).click();
    await expect(page.locator('[data-task-info-action="handoff"]')).toHaveCount(0);
  });
}

test("updates handoff availability while Archive is pending and after it fails", { tag: "@server-changes" }, async ({ page }) => {
  await installEventSourceMock(page, { autoOpen: true });
  await mockAgentModels(page);
  await page.route(/\/api\/agent\/models(?:\?|$)/, route => route.fulfill({ json: {
    models: [AGENT_MODELS_FIXTURE.models[0], { provider: "claude", model: "claude-model", displayName: "Claude model", isDefault: true, efforts: [], supportsFastMode: false }], unavailable: [],
  } }));
  const task = {
    id: "archive-handoff", threadId: "archive-handoff", title: "Retain the checkout",
    ...canonicalTaskState("idle", { latestTurnStatus: "completed" }),
    cwd: "src", cwdPath: "src", relativeCwd: "", conversationAvailable: true,
    worktree: null, createdMs: 100, updatedMs: 100, recencyMs: 100,
  };
  const detail = {
    provider: "codex", threadId: task.threadId, task, workspaceAccess: { mode: "readWrite" },
    syncState: "ready", revision: 1, eventRevision: 1,
    events: [], eventsPage: { nextCursor: null }, eventsRange: { from: null, to: null },
    pendingApprovals: [], historyLoading: false,
  };
  await page.route(/\/api\/tasks(?:\?|$)/, route => route.fulfill({ json: activeTaskProjection([task]) }));
  await page.route(/\/api\/tasks\/archive-handoff(?:\?|$)/, route => route.fulfill({ json: detail }));
  const pending = Promise.withResolvers();
  let requested = false;
  await page.route("**/api/tasks/archive-handoff/archive", async route => {
    requested = true;
    await pending.promise;
    await route.fulfill({ status: 409, json: { error: "Archive could not finish." } });
  });
  try {
    await page.goto(`/tasks/${task.id}`);
    await emitTaskDetailBootstrap(page, detail);
    const composer = page.locator(".task-follow-up-form");
    const trigger = composer.getByRole("button", { name: /^Choose model/ });
    const picker = composer.locator(".task-model-popover");
    await trigger.click();
    await expect(picker.getByRole("button", { name: "Claude", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Task details/ }).click();
    await page.getByRole("button", { name: "Archive task", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await trigger.click();
    await expect(picker.locator(".task-provider-option")).toHaveText(["Codex"]);
    pending.resolve();
    await expect(picker.getByRole("button", { name: "Claude", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(picker.getByRole("button", { name: "Continue with Claude", exact: true })).toBeVisible();
  } finally { pending.resolve(); }
});
