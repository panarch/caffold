import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageApp = join(repoRoot, "desktop/macos/package-app");
const nativeOnly = process.platform === "darwin" && process.arch === "arm64"
  ? false : "requires macOS arm64 and Xcode tools";
const executables = ["MacOS/CaffoldServer", "Resources/caffold", "Resources/caffold-runner"];

// Build real Mach-O executables and a signed bundle so verify-archive reaches
// the compiler's load commands independently of the advertised plist minimum.
function archiveFixture(t, targets) {
  const root = mkdtempSync(join(tmpdir(), "caffold-deployment-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Caffold Server.app");
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  const plist = join(contents, "Info.plist");
  copyFileSync(join(repoRoot, "desktop/macos/Info.plist"), plist);
  const values = {
    CFBundleShortVersionString: "1.2.3",
    CFBundleVersion: "1800000000",
    CaffoldBuildCommit: "1234abcd",
    CaffoldBuildTimestamp: "2026-11-02 12:00:00 KST",
  };
  for (const [key, value] of Object.entries(values)) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  }
  for (const binary of executables) {
    execFileSync("xcrun", ["clang", "-target", `arm64-apple-macosx${targets[binary] ?? "14.0"}`,
      "-x", "c", "-o", join(contents, binary), "-"], {
      input: "int main(void) { return 0; }\n",
    });
  }
  for (const icon of ["CaffoldServer.icns", "CaffoldMenuIcon.png"]) {
    writeFileSync(join(contents, "Resources", icon), "fixture");
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" });
  const archive = join(root, "app.zip");
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  return spawnSync(packageApp, ["verify-archive", archive, "--expected-version", "1.2.3"], {
    cwd: repoRoot, encoding: "utf8",
  });
}

for (const minimum of ["13.0", "14.0"]) {
  test(`archive accepts executables targeting macOS ${minimum}`, { skip: nativeOnly }, (t) => {
    const result = archiveFixture(t, Object.fromEntries(executables.map((path) => [path, minimum])));
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const binary of executables) {
  test(`archive rejects ${binary} requiring macOS 15 despite a macOS 14 plist`, { skip: nativeOnly }, (t) => {
    const result = archiveFixture(t, { [binary]: "15.0" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`${binary} requires macOS 15.0`), result.stderr);
    assert.match(result.stderr, /expected 14\.0 or earlier/);
  });
}
