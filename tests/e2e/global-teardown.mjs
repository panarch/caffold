import { rmSync } from "node:fs";
import { resolve } from "node:path";

const fixtureGitDir = resolve("tests/fixtures/home/src/.git");

export default function globalTeardown() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
}
