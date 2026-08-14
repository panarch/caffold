import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageApp = resolve(repoRoot, "desktop/macos/package-app");
const systemStatusTest = resolve(repoRoot, "desktop/macos/test-system-status");
const updaterTest = resolve(repoRoot, "desktop/macos/test-updater");
const release = resolve(repoRoot, "desktop/macos/release");
const renderCask = resolve(repoRoot, "desktop/macos/render-cask");
const releaseWorkflow = resolve(repoRoot, ".github/workflows/release.yml");
const releaseVerificationWorkflow = resolve(
  repoRoot,
  ".github/workflows/release-verification.yml",
);
const macosReleaseVerificationWorkflow = resolve(
  repoRoot,
  ".github/workflows/macos-release-verification.yml",
);
const rootReadme = resolve(repoRoot, "README.md");
const macosReadme = resolve(repoRoot, "desktop/macos/README.md");
const macosServerSource = resolve(repoRoot, "desktop/macos/CaffoldServer.swift");

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
  assert.doesNotMatch(source, /branch --show-current|require_main_branch/);
  for (const publishingCommand of ["git push", "git tag", "gh release", "brew install"]) {
    assert.doesNotMatch(source, new RegExp(publishingCommand, "i"));
  }
});

test("macOS packaging locks dependencies and verifies the distributed archive", () => {
  const source = readFileSync(packageApp, "utf8");

  assert.match(source, /cargo build --release --locked/);
  assert.match(source, /ditto -x -k/);
  assert.match(source, /codesign --verify --deep --strict/);
  assert.match(source, /otool -L/);
  assert.match(source, /non-system dynamic dependency/);
  assert.match(source, /shasum -a 256/);
  assert.match(source, /CFBundleShortVersionString/);
  assert.match(source, /--expected-version/);
  assert.match(source, /--expected-build-number/);
  assert.match(source, /LSMinimumSystemVersion/);
  assert.match(source, /io\.panarch\.caffold\.server/);
  assert.match(source, /CaffoldServer\/UpdateModel\.swift/);
  assert.match(source, /CaffoldServer\/Updater\.swift/);
  run("bash", ["-n", systemStatusTest]);
  run("bash", ["-n", updaterTest]);
});

