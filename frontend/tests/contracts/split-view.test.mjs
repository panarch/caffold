import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function readFrontend(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

const REVIEW_FILE_SCREENS = [
  "pages/(task-workspace)/tasks/(detail)/(review)/layout.ts",
  "components/git-compare-browser.ts",
  "pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.ts",
  "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.ts",
];

function splitViewBoundaries() {
  const source = readFrontend("components/split-view.ts");
  const single = Number(source.match(/SPLIT_VIEW_SINGLE_MAX_WIDTH_PX = (\d+);/)?.[1]);
  const drawer = Number(source.match(/SPLIT_VIEW_DRAWER_MAX_WIDTH_PX = (\d+);/)?.[1]);
  assert.ok(single && drawer, "split-view.ts names its boundaries");
  return { single, drawer };
}

test("the split view's boundaries match its stylesheet", () => {
  const { single, drawer } = splitViewBoundaries();
  const styles = readFrontend("components/split-view.css");
  assert.match(styles, new RegExp(`@media \\(max-width: ${single}px\\)`));
  assert.match(
    styles,
    new RegExp(
      `@media \\(min-width: ${single + 1}px\\) and \\(max-width: ${drawer}px\\)`,
    ),
  );
});

test("the lists and the file header take their phone look at the split view's phone width", () => {
  const { single } = splitViewBoundaries();
  for (const path of [
    "components/file-navigator/components/list.css",
    "components/git-compare-tree.css",
    "components/file-viewer.css",
    "pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.css",
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.css",
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.css",
  ]) {
    const source = readFrontend(path);
    assert.match(
      source,
      new RegExp(`@media \\(max-width: ${single}px\\)`),
      `${path} uses the split view's phone width`,
    );
    assert.doesNotMatch(source, /@media \(max-width: 860px\)/, path);
  }
});

test("review file screens lay out their list and file through the split view", () => {
  for (const path of REVIEW_FILE_SCREENS) {
    const source = readFrontend(path);
    assert.match(source, /<caffold-split-view\b/, `${path} mounts the split view`);
    assert.doesNotMatch(
      source,
      /<caffold-pane-resizer\b/,
      `${path} leaves the resizer to the split view`,
    );
    assert.doesNotMatch(
      source,
      /matchMedia\(/,
      `${path} leaves the layout boundaries to the split view`,
    );
  }
});
