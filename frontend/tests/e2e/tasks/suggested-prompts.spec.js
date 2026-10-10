import { expect, test } from "@playwright/test";
import { activateActionHint } from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";

const ANSWER = "Created the comparison report.";
const SUGGESTED = [
  {
    label: "Compare vendors",
    prompt: "Compare the shared features of the two payment services.",
  },
  {
    label:
      "Trace one card payment from approval through settlement and the merchant notice, " +
      "naming every document, table, and screen the payment passes on its way",
    prompt: "Explain the card approval flow end to end from the documents.",
  },
  {
    label: "Review test logs",
    prompt: "Summarize the held and failed test cases and what was done about each.",
  },
];

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("offers each suggested request as a button of its own under the answer", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await seedSuggestedPromptTask(page, "thread_suggested_layout_" + testInfo.project.name);
  const answer = finalAnswer(page);
  const buttons = answer.locator(
    ":scope > caffold-task-assistant-message-suggested-prompts > button",
  );

  await expect(buttons).toHaveText(SUGGESTED.map(({ label }) => label));
  await expect(answer.locator(".task-assistant-message-body")).toHaveText(ANSWER);
  for (const button of await buttons.all()) {
    await expect(button.locator(".task-suggested-prompt-icon svg")).toBeVisible();
  }

  const layout = await answer.evaluate((message) => {
    const body = message.querySelector(":scope > .task-assistant-message-body");
    const controls = [...message.querySelectorAll(
      ":scope > caffold-task-assistant-message-suggested-prompts > button",
    )];
    // The approval card's button in the same conversation, from its tokens.
    const reference = document.createElement("span");
    reference.style.cssText = [
      "position: absolute",
      "border: 1px solid var(--border)",
      "border-radius: 5px",
      "background: var(--surface)",
      "color: var(--control-fg)",
      "font-size: var(--interface-meta-font-size)",
      "min-height: var(--interface-compact-visual-size)",
    ].join(";");
    message.append(reference);
    const look = (element) => {
      const style = getComputedStyle(element);
      return {
        border: [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
      };
    };
    const referenceLook = look(reference);
    const referenceHeight = parseFloat(getComputedStyle(reference).minHeight);
    reference.remove();
    const bodyBox = body.getBoundingClientRect();
    return {
      bodyLeft: bodyBox.left,
      bodyWidth: bodyBox.width,
      referenceLook,
      referenceHeight,
      buttons: controls.map((control) => {
        const box = control.getBoundingClientRect();
        const label = control.querySelector(".task-suggested-prompt-label");
        const labelBox = label.getBoundingClientRect();
        const iconBox = control.querySelector(".task-suggested-prompt-icon svg")
          .getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
        return {
          left: box.left,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          look: look(control),
          clipped: control.scrollWidth > control.clientWidth + 1,
          // How far the name stays from each edge, against the corner radius.
          inset: {
            left: labelBox.left - box.left,
            right: box.right - labelBox.right,
            top: labelBox.top - box.top,
            bottom: box.bottom - labelBox.bottom,
          },
          radius: parseFloat(getComputedStyle(control).borderTopLeftRadius),
          iconBeforeName: iconBox.right <= labelBox.left,
          iconOffFirstLine: Math.abs(
            (iconBox.top + iconBox.bottom) / 2 - (labelBox.top + lineHeight / 2),
          ),
        };
      }),
    };
  });

  for (const [index, button] of layout.buttons.entries()) {
    expect(button.look).toEqual(layout.referenceLook);
    expect(Math.abs(button.left - layout.bodyLeft)).toBeLessThanOrEqual(1);
    expect(button.width).toBeLessThanOrEqual(layout.bodyWidth + 1);
    expect(button.clipped).toBe(false);
    expect(button.inset.left).toBeGreaterThanOrEqual(button.radius);
    expect(button.inset.right).toBeGreaterThanOrEqual(button.radius);
    expect(button.inset.top).toBeGreaterThanOrEqual(1);
    expect(button.inset.bottom).toBeGreaterThanOrEqual(1);
    expect(button.iconBeforeName).toBe(true);
    expect(button.iconOffFirstLine).toBeLessThanOrEqual(1);
    if (index > 0) {
      expect(button.top).toBeGreaterThan(layout.buttons[index - 1].bottom);
    }
  }
  // A short name keeps its button as wide as the name, at the conversation's
  // compact button height; a long one fills the message and wraps inside.
  const [short, long] = layout.buttons;
  expect(short.width).toBeLessThan(layout.bodyWidth / 2);
  expect(short.height).toBeCloseTo(layout.referenceHeight, 0);
  expect(long.width).toBeGreaterThan(layout.bodyWidth - 2);
  expect(long.height).toBeGreaterThan(short.height + 4);
});

