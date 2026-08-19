import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bumpReleaseVersion,
  nextReleaseVersion,
} from "../scripts/bump-release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function withReleaseFixture(
  callback,
  { cargo = "1.2.3", web = cargo, lock = cargo } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "caffold-release-version-"));
  const files = {
    cargo: `[package]\nname = "caffold"\nversion = "${cargo}"\nedition = "2024"\n`,
    web: `${JSON.stringify({ name: "caffold", version: web, private: true }, null, 2)}\n`,
    lock: `version = 4\n\n[[package]]\nname = "caffold"\nversion = "${lock}"\ndependencies = []\n\n[[package]]\nname = "dependency"\nversion = "9.8.7"\n`,
  };

  writeFileSync(join(root, "Cargo.toml"), files.cargo);
  mkdirSync(join(root, "frontend"), { recursive: true });
  writeFileSync(join(root, "frontend", "package.json"), files.web);
  writeFileSync(join(root, "Cargo.lock"), files.lock);

  try {
    callback(root, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("release versions follow major, minor, and patch semantics", () => {
  assert.equal(nextReleaseVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextReleaseVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextReleaseVersion("0.1.0", "major"), "1.0.0");
  assert.throws(() => nextReleaseVersion("0.1.0", "resume"), /bump/);
  assert.throws(() => nextReleaseVersion("1.2.3-beta.1", "patch"), /stable/);
});

test("a release bump updates only the three canonical version fields", () => {
  withReleaseFixture((root) => {
    assert.deepEqual(bumpReleaseVersion(root, "minor"), {
      previousVersion: "1.2.3",
      version: "1.3.0",
    });

    assert.match(readFileSync(join(root, "Cargo.toml"), "utf8"), /version = "1\.3\.0"/);
    assert.equal(
      JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version,
      "1.3.0",
    );
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    assert.match(lock, /name = "caffold"\nversion = "1\.3\.0"/);
    assert.match(lock, /name = "dependency"\nversion = "9\.8\.7"/);
  });
});

test("a mismatched source version fails before changing any file", () => {
  withReleaseFixture(
    (root, original) => {
      assert.throws(() => bumpReleaseVersion(root, "patch"), /must match/);
      assert.equal(readFileSync(join(root, "Cargo.toml"), "utf8"), original.cargo);
      assert.equal(readFileSync(join(root, "frontend", "package.json"), "utf8"), original.web);
      assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), original.lock);
    },
    { cargo: "1.2.3", web: "1.2.4", lock: "1.2.3" },
  );
});

test("the committed release files can be bumped together", () => {
  const root = mkdtempSync(join(tmpdir(), "caffold-current-release-version-"));
  try {
    for (const file of ["Cargo.toml", "frontend/package.json", "Cargo.lock"]) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(repoRoot, file), destination);
    }
    const current = JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version;
    const expected = nextReleaseVersion(current, "patch");

    assert.equal(bumpReleaseVersion(root, "patch").version, expected);
    assert.match(
      readFileSync(join(root, "Cargo.toml"), "utf8"),
      new RegExp(`^version = "${expected.replaceAll(".", "\\.")}"$`, "m"),
    );
    assert.match(
      readFileSync(join(root, "Cargo.lock"), "utf8"),
      new RegExp(`name = "caffold"\\nversion = "${expected.replaceAll(".", "\\.")}"`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
