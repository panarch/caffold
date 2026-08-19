import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("reorders existing rows while preserving structural and reconciled state", { tag: "@all-viewports" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const result = await page.evaluate(async () => {
    await import("/assets/components/file-tree.js");
    const { setFileSortMode } = await import("/assets/settings.js");
    const ready = (nodes) => ({ status: "ready", nodes });
    const tree = document.createElement("caffold-file-tree");
    tree.setAttribute("aria-label", "Ordering contract tree");
    document.body.append(tree);

    const nodes = [
      {
        key: "group:unstaged",
        kind: "group",
        name: "Unstaged",
        order: 1,
        children: ready([
          {
            key: "directory:error",
            kind: "directory",
            name: "Error",
            expandedByDefault: true,
            children: { status: "error", message: "Unable to load Error" },
          },
          { key: "file:zebra", kind: "file", name: "Zebra" },
        ]),
      },
      {
        key: "parent",
        kind: "directory",
        name: "..",
        variant: "parent",
      },
      {
        key: "group:staged",
        kind: "group",
        name: "Staged",
        order: 0,
        children: ready([
          {
            key: "directory:beta",
            kind: "directory",
            name: "beta",
            expandedByDefault: true,
            children: { status: "loading", message: "Loading beta" },
          },
          { key: "file:zeta", kind: "file", name: "Zeta" },
          { key: "file:aardvark", kind: "file", name: "aardvark" },
          { key: "file:readme-lower", kind: "file", name: "readme" },
          { key: "file:readme-upper", kind: "file", name: "README" },
          { key: "symlink:alpha", kind: "symlink", name: "alpha" },
        ]),
      },
    ];
    tree.setModel({
      entityKey: "ordering-contract",
      nodes,
      selectedKey: "file:zeta",
    });

    const rowKeys = (target) => [
      ...target.querySelectorAll(":scope .file-tree-rows > li"),
    ].map((row) => row.dataset.fileTreeRowKey);
    const selectedRow = tree.rowForKey("file:zeta");
    const selectedButton = selectedRow.querySelector("button");
    selectedRow.contractMarker = "retained-row";
    selectedButton.contractMarker = "retained-button";
    selectedButton.focus();

    const foldersFirst = rowKeys(tree);
    setFileSortMode("name");
    const byName = rowKeys(tree);

    const overrideTree = document.createElement("caffold-file-tree");
    overrideTree.setAttribute("file-sort-mode", "folders-first");
    document.body.append(overrideTree);
    overrideTree.setModel({
      entityKey: "ordering-override",
      nodes: [
        { key: "override:file", kind: "file", name: "aardvark" },
        { key: "override:directory", kind: "directory", name: "beta" },
      ],
    });

    return {
      foldersFirst,
      byName,
      override: rowKeys(overrideTree),
      sameRow:
        tree.rowForKey("file:zeta") === selectedRow &&
        selectedRow.contractMarker === "retained-row",
      sameButton:
        tree.rowForKey("file:zeta").querySelector("button") === selectedButton &&
        selectedButton.contractMarker === "retained-button",
      focusPreserved: document.activeElement === selectedButton,
      selectionPreserved:
        tree.selectedKey === "file:zeta" &&
        selectedButton.getAttribute("aria-current") === "true",
      expansionPreserved:
        tree.isExpanded("directory:beta") &&
        tree.isExpanded("directory:error"),
      entityPreserved: tree.entityKey === "ordering-contract",
    };
  });

  expect(result.foldersFirst).toEqual([
    "parent",
    "group:staged",
    "directory:beta",
    "directory:beta:children-state",
    "file:aardvark",
    "file:readme-lower",
    "file:readme-upper",
    "file:zeta",
    "symlink:alpha",
    "group:unstaged",
    "directory:error",
    "directory:error:children-state",
    "file:zebra",
  ]);
  expect(result.byName).toEqual([
    "parent",
    "group:staged",
    "file:aardvark",
    "symlink:alpha",
    "directory:beta",
    "directory:beta:children-state",
    "file:readme-upper",
    "file:readme-lower",
    "file:zeta",
    "group:unstaged",
    "directory:error",
    "directory:error:children-state",
    "file:zebra",
  ]);
  expect(result.override).toEqual(["override:directory", "override:file"]);
  expect(result).toEqual(expect.objectContaining({
    sameRow: true,
    sameButton: true,
    focusPreserved: true,
    selectionPreserved: true,
    expansionPreserved: true,
    entityPreserved: true,
  }));
});
