import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { installTaskReviewFixture } from "../support/task-review-fixture.js";
import {
  actionHintDialog,
  activateActionHint,
  enterActionHints,
} from "../support/action-hints.js";
import {
  captureReviewScreenshot,
  stabilizeDynamicText,
} from "../support/task-fixtures.js";

async function revealActionHintControl(control) {
  await control.scrollIntoViewIfNeeded();
  await control.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("renders permission and network approvals without clipping at appearance extremes", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
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
          decisions: ["allow", "allowAlways", "deny"],
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
          decisions: ["allow", "allowAlways", "deny"],
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
            outcome: "allowAlways",
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
    "Allow Always",
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
  await permissionCard.getByRole("button", { name: "Allow Always" }).click();
  await expect(permissionCard).toHaveCount(0);
  expect(permissionBody).toEqual({ decision: "allowAlways" });
  expect(scenario.pageErrors).toEqual([]);
});

test("opens resolved Markdown file links through Task Review with native link semantics", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  const absoluteTarget = "/Users/taehoon/Workspace/rust/codger/src/planner.rs:60";
  const localLinks = [
    resolvedLink("Planner line", absoluteTarget, "planner.rs", 60),
    resolvedLink("Planner duplicate", absoluteTarget, "planner.rs", 60),
    resolvedLink(
      "Screenshot path",
      "/Users/taehoon/Library/Application Support/Caffold/data/worktrees/example/docs/review/policy.md:22",
      "planner.rs",
      22,
    ),
    resolvedLink("Column", "src/planner.rs:60:5", "planner.rs", 60),
    resolvedLink("Range", "src/planner.rs:60-70", "planner.rs", 60),
    resolvedLink("Hash range", "src/planner.rs#L60-L70", "planner.rs", 60),
    resolvedLink(
      "File URL",
      "file:///Users/taehoon/Workspace/rust/codger/src/planner.rs#L60",
      "planner.rs",
      60,
    ),
    resolvedLink("Encoded space", "src/space%20name.rs#L60", "space name.rs", 60),
    resolvedLink(
      "Parentheses Unicode",
      "src/괄호 (초안).rs#L60",
      "괄호 (초안).rs",
      60,
    ),
    resolvedLink("Literal hash filename", "notes#L12", "notes#L12"),
    resolvedLink("Outside Task", "../README.md", "../README.md"),
    resolvedLink("Deleted after render", "delta.rs", "delta.rs"),
    rejectedLink(
      "Malformed location",
      "bad.rs:0",
      "unsupported_or_malformed_location",
    ),
    rejectedLink("Missing file", "missing.rs", "not_found"),
    rejectedLink("Directory target", "directory", "not_regular_readable_file"),
    rejectedLink("Outside root", "../../secret.txt", "outside_root"),
  ];
  const completedAssistantResponse = [
    ...localLinks.map((link) => projectedLinkMarkdown(link)),
    "[External](https://example.com/docs)",
    "[Mail](mailto:reviewer@example.com)",
    "[Section](#review-ready)",
    "[Settings](/settings)",
  ].join("\n\n");
  await installTaskReviewFixture(page);
  const resolverRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/file-links/resolve")) {
      resolverRequests.push(request.url());
    }
  });
  const fileLinks = ["item-10", "event_11_duplicate"].flatMap((eventId) =>
    projectedFileLinks(eventId, localLinks),
  );
  const scenario = await installTaskLoopFixture(page, {
    completedAssistantResponse,
    fileLinks,
    threadId: "thread_local_file_links",
  });
  let deleteResolvedFile = false;
  await page.route(/\/api\/file(?:\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (!deleteResolvedFile || url.searchParams.get("path") !== "src/delta.rs") {
      return route.fallback();
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "path_not_found",
          message: "The selected file is no longer available.",
        },
      }),
    });
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const markdown = page.locator(
    '.task-assistant-message caffold-task-markdown',
  ).filter({ hasText: "Planner line" });
  await expect(markdown).toHaveAttribute("data-render-state", "markdown");
  const planner = markdown.getByRole("link", { name: "Planner line" });
  const outside = markdown.getByRole("link", { name: "Outside Task" });
  const deleted = markdown.getByRole("link", { name: "Deleted after render" });
  await expect(planner).toHaveAttribute(
    "href",
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=planner.rs&line=60`,
  );
  await expect(planner).not.toHaveAttribute("target", /.+/);
  for (const { label, line } of localLinks.filter(
    (link) => link.status === "resolved" && link.taskRelativePath === "planner.rs",
  )) {
    await expect(markdown.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "href",
      `/tasks/${scenario.threadId}/review?nav=files&view=source&file=planner.rs${line ? `&line=${line}` : ""}`,
    );
  }
  await expect(outside).toHaveAttribute(
    "href",
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=..%2FREADME.md`,
  );
  await expect(
    markdown.getByRole("link", { name: "Literal hash filename" }),
  ).toHaveAttribute(
    "href",
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=notes%23L12`,
  );
  await expect(markdown.getByRole("link", { name: "Encoded space" })).toHaveAttribute(
    "href",
    reviewRoute(scenario.threadId, "space name.rs", 60),
  );
  await expect(
    markdown.getByRole("link", { name: "Parentheses Unicode" }),
  ).toHaveAttribute(
    "href",
    reviewRoute(scenario.threadId, "괄호 (초안).rs", 60),
  );
  for (const { label } of localLinks.filter(
    (link) => link.status === "rejected",
  )) {
    await expect(markdown.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    await expect(markdown).toContainText(label);
  }
  await expect(markdown.getByRole("link", { name: "External" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(markdown.getByRole("link", { name: "Mail" })).toHaveAttribute(
    "href",
    "mailto:reviewer@example.com",
  );
  await expect(markdown.getByRole("link", { name: "Section" })).toHaveAttribute(
    "href",
    "#review-ready",
  );
  await expect(markdown.getByRole("link", { name: "Settings" })).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(resolverRequests).toEqual([]);

  await markdown.evaluate((element) => {
    element.dataset.reconnectProbe = "preserved";
  });
  await page.locator("caffold-task-conversation").evaluate((conversation) => {
    conversation.setSnapshot({
      ...conversation.snapshot,
      transportState: "reconnecting",
    });
  });
  await expect(markdown).toHaveAttribute("data-reconnect-probe", "preserved");
  await expect(markdown).toHaveAttribute("data-render-state", "markdown");
  await expect(markdown.locator(".markdown-fallback")).toHaveCount(0);

  const liveLink = resolvedLink("Live file", "live.rs:9", "live.rs", 9);
  const liveFileLinks = projectedFileLinks("event_live_file_link", [liveLink]);
  const liveMarkdownSource = projectedLinkMarkdown(liveLink);
  await page.evaluate(({ threadId, liveFileLinks, liveMarkdownSource }) => {
    const source = window.__caffoldMockEventSources.find((candidate) =>
      candidate.url.includes(`/api/tasks/${threadId}/stream`),
    );
    source.emit("task-event", {
      threadId,
      revision: 2,
      eventRevision: 2,
      event: {
        id: "event_live_file_link",
        threadId,
        type: "assistant_message",
        summary: "Live assistant response",
        payload: {
          phase: "final",
          text: liveMarkdownSource,
        },
        position: { anchorMs: Date.now(), index: 0 },
      },
      fileLinks: liveFileLinks,
    });
  }, { threadId: scenario.threadId, liveFileLinks, liveMarkdownSource });
  await expect(markdown).toHaveAttribute("data-reconnect-probe", "preserved");
  const liveMarkdown = page.locator(
    '.task-assistant-message caffold-task-markdown',
  ).filter({ hasText: "Live file" });
  await expect(liveMarkdown.getByRole("link", { name: "Live file" })).toHaveAttribute(
    "href",
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=live.rs&line=9`,
  );
  expect(resolverRequests).toEqual([]);

  if (testInfo.project.name === "desktop") {
    const popupPromise = context.waitForEvent("page");
    await planner.click({ modifiers: ["ControlOrMeta"] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(
      `/tasks/${scenario.threadId}/review?nav=files&view=source&file=planner.rs&line=60`,
    );
    await popup.close();
  }

  await revealActionHintControl(planner);
  await activateActionHint(page, /Open Planner line$/);
  await expect(page).toHaveURL(
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=planner.rs&line=60`,
  );
  const review = page.locator("caffold-task-review");
  const fileNavigator = review.locator("caffold-file-navigator");
  const viewer = review.locator("caffold-review-file-viewer");
  await expect(viewer).toContainText("pub fn plan");
  await expect
    .poll(() => viewer.evaluate(sourceLineIsVisible, 60))
    .toBe(true);
  await expect(
    fileNavigator.locator('button[data-file-tree-path="src/planner.rs"]'),
  ).toHaveAttribute("aria-current", "true");

  await page.reload();
  await expect(page).toHaveURL(
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=planner.rs&line=60`,
  );
  await expect
    .poll(() => viewer.evaluate(sourceLineIsVisible, 60))
    .toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);

  await outside.click();
  await expect(page).toHaveURL(
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=..%2FREADME.md`,
  );
  await expect(
    fileNavigator.locator('button[data-file-tree-path="README.md"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(viewer).toContainText("Fixture Home");

  await page.goBack();
  await expect(page).toHaveURL(`/tasks/${scenario.threadId}`);
  deleteResolvedFile = true;
  await deleted.click();
  await expect(page).toHaveURL(
    `/tasks/${scenario.threadId}/review?nav=files&view=source&file=delta.rs`,
  );
  await expect(viewer.locator(".error-panel")).toContainText(
    "The selected file is no longer available.",
  );
});

test("owns final Markdown links without guessing fragments or stale bindings", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  const wideCell = "wide".repeat(90);
  const markdownSource = [
    "[External docs](https://example.com/action-hint-external)",
    "",
    "[Duplicate](https://example.com/duplicate) [Duplicate](https://example.com/duplicate)",
    "",
    "[A deliberately long reference label that wraps inside narrow conversation panes](https://example.com/long-label)",
    "",
    "[Mail](mailto:reviewer@example.com)",
    "",
    "[Settings](/settings?from=hint#keyboard)",
    "",
    "[Section](#review-ready)",
    "",
    '<a href="https://example.com/unnamed"></a>',
    "",
    '<a href="https://example.com/title-only" title="Title-only destination"></a>',
    "",
    "| Destination | Wide value |",
    "| --- | --- |",
    `| [Table docs](https://example.com/table) | ${wideCell} |`,
  ].join("\n");
  const scenario = await installTaskLoopFixture(page, {
    completedAssistantResponse: markdownSource,
    threadId: "thread_action_hint_markdown_links",
  });
  await context.route("https://example.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Action Hint destination</title>",
    }),
  );
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const markdown = page.locator(
    ".task-assistant-message caffold-task-markdown",
  ).filter({ hasText: "External docs" });
  await expect(markdown).toHaveAttribute("data-render-state", "markdown");
  const linkTargets = await page.locator("caffold-task-workspace").evaluate(
    (workspace) => workspace.actionHintScope().targets
      .filter((target) => target.controlKind === "link")
      .map(({ id, label }) => ({ id, label })),
  );
  const duplicateTargets = linkTargets.filter(
    ({ label }) => label === "Open Duplicate in a new tab",
  );
  expect(duplicateTargets).toHaveLength(2);
  expect(new Set(duplicateTargets.map(({ id }) => id)).size).toBe(2);
  expect(linkTargets.some(({ label }) => label.includes("Section"))).toBe(false);
  expect(linkTargets.some(({ label }) => label.includes("unnamed"))).toBe(false);
  expect(linkTargets.some(
    ({ label }) => label === "Open Settings in a new tab",
  )).toBe(true);
  expect(linkTargets.some(
    ({ label }) => label === "Open Title-only destination in a new tab",
  )).toBe(true);
  expect(linkTargets.every(
    ({ id }) => !id.includes("http") && !id.includes("mailto"),
  )).toBe(true);

  const external = markdown.locator(
    'a[href="https://example.com/action-hint-external"]',
  );
  await revealActionHintControl(external);
  let hint = await enterActionHints(page);
  let badge = hint.getByLabel(/Open External docs in a new tab$/);
  await expect(badge).toBeVisible();
  await expect(hint.getByLabel(/ — Open Working Tree$/)).toBeVisible();
  await expect(
    hint.getByLabel(/ — Expand (?:Worked for|Work details)/),
  ).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "tasks-action-hint-links");
  const externalCode = await badge.getAttribute("data-action-hint-code");
  await external.evaluate((link) => {
    link.setAttribute("aria-label", "External docs renamed");
  });
  badge = hint.locator(`[data-action-hint-code="${externalCode}"]`);
  await expect(badge).toHaveAttribute(
    "aria-label",
    `${externalCode} — Open External docs renamed in a new tab`,
  );
  const externalPopupPromise = page.waitForEvent("popup");
  await page.keyboard.type(externalCode.toLowerCase());
  const externalPopup = await externalPopupPromise;
  await expect(externalPopup).toHaveURL(
    "https://example.com/action-hint-external",
  );
  await externalPopup.close();
  await external.evaluate((link) => {
    link.removeAttribute("aria-label");
  });

  const mail = markdown.getByRole("link", { name: "Mail" });
  await mail.evaluate((link) => {
    window.__caffoldMailHintClicks = 0;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.__caffoldMailHintClicks += 1;
    });
  });
  await revealActionHintControl(mail);
  await activateActionHint(page, /Open Mail in an email app$/);
  await expect.poll(() => page.evaluate(
    () => window.__caffoldMailHintClicks,
  )).toBe(1);

  const settings = markdown.getByRole("link", { name: "Settings" });
  await revealActionHintControl(settings);
  const settingsPopupPromise = page.waitForEvent("popup");
  await activateActionHint(page, /Open Settings in a new tab$/);
  const settingsPopup = await settingsPopupPromise;
  await expect(settingsPopup).toHaveURL(/\/settings\?from=hint#keyboard$/);
  await settingsPopup.close();

  const duplicates = markdown.getByRole("link", {
    name: "Duplicate",
    exact: true,
  });
  await revealActionHintControl(duplicates.first());
  hint = await enterActionHints(page);
  const duplicateBadges = hint.getByLabel(/Open Duplicate in a new tab$/);
  await expect(duplicateBadges).toHaveCount(2);
  const duplicateCodes = await duplicateBadges.evaluateAll((badges) =>
    badges.map((entry) => entry.dataset.actionHintCode)
  );
  expect(new Set(duplicateCodes).size).toBe(2);
  await page.keyboard.press("Escape");

  await revealActionHintControl(external);
  await enterActionHints(page);
  await external.evaluate((link) => {
    link.setAttribute("href", "https://example.com/changed-after-snapshot");
  });
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(page.locator("caffold-task-workspace")).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await markdown.getByRole("link", { name: "External docs" }).evaluate((link) => {
    link.setAttribute("href", "https://example.com/action-hint-external");
  });

  await revealActionHintControl(external);
  await enterActionHints(page);
  await markdown.evaluate((element, source) => element.setMarkdown(source), markdownSource);
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(page.locator("caffold-task-workspace")).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  await expect(markdown).toHaveAttribute("data-render-state", "markdown");

  const tableScroll = markdown.locator(".markdown-table-scroll");
  const tableLink = tableScroll.getByRole("link", { name: "Table docs" });
  await revealActionHintControl(tableScroll);
  await expect(tableLink).toHaveAttribute("target", "_blank");
  await expect.poll(() => tableScroll.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  )).toBe(true);
  hint = await enterActionHints(page);
  await expect(hint.getByLabel(/Open Table docs in a new tab$/)).toBeVisible();
  await tableScroll.evaluate((element) => {
    element.scrollLeft = Math.min(80, element.scrollWidth - element.clientWidth);
  });
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(page.locator("caffold-task-workspace")).toHaveAttribute(
    "data-action-hint-last-exit",
    "scroll",
  );

  await tableScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  });
  hint = await enterActionHints(page);
  await expect(hint.getByLabel(/Open Table docs in a new tab$/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await tableScroll.evaluate((element) => {
    element.scrollLeft = 0;
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  });
  hint = await enterActionHints(page);
  await expect(hint.getByLabel(/Open Table docs in a new tab$/)).toBeVisible();
  await page.keyboard.press("Escape");
});