test("fills the Composer with the chosen request after what is being written", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await seedSuggestedPromptTask(page, "thread_suggested_fill");
  const prompt = page.getByRole("textbox", { name: "Follow-up prompt" });
  const answer = finalAnswer(page);

  await answer.getByRole("button", { name: SUGGESTED[0].label }).click();
  await expect(prompt).toHaveValue(SUGGESTED[0].prompt);
  await expect(prompt).toBeFocused();
  expect(await caretAtEnd(prompt)).toBe(true);

  await prompt.fill("Also check the refund path.");
  // Keyboard mode offers only what is in view, and choosing the first button
  // scrolled no further than that button, so the third is brought into view.
  await answer.getByRole("button", { name: SUGGESTED[2].label }).scrollIntoViewIfNeeded();
  await activateActionHint(page, SUGGESTED[2].label);
  await expect(prompt).toHaveValue(
    `Also check the refund path.\n\n${SUGGESTED[2].prompt}`,
  );
  await expect(prompt).toBeFocused();
  expect(await caretAtEnd(prompt)).toBe(true);
});

test("locks the buttons while the Task cannot be reached", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await seedSuggestedPromptTask(page, "thread_suggested_locked");
  const buttons = finalAnswer(page).locator(
    "caffold-task-assistant-message-suggested-prompts > button",
  );
  const setTransport = (transportState) =>
    page.locator("caffold-task-conversation").evaluate(
      (conversation, state) =>
        conversation.setSnapshot({ ...conversation.snapshot, transportState: state }),
      transportState,
    );

  await setTransport("reconnecting");
  for (const button of await buttons.all()) {
    await expect(button).toBeDisabled();
  }
  await expect(buttons).toHaveText(SUGGESTED.map(({ label }) => label));

  await setTransport("live");
  for (const button of await buttons.all()) {
    await expect(button).toBeEnabled();
  }
});

test("keeps a message that holds only suggestions", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await seedSuggestedPromptTask(page, "thread_suggested_only", { text: "" });
  const answer = finalAnswer(page);

  await expect(
    answer.locator("caffold-task-assistant-message-suggested-prompts > button"),
  ).toHaveText(SUGGESTED.map(({ label }) => label));
  await expect(answer.getByRole("button", { name: "Copy message" })).toBeHidden();
});

function finalAnswer(page) {
  return page.locator(
    'caffold-tasks-page caffold-task-assistant-message[data-message-phase="final"]',
  );
}

async function caretAtEnd(prompt) {
  return prompt.evaluate(
    (textarea) =>
      textarea.selectionStart === textarea.value.length &&
      textarea.selectionEnd === textarea.value.length,
  );
}

async function seedSuggestedPromptTask(page, threadId, { text = ANSWER } = {}) {
  const scenario = await installTaskLoopFixture(page, {
    threadId,
    completedAssistantResponse: text,
  });
  await scenario.seedCompletedTask();
  scenario.events = scenario.events.map((event) =>
    event.type === "assistant_message" && event.payload?.phase === "final"
      ? { ...event, payload: { ...event.payload, suggestedPrompts: SUGGESTED } }
      : event
  );
  await page.goto("/tasks/" + scenario.threadId);
  await expect(
    finalAnswer(page).locator("caffold-task-assistant-message-suggested-prompts"),
  ).toBeVisible();
  // The conversation settles its scroll once the answer's Markdown is drawn.
  await expect(finalAnswer(page).locator("caffold-task-markdown")).toHaveAttribute(
    "data-render-state",
    "markdown",
  );
  return scenario;
}
