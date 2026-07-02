import { rmSync } from "node:fs";
import { resolve } from "node:path";

const fixtureGitDir = resolve("tests/fixtures/home/src/.git");
const fixtureDataDir = resolve("tests/fixtures/.caffold-data");

export default function globalTeardown() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
}
