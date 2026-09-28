import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./shortcut-dialog.js");
const dialog = registry.element("caffold-keyboard-shortcut-dialog").prototype;
after(() => registry.restore());

test("renders the shared shortcut map in one native dialog", () => {
  const nativeDialog = {};
  const owner = {
    querySelector: () => nativeDialog,
  };
  dialog.ensureRendered.call(owner);

  assert.equal(owner.dialog, nativeDialog);
  assert.match(owner.innerHTML, /<dialog/);
  assert.match(owner.innerHTML, /Keyboard shortcuts/);
  assert.match(owner.innerHTML, /class="keyboard-shortcut-close"/);
  assert.match(owner.innerHTML, /aria-label="Close keyboard shortcuts"/);
  assert.doesNotMatch(owner.innerHTML, />Close<\/button>/);
  assert.match(
    owner.innerHTML,
    /<caffold-keyboard-shortcut-list><\/caffold-keyboard-shortcut-list>/,
  );
  assert.match(
    owner.innerHTML,
    /<\/article>\s*<caffold-keyboard-navigation-presentation><\/caffold-keyboard-navigation-presentation>\s*<\/dialog>/,
  );
});

test("opens, focuses, and closes only its retained native dialog", () => {
  const calls = [];
  const close = {
    focus: (options) => calls.push(["focus", options]),
  };
  const nativeDialog = {
    open: false,
    showModal() {
      this.open = true;
      calls.push("show-modal");
    },
    close() {
      this.open = false;
      calls.push("close");
    },
    querySelector: () => close,
  };
  const owner = { dialog: nativeDialog, ensureRendered() {} };

  assert.equal(dialog.open.call(owner), true);
  assert.deepEqual(calls, [
    "show-modal",
    ["focus", { preventScroll: true }],
  ]);
  assert.equal(dialog.open.call(owner), false);
  assert.equal(dialog.close.call(owner), true);
  assert.equal(dialog.close.call(owner), false);
  assert.equal(calls.at(-1), "close");
});

test("announces a close it did not ask for", () => {
  const reasons = [];
  const nativeDialog = {
    open: true,
    close() {
      this.open = false;
    },
  };
  const owner = {
    dialog: nativeDialog,
    dispatchClose: (reason) => reasons.push(reason),
  };
  dialog.ensureRendered.call(Object.assign(owner, {
    rendered: false,
    querySelector: () => nativeDialog,
  }));

  dialog.close.call(owner);
  owner.boundNativeClose(new Event("close"));
  assert.deepEqual(reasons, []);

  owner.boundNativeClose(new Event("close"));
  assert.deepEqual(reasons, ["dialog"]);
});

test("offers its Close button to Action Hints and its list to Scroll", () => {
  const calls = [];
  const close = {
    getAttribute: (name) =>
      name === "aria-label" ? "Close keyboard shortcuts" : null,
    focus: () => calls.push("focus"),
    click: () => calls.push("click"),
  };
  const list = { getClientRects: () => [{}] };
  const presentation = {
    actionHintDialog: () => ({ name: "hints" }),
    scrollModeHud: () => ({ name: "hud" }),
    scrollSurfaceSelector: () => ({ name: "selector" }),
  };
  const nativeDialog = {
    open: true,
    querySelector(selector) {
      if (selector.includes("keyboard-navigation-presentation")) {
        return presentation;
      }
      if (selector.includes("close-shortcut-help")) {
        return close;
      }
      return selector.includes("caffold-keyboard-shortcut-list") ? list : null;
    },
  };
  const owner = { isConnected: true, dialog: nativeDialog };
  owner.actionHintScope = () => dialog.actionHintScope.call(owner);
  owner.scrollSurfaceScope = () => dialog.scrollSurfaceScope.call(owner);

  const hints = owner.actionHintScope();
  assert.deepEqual(
    hints.targets.map(({ id, actionId, label }) => [id, actionId, label]),
    [["app:keyboard-shortcuts:close", "dialog.button", "Close keyboard shortcuts"]],
  );
  assert.equal(hints.targets[0].isActionable(), true);
  hints.targets[0].activate();
  assert.deepEqual(calls, ["focus", "click"]);

  const scroll = owner.scrollSurfaceScope();
  assert.deepEqual(
    scroll.surfaces.map(({ id, label, scrollport }) => [id, label, scrollport]),
    [["app:keyboard-shortcuts:list", "Keyboard shortcuts", list]],
  );
  assert.equal(scroll.surfaces[0].isEligible(), true);

  const [context] = dialog.keyboardNavigationContexts.call(owner);
  assert.equal(context.id, "app:keyboard-shortcuts");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, nativeDialog);
  assert.equal(context.actionHints.dialog.name, "hints");
  assert.equal(context.scroll.hud.name, "hud");
  assert.equal(context.scroll.selector.name, "selector");

  nativeDialog.open = false;
  assert.equal(hints.targets[0].isActionable(), false);
  assert.equal(scroll.surfaces[0].isEligible(), false);
});
