import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./shortcut-dialog.ts");
const dialog = registry.element("caffold-keyboard-shortcut-dialog").prototype;
const { ActionHints } = await import("../../action-hints.ts");
const { ScrollSurfaces } = await import("../../scroll-scope.ts");
const { KeyboardContexts } = await import("../context.ts");
after(() => registry.restore());

test("draws the shared shortcut map in one native dialog", () => {
  const owner = Object.create(dialog);
  owner.hints = new ActionHints(owner);
  owner.surfaces = new ScrollSurfaces(owner);
  owner.keyboard = new KeyboardContexts(owner);
  const drawn = templateHtml(owner.render()).replace(/\s+/g, " ");

  assert.match(drawn, /^<dialog/);
  assert.match(drawn, /Keyboard shortcuts/);
  assert.match(drawn, /class="keyboard-shortcut-close"/);
  assert.match(drawn, /aria-label="Close keyboard shortcuts"/);
  assert.doesNotMatch(drawn, />Close<\/button>/);
  assert.match(drawn, /<caffold-keyboard-shortcut-list ><\/caffold-keyboard-shortcut-list>/);
  assert.match(
    drawn,
    /<\/article> <caffold-keyboard-navigation-presentation ><\/caffold-keyboard-navigation-presentation> <\/dialog>$/,
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
  };
  const owner = Object.assign(Object.create(dialog), {
    dialog: { value: nativeDialog },
    closeButton: { value: close },
    performUpdate() {},
  });

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
  const owner = Object.assign(Object.create(dialog), {
    ownerClosed: false,
    dialog: { value: nativeDialog },
    dispatchClose: (reason) => reasons.push(reason),
  });

  dialog.close.call(owner);
  dialog.handleClose.call(owner, new Event("close"));
  assert.deepEqual(reasons, []);

  dialog.handleClose.call(owner, new Event("close"));
  assert.deepEqual(reasons, ["dialog"]);
});
