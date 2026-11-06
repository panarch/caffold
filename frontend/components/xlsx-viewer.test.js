import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./xlsx-viewer.js");
const xlsxViewer = registry.element("caffold-xlsx-viewer").prototype;
after(() => registry.restore());

// A viewer drawing a document, ready to be handed another file.
function drawingViewer() {
  const opened = [];
  return {
    opened,
    owner: {
      generation: 4,
      selectedSheetName: "Q3",
      renderState: "xlsx",
      release() {
        xlsxViewer.release.call(this);
      },
      open(generation, file) {
        opened.push({ generation, file });
      },
    },
  };
}

function cellLink(cell, href, text) {
  const values = new Map([
    ["href", href],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  return {
    dataset: { cell },
    textContent: text,
    innerText: text,
    getAttribute: (name) => values.get(name) ?? null,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    focus() {},
    click() {},
  };
}

// A viewer with its workbook drawn: its own declarations make no targets,
// and its sheet tabs answer with `tabScope`.
function workbookViewer({ links = [], tabScope = null } = {}) {
  const received = {};
  const sheetport = {
    querySelectorAll: () => links,
  };
  const tabs = {};
  const owner = elementStandIn(xlsxViewer, {
    renderState: "xlsx",
    hints: {
      scope: () => ({ blocked: false, targets: [], mutationRoots: [owner], scrollRoots: [] }),
    },
    sheetport: { value: sheetport },
    tabStrip: { value: tabs },
    sheetTabs: {
      value: {
        actionHintScope(pull) {
          received.tabs = pull;
          return tabScope ?? { blocked: false, targets: [], mutationRoots: [], scrollRoots: [] };
        },
      },
    },
  });
  return { owner, sheetport, tabs, received };
}

test("lets go of the workbook shown and opens the file it is handed", () => {
  const { owner, opened } = drawingViewer();
  const file = Promise.resolve(new Blob(["bytes"]));

  owner.file = { file, newerCopy: false };
  xlsxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.renderState, "loading", "it says the file is loading until it is drawn");
  assert.deepEqual(opened, [{ generation: 5, file }], "the workbook shown before is let go of first");
});

test("keeps the sheet being read for a newer copy of the same file", () => {
  const { owner } = drawingViewer();

  owner.file = { file: Promise.resolve(new Blob(["bytes"])), newerCopy: true };
  xlsxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.selectedSheetName, "Q3");
});

test("starts another file at its first sheet", () => {
  const { owner } = drawingViewer();

  owner.file = { file: Promise.resolve(new Blob(["bytes"])), newerCopy: false };
  xlsxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.selectedSheetName, null);
});

test("opens a file it is handed at the sheet and places its owner kept for it", () => {
  const { owner } = drawingViewer();
  owner.sheetScrolls = new Map([["Q3", { top: 900, left: 0 }]]);
  const scrolls = new Map([["Q2", { top: 40, left: 8 }]]);

  owner.position = { sheet: "Q2", scrolls };
  owner.file = { file: Promise.resolve(new Blob(["bytes"])), newerCopy: false };
  xlsxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.selectedSheetName, "Q2");
  assert.deepEqual([...owner.sheetScrolls], [["Q2", { top: 40, left: 8 }]]);
  assert.notEqual(owner.sheetScrolls, scrolls, "the owner's copy stays as it was");
});

test("keeps where each sheet was scrolled for a newer copy of the same file", () => {
  const { owner } = drawingViewer();
  owner.sheetScrolls = new Map([["Q3", { top: 900, left: 120 }]]);

  owner.position = { sheet: "Q1", scrolls: new Map() };
  owner.file = { file: Promise.resolve(new Blob(["bytes"])), newerCopy: true };
  xlsxViewer.willUpdate.call(owner, new Map([["file", null]]));

  assert.equal(owner.selectedSheetName, "Q3");
  assert.deepEqual([...owner.sheetScrolls], [["Q3", { top: 900, left: 120 }]]);
});

// A viewer with a workbook of two sheets, ready to show one.
function sheetsViewer(sheetScrolls) {
  const sheetport = { scrollTop: 0, scrollLeft: 0 };
  const owner = {
    generation: 2,
    isConnected: true,
    sheetScrolls,
    selectedSheetName: null,
    visibleSheets: [
      { name: "Q1", hidden: false, index: 0 },
      { name: "Q2", hidden: false, index: 1 },
    ],
    workbook: { sheet: (index) => ({ index }) },
    sheetport: { value: sheetport },
    sheetTabs: { value: { setSnapshot() {} } },
    isCurrent: (generation) => generation === 2,
    layoutSheet() {},
    drawWindow() {},
  };
  return { owner, sheetport };
}

