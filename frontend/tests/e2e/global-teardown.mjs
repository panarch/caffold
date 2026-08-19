import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureGitDir = resolve(repositoryRoot, "tests/fixtures/home/src/.git");
const fixtureDataDir = resolve(repositoryRoot, "tests/fixtures/.caffold-data");
const fixtureWorktreeDir = resolve(
  repositoryRoot,
  "tests/fixtures/home/.caffold-worktrees",
);

export default function globalTeardown() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
  rmSync(fixtureWorktreeDir, { recursive: true, force: true });
}
