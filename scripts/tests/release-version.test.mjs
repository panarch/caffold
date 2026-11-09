import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  nextReleaseCandidateVersion,
  nextReleaseVersion,
} from "../bump-release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bumpScript = resolve(repoRoot, "scripts", "bump-release-version.mjs");

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

  mkdirSync(join(root, "caffold"), { recursive: true });
  writeFileSync(join(root, "caffold", "Cargo.toml"), files.cargo);
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

test("a release candidate takes the next number among its own version's candidate tags", () => {
  assert.equal(nextReleaseCandidateVersion("0.22.2", "minor", []), "0.23.0-rc.1");
  assert.equal(
    nextReleaseCandidateVersion("0.22.2", "minor", ["v0.23.0-rc.1", "v0.23.0-rc.2"]),
    "0.23.0-rc.3",
  );
  assert.equal(
    nextReleaseCandidateVersion("0.22.2", "minor", ["v0.23.0-rc.10", "v0.23.0-rc.9"]),
    "0.23.0-rc.11",
  );
  assert.equal(
    nextReleaseCandidateVersion("0.22.2", "minor", [
      "v0.22.2",
      "v0.22.3-rc.4",
      "v10.23.0-rc.5",
      "v0.23.0-rc.1.1",
      "v0.23.0-rc.01",
    ]),
    "0.23.0-rc.1",
  );
  assert.equal(nextReleaseCandidateVersion("0.22.2", "patch", ["v0.23.0-rc.2"]), "0.22.3-rc.1");
  assert.throws(() => nextReleaseCandidateVersion("0.23.0-rc.1", "minor", []), /stable/);
});

test("a release bump updates only the three canonical version fields", () => {
  withReleaseFixture((root) => {
    assert.deepEqual(bumpReleaseVersion(root, "minor"), {
      previousVersion: "1.2.3",
      version: "1.3.0",
    });

    assert.match(readFileSync(join(root, "caffold", "Cargo.toml"), "utf8"), /version = "1\.3\.0"/);
    assert.equal(
      JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version,
      "1.3.0",
    );
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    assert.match(lock, /name = "caffold"\nversion = "1\.3\.0"/);
    assert.match(lock, /name = "dependency"\nversion = "9\.8\.7"/);
  });
});

test("a release candidate bump writes the candidate to the three canonical version fields", () => {
  withReleaseFixture((root) => {
    assert.deepEqual(
      bumpReleaseVersion(root, "minor", { releaseCandidateTags: ["v1.3.0-rc.1"] }),
      { previousVersion: "1.2.3", version: "1.3.0-rc.2" },
    );

    assert.match(readFileSync(join(root, "caffold", "Cargo.toml"), "utf8"), /version = "1\.3\.0-rc\.2"/);
    assert.equal(
      JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version,
      "1.3.0-rc.2",
    );
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    assert.match(lock, /name = "caffold"\nversion = "1\.3\.0-rc\.2"/);
    assert.match(lock, /name = "dependency"\nversion = "9\.8\.7"/);
  });
});

test("the command numbers a release candidate from the repository's tags", () => {
  withReleaseFixture((root) => {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet");
    git(
      "-c", "user.name=Caffold",
      "-c", "user.email=caffold@example.invalid",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "--no-verify", "--allow-empty", "--message", "Fixture",
    );
    git("-c", "tag.gpgSign=false", "tag", "v1.3.0-rc.1");

    const run = (...args) => execFileSync(process.execPath, [bumpScript, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run("patch"), "previous_version=1.2.3\nversion=1.2.4\n");
    assert.equal(run("minor", "--rc"), "previous_version=1.2.4\nversion=1.3.0-rc.2\n");
    assert.throws(() => run("minor", "--candidate"), { status: 2 });
    assert.throws(() => run("minor", "--rc", "--rc"), { status: 2 });
  });
});

test("a mismatched source version fails before changing any file", () => {
  withReleaseFixture(
    (root, original) => {
      assert.throws(() => bumpReleaseVersion(root, "patch"), /must match/);
      assert.equal(readFileSync(join(root, "caffold", "Cargo.toml"), "utf8"), original.cargo);
      assert.equal(readFileSync(join(root, "frontend", "package.json"), "utf8"), original.web);
      assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), original.lock);
    },
    { cargo: "1.2.3", web: "1.2.4", lock: "1.2.3" },
  );
});

test("the committed release files can be bumped together", () => {
  const root = mkdtempSync(join(tmpdir(), "caffold-current-release-version-"));
  try {
    for (const file of ["caffold/Cargo.toml", "frontend/package.json", "Cargo.lock"]) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(repoRoot, file), destination);
    }
    const current = JSON.parse(readFileSync(join(root, "frontend", "package.json"), "utf8")).version;
    const expected = nextReleaseVersion(current, "patch");

    assert.equal(bumpReleaseVersion(root, "patch").version, expected);
    assert.match(
      readFileSync(join(root, "caffold", "Cargo.toml"), "utf8"),
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
