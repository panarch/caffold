import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const linuxRelease = read(".github/workflows/linux-release.yml");
const release = read(".github/workflows/release.yml");

function workflowJob(workflow, name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|(?![\\s\\S]))`, "m"),
  );
  assert.ok(match, `${name} must exist`);
  return match[0];
}

test("Linux Release builds each architecture in a glibc 2.28 container", () => {
  const job = workflowJob(linuxRelease.split("\njobs:\n")[1], "linux");

  assert.match(job, /^          - arch: x86_64\n            runner: ubuntu-24\.04$/m);
  assert.match(job, /^          - arch: aarch64\n            runner: ubuntu-24\.04-arm$/m);
  assert.match(job, /^    runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(job, /^    container: quay\.io\/pypa\/manylinux_2_28_\$\{\{ matrix\.arch \}\}$/m);
  assert.match(job, /fail-fast: false/);
  const ordered = [
    "ref: ${{ inputs.release_sha || github.sha }}",
    'git config --global --add safe.directory "${GITHUB_WORKSPACE}"',
    "--default-toolchain 1.96.0",
    "node-version: 26",
    "npm ci --omit=dev",
    "distribution/linux/package metadata",
    "distribution/linux/package archive",
    "name: caffold-linux-${{ matrix.arch }}-v${{ steps.metadata.outputs.version }}",
  ].map((step) => job.indexOf(step));
  assert.ok(ordered.every((index, i) => index >= 0 && (i === 0 || index > ordered[i - 1])), ordered.join(","));
  assert.match(job, /retention-days: 7/);
  assert.match(job, /persist-credentials: false/);
  assert.match(linuxRelease, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(linuxRelease, /contents: write|secrets\.|git push|gh release/);
});

test("Linux Release runs for the release, for pull requests that can change the binaries, and by hand", () => {
  const triggers = linuxRelease.split("\npermissions:")[0];

  assert.match(triggers, /^  workflow_call:\n    inputs:\n      release_sha:\n/m);
  assert.match(triggers, /^        required: true$/m);
  assert.match(triggers, /^  workflow_dispatch:$/m);
  const paths = [...triggers.matchAll(/^      - "(.+)"$/gm)].map(([, path]) => path);
  assert.deepEqual(paths, [
    "distribution/linux/**",
    ".github/workflows/linux-*.yml",
    "Cargo.toml",
    "Cargo.lock",
    "caffold/Cargo.toml",
    "caffold/build.rs",
    "runners/caffold/Cargo.toml",
    "rust-toolchain.toml",
  ]);
});

test("Release builds Linux from the macOS job's release commit before it publishes", () => {
  const linux = workflowJob(release, "linux");
  const publish = workflowJob(release, "publish_release");

  assert.match(linux, /^    needs: macos$/m);
  assert.match(linux, /^    uses: \.\/\.github\/workflows\/linux-release\.yml$/m);
  assert.match(linux, /^      release_sha: \$\{\{ needs\.macos\.outputs\.release_sha \}\}$/m);
  assert.doesNotMatch(linux, /permissions:|secrets:|if:/);
  assert.match(publish, /^    needs:\n      - macos\n      - linux\n/m);
  assert.match(publish, /pattern: caffold-linux-\*-v\$\{\{ needs\.macos\.outputs\.version \}\}/);
  assert.match(publish, /merge-multiple: true/);
  assert.match(
    publish,
    /for arch in x86_64 aarch64; do\n            archive="Caffold-\$\{RELEASE_VERSION\}-linux-\$\{arch\}\.tar\.gz"\n            test -f "\$\{archive\}"\n            test -f "\$\{archive\}\.sha256"\n            shasum -a 256 -c "\$\{archive\}\.sha256"/,
  );
  // A resumed release keeps the Linux assets it already published, once
  // their checksums hold.
  assert.match(publish, /--pattern "Caffold-\$\{RELEASE_VERSION\}-linux-\*"/);
  assert.match(publish, /shasum -a 256 -c "Caffold-\$\{RELEASE_VERSION\}-linux-\$\{arch\}\.tar\.gz\.sha256"/);
});

test("a new release publishes both Linux archives, and a candidate's notes say how to install it", () => {
  const publish = workflowJob(release, "publish_release");
  const start = publish.indexOf("            for arch in x86_64 aarch64; do\n              archive=");
  const end = publish.indexOf('            if tag_sha="$(');
  assert.ok(start >= 0 && end > start);
  const argumentsFor = (version) => execFileSync("bash", ["-c", `
    set -e
    GITHUB_REPOSITORY=panarch/caffold
    RELEASE_VERSION=${version}
    tag="v\${RELEASE_VERSION}"
    linux_dir=/runner/target/caffold-linux
    release_args=()
${publish.slice(start, end)}
    printf '%s\\n---\\n' "\${release_args[@]}"
  `], { encoding: "utf8" }).split("\n---\n").filter(Boolean);

  assert.deepEqual(argumentsFor("0.24.0"), [
    "/runner/target/caffold-linux/Caffold-0.24.0-linux-x86_64.tar.gz#Caffold 0.24.0 for Linux x86_64",
    "/runner/target/caffold-linux/Caffold-0.24.0-linux-x86_64.tar.gz.sha256#SHA-256 checksum for Linux x86_64",
    "/runner/target/caffold-linux/Caffold-0.24.0-linux-aarch64.tar.gz#Caffold 0.24.0 for Linux aarch64",
    "/runner/target/caffold-linux/Caffold-0.24.0-linux-aarch64.tar.gz.sha256#SHA-256 checksum for Linux aarch64",
  ]);
  const candidate = argumentsFor("0.25.0-rc.2");
  assert.equal(candidate.length, 6);
  assert.equal(candidate[4], "--notes");
  assert.equal(
    candidate[5],
    [
      "Install this release candidate on Linux:",
      "",
      "```sh",
      "curl -fsSL https://raw.githubusercontent.com/panarch/caffold/v0.25.0-rc.2/distribution/linux/install.sh | sh -s -- --version 0.25.0-rc.2",
      "```",
    ].join("\n"),
  );
});

test("the release, the install script, and the updater name the archive alike", () => {
  const name = "Caffold-{version}-linux-{arch}.tar.gz";

  assert.ok(read("caffold/src/update/linux/host.rs").includes(`format!("${name}")`));
  assert.ok(read("distribution/linux/install.sh").includes('archive="Caffold-$1-linux-$2.tar.gz"'));
  assert.ok(read("distribution/linux/package").includes('ARCHIVE_BASENAME="Caffold-${VERSION}-linux-${ARCH}.tar.gz"'));
  assert.ok(release.includes('archive="Caffold-${RELEASE_VERSION}-linux-${arch}.tar.gz"'));
});
