import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHint,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

const ER_SOURCE = [
  "erDiagram",
  "    TASK ||--o{ MESSAGE : contains",
  "    MESSAGE ||--o{ DIAGRAM : includes",
  "    TASK {",
  "        string id PK",
  "        string title",
  "    }",
  "    MESSAGE {",
  "        string id PK",
  "        string taskId FK",
  "        string content",
  "    }",
  "    DIAGRAM {",
  "        string source",
  "        string svg",
  "    }",
].join("\n");

const KOREAN_SOURCE = [
  "flowchart TD",
  "    A[Mermaid 원문] --> B{렌더링 결과}",
  "    B -->|성공| C[다이얼로그 도표]",
  "    B -->|실패| D[오류와 원문]",
].join("\n");

const SEQUENCE_SOURCE = [
  "sequenceDiagram",
  "    actor U as 사용자",
  "    participant C as Caffold",
  "    U->>C: Preview Mermaid",
  "    C-->>U: 다이얼로그 도표",
].join("\n");

const STATE_SOURCE = [
  "stateDiagram-v2",
  "    [*] --> Code",
  "    Code --> Dialog: Preview Mermaid",
  "    Dialog --> Code: 닫기",
].join("\n");

const CLASS_SOURCE = [
  "classDiagram",
  "    class MermaidDiagram {",
  "        +String source",
  "        +render()",
  "    }",
  "    MermaidDiagram --> Mermaid : 그리기",
].join("\n");

const PIE_SOURCE = [
  "pie title 작업 구성",
  '    "구현" : 50',
  '    "테스트" : 30',
  '    "문서" : 20',
].join("\n");

const WIDE_STEPS = Array.from({ length: 9 }, (_, index) =>
  `    N${index}[단계 ${index + 1} 길게 쓴 노드] --> N${index + 1}[단계 ${index + 2} 길게 쓴 노드]`);

const WIDE_SOURCE = ["flowchart LR", ...WIDE_STEPS].join("\n");

const LINKED_SOURCE = [
  "flowchart LR",
  "    D[Documentation] --> N0",
  ...WIDE_STEPS,
  '    click D "https://example.com/docs" "Documentation"',
].join("\n");

const MERMAID_ENTRY = "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.esm.min.mjs";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("previews a Mermaid fence in a modal with labels inside their boxes", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_draw", [
    mermaidFence(ER_SOURCE),
    "```rust\nfn main() {}\n```",
    mermaidFence(KOREAN_SOURCE),
  ]);
  const blocks = finalMarkdown(page).locator("caffold-task-code-block");
  const previewButton = blocks.nth(0).getByRole("button", { name: "Preview Mermaid" });
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");

  await expect(blocks.nth(0).locator("pre")).toHaveText(ER_SOURCE);
  expect(await previewButton.getAttribute("aria-pressed")).toBeNull();
  await expect(blocks.nth(1).getByRole("button", { name: /^Preview/ })).toHaveCount(0);

  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog.getByRole("heading", { name: "Mermaid preview" })).toBeVisible();
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await expect(diagram.locator("svg")).toHaveCount(1);
  await expect(diagram).toContainText("MESSAGE");
  const erLabels = await labelFit(diagram);
  expect(erLabels.checked).toBeGreaterThan(4);
  expect(erLabels.overflowing).toEqual([]);
  await captureReviewScreenshot(page, testInfo, "task-mermaid-preview-dialog-er");

  const label = diagram.getByText("contains", { exact: true });
  const box = await label.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection().toString())).toContain("contain");

  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();

  await previewButton.click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await page.mouse.click(1, 1);
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();

  const koreanPreview = blocks.nth(2).getByRole("button", { name: "Preview Mermaid" });
  await koreanPreview.click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await expect(diagram).toContainText("다이얼로그 도표");
  await expect(diagram).not.toContainText("MESSAGE");
  const koreanLabels = await labelFit(diagram);
  expect(koreanLabels.checked).toBeGreaterThan(3);
  expect(koreanLabels.overflowing).toEqual([]);
  await dialog.getByRole("button", { name: "Close Mermaid preview" }).click();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(koreanPreview).toBeFocused();
  expect(scenario.pageErrors).toEqual([]);
});

test("draws the common diagram types with labels inside their boxes", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  const diagrams = [
    ["flowchart", KOREAN_SOURCE, "다이얼로그 도표"],
    ["sequence", SEQUENCE_SOURCE, "사용자"],
    ["state", STATE_SOURCE, "닫기"],
    ["class", CLASS_SOURCE, "MermaidDiagram"],
    ["er", ER_SOURCE, "MESSAGE"],
    ["pie", PIE_SOURCE, "구현"],
  ];
  const scenario = await seedMermaidTask(
    page,
    "thread_mermaid_preview_types",
    diagrams.map(([, source]) => mermaidFence(source)),
  );
  const blocks = finalMarkdown(page).locator("caffold-task-code-block");
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");

  for (const [index, [name, , text]] of diagrams.entries()) {
    await blocks.nth(index).getByRole("button", { name: "Preview Mermaid" }).click();
    await expect(dialog).toHaveAttribute("open", "");
    await expect(diagram).toHaveAttribute("data-render-state", "ready");
    await expect(diagram).toContainText(text);
    const size = await diagram.evaluate((element) => {
      const box = element.shadowRoot.querySelector("svg").getBoundingClientRect();
      return [box.width, box.height];
    });
    expect(Math.min(...size), name).toBeGreaterThan(50);
    expect((await labelFit(diagram)).overflowing, name).toEqual([]);
    await captureReviewScreenshot(page, testInfo, `task-mermaid-preview-dialog-${name}`);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toHaveAttribute("open", "");
  }
  expect(scenario.pageErrors).toEqual([]);
});

