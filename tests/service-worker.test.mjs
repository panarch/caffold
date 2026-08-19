import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const frontendRoot = path.join(repositoryRoot, "frontend");
const source = readFileSync(
  path.join(frontendRoot, "service-worker.js"),
  "utf8",
).replace(
  '"caffold-shell-__CAFFOLD_BUILD_ID__"',
  '"caffold-shell-test-build"',
);

test("precaches every bundled runtime asset", async () => {
  let installListener;
  let installedAssets;
  const context = {
    AbortController,
    Promise,
    Response,
    Set,
    URL,
    caches: {
      async open() {
        return {
          async addAll(assets) {
            installedAssets = new Set(assets);
          },
        };
      },
    },
    clearTimeout,
    fetch,
    self: {
      addEventListener(type, listener) {
        if (type === "install") {
          installListener = listener;
        }
      },
      clients: {},
      location: { origin: "https://caffold.test" },
      registration: {},
    },
    setTimeout,
  };
  vm.runInNewContext(source, context);

  let completion = Promise.resolve();
  installListener({
    waitUntil(value) {
      completion = Promise.resolve(value);
    },
  });
  await completion;

  const runtimeAssets = runtimeFrontendFiles(frontendRoot).map(assetUrl);
  runtimeAssets.push("/assets/build-info.js");
  assert.equal(installedAssets.size, appShellAssetCount(source));
  const missing = runtimeAssets.filter((asset) => !installedAssets.has(asset));
  assert.deepEqual(missing, []);
});

function appShellAssetCount(serviceWorkerSource) {
  const sourceList = serviceWorkerSource.match(
    /const APP_SHELL_ASSETS = \[(.*?)\];/s,
  )?.[1];
  assert.ok(sourceList);
  return [...sourceList.matchAll(/^\s*"[^"]+",$/gm)].length;
}

function runtimeFrontendFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests") {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeFrontendFiles(fullPath));
      continue;
    }
    const relative = path.relative(frontendRoot, fullPath).split(path.sep).join("/");
    if (
      relative === "service-worker.js" ||
      relative === "assets/fonts/D2Coding-OFL.txt" ||
      relative.endsWith(".test.js") ||
      !/[.](?:css|html|js|png|svg|webmanifest|woff2)$/.test(relative)
    ) {
      continue;
    }
    files.push(relative);
  }
  return files;
}

function assetUrl(relative) {
  if (relative === "index.html") {
    return "/";
  }
  if (relative === "manifest.webmanifest") {
    return "/assets/manifest.webmanifest";
  }
  return `/assets/${relative.replace(/^assets\//, "")}`;
}
