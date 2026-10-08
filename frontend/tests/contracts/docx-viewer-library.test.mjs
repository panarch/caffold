import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same docx-preview release", () => {
  const viewer = read("components/docx-viewer.js");
  const manifest = JSON.parse(read("package.json"));

  const [, sourceVersion] =
    viewer.match(/const DOCX_PREVIEW_VERSION = "([^"]+)";/) ?? [];
  assert.ok(sourceVersion, "the Word viewer must pin one docx-preview version");
  assert.equal(
    manifest.devDependencies["docx-preview"],
    sourceVersion,
    "the browser suite serves node_modules, so its docx-preview must match the CDN version users load",
  );
  assert.match(viewer, /docx-preview@\$\{DOCX_PREVIEW_VERSION\}\/\+esm/);
});

test("the browser suite answers docx-preview's jsDelivr module from the installed packages", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(
    defaults,
    /\[`\$\{cdnPackageUrl\("docx-preview"\)\}\/\+esm`, docxPreviewModule\]/,
  );
  assert.match(
    defaults,
    /\[`\$\{cdnPackageUrl\("jszip"\)\}\/\+esm`, jszipModule\]/,
    "the module jsDelivr builds imports jszip from its own `+esm` URL",
  );
});

test("docx-preview stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.js");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  for (const manifest of [serviceWorker, staticAssets]) {
    assert.doesNotMatch(manifest, /docx-preview|jszip/);
  }
  assert.match(serviceWorker, /"\/assets\/components\/docx-viewer\.js"/);
  assert.match(staticAssets, /"components\/docx-viewer\.js"/);
});
