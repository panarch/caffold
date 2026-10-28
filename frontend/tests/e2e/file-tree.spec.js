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
      ...target.shadowRoot.querySelectorAll(".file-tree-rows > li"),
    ].map((row) => row.dataset.fileTreeRowKey);
    const selectedRow = tree.rowForKey("file:zeta");
    const selectedButton = selectedRow.querySelector("button");
    selectedRow.contractMarker = "retained-row";
    selectedButton.contractMarker = "retained-button";
    selectedButton.focus();
    const loadingPhrase = () =>
      tree.rowForKey("directory:beta:children-state").querySelector("caffold-loading-text");
    const phrase = loadingPhrase();

    const foldersFirst = rowKeys(tree);
    setFileSortMode("name");
    await tree.updateComplete;
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
      focusPreserved: tree.shadowRoot.activeElement === selectedButton,
      selectionPreserved:
        tree.selectedKey === "file:zeta" &&
        selectedButton.getAttribute("aria-current") === "true",
      expansionPreserved:
        tree.isExpanded("directory:beta") &&
        tree.isExpanded("directory:error"),
      entityPreserved: tree.entityKey === "ordering-contract",
      // Its owner waited before adding the row, so the phrase shows at once,
      // and moving the row keeps it from starting over.
      loadingPhrase: {
        immediate: phrase.hasAttribute("immediate"),
        text: phrase.textContent,
        preserved: loadingPhrase() === phrase,
      },
      errorPhrase: tree.rowForKey("directory:error:children-state").textContent,
      errorIsPlainText: !tree
        .rowForKey("directory:error:children-state")
        .querySelector("caffold-loading-text"),
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
    loadingPhrase: { immediate: true, text: "Loading beta", preserved: true },
    errorPhrase: "Unable to load Error",
    errorIsPlainText: true,
  }));
});

for (const themeMode of ["light", "dark"]) {
  test(`draws ${themeMode} tree guides from each directory's icon to its last child`, { tag: ["@desktop", "@phone"] }, async ({
    page,
  }) => {
    await page.goto("/settings/files");
    await page.evaluate(async (mode) => {
      await import("/assets/components/file-tree.js");
      const { warmIcons } = await import("/assets/components/icons.js");
      await warmIcons();
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
      await document.fonts.load(getComputedStyle(changes.shadowRoot.querySelector(".file-tree-entry")).font);
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
            ...tree.shadowRoot.querySelectorAll(".file-tree-rows > li:not(.file-tree-group)"),
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
            const result = {
              columns: top.map((guide, index) => (guide === bottom[index] ? guide : "partial")),
              branch: [middle - 1, middle, middle + 1].some((y) =>
                contrast(branchX, y, branchBackground) >= 6
              ),
            };
            const directory = row.querySelector(':scope > button[aria-expanded="true"]');
            if (directory) {
              const icon = directory.querySelector(".entry-icon-svg").getBoundingClientRect();
              let guideTop = Math.ceil(rect.bottom) + 1;
              while (contrast(columns[depth], guideTop - 1, color(betweenGuides, guideTop - 1)) >= 6) {
                guideTop -= 1;
              }
              result.start = Math.abs(guideTop - icon.bottom) <= 1;
            }
            return [row.dataset.fileTreeRowKey, result];
          });
        }),
      );
    }, screenshot.toString("base64"));

    expect(guides).toEqual({
      "directory:frontend": { columns: ["partial", false, false], branch: false, start: true },
      "directory:components": { columns: [true, "partial", false], branch: true, start: true },
      "directory:conversation": { columns: [true, true, "partial"], branch: true, start: true },
      "file:code-block.js": { columns: [true, true, "partial"], branch: true },
      "file:dialog.js": { columns: [true, "partial", false], branch: true },
      "directory:styles": { columns: ["partial", "partial", false], branch: true, start: true },
      "file:layout.css": { columns: [false, true, false], branch: true },
      "file:theme.css": { columns: [false, "partial", false], branch: true },
      "file:README.md": { columns: [false, false, false], branch: false },
      "directory:src": { columns: ["partial", false], branch: false, start: true },
      "directory:lazy": { columns: [true, "partial"], branch: true, start: true },
      "directory:lazy:children-state": { columns: [true, "partial"], branch: true },
      "file:index.js": { columns: ["partial", false], branch: true },
    });
  });
}

