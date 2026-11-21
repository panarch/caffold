import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite use the same RHWP release", () => {
  const source = read("components/hwp-viewer.ts");
  const manifest = JSON.parse(read("package.json"));
  const lockfile = JSON.parse(read("package-lock.json"));
  const [, version] = source.match(/const RHWP_VERSION = "([^"]+)";/) ?? [];
  assert.ok(version);
  assert.equal(manifest.devDependencies["@rhwp/core"], version);
  assert.equal(lockfile.packages["node_modules/@rhwp/core"].version, version);
  assert.match(source, /cdn\.jsdelivr\.net\/npm\/@rhwp\/core@\$\{RHWP_VERSION\}\/rhwp\.js/);
  assert.match(read("tests/e2e/support/browser-defaults.js"), /const CDN_PACKAGES = \[[^\]]*"@rhwp\/core"/);
});

test("the app shell carries the Hangul viewer while RHWP loads on demand", () => {
  const serviceWorker = read("service-worker.ts");
  const staticAssets = read("../caffold/src/static_assets.rs");
  for (const source of [serviceWorker, staticAssets]) {
    assert.match(source, /components\/hwp-viewer\.js"/);
    assert.match(source, /components\/hwp-viewer\.css\.js"/);
    assert.doesNotMatch(source, /rhwp_bg\.wasm|@rhwp\/core/);
  }
});
