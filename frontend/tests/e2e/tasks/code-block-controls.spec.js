import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import {
  canonicalTaskState,
  captureReviewScreenshot,
} from "../support/task-fixtures.js";

const FIRST_CODE = [
  "fn main() {",
  '    println!("<tag> & value");',
  "",
  '    const long_value = "' + "segment".repeat(24) + '";',
  "}",
  "",
].join("\n");

const SECOND_CODE = [
  "  alpha",
  "",
  "    beta > gamma & delta",
  "",
].join("\n");

const RAW_LABEL = "custom-fence-label-without-highlighting";

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBrowserDefaults(page);
});

test("keeps the code-block toolbar dense and usable across Task viewports", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedCodeBlockTask(
    page,
    "thread_code_layout_" + testInfo.project.name,
  );
  const tasksPage = page.locator("caffold-tasks-page");
  const userMarkdown = tasksPage.locator(
    '.task-message[data-message-role="user"] caffold-task-markdown',
  );
  const finalMarkdown = tasksPage.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"] caffold-task-markdown',
  );

  await expect(userMarkdown).toHaveAttribute("code-block-controls", "");
  await expect(finalMarkdown).toHaveAttribute("code-block-controls", "");
  await expect(userMarkdown.locator("caffold-task-markdown-code-block")).toHaveCount(1);
  await expect(finalMarkdown.locator("caffold-task-markdown-code-block")).toHaveCount(2);
  await expect(finalMarkdown.locator(".code-block-label")).toHaveText([
    "rust",
    "Plain text",
  ]);
  await expect(finalMarkdown.getByRole("button", { name: "Wrap code lines" })).toHaveCount(2);
  await expect(finalMarkdown.getByRole("button", { name: "Copy code" })).toHaveCount(2);
  await expect(finalMarkdown.locator(".code-block-action-icon-svg")).toHaveCount(4);
  await expect(finalMarkdown.locator("code").filter({ hasText: "inline-only" })).toHaveCount(1);
  await expect(finalMarkdown.getByRole("button", { name: "Injected control" })).toHaveCount(0);
  await expect(
    finalMarkdown.getByRole("button", { name: "Injected component control" }),
  ).toHaveCount(0);
  expect(
    await finalMarkdown.evaluate((markdown) => {
      const codeBlock = markdown.querySelector("caffold-task-markdown-code-block");
      return {
        codeBlockHasShadowRoot: Boolean(codeBlock?.shadowRoot),
        inlineStyles: markdown.querySelectorAll("style").length,
        markdownHasShadowRoot: Boolean(markdown.shadowRoot),
      };
    }),
  ).toEqual({
    codeBlockHasShadowRoot: false,
    inlineStyles: 0,
    markdownHasShadowRoot: false,
  });

  const expectedTarget = testInfo.project.name === "desktop" ? 30 : 40;
  const geometry = await finalMarkdown.locator("caffold-task-markdown-code-block").first().evaluate(
    (wrapper) => {
      const header = wrapper.querySelector(":scope > .code-block-header");
      const label = header.querySelector(":scope > .code-block-label");
      const buttons = [
        ...header.querySelectorAll(".code-block-actions > button"),
      ];
      const wrapperBox = wrapper.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const buttonBoxes = buttons.map((button) => button.getBoundingClientRect());
      return {
        buttonSizes: buttonBoxes.map((box) => ({
          height: Math.round(box.height),
          width: Math.round(box.width),
        })),
        contained:
          headerBox.left >= wrapperBox.left - 0.5 &&
          headerBox.right <= wrapperBox.right + 0.5 &&
          buttonBoxes.every(
            (box) =>
              box.left >= headerBox.left - 0.5 &&
              box.right <= headerBox.right + 0.5,
          ),
        gap: Math.round(buttonBoxes[1].left - buttonBoxes[0].right),
        labelDoesNotOverlap: labelBox.right <= buttonBoxes[0].left + 0.5,
        scrollContained: wrapper.scrollWidth <= wrapper.clientWidth,
      };
    },
  );
  expect(geometry.buttonSizes).toEqual([
    { height: expectedTarget, width: expectedTarget },
    { height: expectedTarget, width: expectedTarget },
  ]);
  expect(geometry.contained).toBe(true);
  expect(geometry.gap).toBeGreaterThanOrEqual(6);
  expect(geometry.labelDoesNotOverlap).toBe(true);
  expect(geometry.scrollContained).toBe(true);

  await page.evaluate(async () => {
    const { setAppearanceRangeSetting } = await import("/assets/settings.js");
    setAppearanceRangeSetting("interfaceScalePercent", 120);
    setAppearanceRangeSetting("codeTextPx", 20);
  });
  const expandedGeometry = await finalMarkdown.locator("caffold-task-markdown-code-block").first().evaluate(
    (wrapper) => {
      const header = wrapper.querySelector(":scope > .code-block-header");
      const label = header.querySelector(":scope > .code-block-label");
      const buttons = [
        ...header.querySelectorAll(".code-block-actions > button"),
      ];
      const headerBox = header.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const buttonBoxes = buttons.map((button) => button.getBoundingClientRect());
      return {
        contained: buttonBoxes.every(
          (box) =>
            box.left >= headerBox.left - 0.5 &&
            box.right <= headerBox.right + 0.5,
        ),
        labelDoesNotOverlap: labelBox.right <= buttonBoxes[0].left + 0.5,
        minimumTarget: Math.min(
          ...buttonBoxes.flatMap((box) => [box.width, box.height]),
        ),
        scrollContained: wrapper.scrollWidth <= wrapper.clientWidth,
      };
    },
  );
  expect(expandedGeometry.contained).toBe(true);
  expect(expandedGeometry.labelDoesNotOverlap).toBe(true);
  expect(expandedGeometry.minimumTarget).toBeGreaterThanOrEqual(expectedTarget);
  expect(expandedGeometry.scrollContained).toBe(true);

  const firstBlock = finalMarkdown.locator("caffold-task-markdown-code-block").first();
  const firstPre = firstBlock.locator("pre");
  await firstPre.evaluate((pre) => {
    pre.scrollLeft = 80;
  });
  const savedScrollLeft = await firstPre.evaluate((pre) => pre.scrollLeft);
  expect(savedScrollLeft).toBeGreaterThan(0);

  await firstBlock.getByRole("button", { name: "Wrap code lines" }).click();
  await expect(firstBlock).toHaveAttribute("data-code-wrap", "on");
  await expect(firstBlock.getByRole("button", { name: "Stop wrapping code lines" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() =>
    firstPre.evaluate((pre) => pre.scrollWidth <= pre.clientWidth)
  ).toBe(true);

  await firstBlock.getByRole("button", { name: "Stop wrapping code lines" }).click();
  await expect(firstBlock).toHaveAttribute("data-code-wrap", "off");
  await expect.poll(() => firstPre.evaluate((pre) => pre.scrollLeft)).toBe(savedScrollLeft);

  const scroller = tasksPage.locator(".task-conversation-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastBlock = finalMarkdown.locator("caffold-task-markdown-code-block").last();
  await lastBlock.getByRole("button", { name: "Wrap code lines" }).click();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      )
    )
    .toBeLessThanOrEqual(2);

  await firstPre.evaluate((pre) => {
    pre.scrollLeft = 0;
  });
  await finalMarkdown.scrollIntoViewIfNeeded();
  await captureReviewScreenshot(page, testInfo, "task-code-block-toolbar");
  expect(scenario.pageErrors).toEqual([]);
});

