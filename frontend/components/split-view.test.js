import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const previousWindow = globalThis.window;
let width = 1280;
globalThis.window = {
  matchMedia(query) {
    const max = Number(query.match(/max-width: (\d+)px/)?.[1] ?? Infinity);
    const min = Number(query.match(/min-width: (\d+)px/)?.[1] ?? 0);
    return { matches: width >= min && width <= max };
  },
};
const registry = installCustomElementUnitRegistry();
const { SPLIT_VIEW_DRAWER_MAX_WIDTH_PX, SPLIT_VIEW_SINGLE_MAX_WIDTH_PX } =
  await import("./split-view.js");
const split = registry.element("caffold-split-view").prototype;
after(() => {
  registry.restore();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

function splitView({ detailOpen = false, collapsed = false } = {}) {
  const attributes = new Set();
  const events = [];
  const stored = [];
  const resizer = {
    collapsed,
    setCollapsed(value) {
      stored.push(value);
      resizer.collapsed = value;
    },
  };
  const view = elementStandIn(split, {
    detailOpen,
    drawerOpen: false,
    openedFrom: null,
    resizer: { value: resizer },
    updateComplete: new Promise(() => {}),
    performUpdate() {},
    requestUpdate() {},
    getAttribute: (name) => (name === "pane-label" ? "review navigator" : null),
    toggleAttribute(name, force) {
      if (force) attributes.add(name);
      else attributes.delete(name);
    },
    dispatchEvent: (event) => events.push(event.type),
  });
  return { view, attributes, events, stored };
}

test("shows one pane up to 560px, the drawer up to 1,060px, and both wider", () => {
  assert.equal(SPLIT_VIEW_SINGLE_MAX_WIDTH_PX, 560);
  assert.equal(SPLIT_VIEW_DRAWER_MAX_WIDTH_PX, 1060);
  const { view } = splitView({ detailOpen: true });
  for (const [viewportWidth, onePane, besideToggle] of [
    [560, true, false],
    [561, false, true],
    [1060, false, true],
    [1061, false, true],
  ]) {
    width = viewportWidth;
    assert.equal(view.showsOnePane(), onePane, `${viewportWidth}px`);
    assert.equal(view.sidePane().beside, besideToggle, `${viewportWidth}px`);
  }
});

test("keeps the list beside the file wide, collapsing it only while a file is open", () => {
  width = 1280;
  const closed = splitView({ collapsed: true });
  const pane = closed.view.sidePane();
  assert.equal(pane.label, "review navigator");
  assert.equal(pane.collapsible, false);
  assert.equal(pane.collapsed, false);
  assert.equal(closed.view.listShown(), true);
  assert.equal(closed.view.detailShown(), true);

  const open = splitView({ detailOpen: true, collapsed: true });
  assert.equal(open.view.sidePane().collapsed, true);
  assert.equal(open.view.listShown(), false);

  open.view.sidePane().setCollapsed(false);
  assert.deepEqual(open.stored, [false]);
  assert.equal(open.view.listShown(), true);
  assert.equal(open.attributes.has("collapsed"), false);
  assert.deepEqual(open.events, ["caffold:side-pane-change"]);
});

test("shows the list or the file in turn on a phone, where nothing collapses", () => {
  width = 390;
  const list = splitView({ collapsed: true });
  assert.equal(list.view.listShown(), true);
  assert.equal(list.view.detailShown(), false);

  const file = splitView({ detailOpen: true, collapsed: true });
  assert.equal(file.view.sidePane().collapsed, false);
  assert.equal(file.view.listShown(), false);
  assert.equal(file.view.detailShown(), true);
});

test("opens the drawer over an open file without remembering it", () => {
  width = 933;
  const { view, attributes, events, stored } = splitView({
    detailOpen: true,
    collapsed: true,
  });
  assert.equal(view.sidePane().collapsible, true);
  assert.equal(view.sidePane().collapsed, true);
  assert.equal(view.listShown(), false);
  assert.equal(view.detailShown(), true);

  view.sidePane().setCollapsed(false);
  assert.equal(view.drawerOpen, true);
  assert.equal(view.sidePane().collapsed, false);
  assert.equal(view.listShown(), true);
  assert.equal(view.detailShown(), false);
  assert.ok(attributes.has("drawer-open"));
  assert.equal(attributes.has("collapsed"), false);

  view.closeDrawer();
  assert.equal(view.drawerOpen, false);
  assert.equal(attributes.has("drawer-open"), false);
  assert.deepEqual(stored, []);
  assert.deepEqual(events, [
    "caffold:side-pane-change",
    "caffold:side-pane-change",
  ]);
});

test("keeps the list beside the empty file pane until a file opens", () => {
  width = 933;
  const { view } = splitView();
  assert.equal(view.sidePane().collapsible, false);
  assert.equal(view.sidePane().collapsed, false);
  assert.equal(view.listShown(), true);
  view.sidePane().setCollapsed(false);
  assert.equal(view.drawerOpen, false);
});

test("closes the drawer when the file closes or the window leaves its widths", () => {
  width = 933;
  const closing = splitView({ detailOpen: true });
  closing.view.sidePane().setCollapsed(false);
  closing.view.setDetailOpen(false);
  assert.equal(closing.view.drawerOpen, false);
  assert.equal(closing.attributes.has("detail-open"), false);

  const widening = splitView({ detailOpen: true });
  widening.view.sidePane().setCollapsed(false);
  width = 1280;
  widening.view.followMode();
  assert.equal(widening.view.drawerOpen, false);
  assert.equal(widening.view.listShown(), true);
});

test("closes the drawer on Escape the keyboard mode left to it", () => {
  width = 933;
  const { view } = splitView({ detailOpen: true });
  view.sidePane().setCollapsed(false);
  const escape = (fields = {}) => {
    let prevented = false;
    view.closeOnEscape({
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...fields,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    return prevented;
  };

  assert.equal(escape({ defaultPrevented: true }), false);
  assert.equal(escape({ isComposing: true }), false);
  assert.equal(view.drawerOpen, true);
  assert.equal(escape(), true);
  assert.equal(view.drawerOpen, false);
  assert.equal(escape(), false);
});
