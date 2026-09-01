import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateScrollSurfaceCodes,
  orderScrollSurfaces,
  sameActiveScrollBinding,
  sameScrollSelectionSnapshot,
  scrollCommandPosition,
  visibleScrollSurfaceRect,
} from "./model.js";

test("allocates same-width prefix-free Scroll codes in ASDF order", () => {
  const surfaces = Array.from({ length: 28 }, (_, index) => ({
    id: `surface-${index}`,
  }));
  const allocated = allocateScrollSurfaceCodes(surfaces);
  assert.equal(allocated[0].code, "AA");
  assert.equal(allocated[1].code, "AS");
  assert.equal(new Set(allocated.map(({ code }) => code)).size, 28);
  assert.ok(allocated.every(({ code }) => code.length === 2));
  assert.throws(
    () => allocateScrollSurfaceCodes([{ id: "same" }, { id: "same" }]),
    /Duplicate or empty/,
  );
});

test("uses direct viewport and clip intersection in visual reading order", () => {
  const visible = visibleScrollSurfaceRect(
    rect(0, 0, 100, 100),
    [rect(25, 25, 80, 90)],
    rect(10, 10, 70, 70),
  );
  assert.deepEqual(visible, rect(25, 25, 70, 70));
  assert.deepEqual(
    orderScrollSurfaces([
      { id: "right", visibleRect: rect(50, 10, 60, 20) },
      { id: "lower", visibleRect: rect(0, 30, 10, 40) },
      { id: "left", visibleRect: rect(10, 10, 20, 20) },
    ]).map(({ id }) => id),
    ["left", "right", "lower"],
  );
});

test("moves by small or half-page deltas and clamps every command", () => {
  const input = { scrollTop: 50, scrollHeight: 500, clientHeight: 100 };
  assert.equal(scrollCommandPosition({ ...input, command: "J" }), 60);
  assert.equal(scrollCommandPosition({ ...input, command: "K" }), 40);
  assert.equal(scrollCommandPosition({ ...input, command: "D" }), 100);
  assert.equal(scrollCommandPosition({ ...input, command: "U" }), 0);
  assert.equal(scrollCommandPosition({ ...input, command: "X" }), null);
  assert.equal(scrollCommandPosition({
    command: "J",
    scrollTop: 400,
    scrollHeight: 500,
    clientHeight: 100,
  }), 400);
  assert.equal(scrollCommandPosition({
    command: "J",
    scrollTop: 0,
    scrollHeight: 3,
    clientHeight: 2,
  }), 1);
});

test("freezes selector geometry and active element identity while allowing labels", () => {
  const root = {};
  const hud = {};
  const scrollport = {};
  const clip = {};
  const context = { id: "workspace", kind: "workspace", root, hud };
  const surface = {
    id: "task-list",
    code: "A",
    label: "Before",
    scrollport,
    clipRoots: [clip],
    visibleRect: rect(0, 0, 100, 100),
  };
  const snapshot = {
    context,
    contextRect: rect(0, 0, 100, 100),
    viewport: viewport(),
    surfaces: [surface],
  };
  assert.equal(sameScrollSelectionSnapshot(snapshot, {
    context,
    contextRect: rect(0, 0, 100, 100),
    viewport: viewport(),
    surfaces: [{ ...surface, label: "After" }],
  }), true);
  assert.equal(sameScrollSelectionSnapshot(snapshot, {
    context,
    contextRect: rect(0, 0, 100, 100),
    viewport: viewport(),
    surfaces: [{ ...surface, scrollport: {} }],
  }), false);
  assert.equal(sameScrollSelectionSnapshot(snapshot, {
    context,
    contextRect: rect(0, 0, 90, 100),
    viewport: viewport(),
    surfaces: [{ ...surface }],
  }), false);
  assert.equal(sameActiveScrollBinding(
    { ...surface, context, viewport: viewport() },
    { ...surface, label: "After", context, viewport: viewport() },
  ), true);
  assert.equal(sameActiveScrollBinding(
    { ...surface, context, viewport: viewport() },
    {
      ...surface,
      visibleRect: rect(10, 10, 90, 90),
      context,
      viewport: viewport(),
    },
  ), true);
  assert.equal(sameActiveScrollBinding(
    { ...surface, context, viewport: viewport() },
    {
      ...surface,
      context,
      viewport: { ...viewport(), scale: 1.25 },
    },
  ), false);
});

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function viewport() {
  return {
    rect: rect(0, 0, 100, 100),
    scale: 1,
    devicePixelRatio: 2,
  };
}
