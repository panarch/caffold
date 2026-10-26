import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./xlsx-viewer.ts");
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
  const owner = Object.assign(Object.create(xlsxViewer), {
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