test("places a status row's message on its branch guide below its folder's name", { tag: ["@desktop", "@phone"] }, async ({
  page,
}) => {
  await page.goto("/settings/files");
  const offsets = await page.evaluate(async () => {
    await import("/assets/components/file-tree.js");
    const directory = (name, children) => ({
      key: `directory:${name}`,
      kind: "directory",
      name,
      expandedByDefault: true,
      children,
    });
    const tree = document.createElement("caffold-file-tree");
    document.body.replaceChildren(tree);
    tree.setModel({
      entityKey: "status-rows",
      nodes: [
        directory("loading", { status: "loading", message: "Loading..." }),
        directory("unreadable", { status: "error", message: "Unable to load directory." }),
        { key: "status:top", kind: "status", name: "No matching folders." },
      ],
    });
    const rows = [...tree.shadowRoot.querySelectorAll(".file-tree-status")];
    await document.fonts.load(getComputedStyle(rows[0]).font);
    const nameLeft = (key) =>
      tree.shadowRoot.querySelector(`[data-file-tree-key="${key}"] .file-tree-name`).getBoundingClientRect().left;

    return Object.fromEntries(rows.map((row) => {
      const message = document.createRange();
      message.selectNodeContents(row.lastChild);
      const text = message.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      return [row.dataset.fileTreeRowKey, {
        // The branch guide is drawn at the middle of the row.
        guide: text.top + text.height / 2 - (rect.top + rect.height / 2),
        // A message under a folder starts below that folder's name; a
        // top-level one keeps the top-level name column.
        column: text.left - nameLeft(row.dataset.fileTreeParentKey ?? "directory:loading"),
      }];
    }));
  });

  expect(Object.keys(offsets).sort()).toEqual([
    "directory:loading:children-state",
    "directory:unreadable:children-state",
    "status:top",
  ]);
  expect(Object.entries(offsets).filter(([, { guide, column }]) =>
    Math.abs(guide) > 1 || Math.abs(column) > 1
  )).toEqual([]);
});

