import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./xlsx-viewer.js");
const xlsxViewer = registry.element("caffold-xlsx-viewer").prototype;
after(() => registry.restore());

function loadedViewer(url, revision = 1700) {
  const opened = [];
  return {
    opened,
    owner: {
      initialized: true,
      generation: 4,
      url,
      revision,
      selectedSheetName: "Q3",
      dataset: { renderState: "xlsx" },
      ensureRendered() {},
      showMessage(renderState) {
        this.dataset.renderState = renderState;
      },
      release() {
        xlsxViewer.release.call(this);
      },
      open(generation, requested) {
        opened.push(requested);
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

function workbookViewer({ links = [], tabsHidden = false, tabScope = null } = {}) {
  const received = {};
  const sheetport = {
    isConnected: true,
    getClientRects: () => [{}],
    querySelectorAll: () => links,
    contains: (element) => links.includes(element),
  };
  const control = {
    actionHintScope(options) {
      received.tabs = options;
      return tabScope ?? { blocked: false, targets: [], mutationRoots: [this], scrollRoots: [] };
    },
  };
  const tabs = {
    hidden: tabsHidden,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => control,
  };
  const owner = {
    initialized: true,
    isConnected: true,
    hidden: false,
    dataset: { renderState: "xlsx" },
    ensureRendered() {},
    sheetport: () => sheetport,
    tabStrip: () => tabs,
  };
  return { owner, sheetport, tabs, control, received };
}

test("keeps the open workbook while its file is unchanged", () => {
  const { owner, opened } = loadedViewer("/api/document?path=budget.xlsx");

  xlsxViewer.setSource.call(owner, {
    url: "/api/document?path=budget.xlsx",
    revision: 1700,
  });

  assert.deepEqual(opened, []);
  assert.equal(owner.dataset.renderState, "xlsx");
});

test("keeps the sheet being read when the same file changes on disk", () => {
  const { owner, opened } = loadedViewer("/api/document?path=budget.xlsx");

  xlsxViewer.setSource.call(owner, {
    url: "/api/document?path=budget.xlsx",
    revision: 1800,
  });

  assert.deepEqual(opened, ["/api/document?path=budget.xlsx"]);
  assert.equal(owner.dataset.renderState, "loading");
  assert.equal(owner.selectedSheetName, "Q3");
});

test("starts another file at its first sheet", () => {
  const { owner, opened } = loadedViewer("/api/document?path=budget.xlsx");

  xlsxViewer.setSource.call(owner, {
    url: "/api/document?path=forecast.xlsm",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/document?path=forecast.xlsm"]);
  assert.equal(owner.selectedSheetName, null);
});

test("retries the same workbook after a failed load", () => {
  const { owner, opened } = loadedViewer("/api/document?path=budget.xlsx");
  owner.dataset.renderState = "error";

  xlsxViewer.setSource.call(owner, {
    url: "/api/document?path=budget.xlsx",
    revision: 1700,
  });

  assert.deepEqual(opened, ["/api/document?path=budget.xlsx"]);
});

test("scrolls the sheet on both axes and the sheet tabs sideways", () => {
  const { owner, sheetport, tabs } = workbookViewer();
  let current = true;

  const scope = xlsxViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer:xlsx",
    label: "budget.xlsx preview",
    isCurrent: () => current,
  });

  assert.deepEqual(scope.surfaces.map(({ id, label, axes, scrollport }) => ({
    id,
    label,
    axes,
    scrollport,
  })), [
    {
      id: "review:viewer:xlsx:sheet",
      label: "budget.xlsx preview",
      axes: ["vertical", "horizontal"],
      scrollport: sheetport,
    },
    {
      id: "review:viewer:xlsx:sheets",
      label: "budget.xlsx preview sheets",
      axes: ["horizontal"],
      scrollport: tabs,
    },
  ]);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = false;
  assert.equal(scope.surfaces[0].isEligible(), false);
});

test("publishes no tab surface for a single sheet and nothing before a workbook is drawn", () => {
  const single = workbookViewer({ tabsHidden: true });
  assert.deepEqual(
    xlsxViewer.scrollSurfaceScope.call(single.owner, { scopeId: "review:viewer:xlsx" })
      .surfaces.map(({ id }) => id),
    ["review:viewer:xlsx:sheet"],
  );

  const loading = workbookViewer();
  loading.owner.sheetport = () => null;
  assert.deepEqual(
    xlsxViewer.scrollSurfaceScope.call(loading.owner, { scopeId: "review:viewer:xlsx" })
      .surfaces,
    [],
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
  let current = true;

  const scope = xlsxViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer:document",
    linkActionId: "link.open",
    buttonActionId: "button.activate",
    clipRoots: [{ id: "file-viewer" }],
    isCurrent: () => current,
  });

  assert.deepEqual(scope.targets.slice(0, 2).map(({ id, label }) => ({ id, label })), [
    { id: "review:viewer:document:cell:3:1", label: "Open Report in a new tab" },
    { id: "review:viewer:document:cell:4:0", label: "Open Team in an email app" },
  ]);
  assert.equal(scope.targets[2], tabTarget);
  assert.deepEqual(scope.scrollRoots, [owner, sheetport]);
  assert.equal(received.tabs.scopeId, "review:viewer:document:sheets");
  assert.equal(received.tabs.actionId, "button.activate");
  assert.deepEqual(received.tabs.clipRoots, [tabs, owner, { id: "file-viewer" }]);
  assert.equal(received.tabs.labelForChoice({ label: "Q3" }), "Show sheet Q3");
  assert.equal(scope.targets[0].isActionable(), true);
  current = false;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("offers nothing while the workbook loads or failed", () => {
  const { owner } = workbookViewer({
    links: [cellLink("0:0", "https://example.com", "Site")],
  });

  for (const renderState of ["loading", "error"]) {
    owner.dataset.renderState = renderState;
    assert.deepEqual(xlsxViewer.actionHintScope.call(owner, {
      scopeId: "review:viewer:document",
      linkActionId: "link.open",
      buttonActionId: "button.activate",
    }).targets, []);
  }
});

test("stops reading, measuring, and drawing the sheet when released", () => {
  const events = [];
  const frames = [];
  const original = globalThis.window;
  globalThis.window = { cancelAnimationFrame: (frame) => frames.push(frame) };
  try {
    const owner = {
      generation: 2,
      url: "/api/document?path=budget.xlsx",
      revision: 1700,
      reading: { abort: () => events.push("abort") },
      sizeObserver: { disconnect: () => events.push("disconnect") },
      windowFrame: 7,
      workbook: {},
      visibleSheets: [],
      sheet: {},
      renderedRange: {},
    };

    xlsxViewer.release.call(owner);

    assert.deepEqual(events, ["abort", "disconnect"]);
    assert.deepEqual(frames, [7]);
    assert.equal(owner.generation, 3);
    assert.equal(owner.windowFrame, 0);
    for (const field of ["url", "revision", "reading", "sizeObserver", "workbook", "visibleSheets", "sheet", "renderedRange"]) {
      assert.equal(owner[field], null, field);
    }
  } finally {
    globalThis.window = original;
  }
});
