import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return extname(entry.name) === ".md" ? [path] : [];
  });
}

const contributorDocs = [
  resolve(repoRoot, "README.md"),
  resolve(repoRoot, "CONTRIBUTING.md"),
  ...markdownFiles(resolve(repoRoot, "docs")),
  ...markdownFiles(resolve(repoRoot, "desktop/macos")),
];

test("official documentation uses repository-owned entrypoints", () => {
  for (const path of contributorDocs) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /(?:^|[\s`(])\.notes\//m, `${path} references .notes`);
  }
});

test("the documentation index links every document", () => {
  const docsRoot = resolve(repoRoot, "docs");
  const docsIndex = readFileSync(resolve(docsRoot, "README.md"), "utf8");
  for (const path of markdownFiles(docsRoot)) {
    if (path === resolve(docsRoot, "README.md")) continue;
    const target = relative(docsRoot, path);
    assert.ok(
      docsIndex.includes(`](${target})`),
      `${target} is missing from docs/README.md`,
    );
  }
});

test("documentation is organized by purpose rather than audience", () => {
  for (const directory of ["docs/public", "docs/internal"]) {
    assert.equal(existsSync(resolve(repoRoot, directory)), false, directory);
  }

  const docsIndex = readFileSync(resolve(repoRoot, "docs/README.md"), "utf8");
  for (const heading of [
    "## Product",
    "## Architecture",
    "## Development",
    "## Review",
    "## Operations",
  ]) {
    assert.match(docsIndex, new RegExp(`^${heading}$`, "m"));
  }
});

test("local Markdown links in contributor documentation resolve", () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const path of contributorDocs) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (
        rawTarget.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
      ) {
        continue;
      }
      const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
      assert.ok(
        existsSync(resolve(dirname(path), target)),
        `${path} links to missing ${rawTarget}`,
      );
    }
  }
});

test("development entrypoints and diagnostic probe remain discoverable", () => {
  for (const path of [
    "CONTRIBUTING.md",
    ".nvmrc",
    "rust-toolchain.toml",
    "docs/development/testing.md",
    "docs/development/macos-local-app.md",
    "docs/development/mobile-pwa-testing.md",
    "desktop/macos/install-local",
    "scripts/dev/probe-codex-app-server.mjs",
  ]) {
    assert.ok(existsSync(resolve(repoRoot, path)), `${path} must exist`);
  }

  const probe = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/dev/probe-codex-app-server.mjs"), "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /THREAD_ID/);
});

// Test commands used to be discoverable from one package manifest. They are now
// owned by the thing they verify, so the testing guide is the only index and
// this contract keeps it complete.
test("every owned test command is discoverable in the testing guide", () => {
  const testingGuide = readFileSync(
    resolve(repoRoot, "docs/development/testing.md"),
    "utf8",
  );

  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "frontend/package.json"), "utf8"),
  );
  const packageCommands = Object.keys(packageJson.scripts).filter((name) =>
    name.startsWith("test:"),
  );
  assert.ok(packageCommands.length > 0);
  for (const command of packageCommands) {
    assert.match(testingGuide, new RegExp(`npm run ${command}`));
  }

  const macosSuites = readdirSync(resolve(repoRoot, "desktop/macos"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.startsWith("test-"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(macosSuites.length > 0);
  for (const suite of macosSuites) {
    assert.match(testingGuide, new RegExp(`desktop/macos/${suite}`));
  }
});
