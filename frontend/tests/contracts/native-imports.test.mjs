import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const index = readFileSync(new URL("index.html", frontendUrl), "utf8");
const importMapScript = index.match(
  /<script type="importmap">([\s\S]*?)<\/script>/,
);
const browserImports = JSON.parse(importMapScript?.[1] ?? "{}").imports;
// Package entries such as lit-html have their own contract.
const browserAliases = Object.fromEntries(
  Object.entries(browserImports).filter(([specifier]) => specifier.startsWith("#")),
);
const nodeImports = JSON.parse(
  readFileSync(new URL("package.json", frontendUrl), "utf8"),
).imports;
const workerEntrypoints = new Set([
  "service-worker.ts",
  "pages/(task-workspace)/tasks/components/composer/voice-worklet.ts",
]);

test("native browser aliases precede app loading and match Node namespace roots", () => {
  assert.ok(importMapScript, "the document must declare an inline import map");
  assert.ok(importMapScript.index < index.indexOf('<script type="module"'));
  assert.deepEqual(Object.keys(browserAliases).sort(), [
    "#app/",
    "#components/",
    "#tasks/",
  ]);
  assert.equal(Object.keys(nodeImports).length, Object.keys(browserAliases).length);

  for (const [prefix, browserRoot] of Object.entries(browserAliases)) {
    assert.ok(browserRoot.startsWith("/assets/") && browserRoot.endsWith("/"));
    const nodePattern = nodeImports[`${prefix}*`];
    assert.ok(nodePattern?.endsWith("*"), `${prefix} needs a Node pattern`);
    assert.equal(
      new URL(nodePattern.slice(0, -1), frontendUrl).href,
      new URL(browserRoot.slice("/assets/".length), frontendUrl).href,
      `${prefix} must name the same directory in both runtimes`,
    );
  }
});

test("production alias imports resolve to the same served and precached files in Node and the browser", () => {
  const staticAssets = readFileSync(
    new URL("../caffold/src/static_assets.rs", frontendUrl),
    "utf8",
  );
  const serviceWorker = readFileSync(
    new URL("service-worker.ts", frontendUrl),
    "utf8",
  );
  const usedPrefixes = new Set();

  for (const [path, source] of productionModules()) {
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](#[^"']+)["']/g,
    )) {
      const prefix = Object.keys(browserAliases).find((key) => specifier.startsWith(key));
      assert.ok(prefix, `${path} uses an unknown alias: ${specifier}`);
      assert.ok(!workerEntrypoints.has(path), `${path} cannot use the document's import map`);
      usedPrefixes.add(prefix);

      const assetPath = browserAliases[prefix].slice("/assets/".length) +
        specifier.slice(prefix.length);
      assert.equal(
        import.meta.resolve(specifier),
        new URL(assetPath, frontendUrl).href,
        `${path}: ${specifier} must resolve identically in both runtimes`,
      );
      assert.ok(assetPath.endsWith(".js") && !assetPath.endsWith(".test.js"));
      assert.ok(!assetPath.split("/").includes("tests"));
      // Rust generates build-info.js, and the module beside each stylesheet
      // from that stylesheet; they are served and cached with source modules.
      if (assetPath !== "build-info.js") {
        const sourcePath = assetPath.endsWith(".css.js")
          ? assetPath.slice(0, -".js".length)
          : assetPath.replace(/\.js$/, ".ts");
        assert.match(
          readFileSync(new URL(sourcePath, frontendUrl), "utf8"),
          /\S/,
          `${path}: ${specifier} must refer to a production module`,
        );
      }
      assert.ok(staticAssets.includes(`"${assetPath}" =>`), `${assetPath} must be served`);
      assert.ok(serviceWorker.includes(`"/assets/${assetPath}"`), `${assetPath} must be precached`);
    }
  }

  assert.deepEqual([...usedPrefixes].sort(), Object.keys(browserAliases).sort());
});

test("document modules use aliases instead of ascending three or more directories", () => {
  const longRelativeImports = [];
  for (const [path, source] of productionModules()) {
    if (workerEntrypoints.has(path)) continue;
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g,
    )) {
      if (specifier.startsWith(".") && specifier.split("/").filter((part) => part === "..").length >= 3) {
        longRelativeImports.push(`${path}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(longRelativeImports, []);
});

function productionModules(directory = frontendUrl, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "tests") return [];
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return productionModules(new URL(`${entry.name}/`, directory), `${path}/`);
    }
    return entry.isFile() && /\.[jt]s$/.test(entry.name) && !/\.(?:test|d)\.[jt]s$/.test(entry.name)
      ? [[path, readFileSync(new URL(entry.name, directory), "utf8")]]
      : [];
  });
}
