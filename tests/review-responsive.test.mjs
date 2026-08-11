import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REVIEW_SINGLE_PANE_MAX_WIDTH_PX,
  REVIEW_SINGLE_PANE_MEDIA_QUERY,
} from "../frontend/components/review-responsive.js";

const frontendUrl = new URL("../frontend/", import.meta.url);

function readFrontend(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("review file workspaces share one single-pane boundary", () => {
  assert.equal(REVIEW_SINGLE_PANE_MAX_WIDTH_PX, 860);
  assert.equal(REVIEW_SINGLE_PANE_MEDIA_QUERY, "(max-width: 860px)");

  const layoutStyles = [
    "components/git-compare-browser.css",
    "pages/(task-workspace)/tasks/components/detail/review/changes-tree.css",
    "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.css",
    "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.css",
  ];
  for (const path of layoutStyles) {
    const source = readFrontend(path);
    assert.match(
      source,
      /@media \(max-width: 860px\)/,
      `${path} must use the shared boundary`,
    );
    assert.doesNotMatch(
      source,
      /@media \(max-width: 1100px\)/,
      `${path} must not add an intermediate stacked layout`,
    );
  }

  const behaviorSources = [
    "components/git-compare-browser.js",
    "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.js",
  ];
  for (const path of behaviorSources) {
    const source = readFrontend(path);
    assert.match(source, /REVIEW_SINGLE_PANE_MEDIA_QUERY/);
    assert.doesNotMatch(source, /matchMedia\("\(max-width: 860px\)"\)/);
  }
});