test("keeps a wide diagram at its natural size inside the Markdown preview's frame", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedMermaidTask(page, `thread_mermaid_preview_wide_${testInfo.project.name}`, [
    "```markdown\n# Reference\n```",
    mermaidFence(WIDE_SOURCE),
  ]);
  const blocks = finalMarkdown(page).locator("caffold-task-code-block");
  const markdownDialog = page.locator("caffold-task-markdown-preview-dialog > dialog");
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");

  await blocks.nth(0).getByRole("button", { name: "Preview Markdown" }).click();
  await expect(markdownDialog).toHaveAttribute("open", "");
  const reference = await markdownDialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const header = element.querySelector(".task-markdown-preview-header").getBoundingClientRect();
    return { box: [box.left, box.top, box.width, box.height], header: header.height };
  });
  await page.keyboard.press("Escape");
  await expect(markdownDialog).not.toHaveAttribute("open", "");

  await blocks.nth(1).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  const frame = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const header = element.querySelector(".task-mermaid-preview-header").getBoundingClientRect();
    return { box: [box.left, box.top, box.width, box.height], header: header.height };
  });
  expect(frame).toEqual(reference);

  const geometry = await diagram.evaluate((element) => {
    const svg = element.shadowRoot.querySelector("svg");
    return {
      natural: svg.viewBox.baseVal.width,
      drawn: svg.getBoundingClientRect().width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(Math.abs(geometry.drawn - geometry.natural)).toBeLessThan(1);
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  // The diagram keeps the same inset at the start and at the end of its scroll.
  const startInset = await diagram.evaluate((element) => {
    const port = element.getBoundingClientRect().left + element.clientLeft;
    return element.shadowRoot.querySelector("svg").getBoundingClientRect().left - port;
  });
  await diagram.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => diagram.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const endInset = await diagram.evaluate((element) => {
    const port = element.getBoundingClientRect().left + element.clientLeft + element.clientWidth;
    return port - element.shadowRoot.querySelector("svg").getBoundingClientRect().right;
  });
  expect(startInset).toBeGreaterThan(8);
  expect(Math.abs(endInset - startInset)).toBeLessThanOrEqual(1);
  await captureReviewScreenshot(page, testInfo, "task-mermaid-preview-dialog-wide");
  expect(scenario.pageErrors).toEqual([]);
});

test("draws the diagram again in the dark theme while it is open", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_theme", [
    mermaidFence(KOREAN_SOURCE),
  ]);
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");
  await finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  expect(await labelLightness(diagram)).toBeLessThan(0.5);
  await diagram.evaluate((element) => {
    window.__mermaidSvg = element.shadowRoot.querySelector("svg");
  });

  await page.evaluate(async () => {
    const { applyThemeMode } = await import("/assets/theme.js");
    applyThemeMode("dark");
  });
  await expect.poll(() => diagram.evaluate((element) =>
    element.shadowRoot.querySelector("svg") !== window.__mermaidSvg)).toBe(true);
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  expect(await labelLightness(diagram)).toBeGreaterThan(0.5);
  await expect(dialog).toHaveAttribute("open", "");
  const labels = await labelFit(diagram);
  expect(labels.overflowing).toEqual([]);
  await captureReviewScreenshot(page, testInfo, "task-mermaid-preview-dialog-dark");
  expect(scenario.pageErrors).toEqual([]);
});

test("shows the reason, the source, and Retry for a diagram Mermaid cannot read", { tag: "@server-steady" }, async ({
  page,
}) => {
  const broken = "flowchart LR\n    A[unclosed --> B";
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_error", [
    mermaidFence(broken),
  ]);
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");
  await finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "error");
  await expect(diagram.locator(".error > p")).toContainText(/\S/);
  await expect(diagram.getByLabel("Mermaid source")).toHaveText(broken);
  await expect(diagram.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(diagram.locator("svg")).toHaveCount(0);
  // Mermaid draws no error diagram of its own into the page.
  expect(await page.evaluate(() =>
    document.querySelectorAll('[id^="caffold-mermaid-"], [id^="dcaffold-mermaid-"]').length)).toBe(0);
  expect(scenario.pageErrors).toEqual([]);
});

