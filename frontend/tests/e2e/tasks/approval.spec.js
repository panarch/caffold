import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { canonicalTaskState, captureReviewScreenshot, stabilizeDynamicText } from "../support/task-fixtures.js";

for (const scopes of [[], ["allowForSession"], ["allowForSession", "allowAlways"]]) {
  test(`MCP approval displays ${scopes.length + 3} choices and submits the selected scope`, { tag: "@all-viewports" }, async ({ page }, testInfo) => {
    await installBrowserDefaults(page);
    await page.addInitScript(() => {
      localStorage.setItem("caffold:settings", JSON.stringify({
        interfaceScalePercent: 120, conversationTextPx: 20, codeTextPx: 20,
      }));
    });
    const scenario = await installTaskLoopFixture(page, { threadId: `thread_mcp_${scopes.length}` });
    await page.goto("/tasks");
    await page.evaluate(async (cwd) => {
      const response = await fetch("/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, titleSource: "Inspect the planner changes", model: "gpt-5.6-sol", effort: "xhigh" }),
      });
      if (!response.ok) throw new Error("Task seed failed");
    }, scenario.contextPath);
    const approvalId = 'mcp:"42"';
    const longValue = `https://example.com/${"long-document-path/".repeat(35)}`;
    const approval = scenario.eventRecord("mcp-approval", "approval_requested", "Read document", {
      approvalId, title: "Read document", reason: "Read the selected document and its comments for this review.",
      tool: {
        serverName: "documents-server", appName: "Documents", description: "Reads a document without modifying it.",
        arguments: [
          { name: "document_url", label: "Document", value: longValue },
          { name: "options", label: "Options", value: { comments: false, revision: null, sections: [1, 2] } },
        ],
      },
      decisions: ["allow", ...scopes, "deny", "cancel"],
    }, 5);
    scenario.events = [approval];
    scenario.updateTask(canonicalTaskState("active", { activeFlags: ["waitingOnApproval"] }));
    let submitted = null;
    let requestStarted;
    let releaseReply;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const released = new Promise((resolve) => { releaseReply = resolve; });
    await page.route(`**/api/tasks/${scenario.threadId}/approvals/**`, async (route) => {
      submitted = route.request().postDataJSON();
      expect(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1))).toBe(approvalId);
      requestStarted();
      await released;
      scenario.events = [scenario.eventRecord("mcp-resolved", "approval_resolved", "Approval answered", {
        approvalId, outcome: submitted.decision,
      }, 6)];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(scenario.detailResponse({ revision: 3 })) });
    });
    await page.goto(`/tasks/${scenario.threadId}`);
    const card = page.locator(".task-approval-card");
    const labels = ["Allow", ...scopes.map((scope) => scope === "allowForSession" ? "Allow for this session" : "Allow Always"), "Deny", "Cancel"];
    await expect(card.getByRole("button")).toHaveText(labels);
    await expect(card).toContainText("documents-server");
    await expect(card).toContainText("Documents");
    await expect(card).not.toContainText("Deny and Stop");
    const argument = card.getByLabel("Document", { exact: true });
    await expect(argument).toHaveText(JSON.stringify(longValue));
    await expect(card.getByLabel("Options", { exact: true })).toHaveText(JSON.stringify({ comments: false, revision: null, sections: [1, 2] }, null, 2));
    await argument.scrollIntoViewIfNeeded();
    await argument.focus();
    await argument.evaluate((node) => {
      window.__mcpScrollEnded = new Promise((resolve) => node.addEventListener("scrollend", () => resolve(true), { once: true }));
    });
    await argument.press("ArrowRight");
    await page.evaluate(() => window.__mcpScrollEnded);
    await expect.poll(() => argument.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const geometry = await card.evaluate((node) => {
      const parent = node.closest(".task-conversation-scroll").getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return {
        contained: box.left >= parent.left - 1 && box.right <= parent.right + 1,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        buttonsReadable: [...node.querySelectorAll("button")].every((button) => {
          const range = document.createRange(); range.selectNodeContents(button);
          const text = range.getBoundingClientRect(); const box = button.getBoundingClientRect();
          return text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom;
        }),
      };
    });
    expect(geometry).toEqual({ contained: true, overflow: false, buttonsReadable: true });
    // Equivalent projection keeps DOM-owned horizontal scroll, text selection,
    // and focus intact, even when an independent detail refresh arrives.
    await argument.evaluate((node) => {
      node.scrollLeft = 80;
      const range = document.createRange(); range.selectNodeContents(node.querySelector("code"));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.__mcpArgument = node;
    });
    await expect.poll(() => page.evaluate((threadId) => Boolean(window.__caffoldTaskSse?.source(threadId)), scenario.threadId)).toBe(true);
    await page.evaluate((detail) => {
      window.__caffoldTaskSse.source(detail.threadId).emit("task-sync", {
        threadId: detail.threadId, revision: detail.revision, detail, reason: "canonical-sync",
      });
    }, scenario.detailResponse({ revision: 2 }));
    await expect(argument).toBeFocused();
    expect(await argument.evaluate((node) => node === window.__mcpArgument && node.scrollLeft === 80)).toBe(true);
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(JSON.stringify(longValue));
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, `mcp-approval-${scopes.length + 3}-choices`);
    const choice = card.getByRole("button", { name: scopes.length ? "Allow for this session" : "Cancel", exact: true });
    await choice.scrollIntoViewIfNeeded();
    await captureReviewScreenshot(page, testInfo, `mcp-approval-${scopes.length + 3}-actions`);
    await choice.focus();
    await choice.press("Enter");
    await started;
    expect(submitted).toEqual({ decision: scopes.length ? "allowForSession" : "cancel" });
    releaseReply();
    await expect(card).toHaveCount(0);
    expect(scenario.pageErrors).toEqual([]);
  });
}

