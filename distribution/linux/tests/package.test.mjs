import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const packageScript = resolve(here, "../package");
const fixtures = resolve(here, "fixtures");
const elf = (name) => join(fixtures, "elf", name);
const version = readFileSync(join(repoRoot, "caffold/Cargo.toml"), "utf8").match(
  /^version = "([^"]+)"/m,
)[1];

// Runs `script` with the packaging functions loaded and stand-ins for uname,
// objdump, and readelf.
function packaging(script, env = {}) {
  return spawnSync("bash", ["-c", `source "${packageScript}"\n${script}`], {
    encoding: "utf8",
    env: {
      PATH: [join(fixtures, "package-bin"), join(fixtures, "bin"), "/usr/bin", "/bin"].join(":"),
      FAKE_MACHINE: "x86_64",
      FAKE_OBJDUMP: elf("symbols-at-the-ceilings.txt"),
      FAKE_READELF_HEADER: elf("header-x86_64.txt"),
      FAKE_READELF_DYNAMIC: elf("dynamic-system.txt"),
      ...env,
    },
  });
}

const binary = join(fixtures, "archive/caffold");

test("names the archive the way the install script and the updater download it", () => {
  for (const machine of ["x86_64", "aarch64"]) {
    const result = packaging("metadata", { FAKE_MACHINE: machine });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        `version=${version}`,
        `arch=${machine}`,
        `archive=Caffold-${version}-linux-${machine}.tar.gz`,
        `checksum=Caffold-${version}-linux-${machine}.tar.gz.sha256`,
        "",
      ].join("\n"),
    );
  }
  assert.equal(packaging("metadata", { FAKE_MACHINE: "riscv64" }).status, 1);
});

test("accepts a binary that asks for glibc 2.28 and libstdc++ 3.4.25 at most", () => {
  const result = packaging(`verify_binary "${binary}"`);

  assert.equal(result.status, 0, result.stderr);
});

test("accepts a binary that uses no libstdc++, as the runner does", () => {
  const result = packaging(`verify_binary "${binary}"`, {
    FAKE_OBJDUMP: elf("symbols-without-libstdcxx.txt"),
  });

  assert.equal(result.status, 0, result.stderr);
});

test("reads the newest version a binary asks for by version, not by text", () => {
  const result = packaging(`newest_symbol_version GLIBC <"${elf("symbols-at-the-ceilings.txt")}"`);

  assert.equal(result.stdout, "2.28\n");
});

test("refuses a binary that asks for a newer glibc or libstdc++", () => {
  for (const [symbols, message] of [
    ["symbols-glibc-2.29.txt", "needs GLIBC_2.29, newer than GLIBC_2.28."],
    ["symbols-glibcxx-3.4.26.txt", "needs GLIBCXX_3.4.26, newer than GLIBCXX_3.4.25."],
  ]) {
    const result = packaging(`verify_binary "${binary}"`, { FAKE_OBJDUMP: elf(symbols) });

    assert.equal(result.status, 1, symbols);
    assert.equal(result.stderr, `${binary} ${message}\n`);
  }
});

test("refuses a binary that needs a library outside the system's", () => {
  const result = packaging(`verify_binary "${binary}"`, {
    FAKE_READELF_DYNAMIC: elf("dynamic-openssl.txt"),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, `${binary} needs libssl.so.3, which is not a system library.\n`);
});

test("refuses a binary built for another architecture", () => {
  const result = packaging(`verify_binary "${binary}"`, {
    FAKE_READELF_HEADER: elf("header-aarch64.txt"),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, `${binary} is built for AArch64, not x86_64.\n`);
});

const health = (buildId) => JSON.stringify({ status: "ok", version, buildId });

test("accepts a server that answers with the version and a build ID naming its commit", () => {
  for (const buildId of ["977af700.1794292206", "977af700-dirty.1794292206"]) {
    const result = packaging(`verify_serves "${binary}" "${version}"`, { FAKE_HEALTH: health(buildId) });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("refuses a build ID that names no commit, as when Git could not read the checkout", () => {
  const result = packaging(`verify_serves "${binary}" "${version}"`, {
    FAKE_HEALTH: health("unknown.1794292206"),
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "caffold serve answered with build ID unknown.1794292206, which names no commit; Git could not read the checkout.\n",
  );
});

test("names its commands and refuses others", () => {
  const help = spawnSync(packageScript, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: distribution\/linux\/package \{archive\|verify-archive\|metadata\}$/m);

  const unknown = spawnSync(packageScript, ["build"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
});
