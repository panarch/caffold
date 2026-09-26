import { expect } from "@playwright/test";

export {
  activeLiveUpdateChannels,
  activeWatchSubscriptionId,
  emitTaskDetailBootstrap,
  installEventSourceMock,
  installEventSourceMockInBrowser,
  installTaskSseControllerInBrowser,
  isWatchSubscriptionClosed,
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
    section.tasks.push(activeListTask(task));
  }
  return {
    sections: [...sectionsByName.values()],
    unsectioned: recovery.map((task) => ({
      ...activeListTask(task),
      recovery: task.recovery,
    })),
  };
}

/**
 * The Active list row a Task fixture stands for.
 *
 * The list is sent these values and nothing else. A fixture in a linked
 * worktree stands for a Task running in a worktree Caffold made.
 */
export function activeListTask(task) {
  return {
    threadId: task.threadId ?? task.id,
    title: task.title,
    threadStatus: task.threadStatus,
    unseen: Boolean(task.unseen),
    lastCompletedMs: task.lastCompletedMs ?? null,
    recencyMs: task.recencyMs ?? null,
    updatedMs: task.updatedMs,
    worktree: task.worktree === true || task.worktree?.linked === true,
  };
}

export function createdTaskResponse(detail, activeTopPlacement) {
  return {
    detail,
    activeTask: activeListTask(detail.task),
    activeTopPlacement,
  };
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

export const UPLOAD_FOLDER_PATTERN = "\\d{8}-\\d{6}-[0-9a-z]{4}";

// Answers a Task's file uploads the way Caffold does, and keeps what arrived:
// each file's upload path and bytes, and each send folder discarded.
export async function routeTaskUploads(page, { respond } = {}) {
  const record = { uploads: [], discarded: [] };
  await page.route(/\/api\/tasks\/[^/]+\/uploads\//, async (route) => {
    const request = route.request();
    const [, , threadId, , folder, name] = new URL(request.url())
      .pathname.split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (request.method() === "DELETE") {
      record.discarded.push(folder);
      return route.fulfill({ status: 204 });
    }
    const path = `.caffold/uploads/${folder}/${name}`;
    const upload = { threadId, folder, name, path, bytes: request.postDataBuffer() };
    record.uploads.push(upload);
    const answer = (await respond?.(upload)) ?? {
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ path }),
    };
    // A browser that cancelled the upload is no longer waiting for an answer.
    return route.fulfill(answer).catch(() => {});
  });
  return record;
}

export function withAttachedFiles(prompt, paths) {
  const list = ["Attached files:", ...paths.map((path) => `- ${path}`)].join("\n");
  return prompt ? `${prompt}\n\n${list}` : list;
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

export const AGENT_MODELS_FIXTURE = {
  models: [
    {
      provider: "codex",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      isDefault: true,
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      supportsFastMode: true,
    },
  ],
  unavailable: [],
};

export async function mockAgentModels(page) {
  await page.route(/\/api\/agent\/models(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(AGENT_MODELS_FIXTURE),
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
