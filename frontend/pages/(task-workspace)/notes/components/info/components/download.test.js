import assert from "node:assert/strict";
import test, { after } from "node:test";

import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./download.js");
const { ActionHints } = await import("#app/action-hints.js");
const download = registry.element("caffold-notes-info-download").prototype;
after(() => registry.restore());

function drawnLink(note) {
  const owner = Object.create(download, Object.getOwnPropertyDescriptors({ note }));
  owner.hints = new ActionHints(owner);
  return templateHtml(owner.render()).match(/<a[^>]*>/)?.[0];
}

test("links to the Note's download and leaves the file name to the server", () => {
  const link = drawnLink({ id: "storage decision", name: "Storage decision", content: "# Storage\n" });

  assert.match(link, /href="\/api\/notes\/storage%20decision\/download"/);
  assert.match(link, /\sdownload\s/);
  assert.doesNotMatch(link, /download="[^"]/);
  assert.doesNotMatch(link, /aria-disabled="true"/);
});

test("is a disabled link without an address for an empty Note", () => {
  const link = drawnLink({ id: "blank", name: "Blank", content: "" });

  assert.doesNotMatch(link, /\/api\/notes/);
  assert.match(link, /role="link"/);
  assert.match(link, /aria-disabled="true"/);
});
