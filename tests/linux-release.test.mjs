import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageLinux = resolve(repoRoot, "distribution/linux/package");
const renderFormula = resolve(repoRoot, "distribution/linux/render-formula");
const checksWorkflow = resolve(repoRoot, ".github/workflows/checks.yml");
const whisperWorkflow = resolve(repoRoot, ".github/workflows/whisper-smoke.yml");

function run(command, args = []) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" });
}

test("Linux package builder is native, locked, versioned, and self-verifying", () => {
  run("bash", ["-n", packageLinux]);
  const source = readFileSync(packageLinux, "utf8");

  assert.match(source, /x86_64\)/);
  assert.match(source, /aarch64\|arm64\)/);
  assert.match(source, /cargo build --release --locked/);
  assert.match(source, /libvulkan\.so\.1/);
  assert.match(source, /readelf -d/);
  assert.match(source, /ldd .*not found/);
  assert.match(source, /--version/);
  assert.match(source, /tar -xzf/);
  assert.match(source, /sha256sum/);
  assert.match(source, /--expected-arch/);

  const help = run(packageLinux, ["--help"]);
  assert.match(help, /archive\|verify-archive\|metadata/);
});

test("Linux Homebrew Formula selects both release architectures and owns a user service", () => {
  run("bash", ["-n", renderFormula]);
  const x86 = "a".repeat(64);
  const arm = "b".repeat(64);
  const formula = run(renderFormula, [
    "--version",
    "1.2.3",
    "--x86-64-sha256",
    x86,
    "--aarch64-sha256",
    arm,
  ]);

  assert.match(formula, /^class Caffold < Formula$/m);
  assert.match(formula, /^  version "1\.2\.3"$/m);
  assert.match(formula, /on_intel do[\s\S]*linux-x86_64\.tar\.gz[\s\S]*sha256 "a{64}"/);
  assert.match(formula, /on_arm do[\s\S]*linux-aarch64\.tar\.gz[\s\S]*sha256 "b{64}"/);
  assert.match(formula, /^  depends_on :linux$/m);
  assert.match(formula, /^  depends_on "vulkan-loader"$/m);
  assert.match(formula, /^  service do$/m);
  assert.match(formula, /brew services start panarch\/tap\/caffold/);
  assert.match(formula, /caffold tailscale enable/);
  assert.match(formula, /environment_variables PATH: std_service_path_env/);
  assert.match(formula, /caffold #\{version\}/);

  const invalid = spawnSync(
    renderFormula,
    [
      "--version",
      "1.2.3",
      "--x86-64-sha256",
      "invalid",
      "--aarch64-sha256",
      arm,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /64 lowercase hexadecimal characters/);
});

test("pull requests build native x86_64 and aarch64 packages", () => {
  const checks = readFileSync(checksWorkflow, "utf8");
  assert.match(checks, /linux-package:/);
  assert.match(checks, /runner: ubuntu-24\.04-arm/);
  assert.match(checks, /release_arch: x86_64/);
  assert.match(checks, /release_arch: aarch64/);
  assert.match(checks, /distribution\/linux\/package archive/);
  assert.match(checks, /glslc libvulkan-dev/);
});

test("the opt-in Whisper smoke pins a tiny multilingual model and CPU inference", () => {
  const workflow = readFileSync(whisperWorkflow, "utf8");
  assert.match(workflow, /^name: Whisper Smoke$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):$/m);
  assert.match(workflow, /ggml-tiny\.bin/);
  assert.match(workflow, /be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21/);
  assert.match(workflow, /59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e/);
  assert.match(workflow, /live_pinned_model_transcribes_a_real_wav/);
  assert.match(workflow, /--ignored --exact --nocapture/);
});
