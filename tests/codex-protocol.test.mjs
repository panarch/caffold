import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { resolveCodexBin } from "./live/codex-bin.mjs";

const SUPPORTED_VERSION = "0.145.0";

function runCodex(args) {
  const result = spawnSync(resolveCodexBin(), args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function writeExecutable(path) {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

test("live Codex binary resolution matches the backend install priorities", () => {
  const root = mkdtempSync(join(tmpdir(), "caffold-codex-bin-"));
  try {
    const pathDirectory = join(root, "path");
    const homeDirectory = join(root, "home");
    const homeBin = join(homeDirectory, ".local", "bin");
    mkdirSync(pathDirectory, { recursive: true });
    mkdirSync(homeBin, { recursive: true });
    const pathCodex = join(pathDirectory, "codex");
    const homeCodex = join(homeBin, "codex");
    const explicitCodex = join(root, "explicit-codex");
    writeExecutable(pathCodex);
    writeExecutable(homeCodex);
    writeExecutable(explicitCodex);

    assert.equal(
      resolveCodexBin({
        explicit: explicitCodex,
        searchPath: pathDirectory,
        home: homeDirectory,
        platformPaths: [],
      }),
      explicitCodex,
    );
    assert.equal(
      resolveCodexBin({
        explicit: "",
        searchPath: [pathDirectory, join(root, "missing")].join(delimiter),
        home: homeDirectory,
        platformPaths: [],
      }),
      pathCodex,
    );
    assert.equal(
      resolveCodexBin({
        explicit: "",
        searchPath: "",
        home: homeDirectory,
        platformPaths: [],
      }),
      homeCodex,
    );
    assert.throws(
      () =>
        resolveCodexBin({
          explicit: join(root, "missing-codex"),
          searchPath: pathDirectory,
          home: homeDirectory,
          platformPaths: [],
        }),
      /CAFFOLD_CODEX_BIN is not executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
        "thread/read",
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

      const listParams = readFileSync(join(outputDirectory, "v2", "ThreadListParams.ts"), "utf8");
      assert.match(listParams, /cursor/);
      assert.match(listParams, /sortKey/);
      assert.match(listParams, /sortDirection/);
      assert.match(listParams, /useStateDbOnly/);

      const readParams = readFileSync(join(outputDirectory, "v2", "ThreadReadParams.ts"), "utf8");
      assert.match(readParams, /includeTurns/);

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
