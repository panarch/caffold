import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SUPPORTED_VERSION = "0.144.4";

function runCodex(args) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test(
  "installed Codex app-server protocol keeps the required Caffold contract",
  { skip: process.env.CAFFOLD_CODEX_PROTOCOL_LIVE !== "1" },
  () => {
    const version = runCodex(["--version"]);
    assert.match(version, new RegExp(`\\b${SUPPORTED_VERSION.replaceAll(".", "\\.")}\\b`));

    const outputDirectory = mkdtempSync(join(tmpdir(), "caffold-codex-protocol-"));
    try {
      runCodex([
        "app-server",
        "generate-ts",
        "--experimental",
        "--out",
        outputDirectory,
      ]);

      const clientRequests = readFileSync(join(outputDirectory, "ClientRequest.ts"), "utf8");
      for (const method of [
        "thread/start",
        "thread/resume",
        "thread/unsubscribe",
        "thread/turns/list",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "model/list",
      ]) {
        assert.ok(
          clientRequests.includes(`"method": "${method}"`),
          `missing client request method ${method}`,
        );
      }

      const resumeParams = readFileSync(
        join(outputDirectory, "v2", "ThreadResumeParams.ts"),
        "utf8",
      );
      assert.match(resumeParams, /excludeTurns/);
      assert.match(resumeParams, /initialTurnsPage/);

      const turnsResponse = readFileSync(
        join(outputDirectory, "v2", "ThreadTurnsListResponse.ts"),
        "utf8",
      );
      assert.match(turnsResponse, /nextCursor/);
      assert.match(turnsResponse, /backwardsCursor/);

      const unsubscribeStatus = readFileSync(
        join(outputDirectory, "v2", "ThreadUnsubscribeStatus.ts"),
        "utf8",
      );
      assert.match(unsubscribeStatus, /notLoaded/);
      assert.match(unsubscribeStatus, /notSubscribed/);
      assert.match(unsubscribeStatus, /unsubscribed/);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  },
);
