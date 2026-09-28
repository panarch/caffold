import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, frontendUrl), "utf8");
}

test("the browser and the browser suite load the same xterm.js releases", () => {
  const view = read("components/terminal-view.js");
  const manifest = JSON.parse(read("package.json"));

  const [, xterm] = view.match(/const XTERM_VERSION = "([^"]+)";/) ?? [];
  const [, fit] = view.match(/const FIT_ADDON_VERSION = "([^"]+)";/) ?? [];
  assert.ok(xterm && fit, "the terminal view must pin one version of each library");
  assert.equal(manifest.devDependencies["@xterm/xterm"], xterm);
  assert.equal(manifest.devDependencies["@xterm/addon-fit"], fit);
});

test("the browser suite serves xterm.js from the installed packages", () => {
  const defaults = read("tests/e2e/support/browser-defaults.js");

  assert.match(
    defaults,
    /const CDN_PACKAGES = \[[^\]]*"@xterm\/xterm", "@xterm\/addon-fit"\]/,
  );
  assert.match(defaults, /"\.css": "text\/css"/);
});

test("xterm.js stays a runtime CDN import rather than a shipped asset", () => {
  const serviceWorker = read("service-worker.js");
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );

  assert.doesNotMatch(serviceWorker, /@xterm|xterm\.(?:mjs|css)/);
  assert.doesNotMatch(staticAssets, /@xterm|xterm\.(?:mjs|css)/);
  assert.match(serviceWorker, /"\/assets\/components\/terminal-view\.js"/);
  assert.match(staticAssets, /"components\/terminal-view\.js"/);
});