function resolvedLink(label, target, taskRelativePath, line = null) {
  return {
    label,
    authoredTarget: target,
    target: canonicalTarget(taskRelativePath, line),
    status: "resolved",
    path: `src/${taskRelativePath}`,
    taskRelativePath,
    ...(line ? { line } : {}),
  };
}

function rejectedLink(label, target, reason) {
  return { label, target, status: "rejected", reason };
}

function projectedLinkMarkdown(link) {
  return link.status === "resolved"
    ? `[${link.label}](${link.target})`
    : link.label;
}

function projectedFileLinks(eventId, links) {
  return links.map((link, linkId) => ({
      eventId,
      linkId,
      target: link.target,
      status: link.status,
      ...(link.status === "resolved"
        ? {
            path: link.path,
            taskRelativePath: link.taskRelativePath,
            ...(link.line ? { line: link.line } : {}),
          }
        : { reason: link.reason }),
    }));
}

function canonicalTarget(path, line) {
  const encodedPath = path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `${encodedPath}${line ? `#L${line}` : ""}`;
}

function reviewRoute(threadId, path, line = null) {
  const query = new URLSearchParams({ nav: "files", view: "source", file: path });
  if (line) {
    query.set("line", `${line}`);
  }
  return `/tasks/${threadId}/review?${query}`;
}