test("offers its rows as Action Hints: directories toggle, entries open, the open one stays out", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const result = await page.evaluate(async () => {
    await import("/assets/components/file-tree.js");
    const tree = document.createElement("caffold-file-tree");
    document.body.append(tree);
    const nodes = [
      {
        key: "src",
        kind: "directory",
        name: "src",
        selectable: false,
        children: [{ key: "src/a.js", kind: "file", name: "a.js" }],
      },
      { key: "folder", kind: "directory", name: "folder", ariaLabel: "Open folder" },
      { key: "current.js", kind: "file", name: "current.js" },
      { key: "locked.js", kind: "file", name: "locked.js", selectable: false },
      { key: "next.js", kind: "file", name: "next.js", ariaLabel: "Show diff for next.js" },
      { key: "plain.js", kind: "file", name: "plain.js" },
      { key: "off.js", kind: "file", name: "off.js", disabled: true },
    ];
    const pull = () => tree.actionHintScope({
      scopeId: "review:files",
      actions: { file: "navigation.file.open", disclosure: "disclosure.toggle" },
    });
    const described = (scope) => scope.targets.map((target) => ({
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      onIcon: target.anchor.classList.contains("file-tree-icon") &&
        target.control.contains(target.anchor),
      clippedByScroll: target.clipRoots.includes(tree.scroller()),
    }));
    tree.setModel({ entityKey: "review", nodes, selectedKey: "current.js" });
    const scope = pull();
    const collapsed = described(scope);
    const scrollRoots = scope.scrollRoots.map((root) => root === tree.scroller());
    tree.shadowRoot.querySelector('[data-file-tree-key="src"]').click();
    const expanded = described(pull())
      .filter(({ id }) => id.includes("src"))
      .map(({ id, label }) => [id, label]);
    tree.setModel({
      entityKey: "picker",
      nodes,
      selectedKey: "current.js",
      listboxLabel: "Folders",
    });
    const listbox = described(pull()).map(({ id }) => id);
    return { collapsed, scrollRoots, expanded, listbox };
  });

  const target = (id, actionId, label) => ({ id: `review:files:${id}`, actionId, label, onIcon: true, clippedByScroll: true });
  expect(result).toEqual({
    collapsed: [
      target("file:folder", "navigation.file.open", "Open folder"),
      target("disclosure:src", "disclosure.toggle", "Expand src"),
      target("file:next.js", "navigation.file.open", "Show diff for next.js"),
      target("file:plain.js", "navigation.file.open", "Open plain.js"),
    ],
    scrollRoots: [true],
    expanded: [
      ["review:files:disclosure:src", "Collapse src"],
      ["review:files:file:src%2Fa.js", "Open a.js"],
    ],
    listbox: [
      "review:files:file:folder",
      "review:files:disclosure:src",
      "review:files:file:current.js",
      "review:files:file:next.js",
      "review:files:file:plain.js",
    ],
  });
});

test("names its scrollport as a Scroll surface after the owner", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const surfaces = await page.evaluate(async () => {
    await import("/assets/components/file-tree.js");
    const tree = document.createElement("caffold-file-tree");
    document.body.append(tree);
    tree.setModel({ entityKey: "review", nodes: [{ key: "a.js", kind: "file", name: "a.js" }] });
    const described = (scope) => scope.surfaces.map((surface) => ({
      id: surface.id,
      label: surface.label,
      scrollport: surface.scrollport === tree.scroller(),
      axes: surface.axes,
      clipRoots: surface.clipRoots.map((root) => root === tree || root === tree.scroller()),
    }));
    return [
      described(tree.scrollSurfaceScope({ scopeId: "review:files" })),
      described(tree.scrollSurfaceScope({ scopeId: "review:files", label: "Changed files" })),
    ];
  });

  const surface = (label) => ({
    id: "review:files:scroll",
    label,
    scrollport: true,
    axes: ["vertical", "horizontal"],
    clipRoots: [true, true],
  });
  expect(surfaces).toEqual([[surface("Files")], [surface("Changed files")]]);
});

test("the file list offers Refresh files while it shows the button, under the label it shows", { tag: "@viewport-independent" }, async ({
  page,
}) => {
  await page.goto("/settings/files");

  const labels = await page.evaluate(async () => {
    await import("/assets/components/file-navigator/components/list.js");
    const list = document.createElement("caffold-file-list");
    document.body.append(list);
    list.setDirectory({
      path: "project",
      entries: [{ name: "a.js", path: "project/a.js", kind: "file", supported: true }],
    });
    const refreshTargets = async () => {
      await new Promise(requestAnimationFrame);
      return list.actionHintScope({
        scopeId: "review:files",
        actions: { refresh: "button.activate" },
      }).targets.map((target) => [target.id, target.actionId, target.label]);
    };
    list.setRefreshVisible(false);
    const hidden = await refreshTargets();
    list.setRefreshVisible(true);
    const shown = await refreshTargets();
    list.setRefreshState("unavailable");
    const unavailable = await refreshTargets();
    return { hidden, shown, unavailable };
  });

  expect(labels).toEqual({
    hidden: [],
    shown: [["review:files:refresh", "button.activate", "Refresh files"]],
    unavailable: [[
      "review:files:refresh",
      "button.activate",
      "Live updates unavailable. Refresh manually.",
    ]],
  });
});
