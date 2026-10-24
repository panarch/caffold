import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./button.ts");
const pageButton = registry.element("caffold-pagination-button").prototype;
after(() => registry.restore());

const options = {
  scopeId: "issues:page",
  actionId: "navigation.page",
};

test("provides its enabled page button and revalidates that same button and page", () => {
  const clipRoot = {};
  let clicks = 0;
  const control = {
    dataset: { pageKind: "next", page: "3" },
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Next page" : null;
    },
    focus() {},
    click() {
      clicks += 1;
    },
  };
  const owner = renderedButton(control);

  const scope = owner.actionHintScope({ ...options, clipRoots: [clipRoot] });

  assert.equal(scope.targets.length, 1);
  const [target] = scope.targets;
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
      invalidationOwner: target.invalidationOwner,
      clipRoots: target.clipRoots,
    },
    {
      id: "issues:page:page:next:3",
      actionId: "navigation.page",
      label: "Next page",
      controlKind: "button",
      invalidationOwner: owner,
      clipRoots: [clipRoot],
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  control.dataset.page = "4";
  assert.equal(target.isActionable(), false);
  control.dataset.page = "3";
  owner.rendered = { ...control };
  assert.equal(target.isActionable(), false);
});

test("provides nothing while disabled, hidden, or outside an Action Hint scope", () => {
  const control = {
    dataset: { pageKind: "first", page: "1" },
    disabled: true,
    getAttribute: () => "First page",
  };

  assert.deepEqual(renderedButton(control).actionHintScope(options).targets, []);
  assert.deepEqual(
    renderedButton({ ...control, disabled: false }, { hidden: true }).actionHintScope(options).targets,
    [],
  );
  assert.deepEqual(renderedButton({ ...control, disabled: false }).actionHintScope({}).targets, []);
});

function renderedButton(control, { hidden = false } = {}) {
  const owner = Object.create(pageButton);
  return Object.assign(owner, {
    hidden,
    isConnected: true,
    rendered: control,
    querySelector(selector) {
      assert.equal(selector, ":scope > .pagination-button");
      return this.rendered;
    },
  });
}
