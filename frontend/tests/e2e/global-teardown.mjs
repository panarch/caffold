import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixtureGitDir = resolve(fixtureRoot, "home/src/.git");
const fixtureDataDir = resolve(fixtureRoot, ".caffold-data");
const fixtureWorktreeDir = resolve(fixtureRoot, "home/.caffold-worktrees");

export default function globalTeardown() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
  rmSync(fixtureWorktreeDir, { recursive: true, force: true });
}
