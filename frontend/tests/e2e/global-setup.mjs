import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRepo = resolve(repositoryRoot, "tests/fixtures/home/src");
const fixtureGitDir = resolve(fixtureRepo, ".git");
const fixtureDataDir = resolve(repositoryRoot, "tests/fixtures/.caffold-data");
const fixtureWorktreeDir = resolve(
  repositoryRoot,
  "tests/fixtures/home/.caffold-worktrees",
);

export default function globalSetup() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
  rmSync(fixtureWorktreeDir, { recursive: true, force: true });
  execFileSync("git", ["init"], {
    cwd: fixtureRepo,
    stdio: "ignore",
  });
}
