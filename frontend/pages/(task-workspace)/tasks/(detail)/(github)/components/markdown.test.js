import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./markdown.js");
const markdown = registry.element("caffold-github-markdown").prototype;
after(() => registry.restore());

test("provides the Issue Markdown host without inspecting Shadow DOM", () => {
  const shadowRoot = { querySelector: () => null };
  const owner = {
    hidden: false,
    isConnected: true,
    shadowRoot,
    scrollSurfaceRecords: [],
    clientHeight: 100,
    scrollHeight: 320,
    getClientRects: () => [{}],
  };
  let current = true;
  const scope = markdown.scrollSurfaceScope.call(owner, {
    scopeId: "github:issue:42:body",
    isCurrent: () => current,
  });
  assert.equal(scope.surfaces[0].scrollport, owner);
  assert.deepEqual(scope.surfaces[0].axes, ["vertical", "horizontal"]);
  assert.deepEqual(scope.mutationRoots, [owner, shadowRoot]);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = false;
  assert.equal(scope.surfaces[0].isEligible(), false);
});

test("composes retained Shadow DOM code and table scrollports", () => {
  const code = layoutElement();
  const table = layoutElement();
  const body = {
    contains: (element) => [code, table].includes(element),
  };
  const shadowRoot = {
    querySelector: () => body,
  };
  const codeRecord = {
    kind: "code",
    ordinal: 1,
    label: "code block 1",
    scrollport: code,
  };
  const tableRecord = {
    kind: "table",
    ordinal: 1,
    label: "Markdown table 1",
    scrollport: table,
  };
  const owner = layoutElement({
    hidden: false,
    isConnected: true,
    shadowRoot,
    scrollSurfaceRecords: [codeRecord, tableRecord],
  });

  const scope = markdown.scrollSurfaceScope.call(owner, {
    scopeId: "github:issue:42:body",
    label: "Issue description",
  });
  assert.deepEqual(scope.surfaces.map(({ id, axes, scrollport }) => ({
    id,
    axes,
    scrollport,
  })), [
    {
      id: "github:issue:42:body:scroll",
      axes: ["vertical", "horizontal"],
      scrollport: owner,
    },
    {
      id: "github:issue:42:body:code:1",
      axes: ["horizontal"],
      scrollport: code,
    },
    {
      id: "github:issue:42:body:table:1",
      axes: ["horizontal"],
      scrollport: table,
    },
  ]);
  assert.equal(scope.surfaces[1].isEligible(), true);
  owner.scrollSurfaceRecords = [tableRecord];
  assert.equal(scope.surfaces[1].isEligible(), false);
  assert.deepEqual(
    new Set(scope.mutationRoots),
    new Set([owner, shadowRoot]),
  );
});

