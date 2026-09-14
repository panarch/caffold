import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same pdf.js release", () => {
  const viewer = read("components/pdf-viewer.js");
  const manifest = JSON.parse(read("package.json"));

  const [, sourceVersion] = viewer.match(/const PDFJS_VERSION = "([^"]+)";/) ?? [];
  assert.ok(sourceVersion, "the PDF viewer must pin one pdf.js version");
  assert.equal(
    manifest.devDependencies["pdfjs-dist"],
    sourceVersion,
    "the browser suite serves node_modules, so its pdf.js must match the CDN version users load",
  );
});

test("the browser suite serves pdf.js from the installed package", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(defaults, /node_modules\/pdfjs-dist\//);
  assert.match(
    defaults,
    /require\("pdfjs-dist\/package\.json"\)\.version/,
    "the fulfilled version must follow the installed package rather than a second literal",
  );
  assert.match(
    defaults,
    /page\.route\("https:\/\/cdn\.jsdelivr\.net\/\*\*"/,
    "every jsDelivr request must be answered locally or aborted",
  );
});

test("pdf.js stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.js");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  assert.doesNotMatch(serviceWorker, /pdfjs/);
  assert.doesNotMatch(staticAssets, /pdfjs/);
  assert.match(serviceWorker, /"\/assets\/components\/pdf-viewer\.js"/);
  assert.match(staticAssets, /"components\/pdf-viewer\.js"/);
});
