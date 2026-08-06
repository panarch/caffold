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

const MINIMUM_SUPPORTED_VERSION = "0.146.0";

function parseCodexVersion(versionOutput) {
  const match =
    /\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\b/.exec(
      versionOutput,
    );
  assert.ok(match, `could not parse Codex CLI version from: ${versionOutput.trim()}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareCodexVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === null) {
    return 1;
  }
  if (right.prerelease === null) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease, "en", {
    numeric: true,
  });
}

function supportsCodexVersion(versionOutput) {
  const installed = parseCodexVersion(versionOutput);
  const minimum = parseCodexVersion(`codex-cli ${MINIMUM_SUPPORTED_VERSION}`);
  return compareCodexVersions(installed, minimum) >= 0;
}

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

test("Codex version gate accepts compatible upgrades and rejects older baselines", () => {
  assert.equal(supportsCodexVersion("codex-cli 0.146.0"), true);
  assert.equal(supportsCodexVersion("codex-cli 0.147.0"), true);
  assert.equal(supportsCodexVersion("codex-cli 1.0.0"), true);
  assert.equal(supportsCodexVersion("codex-cli 0.146.0-alpha.1"), false);
  assert.equal(supportsCodexVersion("codex-cli 0.145.9"), false);
  assert.throws(() => supportsCodexVersion("codex-cli unknown"), /could not parse/);
});

test(
  "installed Codex app-server protocol keeps the required Caffold contract",
  { skip: process.env.CAFFOLD_CODEX_PROTOCOL_LIVE !== "1" },
  () => {
    const version = runCodex(["--version"]);
    assert.ok(
      supportsCodexVersion(version),
      `Codex CLI ${version.trim()} is older than the supported ${MINIMUM_SUPPORTED_VERSION} baseline`,
    );

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
        "thread/name/set",
        "thread/read",
        "thread/resume",
        "thread/unsubscribe",
        "thread/turns/list",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "model/list",
        "permissionProfile/list",
        "config/read",
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

      const threadStatus = readFileSync(
        join(outputDirectory, "v2", "ThreadStatus.ts"),
        "utf8",
      );
      assert.match(threadStatus, /"type": "notLoaded"/);
      assert.match(threadStatus, /"type": "idle"/);
      assert.match(threadStatus, /"type": "systemError"/);
      assert.match(threadStatus, /"type": "active"/);
      assert.match(threadStatus, /activeFlags: Array<ThreadActiveFlag>/);

      const threadActiveFlag = readFileSync(
        join(outputDirectory, "v2", "ThreadActiveFlag.ts"),
        "utf8",
      );
      assert.match(threadActiveFlag, /"waitingOnApproval"/);
      assert.match(threadActiveFlag, /"waitingOnUserInput"/);

      const turnStatus = readFileSync(
        join(outputDirectory, "v2", "TurnStatus.ts"),
        "utf8",
      );
      for (const status of ["completed", "interrupted", "failed", "inProgress"]) {
        assert.ok(turnStatus.includes(`"${status}"`), `missing turn status ${status}`);
      }

      const notificationContracts = [
        ["ThreadStatusChangedNotification.ts", /threadId: string, status: ThreadStatus/],
        ["TurnStartedNotification.ts", /threadId: string, turn: Turn/],
        ["TurnCompletedNotification.ts", /threadId: string, turn: Turn/],
      ];
      for (const [file, contract] of notificationContracts) {
        const notification = readFileSync(join(outputDirectory, "v2", file), "utf8");
        assert.match(notification, contract);
      }

      const unsubscribeStatus = readFileSync(
        join(outputDirectory, "v2", "ThreadUnsubscribeStatus.ts"),
        "utf8",
      );
      assert.match(unsubscribeStatus, /notLoaded/);
      assert.match(unsubscribeStatus, /notSubscribed/);
      assert.match(unsubscribeStatus, /unsubscribed/);

      const threadStartParams = readFileSync(
        join(outputDirectory, "v2", "ThreadStartParams.ts"),
        "utf8",
      );
      assert.match(threadStartParams, /approvalPolicy/);
      assert.match(threadStartParams, /approvalsReviewer/);
      assert.match(threadStartParams, /permissions/);
      assert.match(threadStartParams, /dynamicTools/);

      const serverRequests = readFileSync(join(outputDirectory, "ServerRequest.ts"), "utf8");
      assert.ok(
        serverRequests.includes('"method": "item/tool/call"'),
        "missing dynamic tool server request",
      );
      const dynamicToolParams = readFileSync(
        join(outputDirectory, "v2", "DynamicToolCallParams.ts"),
        "utf8",
      );
      assert.match(dynamicToolParams, /threadId: string/);
      assert.match(dynamicToolParams, /tool: string/);
      assert.match(dynamicToolParams, /arguments/);
      const dynamicToolResponse = readFileSync(
        join(outputDirectory, "v2", "DynamicToolCallResponse.ts"),
        "utf8",
      );
      assert.match(dynamicToolResponse, /contentItems/);
      assert.match(dynamicToolResponse, /success: boolean/);

      const threadNameUpdated = readFileSync(
        join(outputDirectory, "v2", "ThreadNameUpdatedNotification.ts"),
        "utf8",
      );
      assert.match(threadNameUpdated, /threadId: string/);
      assert.match(threadNameUpdated, /threadName/);

      const turnStartParams = readFileSync(
        join(outputDirectory, "v2", "TurnStartParams.ts"),
        "utf8",
      );
      assert.match(turnStartParams, /approvalPolicy/);
      assert.match(turnStartParams, /approvalsReviewer/);
      assert.match(turnStartParams, /permissions/);

      const permissionProfiles = readFileSync(
        join(outputDirectory, "v2", "PermissionProfileListResponse.ts"),
        "utf8",
      );
      assert.match(permissionProfiles, /PermissionProfileSummary/);
      assert.match(permissionProfiles, /nextCursor/);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  },
);