test("asks for Mermaid again on Retry after the library failed to arrive", { tag: "@server-changes" }, async ({
  page,
}) => {
  let entryRequests = 0;
  await page.route(MERMAID_ENTRY, (route) => {
    entryRequests += 1;
    return entryRequests === 1 ? route.abort() : route.fallback();
  });
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_offline", [
    mermaidFence(KOREAN_SOURCE),
  ]);
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");
  await finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "error");
  await expect(diagram.getByLabel("Mermaid source")).toHaveText(KOREAN_SOURCE);

  await diagram.getByRole("button", { name: "Retry" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await expect(diagram).toContainText("다이얼로그 도표");
  expect(entryRequests).toBe(2);
  expect(scenario.pageErrors).toEqual([]);
});

test("drives the preview with Action Hints and Scroll mode", { tag: "@server-steady" }, async ({
  page,
}) => {
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_keyboard", [
    mermaidFence(LINKED_SOURCE),
  ]);
  const previewButton = finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" });
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");
  const modalHud = dialog.locator(
    ":scope > caffold-keyboard-navigation-presentation caffold-scroll-mode-hud .scroll-mode-status",
  );

  await previewButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await activateActionHint(page, /Preview Mermaid$/);
  await expect(dialog).toHaveAttribute("open", "");
  await expect(diagram).toHaveAttribute("data-render-state", "ready");

  await page.keyboard.press("f");
  const modalHint = actionHintDialog(page);
  await expect(modalHint).toBeVisible();
  await expect(
    modalHint.getByRole("button", { name: / — Close Mermaid preview$/ }),
  ).toBeVisible();
  await expect(
    modalHint.getByRole("button", { name: / — Open Documentation/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modalHint).toBeHidden();
  await expect(dialog).toHaveAttribute("open", "");

  await page.keyboard.press("s");
  await expect(modalHud).toContainText("Scroll: Mermaid preview");
  await page.keyboard.press("l");
  await expect.poll(() => diagram.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(modalHud).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(previewButton).toBeFocused();
  expect(scenario.pageErrors).toEqual([]);
});

test("follows a diagram link from its Action Hint the way the link itself does", { tag: "@server-steady" }, async ({
  page,
}) => {
  await page.route("https://example.com/docs", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Diagram documentation</title>" }));
  await seedMermaidTask(page, "thread_mermaid_preview_link", [
    mermaidFence(LINKED_SOURCE),
  ]);
  const dialog = mermaidDialog(page);
  const diagram = dialog.locator("caffold-task-mermaid-diagram");
  await finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "ready");

  await page.keyboard.press("f");
  const badge = actionHintDialog(page).getByLabel(/Open Documentation/);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await page.keyboard.type(code.toLowerCase());
  await expect(page).toHaveURL("https://example.com/docs");
});

test("closes the preview when another Task opens", { tag: "@server-steady" }, async ({
  page,
}) => {
  const scenario = await seedMermaidTask(page, "thread_mermaid_preview_lifecycle", [
    mermaidFence(KOREAN_SOURCE),
  ]);
  const dialog = mermaidDialog(page);
  await finalMarkdown(page).getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(dialog).toHaveAttribute("open", "");

  await page.locator("caffold-tasks-page").evaluate((element) => {
    element.prepareRoute({ kind: "tasks", threadId: "thread_mermaid_preview_other" });
  });
  await expect(dialog).not.toHaveAttribute("open", "");
  expect(scenario.pageErrors).toEqual([]);
});

function mermaidFence(source) {
  return "```mermaid\n" + source + "\n```";
}

function mermaidDialog(page) {
  return page.locator("caffold-task-mermaid-preview-dialog > dialog");
}

function finalMarkdown(page) {
  return page.locator(
    'caffold-task-assistant-message[data-message-phase="final"] caffold-task-markdown',
  );
}

async function seedMermaidTask(page, threadId, fences) {
  const scenario = await installTaskLoopFixture(page, {
    threadId,
    completedAssistantResponse: ["Here is the diagram.", ...fences].join("\n\n"),
  });
  await scenario.seedCompletedTask();
  await page.goto("/tasks/" + scenario.threadId);
  await expect(finalMarkdown(page)).toHaveAttribute("data-render-state", "markdown");
  return scenario;
}

// Every HTML label must fit the box Mermaid measured for it.
function labelFit(diagram) {
  return diagram.evaluate((element) => {
    const overflowing = [];
    let checked = 0;
    for (const box of element.shadowRoot.querySelectorAll("svg foreignObject")) {
      const content = box.firstElementChild;
      const boxWidth = box.getBoundingClientRect().width;
      if (!content || !content.textContent.trim() || boxWidth === 0) continue;
      checked += 1;
      const contentWidth = content.scrollWidth;
      if (contentWidth > boxWidth + 1) {
        overflowing.push({ text: content.textContent.trim(), boxWidth, contentWidth });
      }
    }
    return { checked, overflowing };
  });
}

// Lightness (0–1) of a node label's text color.
function labelLightness(diagram) {
  return diagram.evaluate((element) => {
    const label = element.shadowRoot.querySelector("svg .nodeLabel");
    const [red, green, blue] = getComputedStyle(label).color.match(/\d+(\.\d+)?/g).map(Number);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  });
}
