import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const installScript = resolve(here, "../install.sh");
const fixtures = resolve(here, "fixtures");

// A user's home, a local release the script downloads from, and the state of
// the stand-in systemd service and server.
function world(t, { latest = "0.24.0", releases = ["0.24.0"], broken = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "caffold-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const state = join(root, "state");
  const release = join(root, "release");
  for (const directory of [home, state, release]) mkdirSync(directory);
  for (const version of releases) {
    publish(release, version, broken.includes(version) ? "broken-archive" : "archive");
  }
  writeFileSync(
    join(release, "latest.json"),
    `{\n  "tag_name": "v${latest}",\n  "draft": false\n}\n`,
  );
  return { home, state, release };
}

function publish(release, version, contents, arch = "x86_64") {
  const directory = join(release, `v${version}`);
  mkdirSync(directory, { recursive: true });
  const archive = `Caffold-${version}-linux-${arch}.tar.gz`;
  execFileSync("tar", [
    "-czf",
    join(directory, archive),
    "-C",
    join(fixtures, contents),
    "caffold",
    "caffold-runner",
  ]);
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, archive)))
    .digest("hex");
  writeFileSync(join(directory, `${archive}.sha256`), `${digest}  ${archive}\n`);
  return join(directory, archive);
}

function install({ home, state, release }, args = [], env = {}, { tailscale = true } = {}) {
  const path = [join(fixtures, "bin"), ...(tailscale ? [join(fixtures, "tailscale")] : []), "/usr/bin", "/bin"];
  return spawnSync("sh", [installScript, ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: path.join(":"),
      FAKE_STATE: state,
      FAKE_STARTS: "0.23.0 0.24.0 0.25.0",
      FAKE_TAILSCALE_ANSWER:
        '{"state":"ready","reasonCode":"serveReady","diagnosticMessage":"","tailnetUrl":"https://host.example.ts.net","canManage":true}',
      CAFFOLD_LATEST_RELEASE_URL: `file://${release}/latest.json`,
      CAFFOLD_RELEASE_DOWNLOAD_URL: `file://${release}`,
      ...env,
    },
  });
}

function linked(home) {
  return readlinkSync(join(home, ".local/bin/caffold"));
}

function versions(home) {
  return readdirSync(join(home, ".local/share/caffold/versions")).sort();
}

