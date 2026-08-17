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
const rootReadme = resolve(repoRoot, "README.md");
const macosReadme = resolve(repoRoot, "desktop/macos/README.md");
const productInstallGuide = resolve(repoRoot, "docs/product/installation.md");
const macosServerSource = resolve(repoRoot, "desktop/macos/CaffoldServer.swift");
const macosArm64Only =
  process.platform === "darwin" && process.arch === "arm64"
    ? false
    : "requires a macOS arm64 host";

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

test(
  "macOS package metadata has one versioned arm64 archive identity",
  { skip: macosArm64Only },
  () => {
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
  },
);

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

  for (const readme of [rootReadme, macosReadme, productInstallGuide]) {
    const documentation = readFileSync(readme, "utf8");
    assert.match(documentation, /brew install --cask panarch\/tap\/caffold/);
    assert.match(documentation, /Homebrew/);
  }
});

test("manual release workflow isolates versioning, verification, and publication", () => {
  const source = readFileSync(releaseWorkflow, "utf8");
  const rustVersion = readFileSync(resolve(repoRoot, "Cargo.toml"), "utf8").match(
    /^rust-version = "([^"]+)"$/m,
  )?.[1];
  const macosStart = source.indexOf("  macos:");
  const commitStart = source.indexOf("  commit_release:");
  const releaseStart = source.indexOf("  publish_release:");
  const homebrewStart = source.indexOf("  publish_homebrew:");
  const macosJob = source.slice(macosStart, commitStart);
  const commitJob = source.slice(commitStart, releaseStart);
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
    macosStart >= 0 &&
      commitStart > macosStart &&
      releaseStart > commitStart &&
      homebrewStart > releaseStart,
  );
  assert.doesNotMatch(source, /^  bump_release:$/m);

  assert.match(macosJob, /runs-on: macos-14/);
  assert.match(macosJob, /REQUESTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(macosJob, /CANDIDATE_SHA: \$\{\{ steps\.release_commit\.outputs\.release_sha \}\}/);
  assert.match(macosJob, /release_sha="\$\{CANDIDATE_SHA:-\$\{REQUESTED_SHA\}\}"/);
  assert.match(macosJob, /fetch-depth: 0/);
  assert.match(macosJob, /persist-credentials: false/);
  assert.match(
    macosJob,
    /Check out the complete release history[\s\S]*?ref: main/,
  );
  assert.doesNotMatch(
    macosJob,
    /ref: \$\{\{ steps\.release_source\.outputs\.release_sha \}\}/,
  );
  assert.match(macosJob, /scripts\/bump-release-version\.mjs/);
  assert.match(macosJob, /git commit -m "Release v\$\{RELEASE_VERSION\}"/);
  assert.match(macosJob, /git bundle create/);
  assert.match(macosJob, /git bundle verify/);
  assert.match(macosJob, /caffold-release-candidate-v/);
  for (const canonicalFile of ["Cargo.lock", "Cargo.toml", "package.json"]) {
    assert.match(macosJob, new RegExp(canonicalFile.replace(".", "\\.")));
  }
  assert.match(macosJob, new RegExp(`rustup toolchain install ${rustVersion}(?:\\.0)?`));
  assert.match(macosJob, /npm ci/);
  assert.match(macosJob, /playwright install chromium/);
  assert.match(macosJob, /release --dry-run/);
  assert.match(macosJob, /cargo test --locked/);
  assert.match(macosJob, /cargo clippy --locked --all-targets -- -D warnings/);
  const browserBuildIndex = macosJob.indexOf("cargo build --locked");
  const browserTestIndex = macosJob.indexOf("npm run test:e2e");
  const candidateCommitIndex = macosJob.indexOf(
    'git commit -m "Release v${RELEASE_VERSION}"',
  );
  const candidateBundleIndex = macosJob.indexOf("git bundle create");
  assert.ok(
    candidateCommitIndex >= 0 &&
      browserBuildIndex > candidateCommitIndex &&
      browserTestIndex > browserBuildIndex &&
      candidateBundleIndex > browserTestIndex,
  );
  for (const command of ["test:unit", "test:contract", "test:e2e", "test:macos"]) {
    assert.match(macosJob, new RegExp(`npm run ${command}`));
  }
  assert.match(macosJob, /name: Upload browser failure artifacts/);
  assert.match(macosJob, /name: playwright-release-results-v/);
  assert.doesNotMatch(macosJob, /npm run test:codex-(?:compat|live)/);
  assert.match(macosJob, /actions\/upload-artifact@v\d+/);
  assert.doesNotMatch(macosJob, /contents: write/);
  assert.doesNotMatch(macosJob, /HOMEBREW_TAP_TOKEN/);
  for (const publishingCommand of ["git push", "gh release create", "brew install"]) {
    assert.doesNotMatch(macosJob, new RegExp(publishingCommand, "i"));
  }

  assert.match(commitJob, /^\s+needs: macos$/m);
  assert.match(
    commitJob,
    /needs\.macos\.result == 'success' && startsWith\(inputs\.action, 'release-'\)/,
  );
  assert.match(commitJob, /^\s+contents: write$/m);
  assert.match(commitJob, /caffold-release-candidate-v/);
  assert.match(commitJob, /git bundle verify/);
  assert.match(commitJob, /Release candidate is not a direct child/);
  assert.match(commitJob, /main changed after verification/);
  assert.match(commitJob, /git push origin "\$\{RELEASE_SHA\}:refs\/heads\/main"/);
  assert.match(commitJob, /git ls-remote origin refs\/heads\/main/);
  assert.doesNotMatch(
    commitJob,
    /npm run|cargo (?:build|test|clippy)|gh release|brew install|HOMEBREW_TAP_TOKEN/,
  );

  assert.match(
    releaseJob,
    /startsWith\(inputs\.action, 'release-'\) && needs\.commit_release\.result == 'success'/,
  );
  assert.match(
    releaseJob,
    /inputs\.action == 'resume' && needs\.commit_release\.result == 'skipped'/,
  );
  assert.match(releaseJob, /^\s+contents: write$/m);
  assert.match(releaseJob, /RELEASE_SHA: \$\{\{ needs\.macos\.outputs\.release_sha \}\}/);
  assert.match(releaseJob, /actions\/download-artifact@v\d+/);
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
