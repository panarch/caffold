import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-issue-detail-page").prototype;
after(() => registry.restore());

test("provides Start Task through the current Issue native control", () => {
  const focusOptions = [];
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute: (name) =>
      name === "aria-label" ? "Start Task for issue #42" : null,
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready", payload: { issue: { number: 42 } } },
    querySelector: () => control,
  };
  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:issue:detail",
    clipRoots: [{}],
  });
  const target = scope.targets[0];

  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "github:issue:detail:42:start-task",
      actionId: "task.github.start",
      label: "Start Task for issue #42",
      controlKind: "button",
    },
  );
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  control = null;
  assert.equal(target.isActionable(), false);
  control = {
    disabled: false,
    getAttribute() {},
    focus() {},
    click() {},
  };
  owner.state = { status: "ready", payload: { issue: { number: 43 } } };
  assert.equal(target.isActionable(), false);
});

test("delegates Markdown body scrolling and owns the raw fallback", () => {
  const delegatedSurface = { id: "markdown" };
  const markdownBody = {
    scrollSurfaceScope(options) {
      assert.equal(options.scopeId, "github:issue:42:body");
      return { surfaces: [delegatedSurface] };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready", payload: { issue: { number: 42 } } },
    getClientRects: () => [{}],
    querySelector: () => markdownBody,
  };
  assert.deepEqual(
    page.scrollSurfaceScope.call(owner, { scopeId: "github:issue:42" }).surfaces,
    [delegatedSurface],
  );

  const rawBody = {
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  owner.querySelector = () => rawBody;
  const scope = page.scrollSurfaceScope.call(owner, { scopeId: "github:issue:42" });
  assert.equal(scope.surfaces[0].scrollport, rawBody);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.state = { status: "ready", payload: { issue: { number: 43 } } };
  assert.equal(scope.surfaces[0].isEligible(), false);
});