test("approval owner retains native state through refresh, errors, and lifecycle changes", { tag: "@desktop" }, async ({ page }) => {
  await installBrowserDefaults(page);
  const scenario = await installTaskLoopFixture(page, { threadId: "thread_approval_owner" });
  await page.goto("/tasks");
  await page.evaluate(async (cwd) => {
    const response = await fetch("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, titleSource: "Inspect the planner changes", model: "gpt-5.6-sol", effort: "xhigh" }),
    });
    if (!response.ok) throw new Error("Task seed failed");
  }, scenario.contextPath);
  const approval = scenario.eventRecord("approval-owner", "approval_requested", "Read document", {
    approvalId: "approval-owner", title: "Read document",
    tool: { serverName: "documents", arguments: [{ name: "url", label: "Document", value: "https://example.com/" + "long-path/".repeat(60) }] },
    decisions: ["allow", "deny", "cancel"],
  }, 5);
  scenario.events = [approval];
  scenario.updateTask(canonicalTaskState("active", { activeFlags: ["waitingOnApproval"] }));
  let requests = 0;
  await page.route(`**/api/tasks/${scenario.threadId}/approvals/**`, (route) => {
    requests += 1;
    return route.fulfill({ status: 409, json: { error: { code: "approval_failed", message: "Approval reply failed." } } });
  });
  await page.goto(`/tasks/${scenario.threadId}`);
  const owner = page.locator("caffold-task-approval");
  const argument = owner.getByLabel("Document", { exact: true });
  await expect(owner.getByRole("button")).toHaveCount(3);
  await argument.scrollIntoViewIfNeeded();

  // The leaf's public scroll provider participates in the workspace keyboard mode.
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("s");
  // This fixture has only one scrollable surface, so Scroll mode enters it directly.
  await expect(page.locator("caffold-app-shell > caffold-keyboard-navigation-presentation > caffold-scroll-mode-hud .scroll-mode-status")).toContainText("Scroll: Document");
  const before = await argument.evaluate((node) => node.scrollLeft);
  await page.keyboard.press("l");
  await expect.poll(() => argument.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before);
  await page.keyboard.press("Escape");

  // Trigger the actual Task HTTP owner through the card's keyboard action intent.
  await owner.getByRole("button", { name: "Allow", exact: true }).scrollIntoViewIfNeeded();
  await activateActionHint(page, /Allow$/);
  await expect(owner.getByRole("alert")).toHaveText("Approval reply failed.");
  expect(requests).toBe(1);
  await argument.focus();
  await argument.evaluate((node) => {
    node.scrollLeft = 80;
    const range = document.createRange(); range.selectNodeContents(node.querySelector("code"));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    window.__approvalNode = node;
    window.__approvalOwner = node.closest("caffold-task-approval");
  });
  scenario.events = [approval, scenario.eventRecord("independent-message", "assistant_message", "Still inspecting", {
    text: "Still inspecting", phase: "commentary", itemId: "independent-message",
  }, 6)];
  await page.evaluate((detail) => {
    window.__caffoldTaskSse.source(detail.threadId).emit("task-sync", {
      threadId: detail.threadId, revision: detail.revision, detail, reason: "canonical-sync",
    });
  }, scenario.detailResponse({ revision: 2 }));
  await expect(page.locator("caffold-task-conversation")).toContainText("Still inspecting");
  await expect(owner.getByRole("alert")).toHaveText("Approval reply failed.");
  await expect(argument).toBeFocused();
  expect(await argument.evaluate((node) => node === window.__approvalNode && node.scrollLeft === 80)).toBe(true);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(JSON.stringify(approval.payload.tool.arguments[0].value));

  // Exercise the same public lifecycle boundary used by Task transport and activation.
  await page.locator("caffold-task-conversation").evaluate((conversation) => {
    window.__approvalTargets = conversation.actionHintScope().targets.filter((target) => target.invalidationOwner === window.__approvalOwner);
    conversation.setSnapshot({ ...conversation.snapshot, transportState: "reconnecting" });
  });
  await expect(owner.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__approvalTargets.length)).toBe(3);
  expect(await page.evaluate(() => window.__approvalTargets.every((target) => !target.isActionable()))).toBe(true);
  expect(await argument.evaluate((node) => node === window.__approvalNode && node.scrollLeft === 80)).toBe(true);
  await page.locator("caffold-task-conversation").evaluate((conversation) => {
    conversation.setSnapshot({ ...conversation.snapshot, transportState: "live" });
    conversation.setActive(false);
  });
  await expect(owner.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  await page.locator("caffold-task-conversation").evaluate((conversation) => conversation.setActive(true));
  await expect(owner.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();

  // A different Task may reuse a provider request ID; its local error and DOM
  // must belong to the new Task, and retained old keyboard actions must expire.
  await page.locator("caffold-task-conversation").evaluate((conversation) => {
    window.__approvalTargets = conversation.actionHintScope().targets.filter((target) => target.invalidationOwner === window.__approvalOwner);
    conversation.setSnapshot({ ...conversation.snapshot, threadId: "different-task" });
  });
  await expect(owner.getByRole("alert")).toBeHidden();
  expect(await owner.evaluate((node) => node !== window.__approvalOwner)).toBe(true);
  expect(await page.evaluate(() => window.__approvalTargets.every((target) => !target.isActionable()))).toBe(true);
  await page.locator("caffold-task-conversation").evaluate((conversation) => conversation.setSnapshot({ ...conversation.snapshot, events: [] }));
  await expect(owner).toHaveCount(0);
  expect(scenario.pageErrors).toEqual([]);
});

