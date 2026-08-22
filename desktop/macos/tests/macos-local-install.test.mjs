import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installer = resolve(repoRoot, "desktop/macos/install-local");

function withFakeProcessTools(psOutput, listenerOutput, operation) {
  const directory = mkdtempSync(join(tmpdir(), "caffold-install-test-"));
  const fakePs = join(directory, "ps");
  const fakeLsof = join(directory, "lsof");
  writeFileSync(fakePs, `#!/bin/sh\nprintf '%s' "$FAKE_PS_OUTPUT"\n`, { mode: 0o755 });
  writeFileSync(fakeLsof, `#!/bin/sh\nprintf '%s' "$FAKE_LSOF_OUTPUT"\n`, { mode: 0o755 });
  try {
    return operation({
      ...process.env,
      PATH: `${directory}:/usr/bin:/bin:/usr/sbin:/sbin`,
      FAKE_PS_OUTPUT: psOutput,
      FAKE_LSOF_OUTPUT: listenerOutput,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkStopped(psOutput = "", listenerOutput = "") {
  const target = "/Applications/Caffold Server.app";
  return withFakeProcessTools(psOutput, listenerOutput, (env) =>
    spawnSync(installer, ["--check-stopped"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...env,
        CAFFOLD_SERVER_APP_TARGET: target,
        CAFFOLD_SERVER_STOP_ATTEMPTS: "1",
        CAFFOLD_SERVER_STOP_INTERVAL: "0",
      },
    }),
  );
}

test("local installer validates its shell and documents a read-only preflight", () => {
  const syntax = spawnSync("bash", ["-n", installer], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync(installer, ["--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--check-stopped/);
});

test("local installer accepts a fully stopped target runtime", () => {
  const result = checkStopped();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fully stopped/);
});

test("local installer detects a bundled server after its listener is gone", () => {
  const server = "/Applications/Caffold Server.app/Contents/Resources/caffold";
  const result = checkStopped(` 431 ${server} serve --port 5178\n`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundled server processes/);
  assert.match(result.stderr, /431/);
  assert.doesNotMatch(result.stderr, /listener PIDs/);
});

test("local installer treats an unrelated port listener as a blocking owner", () => {
  const result = checkStopped("", "902\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port 5178 listener PIDs/);
  assert.match(result.stderr, /902/);
});

test("rollback stops the replacement before restoring and verifies old health", () => {
  const source = readFileSync(installer, "utf8");
  assert.doesNotMatch(
    source,
    /^\s*(?:kill|killall|pkill)\b/m,
    "the installer must never force-kill a process it did not start",
  );
  const rollbackStart = source.indexOf("rollback_on_error() {");
  const rollback = source.slice(rollbackStart, source.indexOf("case \"${TARGET_APP}\"", rollbackStart));
  const stopIndex = rollback.indexOf('stop_installed_app "The newly installed Caffold Server"');
  const restoreIndex = rollback.indexOf('mv -- "${BACKUP_APP}" "${TARGET_APP}"');
  const verifyIndex = rollback.indexOf('start_and_verify "" "The restored Caffold Server"');

  assert.ok(stopIndex >= 0, "rollback must stop the failed replacement");
  assert.ok(restoreIndex > stopIndex, "rollback must restore only after the runtime stops");
  assert.ok(verifyIndex > restoreIndex, "rollback must health-check the restored app");
});

test("failed replacement restores the previous app only after the new runtime stops", () => {
  const directory = mkdtempSync(join(tmpdir(), "caffold-install-rollback-"));
  const fakeBin = join(directory, "bin");
  const sourceApp = join(directory, "source", "Caffold Server.app");
  const targetApp = join(directory, "installed", "Caffold Server.app");
  const backupDir = join(directory, "backups");
  const stateFile = join(directory, "runtime-state");
  mkdirSync(fakeBin, { recursive: true });

  function makeApp(path, marker) {
    mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(path, "Contents", "MacOS", "CaffoldServer"), "wrapper\n", {
      mode: 0o755,
    });
    writeFileSync(join(path, "Contents", "Resources", "caffold"), "server\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(path, "Contents", "Resources", "caffold-claude-runner"),
      "runner\n",
      { mode: 0o755 },
    );
    writeFileSync(join(path, "Contents", "Info.plist"), "plist\n");
    writeFileSync(join(path, "marker"), `${marker}\n`);
  }

  function tool(name, source) {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o755 });
  }

  makeApp(sourceApp, "new");
  makeApp(targetApp, "old");
  writeFileSync(stateFile, "stopped\n");

  tool("codesign", "exit 0");
  tool("plutil", "exit 0");
  tool("ditto", 'exec /bin/cp -R "$1" "$2"');
  tool(
    "open",
    'marker="$(/bin/cat "$1/marker")"\nprintf "%s\\n" "$marker" >"$FAKE_STATE_FILE"',
  );
  tool("osascript", 'printf "stopped\\n" >"$FAKE_STATE_FILE"');
  tool(
    "curl",
    'state="$(/bin/cat "$FAKE_STATE_FILE")"\nif [ "$state" = old ]; then\n  printf \'{"status":"ok","buildId":"old"}\\n\'\n  exit 0\nfi\nexit 22',
  );
  tool(
    "lsof",
    'state="$(/bin/cat "$FAKE_STATE_FILE")"\nif [ "$state" != stopped ]; then printf "902\\n"; fi',
  );
  tool(
    "ps",
    'state="$(/bin/cat "$FAKE_STATE_FILE")"\nif [ "$1" = -axo ]; then\n  if [ "$state" != stopped ]; then\n    printf " 901 %s/Contents/MacOS/CaffoldServer\\n" "$FAKE_TARGET_APP"\n    printf " 902 %s/Contents/Resources/caffold serve --port 5178\\n" "$FAKE_TARGET_APP"\n  fi\nelse\n  printf "%s/Contents/Resources/caffold serve --port 5178\\n" "$FAKE_TARGET_APP"\nfi',
  );

  try {
    const result = spawnSync(installer, [], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        FAKE_STATE_FILE: stateFile,
        FAKE_TARGET_APP: targetApp,
        CAFFOLD_SERVER_APP_SOURCE: sourceApp,
        CAFFOLD_SERVER_APP_TARGET: targetApp,
        CAFFOLD_SERVER_BACKUP_DIR: backupDir,
        CAFFOLD_LOCAL_INSTALL_SKIP_BUILD: "true",
        CAFFOLD_SERVER_STOP_ATTEMPTS: "1",
        CAFFOLD_SERVER_STOP_INTERVAL: "0",
        CAFFOLD_SERVER_HEALTH_ATTEMPTS: "1",
        CAFFOLD_SERVER_HEALTH_INTERVAL: "0",
      },
    });

    assert.notEqual(result.status, 0, "the intentionally unhealthy new app must fail");
    assert.equal(readFileSync(join(targetApp, "marker"), "utf8").trim(), "old");
    assert.equal(readFileSync(stateFile, "utf8").trim(), "old");
    assert.match(result.stderr, /previous app was restored and is healthy/);

    const failedBundle = readdirSync(join(directory, "installed")).find((name) =>
      name.startsWith(".Caffold Server.failed."),
    );
    assert.ok(failedBundle, "the failed replacement must be retained for inspection");
    assert.equal(
      readFileSync(join(directory, "installed", failedBundle, "marker"), "utf8").trim(),
      "new",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
