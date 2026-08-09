import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return extname(entry.name) === ".md" ? [path] : [];
  });
}

const contributorDocs = [
  resolve(repoRoot, "README.md"),
  resolve(repoRoot, "CONTRIBUTING.md"),
  ...markdownFiles(resolve(repoRoot, "docs")),
  ...markdownFiles(resolve(repoRoot, "desktop/macos")),
];

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

test("current worktree documentation names the same-Task isolation tool", () => {
  const workflow = readFileSync(resolve(repoRoot, "docs/internal/workflows.md"), "utf8");
  const lifecycle = readFileSync(
    resolve(repoRoot, "docs/internal/worktree-lifecycle.md"),
    "utf8",
  );
  for (const source of [workflow, lifecycle]) {
    assert.match(source, /isolate_current_task/);
    assert.doesNotMatch(source, /start_isolated_task/);
  }
});

test("backend review policy keeps incomplete ownership work visible", () => {
  const policy = readFileSync(
    resolve(repoRoot, "docs/public/review-policy/backend.md"),
    "utf8",
  );
  assert.match(policy, /test ownership is only partially aligned/);
  assert.match(policy, /Completed reference area:/);
  assert.match(policy, /Known incomplete areas:/);
  assert.match(
    policy,
    /all other backend areas remain partially aligned or unclassified/,
  );
});

test("frontend review policy keeps incomplete ownership work visible", () => {
  const policy = readFileSync(
    resolve(repoRoot, "docs/public/review-policy/frontend.md"),
    "utf8",
  );
  assert.match(policy, /test ownership is only partially aligned/);
  assert.match(policy, /Tasks area is\s+not fully owner-aligned/);
  assert.match(policy, /current location or size is not precedent/);
});
