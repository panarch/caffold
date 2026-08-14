import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const frontendRoot = join(repositoryRoot, "frontend");

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function frontendPath(path) {
  return relative(frontendRoot, path).split(sep).join("/");
}

const frontendFiles = filesBelow(frontendRoot);
const unitTestPaths = frontendFiles
  .filter((path) => path.endsWith(".test.js"))
  .map(frontendPath)
  .sort();

test("focused frontend Node tests stay beside exact same-stem owners", () => {
  assert.ok(unitTestPaths.length > 0);
  for (const testPath of unitTestPaths) {
    const ownerPath = testPath.replace(/[.]test[.]js$/, ".js");
    assert.equal(
      existsSync(join(frontendRoot, ownerPath)),
      true,
      `${testPath} must be owned by ${ownerPath}`,
    );
  }
});

test("colocated tests stay outside production imports and runtime assets", () => {
  for (const path of frontendFiles) {
    if (!path.endsWith(".js") || path.endsWith(".test.js")) {
      continue;
    }
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /(?:from\s*|import\s*)["'][^"']*[.]test[.]js["']/,
      `${frontendPath(path)} imports a Node test`,
    );
  }

  const serviceWorker = readFileSync(
    join(frontendRoot, "service-worker.js"),
    "utf8",
  );
  const staticAssets = readFileSync(
    join(repositoryRoot, "src/static_assets.rs"),
    "utf8",
  );
  for (const testPath of unitTestPaths) {
    assert.equal(
      serviceWorker.includes(`"/assets/${testPath}"`),
      false,
      `${testPath} is precached`,
    );
    assert.equal(
      staticAssets.includes(`../frontend/${testPath}`),
      false,
      `${testPath} is served as a Rust static asset`,
    );
  }
});