test("macOS Codex recovery delegates to the shared browser Settings surface", () => {
  const source = readFileSync(macosServerSource, "utf8");

  assert.match(source, /localURL\.appendingPathComponent\("settings\/codex"\)/);
  assert.match(source, /Open Codex Settings\.\.\./);
  assert.match(source, /#selector\(openCodexSettings\)/);
  assert.match(source, /NSWorkspace\.shared\.open\(codexSettingsURL\)/);
});

test("Homebrew cask installs the app and bundled CLI without a user quarantine flag", () => {
  const sha256 = "a".repeat(64);
  const cask = run(renderCask, ["--version", "1.2.3", "--sha256", sha256]);

  assert.match(cask, /^cask "caffold" do$/m);
  assert.match(cask, /^  version "1\.2\.3"$/m);
  assert.match(cask, new RegExp(`^  sha256 "${sha256}"$`, "m"));
  assert.match(
    cask,
    /releases\/download\/v#\{version\}\/Caffold-Server-#\{version\}-macos-arm64\.zip/,
  );
  assert.match(cask, /^  depends_on arch: :arm64$/m);
  assert.match(cask, /^  depends_on macos: :sonoma$/m);
  assert.match(cask, /^  app "Caffold Server\.app"$/m);
  assert.match(cask, /binary "#\{appdir\}\/Caffold Server\.app\/Contents\/Resources\/caffold"/);
  assert.match(cask, /system_command "\/usr\/bin\/xattr"/);
  assert.match(cask, /args: \["-cr", "#\{appdir\}\/Caffold Server\.app"\]/);

  const invalid = spawnSync(
    renderCask,
    ["--version", "1.2.3", "--sha256", "not-a-checksum"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /64 lowercase hexadecimal characters/);

  for (const readme of [rootReadme, macosReadme]) {
    const documentation = readFileSync(readme, "utf8");
    assert.match(documentation, /brew install --cask panarch\/tap\/caffold/);
    assert.match(documentation, /Homebrew/);
  }
});

test("pull requests and main pushes use the shared release verification", () => {
  const source = readFileSync(releaseVerificationWorkflow, "utf8");

  assert.match(source, /^name: Release Verification$/m);
  assert.match(source, /^\s+pull_request:$/m);
  assert.match(source, /^\s+push:$/m);
  assert.equal(source.match(/^\s+branches: \[main\]$/gm)?.length, 2);
  assert.match(source, /^\s+contents: read$/m);
  assert.match(
    source,
    /uses: \.\/\.github\/workflows\/macos-release-verification\.yml/,
  );
  assert.match(source, /release_sha: \$\{\{ github\.sha \}\}/);
  assert.match(source, /require_main_head: false/);
  assert.match(source, /cancel-in-progress: true/);
  assert.doesNotMatch(source, /workflow_dispatch|contents: write/);
  for (const publishingCommand of ["git push", "gh release", "brew install"]) {
    assert.doesNotMatch(source, new RegExp(publishingCommand, "i"));
  }
});

test("manual release workflow isolates versioning, verification, and publication", () => {
  const source = readFileSync(releaseWorkflow, "utf8");
  const sharedVerification = readFileSync(
    macosReleaseVerificationWorkflow,
    "utf8",
  );
  const rustVersion = readFileSync(resolve(repoRoot, "Cargo.toml"), "utf8").match(
    /^rust-version = "([^"]+)"$/m,
  )?.[1];
  const bumpStart = source.indexOf("  bump_release:");
  const macosStart = source.indexOf("  macos:");
  const releaseStart = source.indexOf("  publish_release:");
  const homebrewStart = source.indexOf("  publish_homebrew:");
  const bumpJob = source.slice(bumpStart, macosStart);
  const macosJob = source.slice(macosStart, releaseStart);
  const releaseJob = source.slice(releaseStart, homebrewStart);
  const homebrewJob = source.slice(homebrewStart);

  assert.match(source, /^name: Release$/m);
  assert.match(source, /^\s+workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^\s+(push|pull_request|schedule):$/m);
  assert.match(source, /^\s+contents: read$/m);
  assert.match(source, /^\s+action:$/m);
  assert.match(source, /^\s+type: choice$/m);
  assert.match(source, /^\s+default: dry-run$/m);
  for (const action of [
    "dry-run",
    "release-patch",
    "release-minor",
    "release-major",
    "resume",
  ]) {
    assert.match(source, new RegExp(`^\\s+- ${action}$`, "m"));
  }
  assert.ok(
    bumpStart >= 0 &&
      macosStart > bumpStart &&
      releaseStart > macosStart &&
      homebrewStart > releaseStart,
  );

  assert.match(bumpJob, /if: startsWith\(inputs\.action, 'release-'\)/);
  assert.match(bumpJob, /^\s+contents: write$/m);
  assert.match(bumpJob, /scripts\/bump-release-version\.mjs/);
  assert.match(bumpJob, /Cargo\.lock/);
  assert.match(bumpJob, /Cargo\.toml/);
  assert.match(bumpJob, /package\.json/);
  assert.match(bumpJob, /git commit -m "Release v\$\{RELEASE_VERSION\}"/);
  assert.match(bumpJob, /git push origin HEAD:main/);
  assert.doesNotMatch(bumpJob, /HOMEBREW_TAP_TOKEN|gh release create|brew install/);

  assert.match(macosJob, /^\s+needs: bump_release$/m);
  assert.match(
    macosJob,
    /uses: \.\/\.github\/workflows\/macos-release-verification\.yml/,
  );
  assert.match(
    macosJob,
    /release_sha: \$\{\{ needs\.bump_release\.outputs\.release_sha \|\| github\.sha \}\}/,
  );
  assert.match(macosJob, /require_main_head: true/);
  assert.doesNotMatch(macosJob, /runs-on:|steps:/);

  assert.match(sharedVerification, /^name: macOS Release Verification$/m);
  assert.match(sharedVerification, /^\s+workflow_call:$/m);
  assert.match(sharedVerification, /^\s+contents: read$/m);
  assert.match(sharedVerification, /runs-on: macos-14/);
  assert.match(sharedVerification, /ref: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(sharedVerification, /REQUIRE_MAIN_HEAD: \$\{\{ inputs\.require_main_head \}\}/);
  assert.match(sharedVerification, /git rev-parse origin\/main/);
  assert.match(sharedVerification, /fetch-depth: 0/);
  assert.match(sharedVerification, /persist-credentials: false/);
  assert.match(
    sharedVerification,
    new RegExp(`rustup toolchain install ${rustVersion}(?:\\.0)?`),
  );
  assert.match(sharedVerification, /npm ci/);
  assert.match(sharedVerification, /playwright install chromium/);
  assert.match(sharedVerification, /release --dry-run/);
  const browserBuildIndex = sharedVerification.indexOf("cargo build --locked");
  const browserTestIndex = sharedVerification.indexOf("npm run test:e2e");
  assert.ok(browserBuildIndex >= 0 && browserTestIndex > browserBuildIndex);
  for (const command of ["test:unit", "test:contract", "test:e2e", "test:macos"]) {
    assert.match(sharedVerification, new RegExp(`npm run ${command}`));
  }
  assert.match(sharedVerification, /cargo fmt --check/);
  assert.match(sharedVerification, /cargo test/);
  assert.match(sharedVerification, /cargo clippy --all-targets -- -D warnings/);
  assert.doesNotMatch(sharedVerification, /npm run test:codex-(?:compat|live)/);
  assert.match(sharedVerification, /actions\/upload-artifact@v\d+\.\d+\.\d+/);
  assert.doesNotMatch(sharedVerification, /contents: write/);
  assert.doesNotMatch(sharedVerification, /HOMEBREW_TAP_TOKEN/);
  for (const publishingCommand of ["git push", "gh release", "brew install"]) {
    assert.doesNotMatch(sharedVerification, new RegExp(publishingCommand, "i"));
  }

  assert.match(
    releaseJob,
    /if: always\(\) && needs\.macos\.result == 'success' && inputs\.action != 'dry-run'/,
  );
  assert.match(releaseJob, /^\s+contents: write$/m);
  assert.match(releaseJob, /RELEASE_SHA: \$\{\{ needs\.macos\.outputs\.release_sha \}\}/);
  assert.match(releaseJob, /actions\/download-artifact@v\d+\.\d+\.\d+/);
  assert.match(releaseJob, /published-caffold-macos-arm64-v/);
  assert.match(releaseJob, /gh release create/);
  assert.match(releaseJob, /gh release download/);
  assert.match(releaseJob, /package-app verify-archive/);
  assert.match(releaseJob, /git rev-list --count "\$\{tag_sha\}"/);
  assert.match(releaseJob, /--expected-version "\$\{RELEASE_VERSION\}"/);
  assert.match(releaseJob, /--expected-build-number "\$\{tag_build_number\}"/);
  assert.match(releaseJob, /shasum -a 256 -c/);
  const existingReleaseIndex = releaseJob.indexOf(
    'if gh release view "${tag}"',
  );
  const newReleaseIndex = releaseJob.indexOf(
    "          else\n            release_args=(",
    existingReleaseIndex,
  );
  const tagMismatchIndex = releaseJob.indexOf(
    'if [[ "${tag_sha}" != "${RELEASE_SHA}" ]]',
  );
  assert.ok(
    existingReleaseIndex >= 0 &&
      newReleaseIndex > existingReleaseIndex &&
      tagMismatchIndex > newReleaseIndex,
  );
  assert.doesNotMatch(releaseJob, /cmp --/);
  assert.doesNotMatch(releaseJob, /HOMEBREW_TAP_TOKEN/);
  assert.doesNotMatch(releaseJob, /brew install|git push/);

  assert.match(
    homebrewJob,
    /if: always\(\) && needs\.macos\.result == 'success' && needs\.publish_release\.result == 'success' && inputs\.action != 'dry-run'/,
  );
  assert.match(homebrewJob, /^\s+environment: release$/m);
  assert.match(homebrewJob, /^\s+contents: read$/m);
  assert.doesNotMatch(homebrewJob, /contents: write/);
  assert.match(homebrewJob, /published-caffold-macos-arm64-v/);
  assert.match(homebrewJob, /repository: panarch\/homebrew-tap/);
  assert.match(homebrewJob, /token: \$\{\{ secrets\.HOMEBREW_TAP_TOKEN \}\}/);
  const renderIndex = homebrewJob.indexOf(
    ">homebrew-tap/Casks/caffold.rb",
  );
  const commitIndex = homebrewJob.indexOf(
    'git commit -m "Update Caffold to ${RELEASE_VERSION}"',
  );
  const tapIndex = homebrewJob.indexOf(
    'brew tap panarch/tap "${GITHUB_WORKSPACE}/homebrew-tap"',
  );
  const trustIndex = homebrewJob.indexOf(
    "brew trust --cask panarch/tap/caffold",
  );
  const auditIndex = homebrewJob.indexOf(
    "brew audit --cask --strict panarch/tap/caffold",
  );
  const installIndex = homebrewJob.indexOf(
    "brew install --cask panarch/tap/caffold",
  );
  const pushIndex = homebrewJob.indexOf("git push origin HEAD:main");
  assert.ok(
    renderIndex >= 0 &&
      commitIndex > renderIndex &&
      tapIndex > commitIndex &&
      trustIndex > tapIndex &&
      auditIndex > trustIndex &&
      installIndex > auditIndex &&
      pushIndex > installIndex,
  );
  assert.match(homebrewJob, /if: steps\.tap_update\.outputs\.changed == 'true'/);
  assert.doesNotMatch(homebrewJob, /HOMEBREW_NO_REQUIRE_TAP_TRUST/);
  assert.match(homebrewJob, /brew install --cask panarch\/tap\/caffold/);
  assert.match(homebrewJob, /git push origin HEAD:main/);
  assert.doesNotMatch(homebrewJob, /gh release create/);
});