test("shows each sheet where it was scrolled, and a sheet not yet scrolled at its top", () => {
  const { owner, sheetport } = sheetsViewer(
    new Map([["Q1", { top: 300, left: 50 }]]),
  );

  xlsxViewer.showSheet.call(owner, 2, 0);
  assert.deepEqual([sheetport.scrollTop, sheetport.scrollLeft], [300, 50]);

  xlsxViewer.showSheet.call(owner, 2, 1);
  assert.deepEqual([sheetport.scrollTop, sheetport.scrollLeft], [0, 0]);
  assert.equal(owner.selectedSheetName, "Q2");
});

test("records where the shown sheet is scrolled only while the workbook is drawn", () => {
  const sheetport = { scrollTop: 120, scrollLeft: 30, getClientRects: () => [{}] };
  let windows = 0;
  const owner = {
    generation: 3,
    renderState: "xlsx",
    selectedSheetName: "Q1",
    sheetScrolls: new Map(),
    sheetport: { value: sheetport },
    scheduleWindow: () => {
      windows += 1;
    },
  };

  xlsxViewer.followSheetScroll.call(owner);
  assert.deepEqual(owner.sheetScrolls.get("Q1"), { top: 120, left: 30 });

  owner.renderState = "loading";
  sheetport.scrollTop = 0;
  xlsxViewer.followSheetScroll.call(owner);
  assert.deepEqual(owner.sheetScrolls.get("Q1"), { top: 120, left: 30 });
  assert.equal(windows, 2, "each scroll still asks for the cells near the viewport");
});

test("names the sheet read last and where each sheet was, and nothing before a sheet is shown", () => {
  const owner = {
    selectedSheetName: "Q2",
    sheetScrolls: new Map([["Q2", { top: 40, left: 8 }]]),
  };

  const position = xlsxViewer.readingPosition.call(owner);

  assert.equal(position.sheet, "Q2");
  assert.deepEqual([...position.scrolls], [["Q2", { top: 40, left: 8 }]]);
  assert.notEqual(position.scrolls, owner.sheetScrolls, "later scrolling does not change it");
  assert.equal(
    xlsxViewer.readingPosition.call({ selectedSheetName: null, sheetScrolls: new Map() }),
    null,
  );
});

test("offers the drawn cells' links and the other sheets' tabs", () => {
  const report = cellLink("3:1", "https://example.com/report", "Report");
  const mail = cellLink("4:0", "mailto:team@example.com", "Team");
  const tabTarget = { id: "tab" };
  const { owner, sheetport, tabs, received } = workbookViewer({
    links: [report, mail],
    tabScope: { blocked: false, targets: [tabTarget], mutationRoots: [], scrollRoots: [] },
  });
  const fileViewer = { id: "file-viewer" };

  const scope = owner.actionHintScope({
    scopeId: "review:viewer:document",
    actions: { link: "link.open", button: "button.activate" },
    clipRoots: [fileViewer],
  });

  assert.deepEqual(scope.targets.slice(0, 2).map(({ id, label }) => ({ id, label })), [
    { id: "review:viewer:document:cell:3:1", label: "Open Report in a new tab" },
    { id: "review:viewer:document:cell:4:0", label: "Open Team in an email app" },
  ]);
  assert.deepEqual(scope.targets[0].clipRoots, [sheetport, owner, fileViewer]);
  assert.equal(scope.targets[2], tabTarget);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.scrollRoots, [sheetport]);
  assert.deepEqual(received.tabs, {
    scopeId: "review:viewer:document:sheets",
    actionId: "button.activate",
    clipRoots: [tabs, owner, fileViewer],
  });
});

test("offers nothing while the workbook loads or failed", () => {
  const { owner } = workbookViewer({
    links: [cellLink("0:0", "https://example.com", "Site")],
  });

  for (const renderState of ["loading", "error"]) {
    owner.renderState = renderState;
    assert.deepEqual(owner.actionHintScope({
      scopeId: "review:viewer:document",
      actions: { link: "link.open", button: "button.activate" },
    }).targets, []);
  }
});

test("stops measuring and drawing the sheet when released", () => {
  const events = [];
  const frames = [];
  const original = globalThis.window;
  globalThis.window = { cancelAnimationFrame: (frame) => frames.push(frame) };
  try {
    const owner = {
      generation: 2,
      sizeObserver: { disconnect: () => events.push("disconnect") },
      windowFrame: 7,
      workbook: {},
      visibleSheets: [],
      sheet: {},
      renderedRange: {},
    };

    xlsxViewer.release.call(owner);

    assert.deepEqual(events, ["disconnect"]);
    assert.deepEqual(frames, [7]);
    assert.equal(owner.generation, 3);
    assert.equal(owner.windowFrame, 0);
    for (const field of ["sizeObserver", "workbook", "visibleSheets", "sheet", "renderedRange"]) {
      assert.equal(owner[field], null, field);
    }
  } finally {
    globalThis.window = original;
  }
});
