import { expect, test } from "@playwright/test";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";
import {
  captureReviewScreenshot,
  emitTaskDetailBootstrap,
} from "../support/task-fixtures.js";

test("keeps conversation position stable while the follow-up composer grows", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const detail = await installScrollableTask(page);
  await page.goto("/tasks/thread-1?cwd=src");
  await emitTaskDetailBootstrap(page, detail);

  const form = page.locator(
    'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) .task-follow-up-form[data-task-form="follow-up"]',
  );
  const prompt = form.getByRole("textbox", { name: "Follow-up prompt" });
  const scroller = page.locator(".task-conversation-scroll");
  await expect(page.getByText("Existing conversation block 8.")).toBeVisible();
  await expect
    .poll(() => composerReady(form))
    .toBe(true);
  await expect
    .poll(() => scrollPosition(scroller))
    .toEqual(expect.objectContaining({ overflow: true, atBottom: true }));

  const rapidTransitions = await rapidComposerLayoutTransitions(prompt);
  expect(rapidTransitions).toHaveLength(6);
  for (const transition of rapidTransitions) {
    expect(transition.atBottom, `${transition.lines} line layout`).toBe(true);
    expect(
      transition.lastEventBottom,
      `${transition.lines} line last event`,
    ).toBeLessThanOrEqual(transition.conversationBottom + 1);
  }

  await prompt.fill("One");
  for (const line of ["Two", "Three", "Four", "Five"]) {
    await prompt.press("Shift+Enter");
    await prompt.type(line);
  }
  await expect
    .poll(() => composerLayout(form))
    .toEqual(expect.objectContaining({ atBottom: true }));

  const expanded = await composerLayout(form);
  expect(expanded.lastEventBottom).toBeLessThanOrEqual(
    expanded.conversationBottom + 1,
  );
  expect(expanded.conversationBottom).toBeLessThanOrEqual(expanded.panelTop + 1);
  await captureReviewScreenshot(
    page,
    testInfo,
    "tasks-follow-up-composer-expanded",
  );

  await prompt.fill(
    Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n"),
  );
  const capped = await composerLayout(form);
  expect(capped.textareaScrollHeight).toBeGreaterThan(capped.textareaHeight);
  expect(capped.textareaOverflowY).toBe("auto");
  expect(capped.textareaHeight).toBeLessThanOrEqual(
    Math.min(capped.lineHeight * 8 + capped.padding, capped.viewportHeight * 0.32) +
      1,
  );

  await prompt.fill("");
  await expect.poll(async () => (await composerLayout(form)).atBottom).toBe(true);
  const anchorBefore = await captureUserScrollAnchor(scroller);
  await prompt.fill("One\nTwo\nThree\nFour\nFive");
  await expect
    .poll(() => anchorOffsetDelta(scroller, anchorBefore))
    .toBe(0);
  await expect
    .poll(() => scrollPosition(scroller))
    .toEqual(expect.objectContaining({ atBottom: false }));
});

