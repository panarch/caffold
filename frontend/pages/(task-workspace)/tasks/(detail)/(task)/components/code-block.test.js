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

test("offers Preview only for a Markdown fence and never as a toggle", () => {
  for (const [label, offered] of [
    ["markdown", true],
    ["Markdown", true],
    ["md", true],
    ["mdx", false],
    ["rust", false],
    ["Plain text", false],
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
    assert.equal(Boolean(preview), offered, label);
    if (offered) {
      assert.match(preview, /aria-label="Preview Markdown"/);
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

test("takes Markdown's code, name, and place keeping for its reactive update", () => {
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
  assert.equal(draws, 0);
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