test("copies each block exactly with bounded success and retryable failure", { tag: "@desktop" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedCodeBlockTask(page, "thread_code_copy");
  const finalMarkdown = page.locator(
    '.task-message[data-message-role="assistant"][data-message-phase="final"] caffold-task-markdown',
  );
  const blocks = finalMarkdown.locator("caffold-task-markdown-code-block");
  const firstBlock = blocks.nth(0);
  const secondBlock = blocks.nth(1);
  const firstCopy = firstBlock.locator('button[data-code-action="copy"]');
  const secondCopy = secondBlock.locator('button[data-code-action="copy"]');
  const firstPre = firstBlock.locator("pre");

  await firstPre.evaluate((pre) => {
    pre.scrollLeft = 70;
  });
  const scrollLeft = await firstPre.evaluate((pre) => pre.scrollLeft);
  const requests = [];
  page.on("request", (request) => {
    if (["fetch", "xhr"].includes(request.resourceType())) {
      requests.push(request.url());
    }
  });
  await page.clock.install();
  const pausedAt = await page.evaluate(() => Date.now() + 60_000);
  await page.clock.pauseAt(pausedAt);

  await firstCopy.focus();
  expect(
    await firstCopy.evaluate((button) => button.getRootNode().activeElement === button),
  ).toBe(true);
  await page.keyboard.press("Enter");
  await expect(firstCopy).toHaveAttribute("aria-label", "Copied");
  await expect(firstBlock.locator(".code-block-label")).toHaveText("Copied");
  const firstStatus = firstBlock.locator(".code-block-status");
  const secondStatus = secondBlock.locator(".code-block-status");
  await expect(firstStatus).toHaveAttribute("role", "status");
  await expect(firstStatus).toHaveAttribute("aria-live", "polite");
  await expect(firstStatus).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(FIRST_CODE);
  await expect.poll(() => firstPre.evaluate((pre) => pre.scrollLeft)).toBe(scrollLeft);
  expect(
    await firstCopy.evaluate((button) => button.getRootNode().activeElement === button),
  ).toBe(true);
  expect(requests).toEqual([]);

  await secondCopy.click();
  await expect(secondCopy).toHaveAttribute("aria-label", "Copied");
  await expect(firstCopy).toHaveAttribute("aria-label", "Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SECOND_CODE);
  await page.clock.fastForward(1_799);
  await expect(firstCopy).toHaveAttribute("aria-label", "Copied");
  await expect(secondCopy).toHaveAttribute("aria-label", "Copied");
  await page.clock.fastForward(1);
  await expect(firstCopy).toHaveAttribute("aria-label", "Copy code");
  await expect(secondCopy).toHaveAttribute("aria-label", "Copy code");
  await expect(firstBlock.locator(".code-block-label")).toHaveText("rust");
  await expect(secondBlock.locator(".code-block-label")).toHaveText("Plain text");
  await expect(firstStatus).toBeEmpty();
  await expect(secondStatus).toBeEmpty();

  await page.evaluate(() => {
    window.__codeCopyAttempts = [];
    window.__failNextCodeCopy = true;
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        window.__codeCopyAttempts.push(text);
        if (window.__failNextCodeCopy) {
          window.__failNextCodeCopy = false;
          throw new Error("fixture clipboard failure");
        }
      },
    });
  });

  await secondCopy.click();
  await expect(secondCopy).toHaveAttribute(
    "aria-label",
    "Copy failed. Retry copy code",
  );
  await expect(secondBlock.locator(".code-block-label")).toHaveText(
    "Copy failed — retry",
  );
  await expect(secondStatus).toHaveText("Copy failed — retry");
  await expect(secondCopy).toBeEnabled();
  await page.clock.fastForward(1_799);
  await expect(secondCopy).toHaveAttribute(
    "aria-label",
    "Copy failed. Retry copy code",
  );
  await page.clock.fastForward(1);
  await expect(secondCopy).toHaveAttribute("aria-label", "Copy code");
  await expect(secondBlock.locator(".code-block-label")).toHaveText("Plain text");
  await expect(secondStatus).toBeEmpty();
  await secondCopy.click();
  await expect(secondCopy).toHaveAttribute("aria-label", "Copied");
  await expect
    .poll(() => page.evaluate(() => window.__codeCopyAttempts))
    .toEqual([SECOND_CODE, SECOND_CODE]);
  await page.clock.fastForward(1_800);
  await expect(secondCopy).toHaveAttribute("aria-label", "Copy code");
  expect(scenario.pageErrors).toEqual([]);
  expect(testInfo.project.name).toBe("desktop");
});

