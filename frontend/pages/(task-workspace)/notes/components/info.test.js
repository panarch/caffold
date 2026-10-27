import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./info.js");
const info = registry.element("caffold-notes-info").prototype;
after(() => registry.restore());

test("closes the popover for a different Note, keeps it open for the same Note, and keeps describing the last Note while hidden", () => {
  const calls = [];
  const owner = {
    note: null,
    shownNote: null,
    hidden: false,
    deactivate() {
      calls.push("close");
    },
  };
  const show = (note) => {
    const previous = owner.note;
    owner.note = note;
    info.willUpdate.call(owner, new Map([["note", previous]]));
  };

  show({ id: "note-a" });
  show({ id: "note-a" });
  assert.deepEqual(calls, ["close"], "only a different Note closes the popover");
  show({ id: "note-b" });
  assert.equal(owner.shownNote.id, "note-b");
  show(null);
  assert.deepEqual(calls, ["close", "close", "close"]);
  assert.equal(owner.shownNote.id, "note-b", "the hidden popover keeps the last Note");
  assert.equal(owner.hidden, true);
});

