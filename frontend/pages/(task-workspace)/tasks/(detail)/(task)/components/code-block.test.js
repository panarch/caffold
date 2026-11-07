import assert from "node:assert/strict";
import test, { after } from "node:test";

import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./code-block.js");
const { ActionHints } = await import("#app/action-hints.js");
const { ScrollSurfaces } = await import("#app/scroll-scope.js");
const codeBlock = registry.element("caffold-task-code-block").prototype;
after(() => registry.restore());

test("offers Preview only for a Markdown or Mermaid fence and never as a toggle", () => {
  for (const [label, previewLabel] of [
    ["markdown", "Preview Markdown"],
    ["Markdown", "Preview Markdown"],
    ["md", "Preview Markdown"],
    ["mermaid", "Preview Mermaid"],
    ["Mermaid", "Preview Mermaid"],
    ["mdx", null],
    ["mmd", null],
    ["rust", null],
    ["Plain text", null],
  ]) {
    const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
      text: "",
      label,
      copyState: "idle",
      wrapped: false,
    }));
    owner.hints = new ActionHints(owner);
    owner.surfaces = new ScrollSurfaces(owner);
    const html = templateHtml(owner.render());
    const preview = html.match(/<button[^>]*data-code-action="preview"[^>]*>/)?.[0];
    assert.equal(Boolean(preview), Boolean(previewLabel), label);
    if (previewLabel) {
      assert.match(preview, new RegExp(`aria-label="${previewLabel}"`));
      assert.doesNotMatch(preview, /aria-pressed/);
    }
  }
});

test("draws the text it is given as code under its name", () => {
  const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
    text: '{\n  "name": "<Release notes>"\n}',
    label: "JSON",
    copyState: "idle",
    wrapped: false,
  }));
  owner.hints = new ActionHints(owner);
  owner.surfaces = new ScrollSurfaces(owner);

  const html = templateHtml(owner.render());
  assert.match(html, /<span[^>]*class="code-block-label"[^>]*>JSON<\/span>/);
  assert.match(
    html,
    /<pre[^>]*><code>\{\n {2}&quot;name&quot;: &quot;&lt;Release notes&gt;&quot;\n\}<\/code><\/pre>/,
  );
});

test("takes Markdown's code, name, and place keeping, and draws at once", () => {
  const preserveLayout = () => {};
  let draws = 0;
  const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
    text: "",
    label: "Plain text",
    preserveLayout: null,
    performUpdate: () => {
      draws += 1;
    },
  }));

  owner.setContent("fn main() {}\n", { label: "rust", preserveLayout });
  assert.equal(owner.text, "fn main() {}\n");
  assert.equal(owner.label, "rust");
  assert.equal(owner.preserveLayout, preserveLayout);
  assert.equal(draws, 1);
});

test("requests a preview of the block text from its Preview button", () => {
  const events = [];
  const opener = {};
  const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
    text: "## Notes\n\n- first\n",
    previewButton: { value: opener },
    dispatchEvent: (event) => events.push(event),
  }));

  owner.requestPreview();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:task-markdown-preview-intent");
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, {
    markdown: "## Notes\n\n- first\n",
    opener,
  });

  owner.previewButton = { value: undefined };
  owner.requestPreview();
  assert.equal(events.length, 1);
});

test("requests a diagram preview of a Mermaid block from its Preview button", () => {
  const events = [];
  const opener = {};
  const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
    text: "flowchart LR\n  A --> B\n",
    previewButton: { value: opener },
    dispatchEvent: (event) => events.push(event),
  }));

  owner.requestMermaidPreview();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:task-mermaid-preview-intent");
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].composed, true);
  assert.deepEqual(events[0].detail, {
    source: "flowchart LR\n  A --> B\n",
    opener,
  });

  owner.previewButton = { value: undefined };
  owner.requestMermaidPreview();
  assert.equal(events.length, 1);
});