test("keeps excluded conversation surfaces plain", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedCodeBlockTask(page, "thread_code_exclusions", {
    activeThinking: true,
  });
  const thinking = page.locator(".task-thinking caffold-task-markdown");
  await expect(thinking).toHaveAttribute("data-render-state", "markdown");
  await expect(thinking).not.toHaveAttribute("code-block-controls", "");
  await expect(thinking.locator("pre > code")).toHaveText("thinking-only\n");
  await expect(thinking.locator("caffold-task-markdown-code-block")).toHaveCount(0);
  const interim = page.locator(
    '.task-message[data-message-phase="progress"] caffold-task-markdown',
  );
  await expect(interim).not.toHaveAttribute("code-block-controls", "");
  await expect(interim.locator("pre > code")).toHaveText("interim-only\n");
  await expect(interim.locator("caffold-task-markdown-code-block")).toHaveCount(0);
  await expect(page.locator(".task-turn-work [data-code-action]")).toHaveCount(0);
  await expect(page.locator(".task-command [data-code-action]")).toHaveCount(0);
  expect(scenario.pageErrors).toEqual([]);
});

test("keeps Markdown fallback text plain", { tag: "@desktop" }, async ({ page }) => {
  const scenario = await seedCodeBlockTask(page, "thread_code_fallback");
  await page.evaluate(() => {
    const fallback = document.createElement("caffold-task-markdown");
    fallback.id = "markdown-fallback-probe";
    fallback.setAttribute("code-block-controls", "");
    fallback.textContent = "[[caffold-test:markdown-error]]";
    document.body.append(fallback);
  });
  const fallback = page.locator("#markdown-fallback-probe");
  await expect(fallback).toHaveAttribute("data-render-state", "plain");
  await expect(fallback.locator(".markdown-fallback")).toHaveText(
    "[[caffold-test:markdown-error]]",
  );
  await expect(fallback.locator("caffold-task-markdown-code-block, [data-code-action]"))
    .toHaveCount(0);
  expect(scenario.pageErrors).toEqual([]);
});

