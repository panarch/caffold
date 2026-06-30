import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const fixtureRepo = resolve("tests/fixtures/home/src");
const fixtureGitDir = resolve(fixtureRepo, ".git");
const fixtureDataDir = resolve("tests/fixtures/.codger-data");

export default function globalSetup() {
  rmSync(fixtureGitDir, { recursive: true, force: true });
  rmSync(fixtureDataDir, { recursive: true, force: true });
  execFileSync("git", ["init"], {
    cwd: fixtureRepo,
    stdio: "ignore",
  });
}
