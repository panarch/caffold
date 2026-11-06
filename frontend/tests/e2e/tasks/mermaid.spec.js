import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { workspaceTargets } from "../support/action-hints.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

const SOURCE = 'flowchart TD\nP["SQL planner"] --> S["공용 scalar 표현식·준비·평가"]\nE[Executor] --> S\nE --> A["Storage adapter"]\nA --> S\nA --> B["redb 등 저장 엔진"]\nclick P "https://example.com/planner"\n';
const fence = (source) => '```mermaid\n' + source + '```\n';

test.beforeEach(async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBrowserDefaults(page);
});

test("renders real server SVG inline and retains the fence through Markdown updates", { tag: "@all-viewports" }, async ({ page, browserName }, testInfo) => {
  const scenario = await installTaskLoopFixture(page, { threadId: `mermaid_${testInfo.project.name}`, completedAssistantResponse: fence(SOURCE) });
  await scenario.seedCompletedTask();
  await page.goto(`/tasks/${scenario.threadId}`);
  const markdown = page.locator('caffold-task-assistant-message[data-message-phase="final"] caffold-task-markdown');
  const block = markdown.locator("caffold-task-code-block");
  const diagram = block.locator("caffold-mermaid-view");
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await expect(diagram.locator("svg")).toHaveCount(1);
  await expect(diagram).toContainText("공용 scalar 표현식·준비·평가");
  await expect(block.locator("pre")).toBeHidden();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await diagram.evaluate((element) => {
    window.__mermaidView = element;
    window.__mermaidSvg = element.shadowRoot.querySelector("svg");
    const walker = document.createTreeWalker(window.__mermaidSvg, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes("공용 scalar")) {
        const range = document.createRange();
        range.selectNodeContents(node);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        break;
      }
    }
  });
  if (browserName === "webkit") {
    const label = diagram.getByText("공용 scalar 표현식·준비·평가", { exact: true });
    await label.scrollIntoViewIfNeeded();
    const box = await label.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  const selectedText = await page.evaluate(() => window.getSelection().toString());
  expect(selectedText).toMatch(/공용 scalar|준비·평가/);
  await markdown.evaluate((element) => { element.markdown += "\nAfter the diagram.\n"; });
  await expect(markdown).toContainText("After the diagram.");
  expect(await diagram.evaluate((element) => element === window.__mermaidView && element.shadowRoot.querySelector("svg") === window.__mermaidSvg)).toBe(true);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(selectedText);
  await block.getByRole("button", { name: "Show Mermaid code" }).click();
  await expect(block.locator("pre")).toHaveText(SOURCE);
  if (browserName === "chromium") {
    await block.getByRole("button", { name: "Copy code" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SOURCE);
  }
  await markdown.evaluate((element) => { element.markdown += "\nAnother update.\n"; });
  await expect(markdown).toContainText("Another update.");
  await expect(block.locator("pre")).toBeVisible();
  await block.getByRole("button", { name: "Preview Mermaid" }).click();
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  expect(await diagram.evaluate((element) => element.shadowRoot.querySelector("svg") === window.__mermaidSvg)).toBe(true);
  await diagram.scrollIntoViewIfNeeded();
  await diagram.screenshot({ path: testInfo.outputPath("mermaid-diagram-light.png") });
  await captureReviewScreenshot(page, testInfo, "mermaid-inline-light");
  await page.evaluate(async () => {
    const { applyThemeMode } = await import("/assets/theme.js");
    applyThemeMode("dark");
  });
  await expect.poll(() => diagram.evaluate((element) => element.shadowRoot.querySelector("svg") !== window.__mermaidSvg)).toBe(true);
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await diagram.scrollIntoViewIfNeeded();
  await diagram.screenshot({ path: testInfo.outputPath("mermaid-diagram-dark.png") });
  await captureReviewScreenshot(page, testInfo, "mermaid-inline-dark");
  await expect.poll(async () => (await workspaceTargets(page, "task:")).map(([, label]) => label)).toContain("Open SQL planner");
  expect(scenario.pageErrors).toEqual([]);
});

test("shared Markdown preview renders diagrams and recovers from a partial source", { tag: "@server-steady" }, async ({ page }) => {
  await page.goto("/tasks");
  await page.evaluate(async () => {
    await import("/assets/components/markdown-preview.js");
    const preview = document.createElement("caffold-markdown-preview");
    preview.id = "mermaid-document";
    Object.assign(preview.style, { position: "fixed", inset: "50px", zIndex: "10000", background: "white", overflow: "auto" });
    document.body.append(preview);
    preview.setMarkdown('```mermaid\nflowchart LR\nA[partial\n```');
  });
  const preview = page.locator("#mermaid-document");
  const diagram = preview.locator("caffold-mermaid-view");
  await expect(diagram).toHaveAttribute("data-render-state", "error");
  await expect(diagram.getByRole("button", { name: "Retry" })).toBeVisible();
  await preview.evaluate((element, text) => element.setMarkdown(text), fence(SOURCE));
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  await diagram.evaluate((element) => { window.__mermaidSvg = element.shadowRoot.querySelector("svg"); });
  await preview.evaluate((element, text) => element.setMarkdown(text), fence(SOURCE));
  expect(await diagram.evaluate((element) => element.shadowRoot.querySelector("svg") === window.__mermaidSvg)).toBe(true);
  const resized = page.waitForRequest((request) =>
    request.url().endsWith("/api/mermaid/render") && request.postDataJSON().fontSize === 20,
  );
  await page.evaluate(async () => {
    const settings = await import("/assets/settings.js");
    settings.setAppearanceRangeSetting("conversationTextPx", 20);
  });
  await resized;
  await expect(diagram).toHaveAttribute("data-render-state", "ready");
  expect(await diagram.locator("svg").evaluate((svg) => svg.outerHTML)).toContain("20px");
  expect(await diagram.evaluate((element) => element.shadowRoot.querySelector("svg") === window.__mermaidSvg)).toBe(false);
});


test("keeps wide diagrams readable, loads normal images, and exposes SVG links", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  let images = 0;
  await page.route("https://example.com/mermaid-logo.svg", async (route) => {
    images++;
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="royalblue"/></svg>' });
  });
  await page.route("https://example.com/docs", (route) => route.fulfill({ contentType: "text/html", body: "<title>Diagram documentation</title>" }));
  await page.goto("/tasks");
  await page.evaluate(async () => {
    await import("/assets/components/mermaid-view.js");
    const view = document.createElement("caffold-mermaid-view");
    view.id = "mermaid-wide";
    Object.assign(view.style, { position: "fixed", inset: "60px 12px auto", zIndex: "10000" });
    view.source = 'flowchart LR\nA@{ img: "https://example.com/mermaid-logo.svg", label: "Logo", h: 48 } --> B[Documentation] --> C[길고 넓은 한글 노드] --> D[Fourth node] --> E[Last node]\nclick B "https://example.com/docs" "Documentation" _blank\nstyle E fill:#ffaaaa';
    document.body.append(view);
  });
  const view = page.locator("#mermaid-wide");
  await expect(view).toHaveAttribute("data-render-state", "ready");
  await expect.poll(() => images).toBe(1);
  const geometry = await view.evaluate((element) => {
    const svg = element.shadowRoot.querySelector("svg");
    const scroller = element.shadowRoot.querySelector(".diagram");
    return { natural: svg.viewBox.baseVal.width, drawn: svg.getBoundingClientRect().width, viewport: scroller.clientWidth, scroll: scroller.scrollWidth, links: element.actionHintScope({ scopeId: "probe" }).targets.map((target) => target.label) };
  });
  expect(Math.abs(geometry.drawn - geometry.natural)).toBeLessThan(1);
  if (testInfo.project.name === "phone") expect(geometry.scroll).toBeGreaterThan(geometry.viewport);
  expect(geometry.links).toContain("Open Documentation");
  const link = view.locator("svg a").filter({ hasText: "Documentation" });
  await link.focus();
  expect(await link.evaluate((element) => element.getRootNode().activeElement === element)).toBe(true);
  await view.screenshot({ path: testInfo.outputPath("mermaid-wide-image.png") });
  await view.evaluate((element) => element.actionHintScope({ scopeId: "probe" }).targets[0].activate());
  await expect(page).toHaveURL("https://example.com/docs");
});
