import { expect } from "@playwright/test";

export {
  emitTaskDetailBootstrap,
  installEventSourceMock,
  installEventSourceMockInBrowser,
  installTaskSseControllerInBrowser,
  openTaskWithBootstrap,
} from "./task-sse-fixture.js";

export const PASTED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function activeTaskProjection(tasks = [], recovery = []) {
  const sectionsByName = new Map();
  for (const task of tasks) {
    const repository = Boolean(task?.worktree);
    const name = `${
      task?.worktree?.repositoryRootPath ??
      task?.worktree?.rootPath ??
      task?.cwdPath ??
      task?.cwd ??
      task?.relativeCwd ??
      ""
    }`;
    let section = sectionsByName.get(name);
    if (!section) {
      section = {
        id: `fixture-section-${sectionsByName.size + 1}`,
        name,
        repository,
        tasks: [],
      };
      sectionsByName.set(name, section);
    }
    section.repository ||= repository;
    section.tasks.push(task);
  }
  return { sections: [...sectionsByName.values()], unsectioned: recovery };
}

export function canonicalTaskState(
  type,
  {
    activeFlags = [],
    turnId = null,
    startedAtMs = null,
    latestTurnStatus = null,
  } = {},
) {
  return {
    threadStatus: {
      type,
      ...(type === "active" ? { activeFlags } : {}),
    },
    latestTurnStatus,
    activeTurn:
      type === "active" && turnId
        ? { id: turnId, startedAtMs }
        : null,
  };
}

export async function taskPresentation(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const visualStyle = getComputedStyle(element, "::before");
    const box = element.getBoundingClientRect();
    const visualInset = Number.parseFloat(visualStyle.top) || 0;
    return {
      alignItems: style.alignItems,
      animationName: style.animationName,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      color: style.color,
      cssHeight: style.height,
      cssWidth: style.width,
      display: style.display,
      fontSize: style.fontSize,
      height: Math.round(box.height),
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
      overflow: style.overflow,
      overflowWrap: style.overflowWrap,
      padding: style.padding,
      width: Math.round(box.width),
      visualBackgroundColor: visualStyle.backgroundColor,
      visualBorderColor: visualStyle.borderTopColor,
      visualBorderRadius: visualStyle.borderRadius,
      visualBorderWidth: visualStyle.borderTopWidth,
      visualHeight: box.height - visualInset * 2,
    };
  });
}

export async function pasteImage(locator, name = "clipboard-image.png") {
  await locator.evaluate(
    (textarea, { base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], fileName, { type: "image/png" }));
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    },
    { base64: PASTED_IMAGE_BASE64, fileName: name },
  );
}

export async function captureReviewScreenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach(`${name}-${testInfo.project.name}`, {
    path,
    contentType: "image/png",
  });
}

export async function mockCodexModels(page) {
  await page.route(/\/api\/codex\/models(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "Latest frontier agentic coding model.",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "low",
                description: "Fast responses with lighter reasoning",
              },
              {
                reasoningEffort: "medium",
                description: "Balances speed and reasoning depth for everyday tasks",
              },
              {
                reasoningEffort: "high",
                description: "Greater reasoning depth for complex problems",
              },
              {
                reasoningEffort: "xhigh",
                description: "Extra high reasoning depth for complex problems",
              },
              {
                reasoningEffort: "max",
                description: "Maximum reasoning depth for the hardest problems",
              },
              {
                reasoningEffort: "ultra",
                description: "Maximum reasoning with automatic task delegation",
              },
            ],
            serviceTiers: [
              {
                id: "priority",
                name: "Fast",
                description: "1.5x speed, increased usage",
              },
            ],
          },
        ],
        nextCursor: null,
      }),
    }),
  );
}

export async function scrollTop(locator) {
  return locator.evaluate((element) => element.scrollTop);
}

export async function isScrolledToBottom(locator) {
  return locator.evaluate((element) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    return maxScrollTop - element.scrollTop <= 8;
  });
}

export async function stabilizeDynamicText(page) {
  await page.addStyleTag({
    content: `
      [data-field="modified"] dd {
        color: transparent !important;
        font-size: 0 !important;
      }

      [data-field="modified"] dd::after {
        content: "fixture time";
        color: var(--text);
        font-size: 0.8rem;
      }
    `,
  });
}
