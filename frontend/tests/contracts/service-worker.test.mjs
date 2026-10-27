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
  const moduleStylesheets = stylesheetsImportedAsModules(frontendRoot);
  const documentStylesheets = stylesheetsTheDocumentLoads();
  const runtimeAssets = runtimeFrontendFiles(frontendRoot).flatMap((relative) => {
    if (!moduleStylesheets.has(relative)) {
      return [assetUrl(relative)];
    }
    // A stylesheet a module imports is the module the build writes beside it.
    const module = `${assetUrl(relative)}.js`;
    return documentStylesheets.has(relative) ? [assetUrl(relative), module] : [module];
  });
  runtimeAssets.push("/assets/build-info.js");
  assert.equal(new Set(shellAssets).size, shellAssets.length);
  const missing = runtimeAssets.filter((asset) => !shellAssets.includes(asset));
  assert.deepEqual(missing, []);
});

test("precaches no stylesheet the document does not load", () => {
  const shellAssets = appShellAssets(source);
  const documentStylesheets = stylesheetsTheDocumentLoads();
  const unloaded = shellAssets.filter((asset) =>
    asset.endsWith(".css") && !documentStylesheets.has(asset.slice("/assets/".length)),
  );
  assert.deepEqual(unloaded, []);
});

// Stylesheets production modules import as `<stylesheet>.js`.
function stylesheetsImportedAsModules(root) {
  const stylesheets = new Set();
  for (const relative of runtimeFrontendFiles(root)) {
    if (!relative.endsWith(".ts")) continue;
    const module = readFileSync(path.join(root, relative), "utf8");
    for (const [, specifier] of module.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+\.css)\.js"/g)) {
      stylesheets.add(path.posix.join(path.posix.dirname(relative), specifier));
    }
  }
  return stylesheets;
}

// `styles.css` with every stylesheet it imports, and the shared styles
// `component-styles.ts` fetches for components in the document.
function stylesheetsTheDocumentLoads() {
  const stylesheets = new Set();
  const visit = (relative) => {
    if (stylesheets.has(relative)) return;
    stylesheets.add(relative);
    const css = readFileSync(path.join(frontendRoot, relative), "utf8");
    for (const [, specifier] of css.matchAll(/@import "([^"]+)"/g)) {
      visit(path.posix.join(path.posix.dirname(relative), specifier));
    }
  };
  visit("styles.css");
  const componentStyles = readFileSync(path.join(frontendRoot, "component-styles.ts"), "utf8");
  for (const [, fetched] of componentStyles.matchAll(/"\.\/(component-styles\/[^"]+\.css)"/g)) {
    stylesheets.add(fetched);
  }
  return stylesheets;
}

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
