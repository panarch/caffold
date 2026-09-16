import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./code-block.js");
const codeBlock = registry.element("caffold-task-markdown-code-block").prototype;
after(() => registry.restore());

function button(action, label) {
  return {
    dataset: { codeAction: action },
    disabled: false,
    title: "",
    attributes: new Map(),
    clicks: 0,
    getAttribute(name) {
      return this.attributes.get(name) ?? (name === "aria-label" ? label : null);
    },
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides retained Preview, Wrap, and Copy code buttons", () => {
  const preview = button("preview", "Preview Markdown");
  const wrap = button("wrap", "Wrap code lines");
  const copy = button("copy", "Copy code");
  const controls = new Map([["preview", preview], ["wrap", wrap], ["copy", copy]]);
  const owner = {
    connected: true,
    hidden: false,
    isConnected: true,
    ensureDom() {},
    querySelector(selector) {
      for (const [action, control] of controls) {
        if (selector.includes(`\"${action}\"`)) return control;
      }
      return null;
    },
  };
  const scope = codeBlock.actionHintScope.call(owner, {
    scopeId: "message:a:code-block:1",
  });
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "message:a:code-block:1:preview",
    "message:a:code-block:1:wrap",
    "message:a:code-block:1:copy",
  ]);
  scope.targets.forEach((target) => target.activate());
  assert.deepEqual([preview.clicks, wrap.clicks, copy.clicks], [1, 1, 1]);
  copy.attributes.set("aria-disabled", "true");
  assert.equal(scope.targets[2].isActionable(), false);
  owner.connected = false;
  assert.equal(scope.targets[0].isActionable(), false);

  controls.delete("preview");
  owner.connected = true;
  assert.deepEqual(
    codeBlock.actionHintScope.call(owner, {
      scopeId: "message:a:code-block:2",
    }).targets.map(({ id }) => id),
    ["message:a:code-block:2:wrap"],
  );
});

test("offers Preview only for a Markdown fence and never as a toggle", () => {
  for (const [label, offered] of [
    ["markdown", true],
    ["Markdown", true],
    ["md", true],
    ["mdx", false],
    ["rust", false],
    ["Plain text", false],
  ]) {
    const inserted = [];
    const owner = {
      label,
      previewButton: () => null,
      querySelector: () => ({
        insertAdjacentHTML: (position, html) => inserted.push({ position, html }),
      }),
    };
    codeBlock.syncPreviewButton.call(owner);
    assert.equal(inserted.length, offered ? 1 : 0, label);
    if (offered) {
      assert.equal(inserted[0].position, "afterbegin");
      assert.match(inserted[0].html, /data-code-action="preview"/);
      assert.match(inserted[0].html, /aria-label="Preview Markdown"/);
      assert.doesNotMatch(inserted[0].html, /aria-pressed/);
    }
  }

  const retained = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const owner = {
    label: "markdown",
    previewButton: () => retained,
    querySelector: () => assert.fail("a retained Preview is not inserted again"),
  };
  codeBlock.syncPreviewButton.call(owner);
  assert.equal(retained.removed, false);
  owner.label = "text";
  codeBlock.syncPreviewButton.call(owner);
  assert.equal(retained.removed, true);
});

test("requests a preview of the block text from its Preview button", () => {
  const events = [];
  const opener = {};
  const owner = {
    code: () => ({ textContent: "## Notes\n\n- first\n" }),
    previewButton: () => opener,
    dispatchEvent: (event) => events.push(event),
  };

  codeBlock.requestPreview.call(owner);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:task-markdown-preview-intent");
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, {
    markdown: "## Notes\n\n- first\n",
    opener,
  });

  owner.previewButton = () => null;
  codeBlock.requestPreview.call(owner);
  assert.equal(events.length, 1);
});

test("provides only its exact retained horizontal code scrollport", () => {
  const pre = layoutElement();
  let currentPre = pre;
  let current = true;
  const owner = layoutElement({
    connected: true,
    hidden: false,
    isConnected: true,
    pre: () => currentPre,
  });

  const scope = codeBlock.scrollSurfaceScope.call(owner, {
    scopeId: "message:a:code-block:1",
    label: "JavaScript code block 1",
    isCurrent: () => current,
  });
  const surface = scope.surfaces[0];
  assert.equal(surface.id, "message:a:code-block:1:scroll");
  assert.equal(surface.label, "JavaScript code block 1");
  assert.equal(surface.scrollport, pre);
  assert.deepEqual(surface.axes, ["horizontal"]);
  assert.equal(surface.isEligible(), true);
  currentPre = layoutElement();
  assert.equal(surface.isEligible(), false);
  currentPre = pre;
  current = false;
  assert.equal(surface.isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
