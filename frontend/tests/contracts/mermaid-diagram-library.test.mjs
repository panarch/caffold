import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const DIAGRAM =
  "pages/(task-workspace)/tasks/(detail)/(task)/components/mermaid-preview-dialog/components/mermaid-diagram";

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same Mermaid release", () => {
  const diagram = read(`${DIAGRAM}.ts`);
  const manifest = JSON.parse(read("package.json"));

  const [, sourceVersion] = diagram.match(/const MERMAID_VERSION = "([^"]+)";/) ?? [];
  assert.ok(sourceVersion, "the Mermaid diagram must pin one Mermaid version");
  assert.equal(
    manifest.devDependencies.mermaid,
    sourceVersion,
    "the browser suite serves node_modules, so its Mermaid must match the CDN version users load",
  );
});

test("the browser suite serves Mermaid from the installed package", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(defaults, /const CDN_PACKAGES = \[[^\]]*"mermaid"/);
});

test("Mermaid stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.ts");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  assert.doesNotMatch(serviceWorker, /node_modules\/mermaid|mermaid\.esm/);
  assert.doesNotMatch(staticAssets, /node_modules\/mermaid|mermaid\.esm/);
  assert.match(serviceWorker, new RegExp(`"/assets/${escape(DIAGRAM)}\\.js"`));
  assert.match(staticAssets, new RegExp(`"${escape(DIAGRAM)}\\.js"`));
});

function escape(path) {
  return path.replace(/[()]/g, "\\$&");
}
