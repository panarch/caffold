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
  assert.deepEqual(scrollCommandPosition({ ...input, command: "J" }), {
    axis: "vertical",
    position: 60,
  });
  assert.deepEqual(scrollCommandPosition({ ...input, command: "K" }), {
    axis: "vertical",
    position: 40,
  });
  assert.deepEqual(scrollCommandPosition({ ...input, command: "D" }), {
    axis: "vertical",
    position: 100,
  });
  assert.deepEqual(scrollCommandPosition({ ...input, command: "U" }), {
    axis: "vertical",
    position: 0,
  });
  assert.equal(scrollCommandPosition({ ...input, command: "X" }), null);
  assert.deepEqual(scrollCommandPosition({
    command: "J",
    scrollTop: 400,
    scrollHeight: 500,
    clientHeight: 100,
  }), { axis: "vertical", position: 400 });
  assert.deepEqual(scrollCommandPosition({
    command: "J",
    scrollTop: 0,
    scrollHeight: 3,
    clientHeight: 2,
  }), { axis: "vertical", position: 1 });
});

test("moves horizontally by ten percent with minimum and exact clamping", () => {
  const input = {
    availableAxes: ["horizontal"],
    scrollLeft: 50,
    scrollWidth: 500,
    clientWidth: 100,
  };
  assert.deepEqual(scrollCommandPosition({ ...input, command: "H" }), {
    axis: "horizontal",
    position: 40,
  });
  assert.deepEqual(scrollCommandPosition({ ...input, command: "L" }), {
    axis: "horizontal",
    position: 60,
  });
  assert.deepEqual(scrollCommandPosition({
    ...input,
    command: "L",
    scrollLeft: 400,
  }), { axis: "horizontal", position: 400 });
  assert.deepEqual(scrollCommandPosition({
    availableAxes: ["horizontal"],
    command: "L",
    scrollLeft: 0,
    scrollWidth: 3,
    clientWidth: 2,
  }), { axis: "horizontal", position: 1 });
  assert.equal(scrollCommandPosition({ ...input, command: "J" }), null);
  assert.equal(scrollCommandPosition({
    ...input,
    availableAxes: null,
    command: "L",
  }), null);
});

test("freezes selector geometry and active element identity while allowing labels", () => {
  const root = {};
  const hud = {};
  const selector = {};
  const scrollport = {};
  const clip = {};
  const context = { id: "workspace", kind: "workspace", root, hud, selector };
  const surface = {
    id: "task-list",
    code: "A",
    label: "Before",
    scrollport,
    axes: ["vertical", "horizontal"],
    availableAxes: ["vertical"],
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
    contextRect: rect(0, 0, 100, 100),
    viewport: viewport(),
    surfaces: [{ ...surface, availableAxes: ["horizontal"] }],
  }), false);
  assert.equal(sameScrollSelectionSnapshot(snapshot, {
    context: { ...context, selector: {} },
    contextRect: rect(0, 0, 100, 100),
    viewport: viewport(),
    surfaces: [{ ...surface }],
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
  assert.equal(sameActiveScrollBinding(
    { ...surface, context, viewport: viewport() },
    {
      ...surface,
      availableAxes: ["vertical", "horizontal"],
      context,
      viewport: viewport(),
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
