import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./code-block.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const { ScrollSurfaces } = await import("#app/scroll-scope.ts");
const codeBlock = registry.element("caffold-task-markdown-code-block").prototype;
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
      label,
      copyState: "idle",
      wrapped: false,
    }));
    owner.hints = new ActionHints(owner, () => {});
    owner.surfaces = new ScrollSurfaces(owner, () => {});
    const html = templateHtml(owner.render());
    const preview = html.match(/<button[^>]*data-code-action="preview"[^>]*>/)?.[0];
    assert.equal(Boolean(preview), offered, label);
    if (offered) {
      assert.match(preview, /aria-label="Preview Markdown"/);
      assert.doesNotMatch(preview, /aria-pressed/);
    }
  }
});

test("requests a preview of the block text from its Preview button", () => {
  const events = [];
  const opener = {};
  const owner = Object.create(codeBlock, Object.getOwnPropertyDescriptors({
    pre: { querySelector: () => ({ textContent: "## Notes\n\n- first\n" }) },
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
