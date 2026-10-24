import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const nodeModulesUrl = new URL("node_modules/", frontendUrl);
const importMap = JSON.parse(
  read(frontendUrl, "index.html").match(/<script type="importmap">([\s\S]*?)<\/script>/)[1],
).imports;

test("Caffold builds in the Lit release the frontend package pins", () => {
  const manifest = JSON.parse(read(frontendUrl, "package.json"));
  const pinned = manifest.dependencies?.lit;

  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "Lit must be pinned to one exact release");
  assert.equal(
    manifest.devDependencies?.lit,
    undefined,
    "a build installs runtime dependencies only, so Lit cannot be a development package",
  );
  assert.equal(JSON.parse(read(nodeModulesUrl, "lit/package.json")).version, pinned);
});

test("frontend modules reach Lit through the lit package alone", () => {
  for (const [path, source] of productionModules()) {
    for (const specifier of litSpecifiers(source)) {
      assert.match(specifier, /^lit(?:\/.+\.js)?$/, `${path} must import Lit through the lit package: ${specifier}`);
    }
  }
});

test("every Lit module a page reaches is its package's browser build, served and precached once", () => {
  const staticAssets = readFileSync(new URL("../caffold/src/static_assets.rs", frontendUrl), "utf8");
  const serviceWorker = read(frontendUrl, "service-worker.js");
  const reached = new Set();
  const specifiers = productionModules().flatMap(([, source]) => litSpecifiers(source));
  assert.ok(specifiers.includes("lit"), "the frontend renders with Lit");
  // A bare specifier goes through the import map; a relative one resolves
  // against the module that imports it, as the browser does.
  const pending = specifiers.map(packageModulePath);

  while (pending.length) {
    const assetPath = pending.pop();
    if (reached.has(assetPath)) continue;
    reached.add(assetPath);
    const moduleUrl = new URL(assetPath, nodeModulesUrl);
    const source = readFileSync(moduleUrl, "utf8");
    for (const [, relative] of source.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      pending.push(new URL(relative, moduleUrl).href.slice(nodeModulesUrl.href.length));
    }
    pending.push(...litSpecifiers(source).map(packageModulePath));
  }

  for (const assetPath of reached) {
    const escaped = assetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      staticAssets,
      new RegExp(`"${escaped}" => Some\\(js\\(include_str!\\(\\s*"\\.\\./\\.\\./frontend/node_modules/${escaped}"`),
      `${assetPath} must be served from the installed package`,
    );
  }
  const sorted = [...reached].sort();
  const litPath = String.raw`((?:lit|lit-html|lit-element|@lit/reactive-element)/[^"]+)`;
  const listed = (source, pattern) => [...source.matchAll(new RegExp(pattern, "g"))].map(([, path]) => path).sort();
  assert.deepEqual(listed(staticAssets, `"${litPath}" =>`), sorted);
  assert.deepEqual(listed(serviceWorker, `"/assets/${litPath}"`), sorted);
});

// The import map entry that the browser applies: an exact match, or else the
// longest prefix ending in a slash.
function mappedAssetPath(specifier) {
  const target = importMap[specifier] ?? Object.entries(importMap)
    .filter(([key]) => key.endsWith("/") && specifier.startsWith(key))
    .sort(([left], [right]) => right.length - left.length)
    .map(([key, value]) => value + specifier.slice(key.length))[0];
  assert.ok(target?.startsWith("/assets/"), `the import map must send ${specifier} to Caffold`);
  return target.slice("/assets/".length);
}

function browserBuildPath(specifier) {
  const name = packageName(specifier);
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  const exportsMap = JSON.parse(read(nodeModulesUrl, `${name}/package.json`)).exports;
  const target = browserTarget(exportsMap[subpath]);
  assert.ok(target, `${specifier} must be exported by ${name}`);
  return `${name}/${target.replace(/^\.\//, "")}`;
}

function browserTarget(condition) {
  if (typeof condition === "string") return condition;
  return condition && browserTarget(condition.browser ?? condition.default);
}

function packageModulePath(specifier) {
  const assetPath = mappedAssetPath(specifier);
  assert.equal(assetPath, browserBuildPath(specifier), `${specifier} must map to its package's browser build`);
  return assetPath;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function litSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:lit|lit-html|lit-element|@lit\/[^/"']+)(?:\/[^"']*)?)["']/g)]
    .map(([, specifier]) => specifier);
}

function productionModules(directory = frontendUrl, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "tests") return [];
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return productionModules(new URL(`${entry.name}/`, directory), `${path}/`);
    }
    return entry.isFile() && /\.(?:js|ts)$/.test(entry.name) && !/\.(?:test|d)\.[jt]s$/.test(entry.name)
      ? [[path, readFileSync(new URL(entry.name, directory), "utf8")]]
      : [];
  });
}

function read(base, path) {
  return readFileSync(new URL(path, base), "utf8");
}