function log(state, name) {
  const file = join(state, `${name}.log`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

test("installs the newest release as a systemd user service", (t) => {
  const user = world(t);

  const result = install(user);

  assert.equal(result.status, 0, result.stderr);
  const versionsDir = join(user.home, ".local/share/caffold/versions");
  assert.equal(linked(user.home), join(versionsDir, "0.24.0/caffold"));
  assert.deepEqual(readdirSync(join(versionsDir, "0.24.0")).sort(), ["caffold", "caffold-runner"]);
  const unit = readFileSync(join(user.home, ".config/systemd/user/caffold.service"), "utf8");
  assert.match(
    unit,
    /^ExecStart=%h\/\.local\/bin\/caffold serve --port 5178 --install-root %h\/\.local\/share\/caffold$/m,
  );
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  const path = unit.match(/^Environment=PATH=(.+)$/m)?.[1].split(":");
  for (const directory of [
    "%h/.local/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/run/current-system/sw/bin",
    "/etc/profiles/per-user/%u/bin",
    "%h/.nix-profile/bin",
  ]) {
    assert.ok(path?.includes(directory), `${directory} is on the service PATH`);
  }
  assert.deepEqual(log(user.state, "systemctl"), [
    "--user show-environment",
    "--user daemon-reload",
    "--user enable --quiet caffold.service",
    "--user restart caffold.service",
  ]);
  assert.match(result.stdout, /^Installing Caffold 0\.24\.0 for x86_64\.$/m);
  assert.match(result.stdout, /^Caffold 0\.24\.0 is running at http:\/\/127\.0\.0\.1:5178\.$/m);
});

test("keeps the service running after the user logs out", (t) => {
  const user = world(t);

  const turnedOn = install(user);
  assert.equal(turnedOn.status, 0, turnedOn.stderr);
  assert.match(log(user.state, "loginctl").at(-1), /^--no-ask-password enable-linger \S+$/);
  assert.match(turnedOn.stdout, /^Caffold keeps running after you log out\.$/m);

  const refused = install(user, [], { FAKE_LINGER_REFUSED: "1" });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /^To keep Caffold running after you log out, run: sudo loginctl enable-linger \S+$/m);

  rmSync(join(user.state, "loginctl.log"));
  const lingering = install(user, [], { FAKE_LINGER: "yes" });
  assert.equal(lingering.status, 0, lingering.stderr);
  assert.deepEqual(
    log(user.state, "loginctl").filter((call) => call.includes("enable-linger")),
    [],
  );
});

test("turns Tailscale Serve on through the local server", (t) => {
  const user = world(t);

  const ready = install(user);
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(log(user.state, "tailscale"), [
    '-fsS -X PUT -H Content-Type: application/json --data {"enabled":true} http://127.0.0.1:5178/api/tailscale/serve',
  ]);
  assert.match(ready.stdout, /^Open Caffold from your other devices at https:\/\/host\.example\.ts\.net\.$/m);

  const denied = install(user, [], {
    FAKE_TAILSCALE_ANSWER:
      '{"state":"failed","reasonCode":"serveEnableFailed","diagnosticMessage":"Access denied: serve config denied","canManage":true}',
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /^Tailscale Serve is not on: Access denied: serve config denied$/m);
  assert.match(denied.stdout, /sudo tailscale set --operator=\S+, then run this script again\.$/m);

  rmSync(join(user.state, "tailscale.log"));
  const absent = install(user, [], {}, { tailscale: false });
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(log(user.state, "tailscale"), []);
  assert.match(absent.stdout, /^To open Caffold from your other devices, install Tailscale and run this script again\.$/m);
});

test("running it again installs the newest release and keeps the previous one only", (t) => {
  const user = world(t, { latest: "0.25.0", releases: ["0.23.0", "0.24.0", "0.25.0"] });

  for (const version of ["0.23.0", "0.24.0"]) {
    const result = install(user, ["--version", version]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(versions(user.home), ["0.23.0", "0.24.0"]);

  const newest = install(user);

  assert.equal(newest.status, 0, newest.stderr);
  assert.match(linked(user.home), /\/versions\/0\.25\.0\/caffold$/);
  assert.deepEqual(versions(user.home), ["0.24.0", "0.25.0"]);
  assert.equal(readFileSync(join(user.state, "running"), "utf8").trim(), "0.25.0");
});

test("running it again for the running version leaves the server alone", (t) => {
  const user = world(t);
  assert.equal(install(user).status, 0);
  rmSync(join(user.state, "systemctl.log"));
  rmSync(join(user.release, "v0.24.0"), { recursive: true });

  const again = install(user, [], { FAKE_LINGER: "yes" });

  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^Caffold 0\.24\.0 is already installed\.$/m);
  assert.deepEqual(log(user.state, "systemctl"), [
    "--user show-environment",
    "--user daemon-reload",
    "--user enable --quiet caffold.service",
    "--user is-active --quiet caffold.service",
  ]);

  rmSync(join(user.state, "running"));
  const stopped = install(user);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(log(user.state, "systemctl").at(-1), "--user restart caffold.service");
});

test("puts the previous version back when the new one does not start", (t) => {
  const user = world(t, { latest: "0.25.0", releases: ["0.24.0", "0.25.0"] });
  assert.equal(install(user, ["--version", "0.24.0"]).status, 0);

  const result = install(user, [], { FAKE_STARTS: "0.24.0" });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^caffold install: Caffold 0\.25\.0 did not start, so Caffold 0\.24\.0 runs again\. See: journalctl --user -u caffold$/m,
  );
  assert.match(linked(user.home), /\/versions\/0\.24\.0\/caffold$/);
  assert.equal(readFileSync(join(user.state, "running"), "utf8").trim(), "0.24.0");
  assert.deepEqual(versions(user.home), ["0.24.0", "0.25.0"]);
});

test("changes nothing when an archive does not match its checksum", (t) => {
  const user = world(t);
  const archive = publish(user.release, "0.24.0", "archive");
  writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  ${archive}\n`);

  const result = install(user);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^caffold install: The checksum of Caffold-0\.24\.0-linux-x86_64\.tar\.gz does not match\.$/m,
  );
  assert.equal(existsSync(join(user.home, ".local/bin/caffold")), false);
  assert.deepEqual(versions(user.home), []);
  assert.deepEqual(log(user.state, "systemctl"), ["--user show-environment"]);
});

test("stops before anything changes when the binary cannot start here", (t) => {
  const user = world(t, { broken: ["0.24.0"] });

  const result = install(user);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^caffold install: Caffold cannot start on this system\. It needs glibc 2\.28 or later and the standard dynamic loader\.$/m,
  );
  assert.equal(existsSync(join(user.home, ".local/bin/caffold")), false);
  assert.deepEqual(versions(user.home), []);
});

test("downloads the release for this machine's architecture", (t) => {
  const user = world(t, { releases: [] });
  publish(user.release, "0.24.0", "archive", "aarch64");

  const result = install(user, [], { FAKE_MACHINE: "aarch64" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Installing Caffold 0\.24\.0 for aarch64\.$/m);
});

test("names what this system lacks before it downloads anything", (t) => {
  const user = world(t);
  for (const [env, message] of [
    [{ FAKE_KERNEL: "Darwin" }, "This script installs Caffold on Linux. On a Mac, install it with Homebrew: brew install --cask panarch/tap/caffold"],
    [{ FAKE_MACHINE: "riscv64" }, "Caffold runs on x86_64 and aarch64 Linux; this machine is riscv64."],
    [{ FAKE_GLIBC: "2.27" }, "Caffold needs glibc 2.28 or later; this system has 2.27."],
    [{ FAKE_GLIBC: "" }, "Caffold needs glibc 2.28 or later, and this system has no glibc."],
    [{ FAKE_NO_SYSTEMD: "1" }, "Caffold runs as a systemd user service, and this session has no systemd user manager."],
  ]) {
    const result = install(user, [], env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.equal(result.stderr, `caffold install: ${message}\n`);
  }
  assert.equal(existsSync(join(user.home, ".local")), false);
});

test("accepts glibc 2.28 itself", (t) => {
  const user = world(t);

  const result = install(user, [], { FAKE_GLIBC: "2.28" });

  assert.equal(result.status, 0, result.stderr);
});

test("installs a named version, such as a release candidate", (t) => {
  const user = world(t, { latest: "0.24.0", releases: ["0.24.0", "0.25.0-rc.1"] });

  const result = install(user, ["--version", "0.25.0-rc.1"], { FAKE_STARTS: "0.25.0-rc.1" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(linked(user.home), /\/versions\/0\.25\.0-rc\.1\/caffold$/);

  const wrong = install(user, ["--version", "latest"]);
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stderr, "caffold install: latest is not a Caffold version, such as 0.24.0.\n");
});

test("says how to put the caffold command on the PATH", (t) => {
  const user = world(t);

  const result = install(user);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Add ~\/\.local\/bin to your PATH to run the caffold command\.$/m);
});
