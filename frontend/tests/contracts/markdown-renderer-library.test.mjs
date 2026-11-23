import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const MARKDOWN_OWNERS = [
  "components/markdown-preview.ts",
  "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.ts",
];

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("both Markdown owners and the browser suite load the same Words release", () => {
  const manifest = JSON.parse(read("package.json"));
  const version = manifest.devDependencies["@pierre/words"];
  assert.ok(version, "the browser suite serves Words from node_modules");
  const pinned = new RegExp(
    `const WORDS_IMPORT =\\s*"https://cdn\\.jsdelivr\\.net/npm/@pierre/words@${version.replaceAll(".", "\\.")}/dist/no-math\\.js";`,
  );
  for (const owner of MARKDOWN_OWNERS) {
    assert.match(read(owner), pinned, `${owner} must load the Words release the suite serves`);
  }
});

test("the browser suite serves Words from the installed package", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(defaults, /const CDN_PACKAGES = \[[^\]]*"@pierre\/words"/);
});

test("Words stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.ts");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  assert.doesNotMatch(serviceWorker, /@pierre\/words|no-math\.js/);
  assert.doesNotMatch(staticAssets, /@pierre\/words|no-math\.js/);
});
