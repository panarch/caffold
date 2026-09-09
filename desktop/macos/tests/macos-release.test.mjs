import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageApp = resolve(repoRoot, "desktop/macos/package-app");
const release = resolve(repoRoot, "desktop/macos/release");
const renderCask = resolve(repoRoot, "desktop/macos/render-cask");
const releaseWorkflow = resolve(repoRoot, ".github/workflows/release.yml");
const sharedWorkflows = {
  frontend: "frontend-tests.yml",
  documentation: "documentation-contracts.yml",
  repository_tooling: "repository-tooling-tests.yml",
  macos_packaging: "macos-packaging-contracts.yml",
  browser: "browser-tests.yml",
  rust: "rust-checks.yml",
};
const bundlePlist = resolve(repoRoot, "desktop/macos/Info.plist");
const menuBarWrapper = resolve(repoRoot, "desktop/macos/CaffoldServer.swift");
const rootReadme = resolve(repoRoot, "README.md");
const macosReadme = resolve(repoRoot, "desktop/macos/README.md");
const productInstallGuide = resolve(repoRoot, "docs/product/installation.md");
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

function workflowJob(workflow, name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|(?![\\s\\S]))`, "m"),
  );
  assert.ok(match, `${name} must exist`);
  return match[0];
}

test(
  "macOS package metadata has one versioned arm64 archive identity",
  { skip: macosArm64Only },
  () => {
    const metadata = parseMetadata(run(packageApp, ["metadata"]));
    const cargoVersion = readFileSync(resolve(repoRoot, "caffold/Cargo.toml"), "utf8").match(
      /^version = "([^"]+)"$/m,
    )?.[1];
    const webVersion = JSON.parse(readFileSync(resolve(repoRoot, "frontend/package.json"), "utf8")).version;

    assert.equal(metadata.version, cargoVersion);
    assert.equal(metadata.version, webVersion);
    assert.equal(metadata.arch, "arm64");
    assert.equal(metadata.archive, `Caffold-Server-${metadata.version}-macos-arm64.zip`);
    assert.equal(metadata.checksum, `${metadata.archive}.sha256`);
  },
);

test("macOS bundle identity separates a monotonic build number from a readable commit", () => {
  const source = readFileSync(packageApp, "utf8");

  assert.match(source, /^BUILD_NUMBER="\$\(date '\+%s'\)"$/m);
  assert.doesNotMatch(source, /rev-list --count/);
  assert.doesNotMatch(source, /--expected-build-number/);
  assert.match(source, /'\+%Y-%m-%d %H:%M:%S %Z'/);
  assert.match(source, /Set :CaffoldBuildCommit \$\{BUILD_COMMIT\}/);
  assert.match(source, /CFBundleVersion '\^\[0-9\]\{10\}\$'/);

  assert.match(readFileSync(bundlePlist, "utf8"), /<key>CaffoldBuildCommit<\/key>/);

  const wrapper = readFileSync(menuBarWrapper, "utf8");
  assert.match(wrapper, /forInfoDictionaryKey: "CaffoldBuildCommit"/);
  assert.match(wrapper, /\.version: buildCommit \?\? ""/);
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

test("release checks the source before versioning and packaging on macOS", () => {
  const source = readFileSync(releaseWorkflow, "utf8");
  const readWorkflow = (name) => readFileSync(
    resolve(repoRoot, ".github/workflows", name), "utf8",
  );
  const macosCall = workflowJob(source, "macos");
  const releaseJob = workflowJob(source, "publish_release");
  const homebrewJob = workflowJob(source, "publish_homebrew");
  const common = Object.values(sharedWorkflows).map(readWorkflow).join("\n");
  const macos = readWorkflow("macos-release.yml");
  const checks = readWorkflow("checks.yml");

  assert.match(source, /^name: Release$/m);
  assert.match(source, /^\s+workflow_dispatch:$/m);
  assert.doesNotMatch(source, /^\s+(push|pull_request|schedule):$/m);
  assert.match(source, /^\s+default: dry-run$/m);
  for (const action of ["dry-run", "release-patch", "release-minor", "release-major", "resume"]) {
    assert.match(source, new RegExp(`^\\s+- ${action}$`, "m"));
  }
  assert.doesNotMatch(source + common + macos, /git bundle|candidate-artifact|release-sha:|restore-release-candidate/);
  assert.doesNotMatch(source, /^  (prepare|commit_release):/m);

  // CI and release call the same source checks without release-specific inputs.
  for (const [name, filename] of Object.entries(sharedWorkflows)) {
    const workflow = readWorkflow(filename);
    const check = workflowJob(workflow, name);
    const checkCall = workflowJob(checks, name);
    const releaseCall = workflowJob(source, name);
    assert.equal(checkCall.trim(), releaseCall.trim());
    assert.ok(checkCall.includes(`uses: ./.github/workflows/${filename}`));
    assert.doesNotMatch(checkCall, /with:|needs:|steps:/);
    assert.match(workflow, /^  workflow_call:$/m);
    assert.doesNotMatch(workflow, /inputs:/);
    assert.deepEqual(
      [...workflow.split("\njobs:\n")[1].matchAll(/^  ([a-z_]+):/gm)].map(([, id]) => id),
      [name],
      `${filename} must own only its named check`,
    );
    assert.match(check, /runs-on: ubuntu-latest/);
    assert.match(check, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(macosCall, new RegExp(`^      - ${name}$`, "m"));
  }
  assert.doesNotMatch(common, /contents: write|HOMEBREW_TAP_TOKEN|git push|gh release create/);
  assert.match(macosCall, /uses: \.\/\.github\/workflows\/macos-release\.yml/);
  assert.match(macosCall, /action: \$\{\{ inputs\.action \}\}/);
  assert.match(macosCall, /contents: write/);
  assert.doesNotMatch(macosCall, /if:|secrets:/);

  const browser = workflowJob(readWorkflow("browser-tests.yml"), "browser");
  assert.match(browser, /fail-fast: false/);
  assert.match(browser, /project: \[desktop, foldable, phone\]/);
  assert.match(browser, /npm run test:e2e -- --project=\$\{\{ matrix\.project \}\}/);
  assert.ok(browser.indexOf("cargo build --locked") < browser.indexOf("npm run test:e2e"));
  assert.match(browser, /name: playwright-results-\$\{\{ matrix\.project \}\}/);
  assert.match(browser, /if: failure\(\)/);

  // Versioning, candidate verification, and source push share one worktree.
  // Direct dispatch explains its purpose and offers only verification and packaging.
  assert.match(macos, /^  workflow_call:$/m);
  const dispatch = macos.match(/^  workflow_dispatch:\n([\s\S]*?)(?=^permissions:)/m)?.[1];
  assert.ok(dispatch);
  assert.match(dispatch, /description: \S/);
  assert.match(dispatch, /type: choice/);
  assert.deepEqual([...dispatch.matchAll(/^          - (.+)$/gm)].map(([, option]) => option), ["dry-run"]);
  assert.match(dispatch, /^        default: dry-run$/m);
  assert.match(macos, /^        default: dry-run$/m);
  assert.match(macos, /runs-on: macos-14/);
  assert.match(macos, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(macos, /persist-credentials: false/);
  assert.match(macos, /git checkout -B main "\$\{REQUESTED_SHA\}"/);
  assert.match(macos, /main changed after this workflow was dispatched/);
  assert.equal(macos.match(/git commit -m "Release v/g)?.length, 1);
  for (const name of [
    "Bump the release version locally", "Require an unused release version",
    "Commit the local release candidate", "Push the verified release commit",
  ]) {
    assert.ok(macos.includes(`- name: ${name}\n        if: startsWith(inputs.action, 'release-')`));
  }
  const ordered = [
    "node scripts/bump-release-version.mjs", 'git commit -m "Release v${RELEASE_VERSION}"',
    "desktop/macos/test-contracts", "desktop/macos/test-runtime",
    "cargo test --locked", "cargo clippy --locked --all-targets -- -D warnings",
    "desktop/macos/release --dry-run", "uses: actions/upload-artifact@",
    "gh auth setup-git", "main changed after verification", 'git push origin "${RELEASE_SHA}:refs/heads/main"',
  ].map((command) => macos.indexOf(command));
  assert.ok(ordered.every((index, i) => index >= 0 && (i === 0 || index > ordered[i - 1])));
  assert.match(macos, /Release source changed during verification/);
  assert.match(macos, /git ls-remote origin refs\/heads\/main/);
  for (const suite of ["test-system-status", "test-updater"]) {
    assert.match(macos, new RegExp(`desktop/macos/${suite}`));
  }
  assert.doesNotMatch(macos, /test:e2e|playwright install|HOMEBREW_TAP_TOKEN|gh release create|brew install/);

  // Default success gating carries any source/package/upload/push failure
  // through macOS to both publication jobs, without a skipped push job.
  assert.match(releaseJob, /^    needs: macos$/m);
  assert.match(releaseJob, /^    if: inputs\.action != 'dry-run'$/m);
  assert.match(releaseJob, /^\s+contents: write$/m);
  assert.match(releaseJob, /RELEASE_SHA: \$\{\{ needs\.macos\.outputs\.release_sha \}\}/);
  assert.match(releaseJob, /actions\/download-artifact@v\d+/);
  assert.match(releaseJob, /published-caffold-macos-arm64-v/);
  assert.match(releaseJob, /gh release create/);
  assert.match(releaseJob, /gh release download/);
  assert.match(releaseJob, /package-app verify-archive/);
  assert.match(releaseJob, /--expected-version "\$\{RELEASE_VERSION\}"/);
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
  assert.doesNotMatch(releaseJob, /rev-list --count/);
  assert.doesNotMatch(releaseJob, /cmp --/);
  assert.doesNotMatch(releaseJob, /HOMEBREW_TAP_TOKEN/);
  assert.doesNotMatch(releaseJob, /brew install|git push/);

  assert.match(
    homebrewJob,
    /^    if: inputs\.action != 'dry-run'$/m,
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

test("failed or skipped checks block the release chain in every mode", () => {
  const source = readFileSync(releaseWorkflow, "utf8");
  const dependencies = (name) => {
    const job = workflowJob(source, name);
    const list = job.match(/^    needs:\n((?:      - \w+\n)+)/m)?.[1];
    return list
      ? [...list.matchAll(/- (\w+)/g)].map(([, dependency]) => dependency)
      : [job.match(/^    needs: (\w+)$/m)?.[1]];
  };
  const chain = ["macos", "publish_release", "publish_homebrew"];
  const requiredChecks = Object.keys(sharedWorkflows);
  assert.deepEqual(dependencies("macos"), requiredChecks);
  assert.deepEqual(dependencies("publish_release"), ["macos"]);
  assert.deepEqual(dependencies("publish_homebrew"), ["macos", "publish_release"]);
  // These jobs intentionally use Actions' default success() condition. A
  // status-function override would invalidate this failure-propagation model.
  for (const name of chain) {
    const condition = workflowJob(source, name).match(/^    if: (.+)$/m)?.[1];
    assert.equal(condition, name === "macos" ? undefined : "inputs.action != 'dry-run'");
  }
  const runChain = (action, overrides = {}) => {
    const results = Object.fromEntries(requiredChecks.map((name) => [name, "success"]));
    for (const name of requiredChecks) results[name] = overrides[name] ?? results[name];
    for (const name of chain) {
      const enabled = dependencies(name).every((dependency) => results[dependency] === "success")
        && (name === "macos" || action !== "dry-run");
      results[name] = enabled ? overrides[name] ?? "success" : "skipped";
    }
    return results;
  };
  for (const action of ["dry-run", "resume", "release-patch", "release-minor", "release-major"]) {
    const success = runChain(action);
    assert.equal(success.macos, "success");
    assert.equal(success.publish_release, action === "dry-run" ? "skipped" : "success");
    assert.equal(success.publish_homebrew, success.publish_release);
    for (const name of [...requiredChecks, "macos", "publish_release"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const failed = runChain(action, { [name]: result });
        if (requiredChecks.includes(name)) assert.equal(failed.macos, "skipped");
        if (name !== "publish_release") assert.equal(failed.publish_release, "skipped");
        assert.equal(failed.publish_homebrew, "skipped", `${action}: ${name} ${result} must stop publication`);
      }
    }
  }
});
