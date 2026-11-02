import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./visual-diff.js");
const { DrawnRef } = await import("../../drawn-refs.js");
const visualDiff = registry.element("caffold-visual-diff").prototype;
after(() => registry.restore());

const FETCHED = {
  before: { status: "fetched", url: "blob:before", bytes: 20275 },
  after: { status: "fetched", url: "blob:after", bytes: 24678 },
};
const DRAWN = {
  before: { url: "blob:before", width: 720, height: 440 },
  after: { url: "blob:after", width: 720, height: 440 },
};

// A Visual showing `sides`, with each fetched side already decoded as given.
function visual(sides, values = {}) {
  const owner = elementStandIn(visualDiff, {
    sides,
    mode: "side",
    pictures: DRAWN,
    difference: null,
    ...values,
  });
  owner.surfaces = { surface: () => "" };
  owner.stage = new DrawnRef(owner);
  owner.modeControl = new DrawnRef(owner);
  return owner;
}

test("draws both sides with their size and offers the ways to compare", () => {
  const html = templateHtml(visual(FETCHED).render());

  assert.match(html, /<caffold-segmented-control/);
  assert.match(html, /data-sides="2"/);
  assert.match(html, /<strong>Before<\/strong>\s*<span>720 × 440 · 19\.8 KB<\/span>/);
  assert.match(html, /<strong>After<\/strong>\s*<span>720 × 440 · 24\.1 KB<\/span>/);
  assert.match(html, /--max-natural-width: 720; --max-natural-height: 440;/);
  assert.match(html, /src="blob:before"[\s\S]*--natural-width: 720; --natural-height: 440;/);
});

test("an added file shows After alone, with nothing to choose", () => {
  const html = templateHtml(
    visual({ before: null, after: FETCHED.after }).render(),
  );

  assert.doesNotMatch(html, /caffold-segmented-control/);
  assert.doesNotMatch(html, /Before/);
  assert.match(html, /data-sides="1"/);
  assert.match(html, /src="blob:after"/);
});

test("a side it could not get says so, and the other side still shows", () => {
  const sides = { before: { status: "failed" }, after: FETCHED.after };
  const html = templateHtml(visual(sides).render());

  assert.match(html, /<strong>Before<\/strong>\s*<\/figcaption>\s*<p class="surface-message side-message">This picture could not be loaded\.<\/p>/);
  assert.match(html, /src="blob:after"/);

  const undrawable = templateHtml(
    visual(FETCHED, {
      pictures: { ...DRAWN, before: { url: "blob:before", failed: true } },
    }).render(),
  );
  assert.match(undrawable, /This picture could not be loaded\./);
  assert.match(undrawable, /src="blob:after"/);
});

test("waits until every side is drawn or failed before drawing either", () => {
  const html = templateHtml(
    visual({ before: FETCHED.before, after: { status: "loading" } }).render(),
  );

  assert.match(html, /Loading images\.\.\./);
  assert.doesNotMatch(html, /<img/);
});

test("Difference explains a size change and a side it could not get", () => {
  const resized = templateHtml(
    visual(FETCHED, {
      mode: "difference",
      pictures: { ...DRAWN, after: { url: "blob:after", width: 256, height: 256 } },
    }).render(),
  );
  assert.match(resized, /Difference compares pictures of the same size\./);
  assert.match(resized, /Before is 720 × 440 and After is\s+256 × 256\. Side by side shows both\./);

  const missing = templateHtml(
    visual(
      { before: FETCHED.before, after: { status: "failed" } },
      { mode: "difference" },
    ).render(),
  );
  assert.match(missing, /Difference needs both pictures\./);
  assert.match(missing, /After could not be loaded\./);
});

test("Difference shows the changed share once the pictures are compared", () => {
  const comparing = templateHtml(
    visual(FETCHED, {
      mode: "difference",
      difference: { key: "blob:before blob:after", status: "comparing" },
    }).render(),
  );
  assert.match(comparing, /Comparing images\.\.\./);

  const ready = templateHtml(
    visual(FETCHED, {
      mode: "difference",
      difference: {
        key: "blob:before blob:after",
        status: "ready",
        url: "blob:difference",
        changed: 181,
        total: 1000,
        width: 720,
        height: 440,
      },
    }).render(),
  );
  assert.match(ready, /<strong>Difference<\/strong>\s*<span>18\.1% of pixels changed<\/span>/);
  assert.match(ready, /--changed-color: rgb\(229 46 63\);/);
  assert.match(ready, /src="blob:difference"/);
});

test("a change with no side says there is nothing to compare", () => {
  const html = templateHtml(visual({ before: null, after: null }).render());

  assert.match(html, /No change for this file\./);
});

test("hands a chosen way to compare to the viewer, which keeps it", () => {
  const owner = visual(FETCHED);
  const intents = [];
  owner.dispatchEvent = (event) => intents.push([event.type, event.detail]);
  let stopped = false;

  owner.chooseMode({
    detail: { value: "difference" },
    stopPropagation: () => {
      stopped = true;
    },
  });

  assert.equal(stopped, true, "no review surface above owns the choice");
  assert.deepEqual(intents, [
    ["caffold:visual-diff-mode-intent", { mode: "difference" }],
  ]);
  assert.equal(owner.mode, "side", "the viewer hands the mode back");
});

test("compares pictures drawn at one size once, and drops a difference of others", () => {
  const owner = visual(FETCHED);
  const compared = [];
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (callback) => compared.push(callback) };
  after(() => {
    globalThis.window = previousWindow;
  });

  owner.setComparison({ sides: FETCHED, mode: "difference" });
  owner.setComparison({ sides: FETCHED, mode: "difference" });
  assert.equal(compared.length, 1, "one pair of pictures is compared once");
  assert.deepEqual(owner.difference, {
    key: "blob:before blob:after",
    status: "comparing",
  });

  owner.setComparison({
    sides: { before: { status: "loading" }, after: { status: "loading" } },
    mode: "difference",
  });
  assert.equal(owner.mode, "difference");
  assert.equal(owner.difference, null, "the next file's pictures are compared anew");
});
