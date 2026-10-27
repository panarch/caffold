import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repositoryRoot } from "../repository-paths.mjs";

const frontendRoot = path.join(repositoryRoot, "frontend");
const source = readFileSync(
  path.join(frontendRoot, "service-worker.ts"),
  "utf8",
);

test("precaches every bundled runtime asset", () => {
  const shellAssets = appShellAssets(source);
  const runtimeAssets = runtimeFrontendFiles(frontendRoot).map(assetUrl);
  runtimeAssets.push("/assets/build-info.js");
  assert.equal(new Set(shellAssets).size, shellAssets.length);
  const missing = runtimeAssets.filter((asset) => !shellAssets.includes(asset));
  assert.deepEqual(missing, []);
});

function appShellAssets(serviceWorkerSource) {
  const sourceList = serviceWorkerSource.match(
    /const APP_SHELL_ASSETS = \[(.*?)\];/s,
  )?.[1];
  assert.ok(sourceList);
  return [...sourceList.matchAll(/^\s*"([^"]+)",$/gm)].map(([, asset]) => asset);
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
      relative === "service-worker.ts" ||
      relative === "assets/fonts/D2Coding-OFL.txt" ||
      /\.(?:test|d)\.[jt]s$/.test(relative) ||
      !/[.](?:css|html|js|png|svg|ts|webmanifest|woff2)$/.test(relative)
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
  // A TypeScript module is served as the JavaScript tsc writes for it.
  return `/assets/${relative.replace(/^assets\//, "").replace(/\.ts$/, ".js")}`;
}
