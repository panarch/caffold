import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pull-detail-page").prototype;
after(() => registry.restore());

// A Pull detail page showing pull #7 whose Markdown blocks are `blocks`, in
// the order they are drawn.
function pullPage(blocks, properties = {}) {
  const details = {};
  return {
    state: { status: "ready", payload: { pull: { number: 7 } } },
    details: { value: details },
    markdowns: { get: (key) => blocks[Number(key)] },
    markdownBlocks: page.markdownBlocks,
    pullNumber: page.pullNumber,
    ...properties,
  };
}

test("merges its own actions with each Markdown block's, in the order they are drawn", () => {
  const received = [];
  const block = (id) => ({
    actionHintScope(pull) {
      received.push(pull);
      return { targets: [{ id }] };
    },
  });
  const owner = pullPage([block("first"), block("second")], {
    hints: { scope: () => ({ targets: [{ id: "start" }] }) },
  });

  assert.deepEqual(
    page.actionHintScope
      .call(owner, { scopeId: "github:pull:detail" })
      .targets.map(({ id }) => id),
    ["start", "first", "second"],
  );
  assert.deepEqual(received, [
    {
      scopeId: "github:pull:detail:7:markdown:0",
      clipRoots: [owner, owner.details.value],
    },
    {
      scopeId: "github:pull:detail:7:markdown:1",
      clipRoots: [owner, owner.details.value],
    },
  ]);
});

test("names its details Pull request details and each Markdown block by its place", () => {
  const received = [];
  const block = {
    scrollSurfaceScope(pull) {
      received.push(pull);
      return { surfaces: [{ id: "markdown" }] };
    },
  };
  let own;
  const owner = pullPage([block], {
    surfaces: {
      scope(pull) {
        own = pull;
        return { surfaces: [{ id: "details" }] };
      },
    },
  });

  assert.deepEqual(
    page.scrollSurfaceScope
      .call(owner, { scopeId: "github:pull:detail" })
      .surfaces.map(({ id }) => id),
    ["details", "markdown"],
  );
  assert.deepEqual(own, {
    scopeId: "github:pull:detail",
    label: "Pull request details",
    clipRoots: [],
  });
  assert.deepEqual(received, [
    {
      scopeId: "github:pull:detail:7:markdown:0",
      label: "Pull request Markdown 1",
      clipRoots: [owner, owner.details.value],
    },
  ]);
});