for (const themeMode of ["light", "dark"]) {
  test(`fades ${themeMode} conversation content into the follow-up composer band`, { tag: "@all-viewports" }, async ({
    page,
  }, testInfo) => {
    const detail = await installScrollableTask(page, {
      themeMode,
      trailingText: `| Fade | check |\n| --- | --- |\n${Array.from(
        { length: 60 },
        (_, index) => `| row ${index + 1} | row ${index + 1} |`,
      ).join("\n")}`,
    });
    await page.goto("/tasks/thread-1?cwd=src");
    await emitTaskDetailBootstrap(page, detail);

    const form = page.locator(
      'caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden]) .task-follow-up-form[data-task-form="follow-up"]',
    );
    const scroller = page.locator(".task-conversation-scroll");
    await expect(scroller.locator("table")).toBeVisible();
    await expect
      .poll(() => composerReady(form))
      .toBe(true);
    await expect
      .poll(() => scrollPosition(scroller))
      .toEqual(expect.objectContaining({ overflow: true, atBottom: true }));

    const range = await scrollRangeBeyondContent(scroller);
    expect(Math.abs(range.beyondContent - range.paddingBottom)).toBeLessThanOrEqual(1);

    await scroller.evaluate((element) => {
      const table = element.querySelector("table");
      element.scrollTop +=
        table.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => scrollPosition(scroller))
      .toEqual(expect.objectContaining({ atBottom: false }));

    const screenshot = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    await captureReviewScreenshot(
      page,
      testInfo,
      `tasks-follow-up-composer-fade-${themeMode}`,
    );
    const edge = await bottomEdgeContrast(page, screenshot);
    expect(edge.borderAtEdge).toBeLessThan(3);
    expect(edge.borderAboveFade).toBeGreaterThan(20);
    for (const [index, channel] of edge.shadowAtEdge.entries()) {
      expect(channel, `shadow channel ${index}`).toBeLessThan(edge.surface[index]);
    }
  });
}

async function installScrollableTask(page, { themeMode, trailingText = "" } = {}) {
  await installTaskApiFixture(page);
  await page.addInitScript((mode) => {
    localStorage.setItem(
      "caffold:settings",
      JSON.stringify({
        themeMode: mode,
        uiTypefacePreset: "geist-sans",
        codeTypefacePreset: "geist-mono",
        interfaceScalePercent: 120,
        conversationTextPx: 20,
        codeTextPx: 13,
      }),
    );
  }, themeMode);
  const detail = taskDetailFixture();
  const texts = Array.from(
    { length: 8 },
    (_, index) =>
      `Existing conversation block ${index + 1}.\n\n${"Keep this transcript scrollable. ".repeat(4)}`,
  );
  if (trailingText) {
    texts.push(trailingText);
  }
  detail.events = texts.map((text, index) => ({
    id: `event_composer_resize_${index}`,
    threadId: detail.threadId,
    type: "assistant_message",
    summary: "Assistant response",
    payload: {
      turnId: `turn_composer_resize_${index}`,
      text,
    },
    position: { anchorMs: 1_767_300_000_000 + index, index: 0 },
  }));
  await page.route("**/api/tasks/thread-1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }),
  );
  return detail;
}

function composerReady(form) {
  return form.evaluate((element) => {
    const turnOptions = element.querySelector("caffold-task-turn-options");
    return Boolean(
      turnOptions?.isConnected && turnOptions.readyForSubmission(),
    );
  });
}

function scrollPosition(scroller) {
  return scroller.evaluate((element) => ({
    overflow: element.scrollHeight > element.clientHeight,
    atBottom:
      element.scrollHeight - element.clientHeight - element.scrollTop <= 2,
  }));
}

function scrollRangeBeyondContent(scroller) {
  return scroller.evaluate((element) => {
    const column = element.querySelector(".task-conversation-column");
    const contentEnd =
      column.getBoundingClientRect().bottom -
      element.getBoundingClientRect().top +
      element.scrollTop;
    return {
      beyondContent: element.scrollHeight - contentEnd,
      paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
    };
  });
}

function bottomEdgeContrast(page, screenshot) {
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))]),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const color = (x, y) => {
      const offset = (Math.floor(y) * bitmap.width + Math.floor(x)) * 4;
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    };

    const scroller = document.querySelector(".task-conversation-scroll");
    const panel = document.querySelector(".task-follow-up-form .task-composer-panel");
    const bottom = Math.floor(scroller.getBoundingClientRect().bottom) - 1;
    const fadeHeight = Number.parseFloat(getComputedStyle(scroller, "::after").height);
    // The table's middle divider sits away from the panel's sides, where the
    // panel's shadow is even.
    const divider = Math.round(
      scroller.querySelector("table th:nth-child(2)").getBoundingClientRect().left,
    );
    const borderContrast = (y) => {
      const beside = color(divider - 8, y);
      return Math.max(
        ...[divider - 1, divider, divider + 1].flatMap((x) =>
          color(x, y).map((channel, index) => Math.abs(channel - beside[index])),
        ),
      );
    };
    const panelBox = panel.getBoundingClientRect();
    return {
      // Several rows, so a row border crossing one of them cannot hide the divider.
      borderAboveFade: Math.max(
        ...[0, 1, 2, 3].map((offset) => borderContrast(bottom - fadeHeight - 4 - offset)),
      ),
      borderAtEdge: borderContrast(bottom),
      shadowAtEdge: color(panelBox.left + panelBox.width * 0.75, bottom),
      surface: getComputedStyle(panel.closest("form"))
        .backgroundColor.match(/\d+/g)
        .slice(0, 3)
        .map(Number),
    };
  }, screenshot.toString("base64"));
}

function composerLayout(form) {
  return form.evaluate((element) => {
    const textarea = element.querySelector("textarea[name='prompt']");
    const panel = element.querySelector(".task-composer-panel");
    const conversation = document.querySelector(".task-conversation-scroll");
    const events = [...conversation.querySelectorAll(".task-event[data-event-id]")];
    const lastEvent = events.at(-1);
    const textareaStyle = getComputedStyle(textarea);
    return {
      atBottom:
        conversation.scrollHeight -
          conversation.clientHeight -
          conversation.scrollTop <=
        2,
      conversationBottom: conversation.getBoundingClientRect().bottom,
      lastEventBottom: lastEvent.getBoundingClientRect().bottom,
      panelTop: panel.getBoundingClientRect().top,
      textareaHeight: textarea.getBoundingClientRect().height,
      textareaScrollHeight: textarea.scrollHeight,
      textareaOverflowY: textareaStyle.overflowY,
      lineHeight: Number.parseFloat(textareaStyle.lineHeight),
      padding:
        Number.parseFloat(textareaStyle.paddingTop) +
        Number.parseFloat(textareaStyle.paddingBottom),
      viewportHeight: window.innerHeight,
    };
  });
}

function rapidComposerLayoutTransitions(prompt) {
  return prompt.evaluate((textarea) => {
    const conversation = document.querySelector(".task-conversation-scroll");
    const lastEvent = [
      ...conversation.querySelectorAll(".task-event[data-event-id]"),
    ].at(-1);
    return [6, 1, 8, 2, 7, 1].map((lines) => {
      textarea.value = Array.from(
        { length: lines },
        (_, index) => `Rapid line ${index + 1}`,
      ).join("\n");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return {
        lines,
        atBottom:
          conversation.scrollHeight -
            conversation.clientHeight -
            conversation.scrollTop <=
          2,
        conversationBottom: conversation.getBoundingClientRect().bottom,
        lastEventBottom: lastEvent.getBoundingClientRect().bottom,
      };
    });
  });
}

function captureUserScrollAnchor(scroller) {
  return scroller.evaluate((element) => {
    element.scrollTop = Math.floor(
      (element.scrollHeight - element.clientHeight) / 2,
    );
    element.dispatchEvent(new Event("scroll"));
    const scrollerRect = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll(".task-event[data-event-id]")].find(
      (event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1,
    );
    return {
      eventId: anchor.dataset.eventId,
      offset: anchor.getBoundingClientRect().top - scrollerRect.top,
    };
  });
}

function anchorOffsetDelta(scroller, anchor) {
  return scroller.evaluate((element, expected) => {
    const event = element.querySelector(
      `.task-event[data-event-id="${expected.eventId}"]`,
    );
    return Math.round(
      event.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        expected.offset,
    );
  }, anchor);
}
