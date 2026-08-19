import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixtureRepo = resolve(fixtureRoot, "home/src");
const fixtureGitDir = resolve(fixtureRepo, ".git");
const fixtureDataDir = resolve(fixtureRoot, ".caffold-data");
const fixtureWorktreeDir = resolve(fixtureRoot, "home/.caffold-worktrees");

export default function globalSetup() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
  rmSync(fixtureWorktreeDir, { recursive: true, force: true });
  execFileSync("git", ["init"], {
    cwd: fixtureRepo,
    stdio: "ignore",
  });
}
