import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { resolveCodexBin } from "../live/codex-bin.mjs";

function writeExecutable(path) {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

// The live browser suite resolves the Codex CLI the same way the backend does,
// so this keeps the suite's helper faithful to those install priorities. The
// backend's own resolution is covered by its Rust readiness tests.
test("Codex binary resolution matches the backend install priorities", () => {
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
      homeCodex,
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
    rmSync(homeCodex);
    assert.throws(
      () =>
        resolveCodexBin({
          explicit: "",
          searchPath: pathDirectory,
          home: homeDirectory,
          platformPaths: [],
        }),
      /Unsupported Codex installation/,
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
