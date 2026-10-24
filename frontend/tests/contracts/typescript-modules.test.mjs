import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const sources = frontendSources();

test("a module is JavaScript or TypeScript, never both", () => {
  for (const stem of stems(".ts")) {
    assert.ok(!sources.has(`${stem}.js`), `${stem} is both ${stem}.js and ${stem}.ts`);
  }
});

test("a type declaration file stands beside the JavaScript module it describes", () => {
  for (const stem of stems(".d.ts")) {
    assert.ok(
      sources.has(`${stem}.js`),
      `${stem}.d.ts describes a module that is no longer JavaScript; remove it once ${stem} moves to TypeScript`,
    );
  }
});

test("the frontend type check is strict and only removes erasable syntax", () => {
  const { compilerOptions } = JSON.parse(readFileSync(new URL("tsconfig.json", frontendUrl), "utf8"));
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.erasableSyntaxOnly, true);
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
