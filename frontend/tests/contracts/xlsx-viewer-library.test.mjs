import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same SheetJS release", () => {
  const viewer = read("components/xlsx-viewer.js");
  const manifest = JSON.parse(read("package.json"));

  const [, sourceVersion] =
    viewer.match(/const SHEETJS_VERSION = "([^"]+)";/) ?? [];
  assert.ok(sourceVersion, "the Excel viewer must pin one SheetJS version");
  assert.equal(
    manifest.devDependencies.xlsx,
    `https://cdn.sheetjs.com/xlsx-${sourceVersion}/xlsx-${sourceVersion}.tgz`,
    "the browser suite serves node_modules, so its SheetJS must be the CDN release users load",
  );
  assert.match(
    viewer,
    /`https:\/\/cdn\.sheetjs\.com\/xlsx-\$\{SHEETJS_VERSION\}\/package\/xlsx\.mjs`/,
  );
});

test("the browser suite answers SheetJS's CDN from the installed package", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(
    defaults,
    /prefix: `https:\/\/cdn\.sheetjs\.com\/xlsx-\$\{installedPackageVersion\("xlsx"\)\}\/package\/`/,
  );
  assert.match(defaults, /page\.route\("https:\/\/cdn\.sheetjs\.com\/\*\*"/);
  assert.match(defaults, /"\.js": "text\/javascript"/);
});

test("SheetJS stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.js");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  for (const manifest of [serviceWorker, staticAssets]) {
    assert.doesNotMatch(manifest, /sheetjs|xlsx\.(?:mjs|full|core|mini)/i);
  }
  assert.match(serviceWorker, /"\/assets\/components\/xlsx-viewer\.js"/);
  assert.match(staticAssets, /"components\/xlsx-viewer\.js"/);
});
