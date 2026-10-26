import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.ts");
const page = registry.element("caffold-github-issue-detail-page").prototype;
after(() => registry.restore());

test("merges the raw description's surface with the Markdown body's", () => {
  const pulls = [];
  const owner = {
    surfaces: {
      scope(pull) {
        pulls.push(["raw", pull]);
        return { surfaces: [{ id: "raw" }] };
      },
    },
    markdown: {
      value: {
        scrollSurfaceScope(pull) {
          pulls.push(["markdown", pull]);
          return { surfaces: [{ id: "markdown" }] };
        },
      },
    },
  };
  const clipRoot = {};

  assert.deepEqual(
    page.scrollSurfaceScope
      .call(owner, { scopeId: "github:issue:42", clipRoots: [clipRoot] })
      .surfaces.map(({ id }) => id),
    ["raw", "markdown"],
  );
  assert.deepEqual(pulls, [
    [
      "raw",
      {
        scopeId: "github:issue:42",
        label: "Issue description",
        clipRoots: [clipRoot],
      },
    ],
    [
      "markdown",
      {
        scopeId: "github:issue:42:body",
        label: "Issue description",
        clipRoots: [owner, clipRoot],
      },
    ],
  ]);
});

test("merges its own actions with the Markdown body's, named by the Issue", () => {
  let received;
  const owner = {
    state: { status: "ready", payload: { issue: { number: 42 } } },
    hints: { scope: () => ({ targets: [{ id: "start" }] }) },
    markdown: {
      value: {
        actionHintScope(pull) {
          received = pull;
          return { targets: [{ id: "generated-link" }] };
        },
      },
    },
  };

  assert.deepEqual(
    page.actionHintScope
      .call(owner, { scopeId: "github:issue:detail" })
      .targets.map(({ id }) => id),
    ["start", "generated-link"],
  );
  assert.deepEqual(received, {
    scopeId: "github:issue:detail:42:body",
    clipRoots: [owner],
  });
});
