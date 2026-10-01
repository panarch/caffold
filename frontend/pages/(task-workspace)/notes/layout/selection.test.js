import assert from "node:assert/strict";
import test from "node:test";
import { NotesSelection } from "./selection.js";

test("only a readable primary document can start a companion picker; cancel restores single", () => {
  const selection = new NotesSelection();
  assert.equal(selection.transition("start"), false);
  assert.equal(selection.transition("primary"), false);
  assert.equal(selection.transition("start", { readable: true }), true);
  assert.equal(selection.split, true);
  assert.equal(selection.picker, "secondary");
  assert.equal(selection.transition("primary"), false);
  selection.transition("cancel");
  assert.equal(selection.split, false);
});

test("one picker replaces one committed pane and the route commits or closes the pair", () => {
  const selection = new NotesSelection();
  selection.transition("route", { paired: true });
  assert.equal(selection.picker, "");
  assert.equal(selection.transition("start", { readable: true }), false);
  for (const side of ["primary", "secondary"]) {
    selection.transition(side);
    assert.equal(selection.picker, side);
    selection.transition("cancel");
    assert.equal(selection.node, "paired");
  }
  selection.transition("primary");
  selection.transition("secondary");
  assert.equal(selection.picker, "secondary");
  assert.equal(selection.transition("primary"), true);
  assert.equal(selection.picker, "primary");
  selection.transition("route");
  assert.equal(selection.node, "single");
});
