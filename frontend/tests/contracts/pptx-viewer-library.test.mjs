import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same pptx-renderer release", () => {
  const viewer = read("components/pptx-viewer.js");
  const manifest = JSON.parse(read("package.json"));

  const [, sourceVersion] =
    viewer.match(/const PPTX_RENDERER_VERSION = "([^"]+)";/) ?? [];
  assert.ok(sourceVersion, "the PowerPoint viewer must pin one pptx-renderer version");
  assert.equal(
    manifest.devDependencies["@aiden0z/pptx-renderer"],
    sourceVersion,
    "the browser suite serves node_modules, so its pptx-renderer must match the CDN version users load",
  );
  assert.match(
    viewer,
    /@aiden0z\/pptx-renderer@\$\{PPTX_RENDERER_VERSION\}`[\s\S]*?"\/dist\/aiden0z-pptx-renderer\.browser\.es\.js"/,
  );
});

test("the browser suite serves pptx-renderer from the installed package", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(defaults, /const CDN_PACKAGES = \[[^\]]*"@aiden0z\/pptx-renderer"/);
});

test("pptx-renderer stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.js");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  for (const manifest of [serviceWorker, staticAssets]) {
    assert.doesNotMatch(manifest, /pptx-renderer/);
  }
  assert.match(serviceWorker, /"\/assets\/components\/pptx-viewer\.js"/);
  assert.match(staticAssets, /"components\/pptx-viewer\.js"/);
});
