import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const sources = frontendSources();

test("production modules are TypeScript", () => {
  assert.deepEqual([...sources].filter((path) => path.endsWith(".js")), []);
});

// Rust generates build-info.js; it is served and cached with source modules.
test("the one type declaration file describes the module the server build writes", () => {
  assert.deepEqual(stems(".d.ts"), ["build-info"]);
});

test("the frontend type check is strict", () => {
  const { compilerOptions } = JSON.parse(readFileSync(new URL("tsconfig.json", frontendUrl), "utf8"));
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.verbatimModuleSyntax, true);
});

function stems(extension) {
  return [...sources]
    .filter((path) => path.endsWith(extension) && (extension === ".d.ts" || !path.endsWith(".d.ts")))
    .map((path) => path.slice(0, -extension.length));
}

function frontendSources(directory = frontendUrl, prefix = "") {
  return new Set(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "tests") return [];
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return [...frontendSources(new URL(`${entry.name}/`, directory), `${path}/`)];
    }
    return /\.(?:js|ts)$/.test(entry.name) && !/\.test\.[jt]s$/.test(entry.name) ? [path] : [];
  }));
}