test("keeps opt-in code blocks current across rerenders", { tag: "@desktop" }, async ({
  page,
}) => {
  const scenario = await seedCodeBlockTask(page, "thread_code_rerender");

  await page.evaluate((rawLabel) => {
    const shell = document.createElement("div");
    shell.id = "standalone-code-block-probe";
    shell.style.cssText = "position:fixed;left:-1000px;top:0;width:128px";
    const markdown = document.createElement("caffold-task-markdown");
    markdown.id = "standalone-markdown-probe";
    markdown.setAttribute("code-block-controls", "");
    markdown.textContent = "```text\nstale\n```";
    shell.append(markdown);
    document.body.append(shell);
    markdown.setMarkdown("```rust\nolder\n```");
    markdown.setMarkdown("```" + rawLabel + "\nfresh\n```");
  }, RAW_LABEL);

  const probe = page.locator("#standalone-markdown-probe");
  await expect(probe).toHaveAttribute("data-render-state", "markdown");
  await expect(probe.locator("caffold-task-markdown-code-block")).toHaveCount(1);
  await expect(probe.locator(".code-block-label")).toHaveText(RAW_LABEL);
  await expect(probe.locator("pre > code")).toHaveText("fresh\n");
  await expect(probe.getByRole("button", { name: "Copy code" })).toHaveCount(1);
  await expect(probe.getByRole("button", { name: "Wrap code lines" })).toHaveCount(1);
  const standaloneGeometry = await probe.evaluate((markdown) => {
    const wrapper = markdown.querySelector(
      "caffold-task-markdown-code-block",
    );
    const header = wrapper.querySelector(":scope > .code-block-header");
    const actions = header.querySelector(":scope > .code-block-actions");
    return {
      actionsInside: actions.getBoundingClientRect().right <=
        header.getBoundingClientRect().right + 0.5,
      wrapperInside: wrapper.scrollWidth <= wrapper.clientWidth,
    };
  });
  expect(standaloneGeometry).toEqual({
    actionsInside: true,
    wrapperInside: true,
  });

  await page.evaluate(() => {
    let release;
    window.__pendingCodeCopy = new Promise((resolve) => {
      release = resolve;
    });
    window.__releaseCodeCopy = release;
    window.__standaloneCopyCalls = 0;
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        window.__standaloneCopyCalls += 1;
        await window.__pendingCodeCopy;
      },
    });
  });
  await probe.getByRole("button", { name: "Copy code" }).evaluate((button) => {
    button.click();
  });
  await expect(probe.getByRole("button", { name: "Copying code" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await probe.evaluate((markdown) => {
    markdown.setMarkdown("```text\ncurrent\n```");
  });
  await expect(probe.locator("pre > code")).toHaveText("current\n");
  await page.evaluate(() => window.__releaseCodeCopy());
  await expect(probe.getByRole("button", { name: "Copy code" })).toBeEnabled();
  await expect(probe.locator(".code-block-label")).toHaveText("text");
  await expect(probe.locator("caffold-task-markdown-code-block")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__standaloneCopyCalls)).toBe(1);
  expect(scenario.pageErrors).toEqual([]);
});