test("provides retained sanitized Shadow DOM links and table scroll roots", () => {
  const attributes = new Map([
    ["href", "https://github.com/example/repo"],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  const tableScrollRoot = {};
  const control = {
    innerText: "Repository",
    getAttribute: (name) => attributes.get(name) ?? null,
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    closest: (selector) =>
      selector === ".markdown-table-scroll" ? tableScrollRoot : null,
    focus() {},
    click() {},
  };
  const record = {
    control,
    ordinal: 1,
    binding: {
      href: "https://github.com/example/repo",
      target: "_blank",
      rel: "noreferrer",
    },
  };
  const body = {
    contains: (element) => [control, tableScrollRoot].includes(element),
  };
  const shadowRoot = {
    querySelector: () => body,
  };
  const owner = {
    actionHintLinks: [record],
    hidden: false,
    isConnected: true,
    shadowRoot,
  };
  const scope = markdown.actionHintScope.call(owner, {
    scopeId: "github:issue:42:body",
  });

  assert.equal(scope.targets[0].id, "github:issue:42:body:link:1");
  assert.equal(scope.targets[0].label, "Open Repository in a new tab");
  assert.deepEqual(scope.mutationRoots, [owner, shadowRoot]);
  assert.deepEqual(scope.scrollRoots, [owner, tableScrollRoot]);
  assert.equal(scope.targets[0].isActionable(), true);
  attributes.set("target", "_self");
  assert.equal(scope.targets[0].isActionable(), false);
});

test("declares each folded section's summary and names it by its open state", () => {
  const calls = [];
  const body = treeElement("article");
  const details = treeElement("details", body, { open: false });
  const summary = treeElement("summary", details, {
    innerText: " Test\n output ",
    focus: () => calls.push("focus"),
    click: () => calls.push("click"),
  });
  const owner = {
    actionHintLinks: [],
    actionHintDisclosures: [{ details, summary, ordinal: 2 }],
    hidden: false,
    isConnected: true,
    shadowRoot: { querySelector: () => body },
  };
  const scope = () => markdown.actionHintScope.call(owner, {
    scopeId: "github:pull:7:body",
  });

  const closed = scope();
  assert.deepEqual(
    closed.targets.map(({ id, actionId, label }) => [id, actionId, label]),
    [["github:pull:7:body:disclosure:2", "disclosure.toggle", "Expand Test output"]],
  );
  assert.equal(closed.targets[0].isActionable(), true);
  closed.targets[0].activate();
  assert.deepEqual(calls, ["focus", "click"]);

  details.open = true;
  assert.equal(scope().targets[0].label, "Collapse Test output");

  summary.getClientRects = () => [];
  assert.deepEqual(scope().targets, []);
});

test("leaves out what a closed section folds away, though it has a layout box", () => {
  const body = treeElement("article");
  const outer = treeElement("details", body, { open: false });
  const outerSummary = treeElement("summary", outer, {
    innerText: "Review info",
  });
  const summaryLink = linkElement(outerSummary, "Review guide");
  const inner = treeElement("details", outer, { open: false });
  const innerSummary = treeElement("summary", inner, {
    innerText: "Commits",
  });
  const foldedLink = linkElement(inner, "Commit badge");
  const owner = {
    actionHintLinks: [summaryLink, foldedLink].map((control, index) => ({
      control,
      ordinal: index + 1,
      binding: {
        href: control.getAttribute("href"),
        target: null,
        rel: null,
      },
    })),
    actionHintDisclosures: [
      { details: outer, summary: outerSummary, ordinal: 1 },
      { details: inner, summary: innerSummary, ordinal: 2 },
    ],
    hidden: false,
    isConnected: true,
    shadowRoot: { querySelector: () => body },
  };
  const labels = () => markdown.actionHintScope.call(owner, {
    scopeId: "github:pull:7:body",
  }).targets.map(({ label }) => label);

  assert.deepEqual(labels(), [
    "Open Review guide",
    "Expand Review info",
  ]);

  outer.open = true;
  const outerOpen = markdown.actionHintScope.call(owner, {
    scopeId: "github:pull:7:body",
  });
  assert.deepEqual(outerOpen.targets.map(({ label }) => label), [
    "Open Review guide",
    "Collapse Review info",
    "Expand Commits",
  ]);

  inner.open = true;
  assert.deepEqual(labels(), [
    "Open Review guide",
    "Open Commit badge",
    "Collapse Review info",
    "Collapse Commits",
  ]);

  outer.open = false;
  assert.equal(outerOpen.targets[2].isActionable(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}

function treeElement(localName, parentElement = null, properties = {}) {
  const element = {
    localName,
    parentElement,
    children: [],
    getClientRects: () => [{}],
    querySelectorAll: () => [],
    querySelector(selector) {
      assert.equal(selector, ":scope > summary");
      return this.children.find((child) => child.localName === "summary") ??
        null;
    },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (node.localName === selector) {
          return node;
        }
      }
      return null;
    },
    contains(other) {
      for (let node = other; node; node = node.parentElement) {
        if (node === this) {
          return true;
        }
      }
      return false;
    },
    ...properties,
  };
  parentElement?.children.push(element);
  return element;
}

function linkElement(parentElement, innerText) {
  const href = `https://github.com/example/repo#${innerText.replace(/ /g, "-")}`;
  return treeElement("a", parentElement, {
    innerText,
    getAttribute: (name) => (name === "href" ? href : null),
  });
}