test("renders permission and network approvals without clipping at appearance extremes", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installBrowserDefaults(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:settings",
      JSON.stringify({
        themeMode: "system",
        typefacePreset: "d2-coding",
        interfaceScalePercent: 120,
        conversationTextPx: 20,
        codeTextPx: 20,
        fileSortMode: "folders-first",
      }),
    );
  });
  const scenario = await installTaskLoopFixture(page, {
    threadId: "thread_permission_card",
  });
  await page.goto("/tasks");
  await page.evaluate(async ({ contextPath, threadId }) => {
    const created = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: contextPath,
        titleSource: "Inspect the planner changes",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        permissionMode: "approveForMe",
      }),
    });
    if (!created.ok) {
      throw new Error(`task seed failed: ${created.status}`);
    }
    const prompted = await fetch(`/api/tasks/${threadId}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Inspect the planner changes",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        permissionMode: "approveForMe",
        activeTurnId: null,
        images: [
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ],
      }),
    });
    if (!prompted.ok) {
      throw new Error(`task prompt seed failed: ${prompted.status}`);
    }
  }, { contextPath: scenario.contextPath, threadId: scenario.threadId });

  const longRoot =
    "/Users/taehoon/Library/Application Support/Caffold/data/worktrees/permission-review/fixtures/generated/release-metadata";
  scenario.events = scenario.events
    .filter((event) => event.type !== "approval_requested")
    .concat([
      scenario.eventRecord(
        "event_permission",
        "approval_requested",
        "Permission approval requested",
        {
          approvalId: "permission_1",
          turnId: "turn_1",
          itemId: "permission_item_1",
          title: "Permission requested",
          reason:
            "Download release metadata, inspect the generated cache, and update the shared fixture used by the complete review workflow.",
          cwd: longRoot,
          permissions: [
            { label: "Network", value: "Outbound access", verbatim: false },
            {
              label: "File system · Write",
              value: `${longRoot}/nested/path/with-a-deliberately-long-directory-name/cache.json`,
              verbatim: true,
            },
            {
              label: "File system · Read",
              value: `${longRoot}/**/release-*.json`,
              verbatim: true,
            },
          ],
          decisions: ["allow", "allowForSession", "deny"],
        },
        5,
      ),
      scenario.eventRecord(
        "event_network_approval",
        "approval_requested",
        "Network approval requested",
        {
          approvalId: "network_1",
          title: "Network access requested",
          reason: "Connect to the release API to verify the current artifact metadata.",
          cwd: longRoot,
          networkEndpoint: "https://api.github.com",
          permissions: [
            { label: "Network", value: "Outbound access", verbatim: false },
          ],
          decisions: ["allow", "allowForSession", "deny"],
        },
        6,
      ),
      scenario.eventRecord(
        "event_long_command_approval",
        "approval_requested",
        "Command approval requested",
        {
          approvalId: "command_1",
          title: "Command approval requested",
          reason: "Run the complete permission regression suite.",
          command: `cargo test --manifest-path ${longRoot}/workspace/Cargo.toml --package permission-contract-with-an-intentionally-long-unbroken-package-name`,
          cwd: longRoot,
          decisions: ["allow", "deny"],
        },
        7,
      ),
    ]);
  scenario.updateTask({ lastEventSummary: "Permission approval requested" });
  let permissionBody = null;
  await page.route(
    `**/api/tasks/${scenario.threadId}/approvals/permission_1`,
    async (route) => {
      permissionBody = route.request().postDataJSON();
      scenario.events = [
        ...scenario.events.filter(
          (event) => event.payload?.approvalId !== "permission_1",
        ),
        scenario.eventRecord(
          "event_permission_resolved",
          "approval_resolved",
          "Approval resolved: allow",
          {
            approvalId: "permission_1",
            outcome: "allowForSession",
            turnId: "turn_1",
          },
          8,
        ),
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(scenario.detailResponse()),
      });
    },
  );

  await page.goto(`/tasks/${scenario.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const permissionCard = tasksPage.locator(
    '.task-approval-card:has-text("Permission requested")',
  );
  const networkCard = tasksPage.locator(
    '.task-approval-card:has-text("Network access requested")',
  );
  const commandCard = tasksPage.locator(".task-approval-card:has(pre)");
  await expect(permissionCard).toBeVisible();
  await expect(networkCard).toContainText("https://api.github.com");
  await expect(networkCard).not.toContainText("command unavailable");
  await expect(permissionCard.getByRole("button")).toHaveText([
    "Allow",
    "Allow for this session",
    "Deny",
  ]);
  const interfaceFontSize = await page.evaluate(
    () => getComputedStyle(document.documentElement).fontSize,
  );
  await expect(permissionCard.locator("h3")).toHaveCSS(
    "font-size",
    interfaceFontSize,
  );
  await expect(permissionCard.locator(".task-approval-reason")).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(permissionCard.locator("code").first()).toHaveCSS(
    "font-size",
    "20px",
  );

  const layout = await tasksPage.evaluate((tasks) => {
    const flow = tasks.querySelector(".task-approval-flow");
    const permission = tasks.querySelector(".task-approval-card");
    const actions = permission.querySelector(".task-approval-actions");
    const scroller = tasks.querySelector(".task-conversation-scroll");
    const command = tasks.querySelector(".task-approval-card pre");
    const contained = (child, parent) => {
      const childBox = child.getBoundingClientRect();
      const parentBox = parent.getBoundingClientRect();
      return (
        childBox.left >= parentBox.left - 0.5 &&
        childBox.right <= parentBox.right + 0.5
      );
    };
    const style = getComputedStyle(actions);
    return {
      actionColumns:
        style.display === "grid"
          ? style.gridTemplateColumns.split(" ").filter(Boolean).length
          : 0,
      cardsContained: [...tasks.querySelectorAll(".task-approval-card")].every(
        (card) => contained(card, scroller),
      ),
      commandContained: contained(command, command.closest(".task-approval-card")),
      commandScrolls: command.scrollWidth > command.clientWidth,
      documentOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      flowWidth: flow.getBoundingClientRect().width,
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
    };
  });
  expect(layout.cardsContained).toBe(true);
  expect(layout.commandContained).toBe(true);
  expect(layout.commandScrolls).toBe(true);
  expect(layout.documentOverflow).toBe(false);
  if (layout.flowWidth <= 22 * layout.rootFontSize) {
    expect(layout.actionColumns).toBe(1);
  } else if (layout.flowWidth <= 34 * layout.rootFontSize) {
    expect(layout.actionColumns).toBe(2);
  } else {
    expect(layout.actionColumns).toBe(0);
  }

  await permissionCard.evaluate((card) => card.scrollIntoView({ block: "start" }));
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-permission-approval-responsive",
  );
  await permissionCard.getByRole("button", { name: "Allow for this session" }).click();
  await expect(permissionCard).toHaveCount(0);
  expect(permissionBody).toEqual({ decision: "allowForSession" });
  expect(scenario.pageErrors).toEqual([]);
});
