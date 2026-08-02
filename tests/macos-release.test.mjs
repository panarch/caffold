import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageApp = resolve(repoRoot, "desktop/macos/package-app");
const release = resolve(repoRoot, "desktop/macos/release");
const releaseWorkflow = resolve(repoRoot, ".github/workflows/release.yml");

function run(command, args = []) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function parseMetadata(output) {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
}

test("macOS package metadata has one versioned arm64 archive identity", () => {
  const metadata = parseMetadata(run(packageApp, ["metadata"]));
  const cargoVersion = readFileSync(resolve(repoRoot, "Cargo.toml"), "utf8").match(
    /^version = "([^"]+)"$/m,
  )?.[1];
  const webVersion = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;

  assert.equal(metadata.version, cargoVersion);
  assert.equal(metadata.version, webVersion);
  assert.equal(metadata.arch, "arm64");
  assert.equal(metadata.archive, `Caffold-Server-${metadata.version}-macos-arm64.zip`);
  assert.equal(metadata.checksum, `${metadata.archive}.sha256`);
});

test("macOS release preparation is syntax-valid and dry-run only", () => {
  run("bash", ["-n", packageApp]);
  run("bash", ["-n", release]);

  const help = run(release, ["--help"]);
  assert.match(help, /--dry-run/);
  assert.match(help, /does not\s+create a tag or GitHub Release/i);

  const withoutMode = spawnSync(release, [], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(withoutMode.status, 2);
  assert.match(withoutMode.stderr, /usage: desktop\/macos\/release --dry-run/);

  const source = readFileSync(release, "utf8");
  for (const publishingCommand of ["git push", "git tag", "gh release", "brew install"]) {
    assert.doesNotMatch(source, new RegExp(publishingCommand, "i"));
  }
});

test("macOS packaging locks dependencies and verifies the distributed archive", () => {
  const source = readFileSync(packageApp, "utf8");

  assert.match(source, /cargo build --release --locked/);
  assert.match(source, /ditto -x -k/);
  assert.match(source, /codesign --verify --deep --strict/);
  assert.match(source, /shasum -a 256/);
  assert.match(source, /CFBundleShortVersionString/);
  assert.match(source, /LSMinimumSystemVersion/);
  assert.match(source, /io\.panarch\.caffold\.server/);
});

test("manual release workflow can only build and upload a dry-run artifact", () => {
  const source = readFileSync(releaseWorkflow, "utf8");
  const rustVersion = readFileSync(resolve(repoRoot, "Cargo.toml"), "utf8").match(
    /^rust-version = "([^"]+)"$/m,
  )?.[1];

  assert.match(source, /^name: Release$/m);
  assert.match(source, /^\s+workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^\s+(push|pull_request|schedule):$/m);
  assert.match(source, /^\s+contents: read$/m);
  assert.doesNotMatch(source, /^\s+contents: write$/m);
  assert.match(source, /runs-on: macos-14/);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, new RegExp(`rustup toolchain install ${rustVersion}(?:\\.0)?`));
  assert.match(source, /release --dry-run/);
  assert.match(source, /actions\/upload-artifact@v\d+\.\d+\.\d+/);

  for (const publishingCommand of ["git push", "git tag", "gh release", "brew install"]) {
    assert.doesNotMatch(source, new RegExp(publishingCommand, "i"));
  }
});
