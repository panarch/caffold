import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { updateResultNotice } = await import("./update-result-dialog.js");
const resultDialog = registry.element("caffold-update-result-dialog").prototype;
after(() => registry.restore());

test("tells a rollback with the reason the attempt recorded", () => {
  assert.deepEqual(
    updateResultNotice({
      outcome: "rolledBack",
      fromVersion: "0.18.2",
      toVersion: "0.18.3",
      reason: "0.18.3 could not start",
    }),
    {
      title: "Caffold update was rolled back",
      description:
        "0.18.3 could not start, so Caffold 0.18.2 was restored. See Settings → About Caffold for details.",
    },
  );
  assert.deepEqual(
    updateResultNotice({
      outcome: "rolledBack",
      fromVersion: "0.18.2",
      reason: "Caffold did not quit",
    }).description,
    "Caffold did not quit, so Caffold 0.18.2 was restored. See Settings → About Caffold for details.",
  );
});

test("tells a restore that failed as a failed update", () => {
  assert.deepEqual(
    updateResultNotice({
      outcome: "restoreFailed",
      fromVersion: "0.18.2",
      toVersion: "0.18.3",
      reason: "0.18.3 could not start, and 0.18.2 could not be restored",
    }),
    {
      title: "Caffold update failed",
      description:
        "0.18.3 could not start, and 0.18.2 could not be restored. See Settings → About Caffold for details.",
    },
  );
});

test("leaves every other outcome to other surfaces", () => {
  for (const outcome of [
    "running",
    "succeeded",
    "upToDate",
    "homebrewFailed",
    "interrupted",
  ]) {
    assert.equal(updateResultNotice({ outcome, fromVersion: "0.18.2" }), null);
  }
  assert.equal(updateResultNotice(null), null);
});

test("offers its one button in one exact modal context", () => {
  const calls = [];
  const ok = {
    disabled: false,
    textContent: "OK",
    focus: () => calls.push("focus"),
    click: () => calls.push("click"),
  };
  const hintDialog = {};
  const presentation = { actionHintDialog: () => hintDialog };
  const dialog = {
    open: true,
    querySelector(selector) {
      if (selector.includes("keyboard-navigation-presentation")) {
        return presentation;
      }
      return selector === 'button[value="ok"]' ? ok : null;
    },
  };
  const owner = { isConnected: true, dialog: () => dialog };
  owner.actionHintScope = () => resultDialog.actionHintScope.call(owner);

  const scope = owner.actionHintScope();
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label }) => [id, actionId, label]),
    [["app:update-result:ok", "dialog.button", "OK"]],
  );
  scope.targets[0].activate();
  assert.deepEqual(calls, ["focus", "click"]);

  const [context] = resultDialog.keyboardNavigationContexts.call(owner);
  assert.equal(context.id, "app:update-result");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, dialog);

  dialog.open = false;
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});

test("renders one native button that only closes", () => {
  const owner = { innerHTML: "" };
  resultDialog.render.call(owner);

  assert.match(owner.innerHTML, /<form method="dialog"/);
  assert.match(owner.innerHTML, /button type="submit" value="ok" autofocus>OK</);
  assert.equal([...owner.innerHTML.matchAll(/<button/g)].length, 1);
});
