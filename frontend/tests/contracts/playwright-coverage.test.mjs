import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  ALL_VIEWPORTS_TAG,
  VIEWPORT_COVERAGE_TAGS,
  VIEWPORT_PROJECTS,
  viewportCoveragePattern,
} from "../e2e/support/project-coverage.js";

const e2eRoot = resolve(import.meta.dirname, "../e2e");
const allowedTags = new Set(VIEWPORT_COVERAGE_TAGS);

async function specFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await specFiles(path));
    } else if (entry.name.endsWith(".spec.js")) {
      files.push(path);
    }
  }
  return files.sort();
}

function declarationBlocks(source) {
  const starts = [...source.matchAll(/^[ \t]*test\(/gm)].map((match) => match.index);
  return starts.map((start, index) =>
    source.slice(start, starts[index + 1] ?? source.length)
  );
}

function declarationTags(block) {
  const header = block.slice(0, block.indexOf("async"));
  const details = header.match(/\{\s*tag:\s*("@[^"]+"|\[[^\]]+\])\s*\},\s*$/s);
  assert.ok(details, `missing viewport coverage tag:\n${header.trim()}`);
  return [...details[1].matchAll(/"(@[^"]+)"/g)].map((match) => match[1]);
}

test("every Playwright test declares its minimum viewport coverage", async () => {
  let declarations = 0;
  for (const file of await specFiles(e2eRoot)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /test\.skip\(\s*testInfo\.project\.name/,
      `${file} uses a runtime project skip instead of a coverage tag`,
    );
    for (const block of declarationBlocks(source)) {
      declarations += 1;
      const tags = declarationTags(block);
      assert.ok(tags.length > 0);
      assert.equal(new Set(tags).size, tags.length, `duplicate coverage tag in ${file}`);
      assert.ok(
        tags.every((tag) => allowedTags.has(tag)),
        `unknown viewport coverage tag in ${file}: ${tags.join(", ")}`,
      );
      assert.ok(
        tags.length === 1 || !tags.includes(ALL_VIEWPORTS_TAG),
        `@all-viewports cannot be combined with project tags in ${file}`,
      );
    }
  }
  assert.ok(declarations > 0);
});

test("viewport projects select shared and project-specific coverage", () => {
  for (const project of VIEWPORT_PROJECTS) {
    const pattern = viewportCoveragePattern(project);
    assert.match(ALL_VIEWPORTS_TAG, pattern);
    assert.match(`@${project}`, pattern);
    for (const other of VIEWPORT_PROJECTS.filter((candidate) => candidate !== project)) {
      assert.doesNotMatch(`@${other}`, pattern);
    }
  }
});
