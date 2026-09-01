import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pull-detail-page").prototype;
after(() => registry.restore());

test("provides Start Task and PR Files through their existing native controls", () => {
  const clipRoot = {};
  const focusOptions = [];
  const clicks = [];
  const start = {
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Start Task for pull request #7" : null;
    },
    focus(options) {
      focusOptions.push(["start", options]);
    },
    click() {
      clicks.push("start");
    },
  };
  let files = {
    dataset: { pullNumber: "7" },
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Open files for PR #7" : null;
    },
    focus(options) {
      focusOptions.push(["files", options]);
    },
    click() {
      clicks.push("files");
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready", payload: { pull: { number: 7 } } },
    querySelector(selector) {
      return selector.includes("github-pull-start-button") ? start : files;
    },
  };

  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:pull:detail",
    clipRoots: [clipRoot],
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label, controlKind }) => ({
      id,
      actionId,
      label,
      controlKind,
    })),
    [
      {
        id: "github:pull:detail:7:start-task",
        actionId: "task.github.start",
        label: "Start Task for pull request #7",
        controlKind: "button",
      },
      {
        id: "github:pull:detail:7:files",
        actionId: "navigation.pull.files",
        label: "Open files for PR #7",
        controlKind: "button",
      },
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
  for (const target of scope.targets) {
    assert.deepEqual(target.clipRoots, [owner, clipRoot]);
  }
  scope.targets[0].activate();
  scope.targets[1].activate();
  assert.deepEqual(focusOptions, [
    ["start", { preventScroll: true }],
    ["files", { preventScroll: true }],
  ]);
  assert.deepEqual(clicks, ["start", "files"]);

  files = null;
  assert.equal(scope.targets[0].isActionable(), true);
  assert.equal(scope.targets[1].isActionable(), false);
  owner.state = { status: "ready", payload: { pull: { number: 8 } } };
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});
