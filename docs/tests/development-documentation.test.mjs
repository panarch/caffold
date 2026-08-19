import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return extname(entry.name) === ".md" ? [path] : [];
  });
}

// Every tracked Markdown file is contributor documentation, wherever its owner
// keeps it. Asking Git for the list excludes ignored trees — local notes,
// node_modules, build output — without naming them. Fixture Markdown is test
// data rather than documentation, so it stays out.
const contributorDocs = execFileSync("git", ["ls-files", "*.md"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => path && !path.split("/").includes("fixtures"))
  .map((path) => resolve(repoRoot, path));

test("official documentation uses repository-owned entrypoints", () => {
  for (const path of contributorDocs) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /(?:^|[\s`(])\.notes\//m, `${path} references .notes`);
  }
});

test("the documentation index links every document", () => {
  const docsRoot = resolve(repoRoot, "docs");
  const docsIndex = readFileSync(resolve(docsRoot, "README.md"), "utf8");
  for (const path of markdownFiles(docsRoot)) {
    if (path === resolve(docsRoot, "README.md")) continue;
    const target = relative(docsRoot, path);
    assert.ok(
      docsIndex.includes(`](${target})`),
      `${target} is missing from docs/README.md`,
    );
  }
});

test("local Markdown links in contributor documentation resolve", () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const path of contributorDocs) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (
        rawTarget.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
      ) {
        continue;
      }
      const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
      assert.ok(
        existsSync(resolve(dirname(path), target)),
        `${path} links to missing ${rawTarget}`,
      );
    }
  }
});

test("development entrypoints and diagnostic probe remain discoverable", () => {
  for (const path of [
    "CONTRIBUTING.md",
    ".nvmrc",
    "rust-toolchain.toml",
    "docs/development/testing.md",
    "docs/development/macos-local-app.md",
    "docs/development/mobile-pwa-testing.md",
    "desktop/macos/install-local",
    "scripts/dev/probe-codex-app-server.mjs",
  ]) {
    assert.ok(existsSync(resolve(repoRoot, path)), `${path} must exist`);
  }

  const probe = spawnSync(
    process.execPath,
    [resolve(repoRoot, "scripts/dev/probe-codex-app-server.mjs"), "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /THREAD_ID/);
});

// Test commands used to be discoverable from one package manifest. They are now
// owned by the thing they verify, so the testing guide is the only index and
// this contract keeps it complete.
// Test suites are owned by the thing they verify rather than listed in one
// manifest, so these enumerate what the repository actually exposes and check
// that each one is written down and wired up.
function ownedSuites() {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "frontend/package.json"), "utf8"),
  );
  const packageCommands = Object.keys(packageJson.scripts)
    .filter((name) => name.startsWith("test:"))
    .map((name) => `npm run ${name}`)
    .sort();

  const macosRunners = readdirSync(resolve(repoRoot, "desktop/macos"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.startsWith("test-"))
    .map((entry) => `desktop/macos/${entry.name}`)
    .sort();

  // Owners outside the frontend package keep their Node contracts in a tests/
  // directory of their own.
  const testRoots = execFileSync("git", ["ls-files", "*/tests/*.test.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((path) => dirname(path))
    .filter((directory) => !directory.startsWith("frontend/"))
    .filter((directory, index, all) => all.indexOf(directory) === index)
    .sort();

  assert.ok(packageCommands.length > 0);
  assert.ok(macosRunners.length > 0);
  assert.ok(testRoots.length > 0);
  return { packageCommands, macosRunners, testRoots };
}

function readWorkflow(name) {
  return readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8");
}

/** A root is reached when a workflow runs it directly or runs a runner that does. */
function reaches(workflow, root) {
  if (workflow.includes(root)) {
    return true;
  }
  const { macosRunners } = ownedSuites();
  return macosRunners.some((runner) => {
    const runnerDirectory = dirname(runner);
    if (!workflow.includes(runner) || !root.startsWith(`${runnerDirectory}/`)) {
      return false;
    }
    const relative = root.slice(runnerDirectory.length + 1);
    return readFileSync(resolve(repoRoot, runner), "utf8").includes(relative);
  });
}

test("every owned test command is discoverable in the testing guide", () => {
  const testingGuide = readFileSync(
    resolve(repoRoot, "docs/development/testing.md"),
    "utf8",
  );
  const { packageCommands, macosRunners, testRoots } = ownedSuites();

  for (const entry of [...packageCommands, ...macosRunners, ...testRoots]) {
    assert.ok(
      testingGuide.includes(entry),
      `${entry} is missing from the testing guide`,
    );
  }
});

test("every owned test suite is run where it can run", () => {
  // Each suite has to have an answer to "where does this run", so adding one
  // forces the decision rather than leaving it unrun and unnoticed. Suites that
  // cannot run on a plain Ubuntu runner belong to the release gate; suites that
  // run nowhere in CI have to say why.
  const requiresMacos = new Set([
    "desktop/macos/test-runtime",
    "desktop/macos/test-system-status",
    "desktop/macos/test-updater",
  ]);
  const outsideCi = new Map([
    [
      "npm run test:codex-live",
      "needs an authenticated Codex CLI and spends model usage",
    ],
  ]);

  const checks = readWorkflow("checks.yml");
  const release = readWorkflow("release.yml");
  const { packageCommands, macosRunners, testRoots } = ownedSuites();

  for (const command of [...packageCommands, ...macosRunners]) {
    if (outsideCi.has(command)) {
      continue;
    }
    if (requiresMacos.has(command)) {
      assert.ok(
        release.includes(command),
        `${command} needs macOS but the release gate does not run it`,
      );
      continue;
    }
    assert.ok(
      checks.includes(command),
      `${command} is portable but the pull-request checks do not run it`,
    );
  }

  for (const root of testRoots) {
    assert.ok(
      reaches(checks, root),
      `${root} is portable but the pull-request checks do not run it`,
    );
  }

  for (const declared of [...outsideCi.keys(), ...requiresMacos]) {
    assert.ok(
      [...packageCommands, ...macosRunners].includes(declared),
      `${declared} no longer exists and can leave the declaration`,
    );
  }
});

test("the release gate runs everything the pull-request checks run", () => {
  const checks = readWorkflow("checks.yml");
  const release = readWorkflow("release.yml");
  const { packageCommands, macosRunners, testRoots } = ownedSuites();

  for (const entry of [...packageCommands, ...macosRunners]) {
    if (!checks.includes(entry)) {
      continue;
    }
    assert.ok(
      release.includes(entry),
      `${entry} runs in the pull-request checks but not in the release gate`,
    );
  }

  for (const root of testRoots) {
    if (!reaches(checks, root)) {
      continue;
    }
    assert.ok(
      reaches(release, root),
      `${root} runs in the pull-request checks but not in the release gate`,
    );
  }
});