async function seedCodeBlockTask(page, threadId, { activeThinking = false } = {}) {
  const scenario = await installTaskLoopFixture(page, {
    threadId,
    completedAssistantResponse: [
      "## Code controls",
      "",
      "Inline `inline-only` code stays outside the toolbar.",
      "",
      "```rust",
      ...FIRST_CODE.slice(0, -1).split("\n"),
      "```",
      "",
      "```",
      ...SECOND_CODE.slice(0, -1).split("\n"),
      "```",
      "",
      '<button aria-label="Injected control">Untrusted control</button>',
      '<caffold-task-markdown-code-block data-code-wrap="on">',
      '<button aria-label="Injected component control">Untrusted component</button>',
      "</caffold-task-markdown-code-block>",
    ].join("\n"),
  });
  await scenario.seedCompletedTask();

  scenario.events = scenario.events.map((event) => {
    if (event.id === "event_1_user") {
      return {
        ...event,
        payload: {
          ...event.payload,
          text: [
            "# Files mentioned by the user:",
            "",
            "## planner-layout.png: /tmp/planner-layout.png",
            "",
            "## My request for Codex:",
            "Run this command:",
            "",
            "```sh",
            "printf '<user>&'",
            "```",
          ].join("\n"),
        },
      };
    }
    if (event.id === "item-9") {
      return {
        ...event,
        payload: {
          ...event.payload,
          text: "Interim output\n\n```text\ninterim-only\n```",
        },
      };
    }
    return event;
  });

  if (activeThinking) {
    scenario.events = [
      ...scenario.events,
      scenario.eventRecord(
        "turn_2_started",
        "turn_started",
        "Turn started",
        { turnId: "turn_2" },
        20,
      ),
      scenario.eventRecord(
        "turn_2_reasoning",
        "reasoning",
        "Reasoning summary",
        {
          turnId: "turn_2",
          summary: ["Thinking details\n\n```text\nthinking-only\n```"],
        },
        21,
      ),
      scenario.eventRecord(
        "turn_2_commentary",
        "assistant_message",
        "Interim output",
        {
          turnId: "turn_2",
          phase: "progress",
          text: "Interim output\n\n```text\ninterim-only\n```",
        },
        22,
      ),
    ];
    scenario.updateTask({
      ...canonicalTaskState("active", {
        turnId: "turn_2",
        latestTurnStatus: "inProgress",
      }),
      lastEventSummary: "Reasoning summary",
    });
  }

  await page.goto("/tasks/" + scenario.threadId);
  await expect(
    page.locator(
      '.task-message[data-message-role="assistant"][data-message-phase="final"] caffold-task-markdown',
    ),
  ).toHaveAttribute("data-render-state", "markdown");
  return scenario;
}
