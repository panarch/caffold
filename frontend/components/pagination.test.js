import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousCss = globalThis.CSS;
globalThis.CSS = { escape: (value) => `${value}` };
const registry = installCustomElementUnitRegistry();
await import("./pagination.js");
const pagination = registry.element("caffold-pagination").prototype;
after(() => {
  registry.restore();
  if (previousCss === undefined) {
    delete globalThis.CSS;
  } else {
    globalThis.CSS = previousCss;
  }
});

test("provides enabled page intents and revalidates their owned buttons", () => {
  const clipRoot = {};
  let clicks = 0;
  const first = {
    dataset: { pageKind: "first", page: "1" },
    disabled: true,
  };
  const previous = {
    dataset: { pageKind: "previous", page: "1" },
    disabled: false,
    getAttribute: () => "Previous page",
    focus() {},
    click() {},
  };
  const next = {
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
  const last = {
    dataset: { pageKind: "last", page: "4" },
    disabled: false,
    getAttribute: () => "Last page",
    focus() {},
    click() {},
  };
  const controls = new Map([
    ["first", first],
    ["previous", previous],
    ["next", next],
    ["last", last],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    querySelectorAll() {
      return [...controls.values()];
    },
    querySelector(selector) {
      const kind = selector.match(/data-page-kind="([^"]+)"/)?.[1];
      return controls.get(kind) ?? null;
    },
  };

  const scope = pagination.actionHintScope.call(owner, {
    scopeId: "issues:page",
    actionId: "navigation.page",
    clipRoots: [clipRoot],
  });

  assert.deepEqual(
    scope.targets.map(({ id }) => id),
    [
      "issues:page:page:previous:1",
      "issues:page:page:next:3",
      "issues:page:page:last:4",
    ],
  );
  const target = scope.targets[1];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "issues:page:page:next:3",
      actionId: "navigation.page",
      label: "Next page",
      controlKind: "button",
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  controls.set("next", { ...next });
  assert.equal(target.isActionable(), false);
});