function sourceLineIsVisible(viewer, line) {
  const scroller = viewer.querySelector(".code-lines");
  const row = viewer.querySelector(`.code-row[data-line-number="${line}"]`);
  if (!scroller || !row) {
    return false;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.top >= scrollerRect.top && rowRect.bottom <= scrollerRect.bottom;
}

test("preserves ordered-list starts through Task Markdown sanitization", { tag: "@all-viewports" }, async ({ page }) => {
  const completedAssistantResponse = [
    "1. First",
    "",
    "- detail",
    "",
    "2. Second",
    "",
    "- detail",
    "",
    "3. Third",
  ].join("\n");
  const scenario = await installTaskLoopFixture(page, {
    completedAssistantResponse,
    threadId: "thread_ordered_list_starts",
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const assistantMarkdown = tasksPage.locator(
    '.task-assistant-message caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("ol")).toHaveCount(3);
  await expect(assistantMarkdown.locator("ul")).toHaveCount(2);
  expect(
    await assistantMarkdown.locator("ol").evaluateAll((lists) =>
      lists.map((list) => ({
        effectiveStart: list.start,
        start: list.getAttribute("start"),
        text: list.textContent.trim(),
      })),
    ),
  ).toEqual([
    { effectiveStart: 1, start: null, text: "First" },
    { effectiveStart: 2, start: "2", text: "Second" },
    { effectiveStart: 3, start: "3", text: "Third" },
  ]);

  await tasksPage.evaluate(() => {
    const probes = [
      {
        id: "fifth",
        markdown: "5. Fifth",
      },
      {
        id: "attributes",
        markdown: [
          '<ol start="7" class="discard" data-extra="discard" onclick="discard()"><li id="discard">Valid</li></ol>',
          "",
          '<ol start="not-an-integer"><li>Malformed</li></ol>',
          "",
          '<ol start="+8"><li>Plus-prefixed</li></ol>',
          "",
          '<ol start=" 9"><li>Whitespace-prefixed</li></ol>',
          "",
          '<ol start="-2" aria-label="discard"><li>Negative</li></ol>',
          "",
          '<ul start="4" data-extra="discard"><li>Wrong element</li></ul>',
        ].join("\n"),
      },
      {
        id: "list-features",
        markdown: [
          "1. One",
          "2. Two",
          "",
          "- Parent",
          "  - Nested detail",
          "",
          "- [x] Complete",
          "- [ ] Pending",
        ].join("\n"),
      },
    ];

    for (const { id, markdown } of probes) {
      const probe = document.createElement("caffold-task-markdown");
      probe.dataset.testProbe = id;
      probe.hidden = true;
      probe.textContent = markdown;
      document.body.append(probe);
    }
  });

  const fifth = page.locator('caffold-task-markdown[data-test-probe="fifth"]');
  await expect(fifth).toHaveAttribute("data-render-state", "markdown");
  await expect(fifth.locator("ol")).toHaveAttribute("start", "5");
  expect(await fifth.locator("ol").evaluate((list) => list.start)).toBe(5);

  const attributes = page.locator('caffold-task-markdown[data-test-probe="attributes"]');
  await expect(attributes).toHaveAttribute("data-render-state", "markdown");
  expect(
    await attributes.locator("ol").evaluateAll((lists) =>
      lists.map((list) => ({
        attributes: [...list.attributes].map((attribute) => attribute.name).sort(),
        effectiveStart: list.start,
        itemAttributes: [...list.querySelector("li").attributes].map(
          (attribute) => attribute.name,
        ),
        start: list.getAttribute("start"),
      })),
    ),
  ).toEqual([
    { attributes: ["start"], effectiveStart: 7, itemAttributes: [], start: "7" },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: [], effectiveStart: 1, itemAttributes: [], start: null },
    { attributes: ["start"], effectiveStart: -2, itemAttributes: [], start: "-2" },
  ]);
  expect(
    await attributes.locator("ul").evaluate((list) =>
      [...list.attributes].map((attribute) => attribute.name),
    ),
  ).toEqual([]);

  const listFeatures = page.locator(
    'caffold-task-markdown[data-test-probe="list-features"]',
  );
  await expect(listFeatures).toHaveAttribute("data-render-state", "markdown");
  await expect(listFeatures.locator("ol > li")).toHaveCount(2);
  expect(await listFeatures.locator("ol").evaluate((list) => list.start)).toBe(1);
  await expect(listFeatures.locator("ul ul > li")).toHaveText("Nested detail");
  const checkboxes = listFeatures.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.first()).toBeChecked();
  await expect(checkboxes.last()).not.toBeChecked();
  await expect(checkboxes.first()).toBeDisabled();
  await expect(checkboxes.last()).toBeDisabled();
});

test("names the work an agent did that Caffold draws no surface for", { tag: "@all-viewports" }, async ({
  page,
}) => {
  const scenario = await installTaskLoopFixture(page, {
    threadId: "019fd747-1247-7bb0-998b-9aec53bdf7f3",
  });
  await scenario.seedCompletedTask();
  scenario.events = scenario.events.concat([
    scenario.eventRecord(
      "event_web_search",
      "tool_call",
      "web_search: completed",
      {
        threadId: scenario.threadId,
        turnId: "turn_1",
        itemId: "tool_web_search",
        name: "web_search",
        status: "completed",
      },
      20,
    ),
    scenario.eventRecord(
      "event_mcp_probe",
      "tool_call",
      "inspector.probe: failed",
      {
        threadId: scenario.threadId,
        turnId: "turn_1",
        itemId: "tool_mcp_probe",
        name: "inspector.probe",
        status: "failed",
      },
      21,
    ),
  ]);

  await page.goto(`/tasks/${scenario.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  const workSummary = tasksPage.locator(
    "caffold-task-work-details > details > summary",
  );
  await workSummary.scrollIntoViewIfNeeded();
  await workSummary.click();

  const toolCalls = tasksPage.locator(
    '.task-work-details-item[data-event-type="tool_call"]',
  );
  await expect(toolCalls).toHaveCount(2);

  // The agent's own name for the work, not a summary line restating it.
  const searched = toolCalls.filter({ hasText: "web_search" });
  await expect(searched.locator("header strong")).toHaveText("web_search");
  await expect(searched).toContainText("Status: completed");
  await expect(searched).toHaveAttribute("data-tool-tone", "neutral");

  // Work that failed reads as failed, the way every other failure here does.
  const probed = toolCalls.filter({ hasText: "inspector.probe" });
  await expect(probed.locator("header strong")).toHaveText("inspector.probe");
  await expect(probed).toContainText("Status: failed");
  await expect(probed).toHaveAttribute("data-tool-tone", "danger");
});

test("shows a prompt as the characters a person typed", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const prompt = [
    "# Not a heading",
    "",
    "**Not bold**   keeps   its   spacing",
    "",
    "```sh",
    `printf '<user> & "quoted"'`,
    "```",
    "",
    "[Not a link](docs/review/policy.md#L22)",
    `unbroken-${"segment".repeat(24)}`,
  ].join("\n");
  const scenario = await installTaskLoopFixture(page, {
    threadId: "thread_plain_prompt",
  });
  await scenario.seedCompletedTask();
  scenario.events = scenario.events.map((event) =>
    event.id === "event_1_user"
      ? { ...event, payload: { ...event.payload, content: [], text: prompt } }
      : event,
  );
  await page.goto(`/tasks/${scenario.threadId}`);

  const tasksPage = page.locator("caffold-tasks-page");
  const userMessage = tasksPage.locator('.task-message[data-message-role="user"]');
  const bubble = userMessage.locator(".task-message-content");
  const promptText = userMessage.locator(".task-message-text");
  await expect(
    tasksPage.locator('.task-assistant-message caffold-task-markdown'),
  ).toHaveAttribute("data-render-state", "markdown");

  await expect(userMessage.locator("caffold-task-markdown")).toHaveCount(0);
  expect(await promptText.evaluate((element) => element.textContent)).toBe(prompt);
  expect(
    await promptText.evaluate((element) => ({
      markup: element.childElementCount,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ).toEqual({ markup: 0, whiteSpace: "pre-wrap" });

  const layout = await bubble.evaluate((element) => {
    const scroller = element.closest(".task-conversation-scroll");
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inner =
      box.height -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    return {
      containedInScroller:
        box.right <= scroller.getBoundingClientRect().right + 0.5,
      renderedLines: Math.round(inner / parseFloat(style.lineHeight)),
      wrapsInsteadOfOverflowing: element.scrollWidth <= element.clientWidth,
    };
  });
  expect(layout.containedInScroller).toBe(true);
  expect(layout.wrapsInsteadOfOverflowing).toBe(true);
  expect(layout.renderedLines).toBeGreaterThanOrEqual(prompt.split("\n").length);

  await promptText.scrollIntoViewIfNeeded();
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-plain-text-prompt");
  expect(scenario.pageErrors).toEqual([]);
});

test("renders an agent message that ends where its text ends", { tag: "@all-viewports" }, async ({
  page,
}) => {
  // Every block inside a rendered Markdown message carries a margin so the
  // blocks stand apart. The outermost two must give theirs back, or the message
  // reads as though the writer left a blank line at the end they never typed.
  const scenario = await installTaskLoopFixture(page, {
    threadId: "019fd747-1247-7bb0-998b-9aec53bdf7f4",
  });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(
    tasksPage.locator('.task-assistant-message caffold-task-markdown'),
  ).toHaveAttribute("data-render-state", "markdown");

  const edges = await tasksPage.evaluate((root) => {
    const body = root.querySelector(
      '.task-assistant-message .markdown-body',
    );
    return {
      marginTop: getComputedStyle(body.firstElementChild).marginTop,
      marginBottom: getComputedStyle(body.lastElementChild).marginBottom,
    };
  });

  expect(edges).toEqual({ marginTop: "0px", marginBottom: "0px" });
});

test("presents a completed canonical turn without duplicate or unsafe content", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const contextPath = "Users/taehoon/Workspace/rust/codger";
  const scenario = await installTaskLoopFixture(page, {
    contextPath,
    threadId: "019fd747-1247-7bb0-998b-9aec53bdf7f2",
  });
  const { threadId } = scenario;
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${threadId}`);
  const tasksPage = page.locator("caffold-tasks-page");
  await expect(tasksPage.locator('.task-assistant-message')).toContainText(
    "The planner changes are ready to review.",
  );
  const assistantMarkdown = tasksPage.locator(
    '.task-assistant-message caffold-task-markdown',
  );
  await expect(assistantMarkdown).toHaveAttribute("data-render-state", "markdown");
  await expect(assistantMarkdown.locator("h2")).toHaveText("Review ready");
  await expect(assistantMarkdown.locator("strong")).toHaveText("ready");
  await expect(assistantMarkdown.locator("li")).toHaveCount(2);
  await expect(assistantMarkdown.locator("pre code")).toHaveText("cargo test");
  await expect(assistantMarkdown.getByRole("link", { name: "Planner notes" })).toHaveAttribute(
    "href",
    "https://example.com/planner",
  );
  await expect(assistantMarkdown.locator("table")).toContainText("Planner");
  await expect(assistantMarkdown).toContainText("Malformed **marker stays readable.");
  await expect
    .poll(() =>
      assistantMarkdown.evaluate((element) => {
        const body = element.querySelector(":scope > .markdown-body");
        return body.scrollWidth <= body.clientWidth;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      tasksPage.evaluate(() => {
        const probe = document.createElement("caffold-task-markdown");
        probe.textContent = "Fallback content";
        document.body.append(probe);
        const loading = probe.querySelector(":scope > .markdown-body > .markdown-loading");
        const style = getComputedStyle(loading);
        const result = {
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderWidth,
          margin: style.margin,
          padding: style.padding,
        };
        probe.remove();
        return result;
      }),
    )
    .toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
      margin: "0px",
      padding: "0px",
    });
  await tasksPage.evaluate(() => {
    const probe = document.createElement("caffold-task-markdown");
    probe.hidden = true;
    probe.textContent = "[unsafe](javascript:alert(1))";
    document.body.append(probe);
  });
  await expect(page.locator("caffold-task-markdown").last()).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  await expect(page.locator("caffold-task-markdown").last().locator("a")).toHaveCount(0);
  await expect(tasksPage.locator(".task-assistant-message")).toHaveCount(1);
  await expect(
    tasksPage.locator(
      '.task-assistant-message caffold-task-assistant-message[data-message-phase="final"]',
    ),
  ).toHaveCount(1);
  await expect(tasksPage.locator(".task-assistant-message")).not.toContainText(
    "I am checking the planner diff",
  );
  await expect(tasksPage.locator(".task-turn-work")).toContainText("Worked for");
  await expect(tasksPage.locator(".task-turn-work")).toContainText("7 updates");
  await expect(
    tasksPage.locator("caffold-task-work-details > details"),
  ).not.toHaveAttribute("open", "");
  await expect
    .poll(() =>
      tasksPage.evaluate((element) => {
        const work = element.querySelector(".task-turn-work");
        const assistant = element.querySelector(".task-assistant-message");
        const position = work && assistant ? work.compareDocumentPosition(assistant) : 0;
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    )
    .toBe(true);
  await expect(tasksPage.locator(".task-work-details-item")).toHaveCount(7);
  await expect(tasksPage.locator(".task-work-details-item").first()).not.toBeVisible();
  const workDetails = tasksPage.locator("caffold-task-work-details > details");
  const workSummary = workDetails.locator(":scope > summary");
  await workSummary.scrollIntoViewIfNeeded();
  const workSummaryOffset = await workSummary.evaluate((summary) => {
    const scroller = summary.closest(".task-conversation-scroll");
    return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  await workSummary.click();
  await expect(workDetails).toHaveAttribute("open", "");
  await expect
    .poll(() =>
      workSummary.evaluate((summary) => {
        const scroller = summary.closest(".task-conversation-scroll");
        return summary.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }),
    )
    .toBeCloseTo(workSummaryOffset, 1);
  await expect(
    tasksPage.locator('.task-work-details-item[data-event-type="assistant_message"]'),
  ).toContainText("I am checking the planner diff");
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="reasoning"]')).toContainText(
    "Checked the planner diff.",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="plan"]')).toContainText(
    "Run focused tests",
  );
  const completedCommand = tasksPage.locator(
    '.task-work-details-item[data-event-type="command_execution"]:has(> caffold-task-command[data-command-status="completed"])',
  );
  const completedCommandRow = completedCommand.locator(
    "caffold-task-command",
  );
  const completedCommandAction = completedCommandRow.getByRole("button", {
    name: "View output",
  });
  await expect(completedCommand.locator("details")).toHaveCount(0);
  await expect(completedCommandRow).toContainText("Completed");
  await expect(completedCommandRow).toContainText("cargo test");
  await expect(completedCommandRow).toContainText("1s");
  await expect(completedCommandRow).not.toContainText("test result: ok");
  await completedCommandAction.click({ trial: true });
  const conversationScrollBeforeDialog = await tasksPage
    .locator(".task-conversation-scroll")
    .evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
  const commandRowHeight = await completedCommand.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await completedCommandAction.click();
  const commandDialog = tasksPage.locator("caffold-task-command-dialog > dialog");
  const commandDialogClose = commandDialog.getByRole("button", {
    name: "Close command output",
  });
  await expect(commandDialog).toHaveAttribute("open", "");
  await expect(
    commandDialogClose.locator(".task-command-dialog-close-icon"),
  ).toBeVisible();
  await expect
    .poll(() =>
      commandDialogClose.evaluate((button) => {
        const { width, height } = button.getBoundingClientRect();
        return Math.abs(width - height);
      }),
    )
    .toBeLessThan(1);
  await expect(commandDialog).toContainText("cargo test");
  await expect(commandDialog).toContainText("Working directory");
  await expect(commandDialog).toContainText("src");
  await expect(commandDialog).toContainText("Completed");
  await expect(commandDialog).toContainText("1s");
  await expect(commandDialog).toContainText("Exit code");
  await expect(commandDialog).toContainText("test result: ok");
  const completedCommandOutput = commandDialog.locator(".task-command-dialog-output pre");
  await expect
    .poll(() =>
      completedCommandOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      commandDialog.locator(".task-command-dialog-body").evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  const commandDialogBody = commandDialog.locator(".task-command-dialog-body");
  await expect
    .poll(() =>
      commandDialogBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      }),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      tasksPage.locator(".task-conversation-scroll").evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      })),
    )
    .toEqual(conversationScrollBeforeDialog);
  await captureReviewScreenshot(page, testInfo, "tasks-command-output");
  await commandDialogClose.click();
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect
    .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(completedCommandAction).toBeFocused();
  await expect
    .poll(() => completedCommand.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(commandRowHeight, 1);

  await test.step("resets after opening when a hidden scroller ignores reset", async () => {
    await completedCommandAction.click();
    await commandDialogBody.evaluate((element) => {
      let prototype = Object.getPrototypeOf(element);
      let descriptor = null;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        prototype = Object.getPrototypeOf(prototype);
      }
      if (!descriptor?.get || !descriptor?.set) {
        throw new Error("scrollTop accessors are unavailable");
      }
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          if (Number(value) === 0 && !this.closest("dialog")?.open) {
            return;
          }
          descriptor.set.call(this, value);
        },
      });
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await commandDialogClose.click();
    await completedCommandAction.click();
    await expect
      .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
      .toBe(0);
    await commandDialogBody.evaluate((element) => {
      delete element.scrollTop;
    });
    await commandDialogClose.click();
  });

  const failedCommand = tasksPage.locator(
    '.task-work-details-item[data-event-type="command_execution"]:has(> caffold-task-command[data-command-status="failed"])',
  );
  const failedCommandRow = failedCommand.locator(
    "caffold-task-command",
  );
  const failedCommandAction = failedCommandRow.getByRole("button", {
    name: "View output",
  });
  await expect(failedCommandRow).toContainText("Failed");
  await expect(failedCommandRow).toContainText("Exit 101");
  await failedCommandAction.click();
  await expect(commandDialog).toHaveAttribute("data-command-status", "failed");
  await expect
    .poll(() => commandDialogBody.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(commandDialog).toContainText("cargo test --package missing");
  await expect(commandDialog).toContainText("2s");
  await expect(commandDialog).toContainText("101");
  await expect(commandDialog).toContainText("package `missing` was not found");
  await page.keyboard.press("Escape");
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect(failedCommandAction).toBeFocused();

  await failedCommandAction.click();
  await expect(commandDialog).toHaveAttribute("open", "");
  await page.mouse.click(1, 1);
  await expect(commandDialog).not.toHaveAttribute("open", "");
  await expect(failedCommandAction).toBeFocused();
  await expect
    .poll(() =>
      tasksPage.evaluate(
        (element) =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    )
    .toBe(true);
  const workItemOrder = await tasksPage.locator(".task-work-details-item").evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-event-type")),
  );
  expect(workItemOrder).toEqual([
    "approval_resolved",
    "reasoning",
    "plan",
    "command_execution",
    "command_execution",
    "file_change",
    "assistant_message",
  ]);
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "2 file change updates",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "src/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "tests/planner.rs",
  );
  await expect(tasksPage.locator('.task-work-details-item[data-event-type="file_change"]')).toContainText(
    "src/lib.rs",
  );
  await stabilizeDynamicText(page);
  await captureReviewScreenshot(page, testInfo, "tasks-work-details");
  await tasksPage.locator("caffold-task-work-details > details > summary").click();
  await expect(
    tasksPage.locator("caffold-task-work-details > details"),
  ).not.toHaveAttribute("open", "");
  await expect(tasksPage.locator(".task-approval-card")).toHaveCount(0);
  await expect(tasksPage.locator(".task-follow-up-form")).toBeVisible();
  await expect(tasksPage.locator(".task-conversation-scroll")).toHaveCSS("overflow-y", "auto");
  await expect(tasksPage).not.toContainText("assistant message");
  await expect(tasksPage).not.toContainText("user message");
  await expect(tasksPage).not.toContainText("turn started");
  const taskDetailsButton = tasksPage.getByRole("button", { name: /Task details/ });
  await expect(taskDetailsButton).toBeVisible();
  await expect(taskDetailsButton).toHaveAttribute("title", "Status: idle");
  await taskDetailsButton.click();
  const taskDetailsPopover = tasksPage.locator(".task-detail-popover");
  await expect(taskDetailsPopover).toBeVisible();
  await expect(taskDetailsPopover).toContainText("idle");
  await expect(taskDetailsPopover).toContainText(threadId);
  await expect(taskDetailsPopover).toContainText(contextPath);
  await expect(taskDetailsPopover).toContainText("Worktree");
  await expect(taskDetailsPopover).toContainText("Branch");
  await expect(taskDetailsPopover).toContainText("main");
  if (testInfo.project.name !== "phone") {
    const metadataLayout = await taskDetailsPopover.evaluate((popover) => {
      const values = new Map(
        [...popover.querySelectorAll("dl > div")].map((row) => [
          row.querySelector("dt").textContent,
          row.querySelector("dd"),
        ]),
      );
      const lineCount = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].filter(({ width, height }) => width > 0 && height > 0)
          .length;
      };
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      return {
        maxWidth: Math.min(42 * rootFontSize, innerWidth - 1.5 * rootFontSize),
        threadLines: lineCount(values.get("Thread")),
        workingDirectoryLines: lineCount(values.get("Working directory")),
        worktreeLines: lineCount(values.get("Worktree")),
        width: popover.getBoundingClientRect().width,
      };
    });
    expect(metadataLayout.width).toBeLessThan(metadataLayout.maxWidth);
    expect(metadataLayout.threadLines).toBe(1);
    expect(metadataLayout.workingDirectoryLines).toBe(1);
    expect(metadataLayout.worktreeLines).toBe(1);
  }
  const [taskDetailsButtonBox, taskDetailsPopoverBox] = await Promise.all([
    taskDetailsButton.boundingBox(),
    taskDetailsPopover.boundingBox(),
  ]);
  expect(taskDetailsButtonBox).not.toBeNull();
  expect(taskDetailsPopoverBox).not.toBeNull();
  expect(taskDetailsPopoverBox.x).toBeGreaterThanOrEqual(7);
  expect(
    taskDetailsPopoverBox.x + taskDetailsPopoverBox.width,
  ).toBeLessThanOrEqual(page.viewportSize().width - 7);
  expect(taskDetailsPopoverBox.y).toBeGreaterThanOrEqual(
    taskDetailsButtonBox.y + taskDetailsButtonBox.height + 4,
  );
  expect(taskDetailsButtonBox.x + taskDetailsButtonBox.width / 2).toBeGreaterThanOrEqual(
    taskDetailsPopoverBox.x - 1,
  );
  expect(taskDetailsButtonBox.x + taskDetailsButtonBox.width / 2).toBeLessThanOrEqual(
    taskDetailsPopoverBox.x + taskDetailsPopoverBox.width + 1,
  );
  const detailActionGeometry = await tasksPage
    .locator(
      ".detail-layout-actions > caffold-task-detail-git > .task-git-button, .detail-layout-actions > caffold-task-detail-github > .task-github-button, .task-detail-info-button",
    )
    .evaluateAll((controls) =>
      controls.map((control) => {
        const icon = control.querySelector(
          "svg, img, .task-git-icon, .task-github-icon",
        );
        const chip = control.querySelector(".task-status-chip");
        const controlBox = control.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        const chipBox = chip?.getBoundingClientRect();
        return {
          label:
            control.getAttribute("aria-label") ||
            control.getAttribute("title") ||
            control.className,
          iconOnly:
            control.matches(
              ".task-git-button, .task-github-button, .task-detail-info-button",
            ) ||
            control.classList.contains("task-icon-button"),
          iconWidth: iconBox.width,
          iconHeight: iconBox.height,
          centerDeltaX: Math.abs(
            controlBox.left + controlBox.width / 2 -
              (iconBox.left + iconBox.width / 2),
          ),
          centerDeltaY: Math.abs(
            controlBox.top + controlBox.height / 2 -
              (iconBox.top + iconBox.height / 2),
          ),
          width: controlBox.width,
          height: controlBox.height,
          controlTop: controlBox.top,
          iconTop: iconBox.top,
          chipTop: chipBox?.top ?? null,
          chipHeight: chipBox?.height ?? null,
        };
      }),
    );
  expect(detailActionGeometry.length).toBeGreaterThan(2);
  for (const geometry of detailActionGeometry) {
    expect(geometry.iconWidth).toBeCloseTo(geometry.iconHeight, 1);
    if (geometry.iconOnly) {
      expect(geometry.centerDeltaX).toBeLessThanOrEqual(0.5);
    }
    expect(
      geometry.centerDeltaY,
      `${geometry.label} icon must stay vertically centered: ${JSON.stringify(geometry)}`,
    ).toBeLessThanOrEqual(0.5);
  }
  expect(new Set(detailActionGeometry.map(({ iconWidth }) => iconWidth)).size).toBe(1);
  const contextualControlGeometry = await tasksPage.evaluate((element) => {
    const modeSwitch = element.querySelector(
      "caffold-segmented-control[data-detail-view-switch]",
    );
    const controls = [
      modeSwitch,
      ...element.querySelectorAll(
        ".detail-layout-actions > button, .detail-layout-actions > details > summary, .task-detail-info-button",
      ),
    ];
    const modeButtons = [...modeSwitch.querySelectorAll("button")];
    const expandedTouchControls = [
      ...element.querySelectorAll(
        ".task-detail-actions > button, .task-detail-actions > details > summary, .task-detail-info-button",
      ),
    ].filter((control) => !control.matches(":disabled"));
    return {
      visualHeights: controls.map((control) => {
        const bounds = control.getBoundingClientRect();
        if (control === modeSwitch) {
          return bounds.height;
        }
        const visual = getComputedStyle(control, "::before");
        const top = Number.parseFloat(visual.top) || 0;
        const bottom = Number.parseFloat(visual.bottom) || 0;
        return Math.min(bounds.height, bounds.height - top - bottom);
      }),
      modeButtonHeights: modeButtons.map(
        (control) => control.getBoundingClientRect().height,
      ),
      selectedInset: (() => {
        const selected = modeSwitch.querySelector('button[aria-pressed="true"] > span');
        const group = modeSwitch.getBoundingClientRect();
        const visual = selected.getBoundingClientRect();
        return {
          bottom: group.bottom - visual.bottom,
          top: visual.top - group.top,
        };
      })(),
      expandedTouchHits: expandedTouchControls.map((control) => {
        const bounds = control.getBoundingClientRect();
        const hitEdgeY = bounds.height >= 39 ? bounds.top + 1 : bounds.top - 3;
        const hit = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          hitEdgeY,
        );
        return {
          label:
            control.getAttribute("aria-label") ||
            control.getAttribute("title") ||
            control.className,
          hit: hit === control || control.contains(hit),
          hitLabel:
            hit?.getAttribute?.("aria-label") ||
            hit?.getAttribute?.("title") ||
            hit?.className ||
            hit?.tagName ||
            null,
        };
      }),
    };
  });
  expect(
    Math.max(...contextualControlGeometry.visualHeights) -
      Math.min(...contextualControlGeometry.visualHeights),
  ).toBeLessThanOrEqual(1);
  expect(contextualControlGeometry.selectedInset.top).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.bottom).toBeGreaterThanOrEqual(0);
  expect(contextualControlGeometry.selectedInset.top).toBeLessThanOrEqual(2);
  expect(contextualControlGeometry.selectedInset.bottom).toBeLessThanOrEqual(2);
  if (testInfo.project.name !== "desktop") {
    expect(Math.max(...contextualControlGeometry.visualHeights)).toBeLessThanOrEqual(34);
    expect(Math.min(...contextualControlGeometry.modeButtonHeights)).toBeGreaterThanOrEqual(40);
    expect(
      contextualControlGeometry.expandedTouchHits.every(({ hit }) => hit),
      JSON.stringify(contextualControlGeometry.expandedTouchHits),
    ).toBe(true);
  }
  const workspaceHeaderMetrics = await tasksPage.evaluate((element) => {
    const close = document.querySelector(".task-workspace-back");
    const summary = element.querySelector(".task-detail-summary");
    const summaryBounds = summary.getBoundingClientRect();
    const headingBounds = summary
      .querySelector(".task-detail-heading")
      .getBoundingClientRect();
    const actionBounds = summary
      .querySelector(".detail-layout-actions")
      .getBoundingClientRect();
    const closeBounds = close.getBoundingClientRect();
    const titleBounds = summary.querySelector("h2").getBoundingClientRect();
    return {
      appHeaderCount: element.querySelectorAll(".tasks-header").length,
      closeSize: closeBounds.width,
      closeTitleCenterDelta: Math.abs(
        closeBounds.top + closeBounds.height / 2 -
          (titleBounds.top + titleBounds.height / 2),
      ),
      closeVisible:
        getComputedStyle(close).display !== "none" &&
        close.getBoundingClientRect().width > 0,
      overflow: element.scrollWidth > element.clientWidth,
      actionHeight: actionBounds.height,
      actionChildren: [...summary.querySelectorAll(
        ".detail-layout-actions > *, .task-detail-info-button",
      )].map((control) => ({
        className: control.className,
        height: control.getBoundingClientRect().height,
      })),
      paddingBlock: getComputedStyle(summary).paddingBlock,
      sameRow:
        Math.abs(
          headingBounds.top + headingBounds.height / 2 -
            (actionBounds.top + actionBounds.height / 2),
        ) <= 1,
      summaryHeight: summaryBounds.height,
      summaryTop: Math.round(summaryBounds.top),
      surfaceTop: Math.round(element.getBoundingClientRect().top),
    };
  });
  expect(workspaceHeaderMetrics.appHeaderCount).toBe(0);
  expect(workspaceHeaderMetrics.summaryTop).toBe(workspaceHeaderMetrics.surfaceTop);
  expect(workspaceHeaderMetrics.overflow).toBe(false);
  if (testInfo.project.name !== "phone") {
    const navigatorClearance = await page
      .locator("caffold-task-workspace")
      .evaluate((element) => {
        const brand = element
          .querySelector(".task-list-primary-header caffold-workspace-brand")
          .getBoundingClientRect();
        const sectionHeader = element
          .querySelector(".task-list-primary-header")
          .getBoundingClientRect();
        const newTask = element
          .querySelector(".task-list-primary-header .task-list-new-task")
          .getBoundingClientRect();
        const summary = element
          .querySelector(".task-detail-summary")
          .getBoundingClientRect();
        return {
          headerBottomDelta: Math.abs(sectionHeader.bottom - summary.bottom),
          brandLeftInset: brand.left - sectionHeader.left,
          brandActionGap: newTask.left - brand.right,
        };
      });
    expect(workspaceHeaderMetrics.closeVisible).toBe(false);
    expect(navigatorClearance.brandLeftInset).toBeGreaterThanOrEqual(0);
    expect(navigatorClearance.brandActionGap).toBeGreaterThanOrEqual(0);
    expect(
      navigatorClearance.headerBottomDelta,
      JSON.stringify({ navigatorClearance, workspaceHeaderMetrics }),
    ).toBeLessThanOrEqual(1);
  } else {
    expect(workspaceHeaderMetrics.closeVisible).toBe(true);
    expect(workspaceHeaderMetrics.closeSize).toBeGreaterThanOrEqual(40);
    expect(workspaceHeaderMetrics.closeTitleCenterDelta).toBeLessThanOrEqual(2);
  }
  if (testInfo.project.name === "phone") {
    expect(workspaceHeaderMetrics.sameRow).toBe(false);
    expect(workspaceHeaderMetrics.summaryHeight).toBeLessThanOrEqual(112);
    await stabilizeDynamicText(page);
    await captureReviewScreenshot(page, testInfo, "tasks-mobile-header-details");
  } else {
    expect(workspaceHeaderMetrics.sameRow).toBe(true);
    expect(workspaceHeaderMetrics.summaryHeight).toBeLessThanOrEqual(64);
  }
  if (testInfo.project.name === "foldable") {
    await page.setViewportSize({ width: 800, height: 1100 });
    const compactFoldableHeader = await tasksPage.evaluate((element) => {
      const summary = element.querySelector(".task-detail-summary");
      const heading = summary
        .querySelector(".task-detail-heading")
        .getBoundingClientRect();
      const actions = summary
        .querySelector(".detail-layout-actions")
        .getBoundingClientRect();
      return {
        closeVisible:
          getComputedStyle(document.querySelector(".task-workspace-back"))
            .display !== "none",
        sameRow:
          Math.abs(
            heading.top + heading.height / 2 -
              (actions.top + actions.height / 2),
          ) <= 1,
        summaryHeight: summary.getBoundingClientRect().height,
      };
    });
    expect(compactFoldableHeader.closeVisible).toBe(true);
    expect(compactFoldableHeader.sameRow).toBe(true);
    expect(compactFoldableHeader.summaryHeight).toBeLessThanOrEqual(64);
  }
  await taskDetailsButton.click();
  await expect(taskDetailsPopover).toBeHidden();
  await stabilizeDynamicText(page);
  if (testInfo.project.name === "foldable") {
    await captureReviewScreenshot(page, testInfo, "tasks-foldable-compact-header");
  }
  await captureReviewScreenshot(page, testInfo, "tasks-conversation");
});
