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

for (const themeMode of ["light", "dark"]) {
  test(`draws ${themeMode} tree guides that end at each directory's last child`, { tag: ["@desktop", "@phone"] }, async ({
    page,
  }) => {
    await page.goto("/settings/files");
    await page.evaluate(async (mode) => {
      await import("/assets/components/file-tree.js");
      const { setThemeMode } = await import("/assets/settings.js");
      setThemeMode(mode);
      const ready = (nodes) => ({ status: "ready", nodes });
      const directory = (name, children) => ({
        key: `directory:${name}`,
        kind: "directory",
        name,
        expandedByDefault: true,
        children,
      });
      const file = (name, status) => ({ key: `file:${name}`, kind: "file", name, status });

      const fixture = document.createElement("div");
      fixture.style.background = "var(--surface)";
      const changes = document.createElement("caffold-file-tree");
      const files = document.createElement("caffold-file-tree");
      fixture.append(changes, files);
      document.body.replaceChildren(fixture);

      changes.setModel({
        entityKey: "indent-guides-changes",
        statusColumn: true,
        selectedKey: "file:code-block.js",
        nodes: [
          {
            key: "group:unstaged",
            kind: "group",
            name: "Unstaged",
            children: ready([
              directory("frontend", ready([
                directory("components", ready([
                  directory("conversation", ready([file("code-block.js", "M")])),
                  file("dialog.js", "A"),
                ])),
                directory("styles", ready([file("layout.css", "M"), file("theme.css", "M")])),
              ])),
              file("README.md", "M"),
            ]),
          },
        ],
      });
      files.setModel({
        entityKey: "indent-guides-files",
        nodes: [
          directory("src", ready([
            directory("lazy", { status: "loading", message: "Loading lazy" }),
            file("index.js"),
          ])),
        ],
      });
      await document.fonts.load(getComputedStyle(changes.querySelector(".file-tree-entry")).font);
    }, themeMode);
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width - 1, viewport.height - 1);

    const screenshot = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    const guides = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))]),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const color = (x, y) => {
        const offset = (y * bitmap.width + Math.floor(x)) * 4;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      };
      const contrast = (x, y, background) => Math.max(
        ...[x, x + 1].flatMap((column) =>
          color(column, y).map((channel, index) => Math.abs(channel - background[index]))
        ),
      );

      return Object.fromEntries(
        [...document.querySelectorAll("caffold-file-tree")].flatMap((tree) => {
          const rows = [
            ...tree.querySelectorAll(".file-tree-rows > li:not(.file-tree-group)"),
          ].map((row) => ({
            row,
            depth: Number(
              (row.querySelector(":scope > button") ?? row).style.getPropertyValue("--tree-depth"),
            ),
          }));
          const iconCenters = [];
          for (const { row, depth } of rows) {
            const icon = row.querySelector(".file-tree-icon")?.getBoundingClientRect();
            if (icon) {
              iconCenters[depth] ??= icon.left + icon.width / 2;
            }
          }
          const columns = iconCenters.slice(0, Math.max(...rows.map(({ depth }) => depth)));
          const indent = columns[1] - columns[0];
          const betweenGuides = columns[0] + indent / 2;

          return rows.map(({ row, depth }) => {
            const rect = row.getBoundingClientRect();
            const [top, bottom] = [Math.ceil(rect.top) + 1, Math.floor(rect.bottom) - 2].map((y) => {
              const background = color(betweenGuides, y);
              return columns.map((x) => contrast(x, y, background) >= 6);
            });
            const branchX = (depth > 0 ? columns[depth - 1] : columns[0] - indent) + 4;
            const branchBackground = color(branchX, Math.ceil(rect.top) + 1);
            const middle = Math.floor(rect.top + rect.height / 2);
            return [
              row.dataset.fileTreeRowKey,
              {
                columns: top.map((guide, index) => (guide === bottom[index] ? guide : "partial")),
                branch: [middle - 1, middle, middle + 1].some((y) =>
                  contrast(branchX, y, branchBackground) >= 6
                ),
              },
            ];
          });
        }),
      );
    }, screenshot.toString("base64"));

    expect(guides).toEqual({
      "directory:frontend": { columns: [false, false, false], branch: false },
      "directory:components": { columns: [true, false, false], branch: true },
      "directory:conversation": { columns: [true, true, false], branch: true },
      "file:code-block.js": { columns: [true, true, "partial"], branch: true },
      "file:dialog.js": { columns: [true, "partial", false], branch: true },
      "directory:styles": { columns: ["partial", false, false], branch: true },
      "file:layout.css": { columns: [false, true, false], branch: true },
      "file:theme.css": { columns: [false, "partial", false], branch: true },
      "file:README.md": { columns: [false, false, false], branch: false },
      "directory:src": { columns: [false, false], branch: false },
      "directory:lazy": { columns: [true, false], branch: true },
      "directory:lazy:children-state": { columns: [true, "partial"], branch: true },
      "file:index.js": { columns: ["partial", false], branch: true },
    });
  });
}
